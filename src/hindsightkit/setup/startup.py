"""Register per-user Windows login startup and preserve explicit pauses."""
import json
import os
from pathlib import Path
import subprocess
import sys

from hindsightkit import connection, services
from hindsightkit.platform import lifecycle, runtime

MARKER = '# Managed by HindsightKit login startup v1.'


def _preference():
    path = runtime.home() / 'startup.json'
    if not path.is_file():
        return None
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict) or value.get('schema') != 1 or type(value.get('enabled')) is not bool:
        raise RuntimeError('Invalid login startup settings. Check startup.json before retrying.')
    return value['enabled']


def _task(action, *, enable=False):
    if sys.platform != 'win32':
        raise RuntimeError('Login startup currently supports Windows only.')
    shell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    arguments = [str(shell), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                 '-File', str(runtime.PACKAGE / 'scripts/login_task.ps1'), '-Action', action,
                 '-Root', str(runtime.home())]
    if enable:
        arguments.append('-Enable')
    result = subprocess.run(arguments, capture_output=True, text=True, encoding='utf-8',
                            errors='replace', timeout=60, creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        raise RuntimeError('Windows login startup: ' + (result.stderr or result.stdout).strip())
    return json.loads(result.stdout)


def _save(enabled):
    path = runtime.home() / 'startup.json'
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps({'schema': 1, 'enabled': enabled}) + '\n', encoding='utf-8')
    temporary.replace(path)


def _quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def _runner(launcher):
    root = runtime.home()
    # Save only paths, never tokens or the installing shell's entire environment.
    return f"""{MARKER}
$ErrorActionPreference = 'Stop'
$env:HINDSIGHTKIT_HOME = {_quote(root)}
$env:HINDSIGHT_CONFIG = {_quote(connection.config_path().resolve())}
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUNBUFFERED = '1'
$output = Join-Path $env:HINDSIGHTKIT_HOME 'startup.log'
$errors = Join-Path $env:HINDSIGHTKIT_HOME 'startup-error.log'
try {{
    foreach ($log in @($output, $errors)) {{
        if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -ge 1MB) {{
            Move-Item -LiteralPath $log -Destination ($log + '.1') -Force
        }}
    }}
    $process = Start-Process -FilePath {_quote(launcher)} -ArgumentList 'startup-run' -WorkingDirectory {_quote(root)} -WindowStyle Hidden -PassThru -RedirectStandardOutput $output -RedirectStandardError $errors
    $handle = $process.Handle
    $process.WaitForExit()
    exit $process.ExitCode
}} catch {{
    $_.Exception.Message | Out-File -LiteralPath $errors -Encoding utf8 -Append
    exit 1
}}
"""


def install(launcher, *, enable=False):
    """Refresh a verified stable launcher; keep a user's opt-out on upgrades."""
    from hindsightkit.platform.files import private_directory
    root = runtime.home()
    settings = root / 'startup.json'
    preference = _preference()
    if preference is False and not enable:
        _task('remove')
        print('Login startup: disabled (saved preference).')
        return
    launcher = Path(launcher).resolve(strict=True)
    if launcher != (root / 'bin/hindsightkit.exe').resolve():
        raise RuntimeError('Login startup requires the installed HindsightKit command.')
    state = _task('status')  # Check ownership before changing a task or its script.
    private_directory(root / 'bin')
    script = root / 'bin/login-startup.ps1'
    original = script.read_bytes() if script.is_file() else None
    if original is not None and original.decode('utf-8-sig').splitlines()[:1] != [MARKER]:
        raise RuntimeError(f'Existing startup script is not managed by HindsightKit: {script}')
    original_settings = settings.read_bytes() if settings.is_file() else None
    temporary = script.with_suffix('.tmp')
    try:
        # Windows PowerShell 5.1 needs a BOM for non-ASCII installation paths.
        temporary.write_text(_runner(launcher), encoding='utf-8-sig')
        temporary.replace(script)
        _save(enable or not state['exists'] or state['enabled'])
        state = _task('install', enable=enable)
    except Exception:
        if original is None:
            script.unlink(missing_ok=True)
        else:
            script.write_bytes(original)
        if original_settings is None:
            settings.unlink(missing_ok=True)
        else:
            settings.write_bytes(original_settings)
        raise
    finally:
        temporary.unlink(missing_ok=True)
    print('Login startup: ' + ('enabled, 30 seconds after Windows sign-in.' if state['enabled'] else 'disabled.'))


def command(action):
    if action == 'on':
        install(runtime.home() / 'bin/hindsightkit.exe', enable=True)
        if lifecycle.state().get('stopped'):
            print('HindsightKit remains stopped. Run hindsightkit start to resume.')
    elif action == 'off':
        _task('remove')
        runtime.home().mkdir(parents=True, exist_ok=True)
        _save(False)
        print('Login startup: disabled; scheduled task removed.')
    else:
        state = _task('status')
        print('Login startup: ' + ('enabled' if state['enabled'] else 'disabled'))
        if state['exists']:
            print(f"Task: {state['name']}\nLast task result: {state['lastResult']}")
        print(f'Logs: {runtime.home() / "startup.log"}, {runtime.home() / "startup-error.log"}')


def run():
    """Unattended resume never overrides stop or reconnects an unshared client."""
    if _preference() is False:
        print('Login startup is disabled.')
        return
    current = lifecycle.state()
    if current.get('stopped'):
        print('HindsightKit remains stopped. Run hindsightkit start to resume.')
        return
    record = runtime.home() / 'installation.json'
    if not record.is_file():
        raise RuntimeError('No successful installation is recorded. Rerun the installer.')
    installed = json.loads(record.read_text(encoding='utf-8'))
    if (not isinstance(installed, dict) or installed.get('schema') != 1 or
            installed.get('mode') not in {'full', 'server-only', 'client-only'}):
        raise RuntimeError('Invalid installation mode. Rerun the installer.')
    mode = installed['mode']
    if mode != 'client-only':
        from hindsightkit.sharing.remote import resume
        try:
            services.start_local()
        finally:
            if lifecycle.state().get('stopped'):
                services.stop_profile_services(database=True)
        if lifecycle.state().get('stopped'):
            return
        resume()
    elif not current.get('disconnected') and connection.config_path().is_file():
        from hindsightkit.sharing.remote import prepare_client
        prepare_client(connection.load())
    else:
        print('Client is not connected. Run hindsightkit connect when ready.')
