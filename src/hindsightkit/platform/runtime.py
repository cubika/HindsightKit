"""Paths and official runtime command helpers."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from hindsightkit.platform import config
from hindsightkit.platform.config import PROFILE
VERSION = '0.10.0'
DEFAULT_MODEL = 'gpt-6-astra'
DEFAULT_REASONING_EFFORT = 'xhigh'
PACKAGE = Path(__file__).resolve().parents[1]


def run(command, *, cwd=None, capture=False, env=None):
    result = subprocess.run(
        [str(value) for value in command], cwd=cwd, env=env, check=True,
        text=True, encoding='utf-8', errors='replace', capture_output=capture,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0,
    )
    return result.stdout.strip() if capture else ''


def home() -> Path:
    return Path(os.environ.get('HINDSIGHTKIT_HOME', Path.home() / '.hindsightkit')).resolve()


def scripts() -> Path:
    return Path(sys.executable).parent


def executable(name: str) -> str:
    suffix = '.exe' if sys.platform == 'win32' else ''
    local = scripts() / (name + suffix)
    return str(local) if local.is_file() else name


def prepare_env():
    os.environ.update(PYTHONUTF8='1', PYTHONIOENCODING='utf-8', PYTHONUNBUFFERED='1')
    os.environ['PATH'] = str(scripts()) + os.pathsep + os.environ['PATH']
    os.environ.setdefault('HINDSIGHT_EMBED_DAEMON_STARTUP_TIMEOUT', '600')
    os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
    saved = home() / 'node-path.txt'
    if saved.is_file():
        os.environ['PATH'] = str(Path(saved.read_text().strip()).parent) + os.pathsep + os.environ['PATH']


def node() -> str:
    binary = shutil.which('node')
    saved = home() / 'node-path.txt'
    if not binary and saved.is_file():
        candidate = saved.read_text(encoding='utf-8').strip()
        binary = candidate if Path(candidate).is_file() else None
    if not binary:
        raise RuntimeError('Node.js 22+ is required. Run setup.ps1 to install prerequisites.')
    major = int(run([binary, '--version'], capture=True).lstrip('v').split('.')[0])
    if major < 22:
        raise RuntimeError('Node.js 22+ is required.')
    saved.parent.mkdir(parents=True, exist_ok=True)
    saved.write_text(binary, encoding='utf-8')
    return binary


def npm() -> list[str]:
    # Invoke npm's JS entry directly to avoid Windows .cmd shell quoting.
    root = Path(node()).resolve().parent
    for path in [root / 'node_modules/npm/bin/npm-cli.js', root.parent / 'lib/node_modules/npm/bin/npm-cli.js']:
        if path.is_file():
            return [node(), str(path)]
    raise RuntimeError('Cannot find npm beside Node.js. Install a standard Node.js distribution.')


def runtime() -> Path:
    path = config.config_path()
    if path.is_file() and config.client_mode(json.loads(path.read_text(encoding='utf-8'))):
        return home() / 'client-runtime'
    return home() / 'runtime'


def backup(path: Path):
    saved = path.with_name(path.name + '.hindsightkit-backup')
    if path.is_file() and not saved.exists():
        shutil.copy2(path, saved)
