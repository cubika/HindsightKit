"""Public command-line interface."""
import argparse
import sys
from hindsightkit import services
from hindsightkit.platform import runtime as runtime_env


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(description='Local Hindsight memory for Copilot Chat and CLI.')
    sub = parser.add_subparsers(dest='command', required=True)
    descriptions = {
        'start': 'Start local services and resume this client.',
        'stop': 'Stop local services and pause memory on this computer.',
        'status': 'Show local services and the selected client connection.',
        'clients': 'List devices registered with the memory server.',
        'ui': 'Start local services and open the dashboard.',
        'connectors': 'Open optional connector settings on this server.',
    }
    for command, description in descriptions.items():
        command_parser = sub.add_parser(command, help=description, description=description)
        if command == 'status':
            command_parser.add_argument('--test-memory', action='store_true',
                                        help='Also write and recall temporary local memory (uses Copilot allowance).')
    memory_parser = sub.add_parser('memory', help='Enable, disable, or inspect memory for this local Git repository.')
    memory_parser.add_argument('action', choices=['on', 'off', 'status'])
    startup_parser = sub.add_parser('startup', help='Enable, disable, or inspect automatic startup after Windows sign-in.')
    startup_parser.add_argument('action', choices=['on', 'off', 'status'])
    share_parser = sub.add_parser('share', help='After installation, prepare a connection code for another computer.')
    share_parser.add_argument('--relay', action='store_true', help='Enable a private relay for computers that cannot connect directly.')
    share_parser.add_argument('--address', help='Direct HTTP(S) address that the other computer can reach.')
    sub.add_parser('unshare', help='Disconnect remote clients and disable direct and relay sharing.')
    connect_parser = sub.add_parser('connect', help='Connect this installed client to another computer, or restore local memory.')
    destination = connect_parser.add_mutually_exclusive_group()
    destination.add_argument('--server', help='Direct server address; its key is requested separately.')
    destination.add_argument('--local', action='store_true', help='Use this computer\'s existing local memory server.')
    connect_parser.add_argument('--api-key-env', help='Read the key for --server from an environment variable.')
    for remote_parser in (share_parser, connect_parser):
        remote_parser.add_argument('--relay-provider', choices=['microsoft', 'github'],
                                   help='Account type for private relay login; prompts when sign-in is needed.')
    # Installed integrations keep their private entry points out of user help.
    if argv[:1] in (['mcp'], ['hook'], ['startup-run']):
        internal = argparse.ArgumentParser()
        internal.add_argument('command', choices=['mcp', 'hook', 'startup-run'])
        if argv[0] == 'mcp':
            internal.add_argument('--context', choices=['cli', 'vscode'], required=True)
        elif argv[0] == 'hook':
            internal.add_argument('event', choices=['sessionStart', 'userPromptTransformed', 'agentStop'])
        parser = internal
    args = parser.parse_args(argv)
    try:
        runtime_env.prepare_env()
        if args.command in {'startup', 'startup-run'}:
            from hindsightkit.setup import startup
            startup.run() if args.command == 'startup-run' else startup.command(args.action)
        elif args.command == 'memory':
            from hindsightkit.memory.control import command
            command(args.action)
        elif args.command in {'share', 'connect'}:
            from hindsightkit.sharing import remote
            getattr(remote, args.command)(args)
        elif args.command == 'unshare':
            from hindsightkit.sharing.remote import unshare
            unshare()
        elif args.command == 'mcp':
            from hindsightkit.mcp import serve
            serve(args.context)
        elif args.command == 'hook':
            from hindsightkit.hooks import run as run_hook
            run_hook(args.event)
        elif args.command == 'status':
            return 0 if services.status(test_memory=args.test_memory) else 1
        else:
            getattr(services, args.command)()
        return 0
    except Exception as exc:
        detail = str(exc).strip() or type(exc).__name__
        print(f'HindsightKit: {detail}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
