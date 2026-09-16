"""Install and operate official Hindsight components."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import uuid
import webbrowser

VERSION = '0.10.0'
DEFAULT_MODEL = 'gpt-6-astra'
DEFAULT_REASONING_EFFORT = 'xhigh'
PROFILE = 'provenloop'
PACKAGE = Path(__file__).parent


def run(command, *, cwd=None, capture=False, env=None):
    result = subprocess.run(
        [str(value) for value in command], cwd=cwd, env=env, check=True,
        text=True, encoding='utf-8', errors='replace', capture_output=capture,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0,
    )
    return result.stdout.strip() if capture else ''


def home() -> Path:
    return Path(os.environ.get('PROVENLOOP_HOME', Path.home() / '.provenloop')).resolve()


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
    return home() / 'runtime'


def install_node_packages():
    directory = runtime()
    directory.mkdir(parents=True, exist_ok=True)
    lock = PACKAGE / 'package-lock.json'
    stamp = directory / '.installed-lock'
    digest = hashlib.sha256(lock.read_bytes()).hexdigest()
    if stamp.is_file() and stamp.read_text() == digest and (directory / 'node_modules/@vectorize-io/hindsight-control-plane/bin/cli.js').is_file():
        return
    for name in ['package.json', 'package-lock.json']:
        source = PACKAGE / name
        if source.is_file():
            shutil.copyfile(source, directory / name)
    print('Installing official Copilot integration and Hindsight UI...', flush=True)
    run(npm() + ['ci', '--omit=dev', '--no-audit', '--no-fund', '--registry', 'https://registry.npmjs.org'], cwd=directory)
    stamp.write_text(digest)


async def copilot_authenticated():
    from copilot import CopilotClient
    with tempfile.TemporaryDirectory(prefix='provenloop-auth-') as temp:
        account = Path.home() / '.copilot/config.json'
        if account.is_file():
            shutil.copyfile(account, Path(temp) / 'config.json')
        client = CopilotClient(base_directory=temp, working_directory=temp, use_logged_in_user=True)
        try:
            await asyncio.wait_for(client.start(), timeout=90)
            auth = await asyncio.wait_for(client.get_auth_status(), timeout=30)
            return auth.isAuthenticated
        finally:
            await asyncio.wait_for(client.stop(), timeout=15)


def ensure_copilot():
    command = copilot_command()
    if command is None:
        print('Installing the official Copilot CLI...', flush=True)
        run(npm() + ['install', '--prefix', home() / 'copilot', '--no-audit', '--no-fund',
                     '--registry', 'https://registry.npmjs.org', '@github/copilot@1.0.85'])
        command = copilot_command()
    print('Checking Copilot authentication...', flush=True)
    if asyncio.run(copilot_authenticated()):
        return
    print('Sign in through Copilot to finish setup. Credentials stay with Copilot.', flush=True)
    # Native login owns the browser/device flow and credential storage.
    run(command + ['login'])
    if not asyncio.run(copilot_authenticated()):
        raise RuntimeError('Copilot login did not complete. Run copilot login, then rerun setup.')


def copilot_command():
    binary = shutil.which('copilot')
    if binary:
        if Path(binary).suffix.lower() in {'.cmd', '.ps1'}:
            loader = Path(binary).parent / 'node_modules/@github/copilot/npm-loader.js'
            if loader.is_file():
                return [node(), loader]
        else:
            return [binary]
    loader = home() / 'copilot/node_modules/@github/copilot/npm-loader.js'
    return [node(), loader] if loader.is_file() else None


def integrate(action, *args):
    run([node(), PACKAGE / 'integrate.mjs', runtime(), action, *args])


def project_identity(project: Path) -> tuple[Path, str]:
    project = project.resolve(strict=True)
    if not project.is_dir():
        raise ValueError('Project must be a directory.')
    root = project
    try:
        common = run(['git', '-C', project, 'rev-parse', '--path-format=absolute', '--git-common-dir'], capture=True)
        if common:
            root = Path(common).resolve().parent
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    identity = os.path.normcase(str(root))
    digest = hashlib.sha256(identity.encode()).hexdigest()[:12]
    return root, 'provenloop-' + digest


def backup(path: Path):
    saved = path.with_name(path.name + '.provenloop-backup')
    if path.is_file() and not saved.exists():
        shutil.copy2(path, saved)


def profile_config():
    from hindsight_embed.profile_manager import ProfileManager
    manager = ProfileManager()
    config = manager.load_profile_config(PROFILE)
    if not config:
        raise RuntimeError('ProvenLoop is not configured. Run setup first.')
    return config, manager.resolve_profile_paths(PROFILE)


def configure_profile(args):
    from hindsight_embed.profile_manager import ProfileManager
    manager = ProfileManager()
    existing = manager.load_profile_config(PROFILE)
    if existing:
        if args.port and manager.resolve_profile_paths(PROFILE).port != args.port:
            raise RuntimeError('The profile uses another port. Stop and edit the official profile before changing it.')
        if args.model and existing.get('HINDSIGHT_API_LLM_MODEL') != args.model:
            raise RuntimeError('The profile uses another model. Edit the official profile and restart.')
        if getattr(args, 'reasoning_effort', None) and existing.get('HINDSIGHT_API_LLM_REASONING_EFFORT') != args.reasoning_effort:
            raise RuntimeError('The profile uses another reasoning effort. Edit HINDSIGHT_API_LLM_REASONING_EFFORT in the official profile and restart.')
        if getattr(args, 'model_dir', None):
            selected = str(Path(args.model_dir).resolve(strict=True) / 'onnx/model.onnx')
            if existing.get('HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH') != selected:
                raise RuntimeError('The profile uses another embedding path. Edit its HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH and HINDSIGHT_API_EMBEDDINGS_ONNX_TOKENIZER_NAME_OR_PATH, then restart.')
        return
    config = {
        'HINDSIGHT_API_LLM_PROVIDER': 'github-copilot',
        'HINDSIGHT_API_LLM_MODEL': args.model or DEFAULT_MODEL,
        'HINDSIGHT_API_LLM_REASONING_EFFORT': getattr(args, 'reasoning_effort', None) or DEFAULT_REASONING_EFFORT,
        'HINDSIGHT_API_DATABASE_SCHEMA': 'public',
        'HINDSIGHT_API_HOST': '127.0.0.1',
        'HINDSIGHT_API_EMBEDDINGS_PROVIDER': 'onnx',
        'HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_ID': 'intfloat/multilingual-e5-small',
        'HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS': '384',
        'HINDSIGHT_API_RERANKER_PROVIDER': 'rrf',
        'HINDSIGHT_API_WORKER_ID': PROFILE,
        'HINDSIGHT_EMBED_API_VERSION': VERSION,
        'HINDSIGHT_EMBED_CP_VERSION': VERSION,
        'HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT': '0',
    }
    if args.model_dir:
        directory = Path(args.model_dir).resolve(strict=True)
        graph = directory / 'onnx/model.onnx'
        if not graph.is_file() or not (directory / 'tokenizer.json').is_file():
            raise ValueError('--model-dir must contain onnx/model.onnx and tokenizer.json for multilingual-e5-small.')
        config['HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH'] = str(graph)
        config['HINDSIGHT_API_EMBEDDINGS_ONNX_TOKENIZER_NAME_OR_PATH'] = str(directory)
    with socket.socket() as listener:
        try:
            listener.bind(('127.0.0.1', args.port or 9077))
        except OSError as exc:
            raise RuntimeError('The requested API port is already in use. Choose another --port.') from exc
    manager.create_profile(PROFILE, args.port or 9077, config)


def start():
    _, paths = profile_config()
    print('Starting Hindsight (first start downloads the database and embedding model)...', flush=True)
    run([executable('hindsight-embed'), '--profile', PROFILE, 'daemon', 'start'])
    os.environ['PATH'] = str(Path(node()).parent) + os.pathsep + os.environ['PATH']
    ui_env = os.environ.copy()
    # Upstream #4379: Next.js locale rewriting loops with a literal 127.0.0.1 hostname.
    ui_env['NODE_OPTIONS'] = (ui_env.get('NODE_OPTIONS', '') + ' --dns-result-order=ipv4first').strip()
    run([executable('hindsight-embed'), '--profile', PROFILE, 'ui', 'start', '--hostname', 'localhost'], cwd=runtime(), env=ui_env)
    ui_url = f'http://localhost:{paths.ui_port}'
    asyncio.run(check_ui(ui_url))
    return f'http://127.0.0.1:{paths.port}', ui_url


async def check_ui(url):
    import aiohttp
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        async with session.get(url + '/dashboard') as response:
            content = await response.text()
            if response.status != 200 or 'Hindsight' not in content:
                raise RuntimeError('Hindsight UI health passed but its dashboard did not load.')


async def check_memory(api_url: str):
    from hindsight_client import Hindsight
    bank = 'provenloop-check-' + uuid.uuid4().hex
    marker = 'PL-' + uuid.uuid4().hex[:10]
    client = Hindsight(base_url=api_url, timeout=180)
    error = None
    try:
        await client.aretain(
            bank_id=bank, content=f'The verification label for project Peregrine is {marker}.',
            document_id='setup-check',
        )
        recall = await client.arecall(bank_id=bank, query='What is the verification label for project Peregrine?')
        if marker not in recall.model_dump_json():
            raise RuntimeError('Retain completed but recall did not return the verification memory.')
        print('Memory check passed: Copilot inference, retain and recall.', flush=True)
    except Exception as exc:
        error = exc
        raise
    finally:
        try:
            await client.adelete_bank(bank_id=bank)
        except Exception:
            if error is None:
                raise
        finally:
            await client.aclose()


async def ensure_bank(api_url: str, bank: str):
    from hindsight_client import Hindsight
    client = Hindsight(base_url=api_url)
    try:
        # An empty official upsert creates the bank without changing existing settings.
        await client.acreate_bank(bank_id=bank)
    finally:
        await client.aclose()


def status():
    from hindsight_embed.daemon_embed_manager import DaemonEmbedManager
    _, paths = profile_config()
    manager = DaemonEmbedManager()
    healthy = manager.is_running(PROFILE)
    ui = manager.is_ui_running(PROFILE)
    print(f'Hindsight: {"running" if healthy else "stopped"} at http://127.0.0.1:{paths.port}')
    print(f'UI: {"running" if ui else "stopped"} at http://localhost:{paths.ui_port}')
    print(f'Profile: {paths.config}\nLog: {paths.log}')
    return healthy and ui


def setup(args):
    from hindsight_copilot.instructions import write_rule
    selected_home = os.environ.get('COPILOT_HOME')
    if selected_home and Path(selected_home).resolve() != (Path.home() / '.copilot').resolve():
        raise RuntimeError('This setup uses the default Copilot profile. Unset COPILOT_HOME before setup.')
    project = Path(args.project).resolve(strict=True)
    root, bank = project_identity(project)
    install_node_packages()
    ensure_copilot()
    configure_profile(args)
    _, paths = profile_config()
    api_url = f'http://127.0.0.1:{paths.port}'
    mcp = project / '.vscode/mcp.json'
    cli_mcp = Path.home() / '.copilot/mcp-config.json'
    coding_config = Path(os.environ.get('HINDSIGHT_CONFIG', Path.home() / '.hindsight/coding-agent.json'))
    integrate('preflight', mcp, cli_mcp, coding_config, api_url, root, bank)
    api_url, ui_url = start()
    asyncio.run(check_memory(api_url))
    asyncio.run(ensure_bank(api_url, bank))
    print('Connecting Copilot Chat and CLI to the same project memory...', flush=True)
    integrate('config', coding_config, root, bank, api_url)
    backup(cli_mcp)
    backup(Path.home() / '.copilot/hooks/hindsight-coding-agents.json')
    integrate('install-cli', Path.home(), coding_config, api_url, node())
    integrate('vscode', mcp, api_url, bank)
    instructions = project / '.github/copilot-instructions.md'
    backup(instructions)
    write_rule(instructions)
    integrate('check', mcp, coding_config, root, bank, api_url)
    from .command import install
    launcher = install(home() / 'bin')
    print(f'\nSetup complete. Project: {project}\nMemory bank: {bank}\nUI: {ui_url}')
    print(f'Command installed: {launcher}. Open a new terminal to use provenloop.')
    print('Reload VS Code and enable its Hindsight MCP server. Start a new Copilot CLI session.')
    if not args.no_open:
        webbrowser.open(ui_url)


def main(argv=None):
    prepare_env()
    parser = argparse.ArgumentParser(description='Local Hindsight memory for Copilot Chat and CLI.')
    sub = parser.add_subparsers(dest='command', required=True)
    setup_parser = sub.add_parser('setup', help='Install, start, verify and connect official components.')
    setup_parser.add_argument('--project', default=os.getcwd())
    setup_parser.add_argument('--port', type=int)
    setup_parser.add_argument('--model', help=f'Copilot model for new profiles (default: {DEFAULT_MODEL}).')
    setup_parser.add_argument('--reasoning-effort', choices=['low', 'medium', 'high', 'xhigh', 'max'],
                              help=f'Reasoning effort for new profiles (default: {DEFAULT_REASONING_EFFORT}).')
    setup_parser.add_argument('--model-dir', help='Existing official multilingual-e5-small ONNX model directory.')
    setup_parser.add_argument('--no-open', action='store_true')
    for command in ['start', 'stop', 'status', 'check', 'ui']:
        sub.add_parser(command)
    copilot_parser = sub.add_parser('copilot', help='Launch the installed official Copilot CLI.')
    copilot_parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        if args.command == 'setup':
            setup(args)
        elif args.command == 'start':
            start()
        elif args.command == 'stop':
            run([executable('hindsight-embed'), '--profile', PROFILE, 'ui', 'stop'])
            run([executable('hindsight-embed'), '--profile', PROFILE, 'daemon', 'stop'])
        elif args.command == 'status':
            return 0 if status() else 1
        elif args.command == 'check':
            _, paths = profile_config()
            asyncio.run(check_memory(f'http://127.0.0.1:{paths.port}'))
        elif args.command == 'ui':
            _, paths = profile_config()
            webbrowser.open(f'http://localhost:{paths.ui_port}')
        elif args.command == 'copilot':
            command = copilot_command()
            if command is None:
                raise RuntimeError('Run setup to install Copilot CLI.')
            arguments = args.arguments[1:] if args.arguments[:1] == ['--'] else args.arguments
            return subprocess.call([str(value) for value in command + arguments])
        return 0
    except Exception as exc:
        print(f'ProvenLoop: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
