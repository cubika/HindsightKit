"""Visible, bounded startup around the official Hindsight launcher."""
from collections import deque
from contextlib import contextmanager
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time

from hindsightkit.setup.progress import redact


@contextmanager
def stage(label, *, log=None, interval=10):
    started = time.monotonic()
    done = threading.Event()
    print(f'{label}...', flush=True)
    if log:
        print(f'Log: {log}', flush=True)

    def heartbeat():
        while not done.wait(interval):
            print(f'{label}... {time.monotonic() - started:.0f}s elapsed.', flush=True)

    worker = threading.Thread(target=heartbeat, daemon=True, name='startup-progress')
    worker.start()
    try:
        yield
    except BaseException:
        print(f'{label}: failed after {time.monotonic() - started:.1f}s.', flush=True)
        raise
    else:
        print(f'{label}: ready ({time.monotonic() - started:.1f}s).', flush=True)
    finally:
        done.set()
        worker.join(timeout=1)


class LogTail:
    """Read only new bytes, including after upstream rotates its log."""
    def __init__(self, path):
        self.path = Path(path)
        self.position = 0
        self.identity = None
        self.pending = ''
        try:
            info = self.path.stat()
            self.position, self.identity = info.st_size, info.st_ino
        except FileNotFoundError:
            pass

    def read(self):
        try:
            with self.path.open('rb') as stream:
                info = os.fstat(stream.fileno())
                if info.st_ino != self.identity or info.st_size < self.position:
                    self.position, self.pending = 0, ''
                self.identity = info.st_ino
                stream.seek(self.position)
                content = stream.read(65536)
                self.position = stream.tell()
        except FileNotFoundError:
            return []
        lines = (self.pending + content.decode('utf-8', errors='replace')).split('\n')
        self.pending = lines.pop()[-8192:]
        return [line.rstrip('\r') for line in lines]


def stop_launcher(process):
    if process.poll() is not None:
        return
    if os.name == 'nt':
        # Python's Windows venv launcher has a child interpreter. Terminate only
        # this invocation's process tree, never a pre-existing service by port.
        try:
            subprocess.run([str(Path(os.environ['SystemRoot']) / 'System32/taskkill.exe'),
                            '/PID', str(process.pid), '/T', '/F'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                           creationflags=subprocess.CREATE_NO_WINDOW, check=True)
        except (OSError, subprocess.SubprocessError):
            if process.poll() is None:
                process.kill()
    else:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def start_api(paths, config, *, command=None, timeout=None, interval=10):
    from filelock import FileLock, Timeout
    if timeout is None:
        raw = os.environ.get('HINDSIGHT_EMBED_DAEMON_STARTUP_TIMEOUT', '600')
        try:
            timeout = int(raw)
        except ValueError:
            raise RuntimeError('HINDSIGHT_EMBED_DAEMON_STARTUP_TIMEOUT must be a positive integer.') from None
    if not math.isfinite(timeout) or timeout <= 0:
        raise RuntimeError('The API startup timeout must be positive and finite.')
    started = time.monotonic()
    print(f'API startup limit: {timeout:g}s, including any wait for another start. '
          'The first launch may download the embedding model.', flush=True)
    paths.log.parent.mkdir(parents=True, exist_ok=True)
    with stage('Starting Hindsight API', log=paths.log, interval=interval):
        try:
            # Do not attribute another hk invocation's log entries to this one.
            with FileLock(str(paths.log) + '.hk-start.lock', timeout=timeout):
                _start_api(paths, config, command=command, timeout=timeout, started=started)
        except Timeout:
            raise RuntimeError(f'Another hk start is still running after {timeout:g}s. '
                               f'Log: {paths.log}. Check hk status before retrying.') from None


def _start_api(paths, config, *, command, timeout, started):
    from hindsightkit.platform import runtime
    settings = list(config.items()) + [(key, value) for key, value in os.environ.items()
                                      if key.startswith(('HINDSIGHT_', 'COPILOT_'))]
    secrets = [str(value) for key, value in settings if value and
               any(part in key for part in ('KEY', 'TOKEN', 'PASSWORD', 'DATABASE_URL'))]

    def safe(value):
        for secret in sorted(secrets, key=len, reverse=True):
            value = value.replace(secret, '[REDACTED]')
        return redact(value)

    tail = LogTail(paths.log)
    recent = deque(maxlen=6)
    traceback_pending = top_level_traceback = False
    fatal = None
    shown = set()
    command = command or [sys.executable, '-m', 'hindsight_embed.cli',
                          '--profile', runtime.PROFILE, 'daemon', 'start']
    # A file avoids waiting for pipe EOF from a detached descendant. The wrapper
    # supplies plain progress even when upstream Rich suppresses non-TTY output.
    with tempfile.TemporaryFile() as output:
        process = subprocess.Popen([str(value) for value in command], stdin=subprocess.DEVNULL,
            stdout=output, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        try:
            while True:
                for line in tail.read():
                    if line.strip():
                        recent.append(safe(line)[-1500:])
                    for marker, progress in (
                        ('Embeddings: initializing ONNX', 'Loading embedding model'),
                        ('ONNX provider initialized', 'Embedding model loaded'),
                        ('Running database migrations', 'Checking database migrations'),
                        ('Application startup complete.', 'API initialized; checking readiness'),
                    ):
                        if marker in line and marker not in shown:
                            print(f'  {progress} ({time.monotonic() - started:.0f}s).', flush=True)
                            shown.add(marker)
                    if traceback_pending:
                        # An uncaught module-level traceback proves the API exited.
                        # Ordinary logged/retried exceptions must not abort startup.
                        top_level_traceback = '<frozen runpy>' in line and '_run_module_as_main' in line
                        traceback_pending = False
                    if line == 'Traceback (most recent call last):':
                        traceback_pending = True
                    if top_level_traceback and re.match(r'^[\w.]+(?:Error|Exception):', line):
                        fatal = safe(line)
                    if re.search(r'ERROR:\s+Application startup failed\. Exiting\.', line):
                        fatal = safe(line)
                code = process.poll()
                elapsed = time.monotonic() - started
                if code == 0:
                    return
                if fatal or code not in (None, 0) or elapsed >= timeout:
                    reason = fatal or (f'launcher exited with code {code}' if code is not None
                                       else f'timed out after {timeout:g}s')
                    output.seek(max(0, output.seek(0, 2) - 6000))
                    detail = '\n'.join(recent) or safe(output.read().decode('utf-8', errors='replace'))
                    hint = ''
                    if fatal and 'PermissionError' in fatal:
                        hint = '\nCheck access to the path above. Run hk start again after fixing it.'
                    raise RuntimeError(f'Hindsight API failed: {reason}. Log: {paths.log}'
                                       + (f'\nLatest startup output:\n{detail}' if detail else '') + hint)
                time.sleep(0.2)
        except BaseException as exc:
            try:
                stop_launcher(process)
            except (OSError, subprocess.SubprocessError) as cleanup:
                raise RuntimeError(f'{exc}\nCould not stop the startup launcher: {safe(str(cleanup))}') from exc
            raise
