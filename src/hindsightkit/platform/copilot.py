"""Use the installed official Copilot CLI for SDK clients."""
import os
from pathlib import Path
import tempfile

from hindsightkit.platform import runtime


def _saved_path():
    return runtime.home() / 'copilot-path.txt'


def _safe_path(value):
    return (bool(value) and not any(ord(char) < 32 for char in value)
            and Path(value).suffix.lower() not in {'.cmd', '.bat', '.ps1'})


def restore():
    """Restore a previously checked CLI without output or executable probes."""
    explicit = os.environ.get('COPILOT_CLI_PATH')
    if explicit:
        return explicit
    try:
        value = _saved_path().read_text(encoding='utf-8').strip()
        if not _safe_path(value) or not Path(value).is_absolute() or not Path(value).is_file():
            return None
    except OSError:
        return None
    os.environ['COPILOT_CLI_PATH'] = value
    return value


def select(command):
    """Persist an entry point already validated by find_copilot."""
    explicit = os.environ.get('COPILOT_CLI_PATH')
    if explicit:
        return explicit
    value = str(Path(command[-1]).resolve())
    if not _safe_path(value):
        raise RuntimeError('Copilot SDK requires a native executable or its official JavaScript entry point.')
    saved = _saved_path()
    saved.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=saved.parent,
                                         prefix='copilot-path-', suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(value + '\n')
        os.replace(temporary, saved)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    os.environ['COPILOT_CLI_PATH'] = value
    return value


def prepare(config):
    """Select a local CLI before starting a profile that uses GitHub Copilot."""
    provider = os.environ.get('HINDSIGHT_API_LLM_PROVIDER', config.get('HINDSIGHT_API_LLM_PROVIDER', ''))
    external = os.environ.get('HINDSIGHT_API_LLM_BASE_URL', config.get('HINDSIGHT_API_LLM_BASE_URL', ''))
    # The official provider treats this old template value as a local runtime.
    external = external.strip().rstrip('/')
    if provider.lower() != 'github-copilot' or external not in {'', 'https://api.openai.com/v1'}:
        return None
    from hindsightkit.setup.installer import copilot_message, find_copilot
    selected = restore()
    if not selected:
        copilot_message('Checking the installed Copilot CLI for Hindsight...')
        found = find_copilot()
        if found is None:
            raise RuntimeError('No installed GitHub Copilot CLI was found. Rerun the release installer.')
        selected = select(found[0])
    copilot_message(f'Copilot SDK: using {selected}.')
    return selected
