# Development

- Keep ProvenLoop a setup wrapper around pinned official Hindsight components. Do not add a memory database, learning pipeline, connector framework, or forked engine.
- Maintain one current implementation. Remove superseded paths and unnecessary compatibility fallbacks when replacing behavior.
- Work in a dedicated worktree from local master: `git worktree add -b codex/<task> .runtime/worktrees/<task> master`. Keep the primary checkout on master and preserve unrelated changes.
- Setup: `./setup.ps1` on Windows. Test: `.venv/Scripts/python.exe -m unittest discover -s tests -v`.
- Use the official installers/SDKs. Preserve user configuration and validate conflicts before registering integrations.
- Live tests use disposable banks and must remove them. `tests/live_memory.py` uses Copilot allowance and restarts only the ProvenLoop profile.
- Read logs and run the relevant checks before claiming setup works. Keep generated runtime files and credentials out of Git.
- Before merging, integrate any newer master changes into the task branch, resolve conflicts there, and rerun affected checks. Commit and merge with `git merge --ff-only codex/<task>` from the primary checkout. Push only when requested.
- After confirming the branch is merged and the worktree is clean, remove it with `git worktree remove <path>` and delete the branch with `git branch -d codex/<task>`. Verify the absolute path is this task's worktree inside the workspace; remove dependency junctions without traversing their targets. Never force cleanup of unmerged work.
- Report the commit, validation results, and change totals. If validation is blocked, retain the worktree and report the unresolved issue.
