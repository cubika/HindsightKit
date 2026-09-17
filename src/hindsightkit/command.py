"""Expose the installed Python console entry point on the Windows user PATH."""
import ctypes
import os
from pathlib import Path
import shutil
import sys

SHORT_COMMAND = 'hk'


def prepend_path(value: str, directory: Path) -> str:
    target = os.path.normcase(os.path.normpath(str(directory)))
    entries = value.split(os.pathsep) if value else []
    return os.pathsep.join([str(directory)] + [
        entry for entry in entries
        if os.path.normcase(os.path.normpath(os.path.expandvars(entry))) != target
    ])


def install_short_command(source: Path, directory: Path, search_path: str,
                          previous: bytes | None = None) -> Path | None:
    """Install hk only when it does not hide or replace another command."""
    target = directory / (SHORT_COMMAND + '.exe')
    payload = source.read_bytes()
    owned = {payload} | ({previous} if previous is not None else set())
    extensions = {'', '.exe', '.com', '.bat', '.cmd', '.ps1'}
    extensions.update(ext.lower() for ext in os.environ.get('PATHEXT', '').split(';') if ext)
    directories = [directory, Path.cwd()] + [
        Path(os.path.expandvars(item.strip('"'))) for item in search_path.split(os.pathsep) if item
    ]
    conflict = os.environ.get('HINDSIGHTKIT_HK_CONFLICT')
    for folder in dict.fromkeys(directories):
        for extension in sorted(extensions):
            candidate = folder / (SHORT_COMMAND + extension)
            try:
                if not candidate.exists() and not candidate.is_symlink():
                    continue
                ours = (candidate.is_file() and not candidate.is_symlink() and
                        any(candidate.stat().st_size == len(content) for content in owned) and
                        candidate.read_bytes() in owned)
            except OSError:
                ours = False
            if not ours:
                conflict = str(candidate)
                break
        if conflict:
            break
    if conflict:
        print(f'Skipped hk: already used by {conflict}. Use hindsightkit.')
        return None
    try:
        if not target.exists():
            # Exclusive creation protects a command created since the conflict check.
            with target.open('xb') as stream:
                stream.write(payload)
        elif target.read_bytes() in owned:
            if target.read_bytes() != payload:
                target.write_bytes(payload)
        else:
            print('Skipped hk: the command changed during setup. Use hindsightkit.')
            return None
    except OSError as exc:
        print(f'Skipped hk: could not install the optional command ({exc}). Use hindsightkit.')
        return None
    print('Short command installed: hk (same commands as hindsightkit).')
    return target


def install(directory: Path) -> Path:
    if sys.platform != 'win32':
        raise RuntimeError('Command registration currently supports Windows only.')
    import winreg

    source = Path(sys.executable).parent / 'hindsightkit.exe'
    target = directory / 'hindsightkit.exe'
    previous = target.read_bytes() if target.is_file() else None
    directory.mkdir(parents=True, exist_ok=True)
    if not target.is_file() or source.read_bytes() != target.read_bytes():
        shutil.copy2(source, target)

    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, 'Environment', 0,
                           winreg.KEY_QUERY_VALUE | winreg.KEY_SET_VALUE) as key:
        try:
            original, kind = winreg.QueryValueEx(key, 'Path')
        except FileNotFoundError:
            original, kind = '', winreg.REG_EXPAND_SZ
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                                r'SYSTEM\CurrentControlSet\Control\Session Manager\Environment') as system:
                system_path = winreg.QueryValueEx(system, 'Path')[0]
            search_path = os.pathsep.join([os.environ.get('PATH', ''), original, system_path])
            install_short_command(source, directory, search_path, previous)
        except OSError as exc:
            print(f'Skipped hk: could not check existing commands ({exc}). Use hindsightkit.')
        updated = prepend_path(original, directory)
        if updated != original:
            winreg.SetValueEx(key, 'Path', 0, kind, updated)
    os.environ['PATH'] = prepend_path(os.environ.get('PATH', ''), directory)
    # Let Explorer and newly opened terminals pick up the user environment.
    result = ctypes.c_size_t()
    ctypes.windll.user32.SendMessageTimeoutW(
        0xFFFF, 0x001A, 0, ctypes.c_wchar_p('Environment'), 0x0002, 1000,
        ctypes.byref(result),
    )
    return target
