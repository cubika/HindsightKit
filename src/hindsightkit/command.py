"""Expose the installed Python console entry point on the Windows user PATH."""
import ctypes
import os
from pathlib import Path
import shutil
import sys


def prepend_path(value: str, directory: Path) -> str:
    target = os.path.normcase(os.path.normpath(str(directory)))
    entries = value.split(os.pathsep) if value else []
    return os.pathsep.join([str(directory)] + [
        entry for entry in entries
        if os.path.normcase(os.path.normpath(os.path.expandvars(entry))) != target
    ])


def install(directory: Path) -> Path:
    if sys.platform != 'win32':
        raise RuntimeError('Command registration currently supports Windows only.')
    import winreg

    source = Path(sys.executable).parent / 'hindsightkit.exe'
    target = directory / 'hindsightkit.exe'
    directory.mkdir(parents=True, exist_ok=True)
    if not target.is_file() or source.read_bytes() != target.read_bytes():
        shutil.copy2(source, target)

    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, 'Environment', 0,
                           winreg.KEY_QUERY_VALUE | winreg.KEY_SET_VALUE) as key:
        try:
            original, kind = winreg.QueryValueEx(key, 'Path')
        except FileNotFoundError:
            original, kind = '', winreg.REG_EXPAND_SZ
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
