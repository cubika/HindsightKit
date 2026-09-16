# Development

- Keep ProvenLoop a setup wrapper around pinned official Hindsight components. Do not add a memory database, learning pipeline, connector framework, or forked engine.
- Setup: `./setup.ps1` on Windows. Test: `.venv/Scripts/python.exe -m unittest discover -s tests -v`.
- Use the official installers/SDKs. Preserve user configuration and validate conflicts before registering integrations.
- Live tests use disposable banks and must remove them. `tests/live_memory.py` uses Copilot allowance and restarts only the ProvenLoop profile.
- Read logs and run the relevant checks before claiming setup works. Keep generated runtime files and credentials out of Git.
