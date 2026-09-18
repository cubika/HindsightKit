"""Repository-local switches for the managed memory integrations."""
from dataclasses import dataclass
import os
from pathlib import Path
import subprocess
import uuid

from filelock import FileLock

from hindsightkit.memory.api import scope_for


ENABLED = "hindsightkit.memory.enabled"
EPOCH = "hindsightkit.memory.captureepoch"


@dataclass(frozen=True)
class State:
    enabled: bool = True
    capture_epoch: str = ""


def git(repository, *arguments, missing_ok=False):
    result = subprocess.run(
        ["git", "-C", str(repository), *arguments], capture_output=True,
        text=True, encoding="utf-8", timeout=5,
        env={key: value for key, value in os.environ.items() if not key.startswith("GIT_")},
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if result.returncode != 0 and not (missing_ok and result.returncode == 1):
        raise RuntimeError("Cannot read or update the repository memory setting.")
    return result


def state(repository: str | None) -> State:
    if repository is None:
        return State()
    # One Git read observes both keys from the same config snapshot. --local
    # keeps global and per-worktree overrides out of this repository switch.
    result = git(repository, "config", "--local", "--null", "--get-regexp",
                 r"^hindsightkit\.memory\.(enabled|captureepoch)$", missing_ok=True)
    values = {}
    for entry in result.stdout.split("\0"):
        if entry:
            key, separator, value = entry.partition("\n")
            values[key] = value if separator else "true"
    value = values.get(ENABLED, "true").lower()
    if value in {"true", "yes", "on"}:
        enabled = True
    elif value in {"", "false", "no", "off"}:
        enabled = False
    else:
        try:
            enabled = int(value) != 0
        except ValueError as exc:
            raise ValueError("Invalid repository memory setting; run hindsightkit memory on or off.") from exc
    return State(enabled, values.get(EPOCH, ""))


def command(action: str, directory=None):
    repository = scope_for(directory or Path.cwd()).repository
    if repository is None:
        raise ValueError("Run hindsightkit memory inside a Git repository.")
    if action != "status":
        common = git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.strip()
        with FileLock(str(Path(common) / "hindsightkit-memory.lock"), timeout=5):
            try:
                current = state(repository)
            except ValueError:
                current = State(False)
            if action == "off" or not current.enabled:
                # Disable first, then rotate capture history. Enable only after
                # rotation, so interrupted commands cannot resume old transcripts.
                if action == "off":
                    git(repository, "config", "--local", "--replace-all", ENABLED, "false")
                git(repository, "config", "--local", "--replace-all", EPOCH, uuid.uuid4().hex)
                if action == "on":
                    git(repository, "config", "--local", "--replace-all", ENABLED, "true")
    current = state(repository)
    print(f"Repository memory: {'on' if current.enabled else 'off'} ({repository})")
    from hindsightkit.platform import lifecycle
    service = lifecycle.state()
    if service.get('stopped'):
        print('HindsightKit is stopped. Run hindsightkit start to use memory.')
        return
    if service.get('disconnected'):
        print('This client is disconnected. Run hindsightkit connect to use memory.')
        return
    if action == "on" and current.capture_epoch:
        print("Start a new Copilot CLI session to resume automatic session saving. MCP and recall resume immediately.")
