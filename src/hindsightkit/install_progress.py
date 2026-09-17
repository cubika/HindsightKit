"""Stream dependency installation output with elapsed-time progress and safe logs."""
from __future__ import annotations

from collections import deque
from contextlib import nullcontext
import math
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time


_ANSI = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")
_URL = re.compile(r"(?i)https?://[^\s<>\"']+")
_SECRET = re.compile(
    r"(?i)([\"']?(?:_?auth(?:token)?|authorization|(?:access|refresh|id|api)[_-]?token|"
    r"api[_-]?key|(?:npm|node_auth|github|gh)[_-]?token|password|passwd|secret|token)"
    r"[\"']?\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|[^\s,;]+)")
_ERROR = re.compile(r"(?i)\bnpm\s+err!|\b(?:error|fatal|exception|failed)\b")


def redact(text: str) -> str:
    text = _ANSI.sub("", str(text))
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)

    def safe_url(match):
        value = match.group()
        value = re.sub(r"^(https?://)[^/\s]*@", r"\1[REDACTED]@", value, flags=re.I)
        if "?" in value:
            value = value.split("?", 1)[0] + "?[REDACTED]"
        elif "#" in value:
            value = value.split("#", 1)[0] + "#[REDACTED]"
        return value

    text = _URL.sub(safe_url, text)
    text = re.sub(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)
    text = re.sub(r"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|npm_[A-Za-z0-9]+)\b",
                  "[REDACTED]", text)
    return _SECRET.sub(lambda match: match[1] + "[REDACTED]", text)


class InstallError(RuntimeError):
    def __init__(self, message: str, returncode: int | None = None):
        super().__init__(message)
        self.returncode = returncode


def _stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def run_install(command, *, cwd, label, log_path=None, heartbeat_seconds=10):
    """Run a noninteractive installer; raise InstallError with a redacted failure summary."""
    if not math.isfinite(heartbeat_seconds) or heartbeat_seconds <= 0:
        raise ValueError("Heartbeat interval must be positive and finite.")
    directory = Path(cwd).resolve()
    label = redact(label).replace("\n", " ").replace("\r", " ")
    selected_log = log_path or os.environ.get("HINDSIGHTKIT_INSTALL_LOG")
    selected_log = Path(selected_log) if selected_log else None
    started = time.monotonic()
    messages = queue.Queue(maxsize=128)
    finished = object()
    stop_reader = threading.Event()
    process = reader = None
    tail = deque(maxlen=8)
    first_error = None

    def elapsed():
        return f"{time.monotonic() - started:.1f}s"

    log_context = selected_log.open("a", encoding="utf-8") if selected_log else nullcontext(None)
    with log_context as log:
        def emit(message):
            safe = redact(message)
            print(safe, flush=True)
            if log:
                log.write(safe + "\n")
                log.flush()
            return safe

        def location():
            result = f"Working directory: {directory}."
            return result + (f" Log: {selected_log}." if selected_log else "")

        def enqueue(item):
            while not stop_reader.is_set():
                try:
                    messages.put(item, timeout=0.1)
                    return
                except queue.Full:
                    pass

        def read_output():
            try:
                for line in process.stdout:
                    enqueue(line.rstrip("\r\n"))
            except (OSError, ValueError) as exc:
                enqueue(f"Output read error: {exc}")
            finally:
                enqueue(finished)

        emit(f"Starting {label}... {location()}")
        try:
            try:
                process = subprocess.Popen(
                    [str(part) for part in command], cwd=directory, stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                    errors="replace", bufsize=1,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            except OSError as exc:
                summary = emit(f"{label} could not start (elapsed {elapsed()}). {location()} {exc}")
                raise InstallError(summary) from None
            reader = threading.Thread(target=read_output, daemon=True, name="install-output")
            reader.start()
            next_heartbeat = started + heartbeat_seconds
            output_done = False
            while not output_done or process.poll() is None:
                remaining = max(0, next_heartbeat - time.monotonic()) if process.poll() is None else 0.1
                try:
                    message = messages.get(timeout=min(remaining, 0.1))
                except queue.Empty:
                    message = None
                if message is finished:
                    output_done = True
                elif message is not None:
                    safe = emit(message)
                    if safe.strip():
                        tail.append(safe)
                        if first_error is None and _ERROR.search(safe):
                            first_error = safe
                if time.monotonic() >= next_heartbeat and process.poll() is None:
                    emit(f"Still installing {label}... elapsed {elapsed()}.")
                    next_heartbeat = time.monotonic() + heartbeat_seconds
            code = process.wait()
            if code:
                summary = f"{label} failed (exit {code}; elapsed {elapsed()}). {location()}"
                if first_error:
                    summary += "\nFirst error: " + first_error
                if tail:
                    summary += "\nLast output:\n" + "\n".join(tail)
                raise InstallError(emit(summary), code)
            emit(f"Completed {label} (elapsed {elapsed()}).")
        except KeyboardInterrupt:
            if process:
                _stop(process)
            emit(f"Interrupted {label} (elapsed {elapsed()}). {location()}")
            raise
        except BaseException:
            if process:
                _stop(process)
            raise
        finally:
            stop_reader.set()
            if reader:
                reader.join(timeout=1)
            if process and process.stdout and (not reader or not reader.is_alive()):
                process.stdout.close()
