"""Read coding-client and official server profile configuration."""
import os
from pathlib import Path

PROFILE = 'hindsightkit'


def config_path() -> Path:
    return Path(os.environ.get('HINDSIGHT_CONFIG', Path.home() / '.hindsight/coding-agent.json'))


def client_mode(config: dict) -> bool:
    return config.get('hindsightkit', {}).get('mode') == 'client'


def profile_config():
    from hindsight_embed.profile_manager import ProfileManager
    manager = ProfileManager()
    config = manager.load_profile_config(PROFILE)
    if not config:
        raise RuntimeError('HindsightKit is not configured. Run the release installer first.')
    return config, manager.resolve_profile_paths(PROFILE)
