"""Run native commands with bounded, redacted failure output."""
import os
from pathlib import Path
import subprocess
import tempfile


def execute(command, *, env=None, input=None, allowed=(0,), sensitive=()):
    # On Windows postgres children can inherit pg_ctl's output handles. Files avoid
    # waiting forever for pipe EOF after pg_ctl itself has already exited.
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(
            [str(item) for item in command], input=input, env=env, stdout=output, stderr=output,
            text=True, encoding='utf-8', errors='replace', timeout=1800,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
        )
        output.seek(0)
        result.stdout = output.read().decode('utf-8', errors='replace')
        result.stderr = ''
    if result.returncode not in allowed:
        detail = (result.stderr or result.stdout)[-3000:]
        for value in sensitive:
            if value:
                detail = detail.replace(value, '[redacted]')
        raise RuntimeError(f'{Path(command[0]).name} failed ({result.returncode}): {detail}')
    return result
