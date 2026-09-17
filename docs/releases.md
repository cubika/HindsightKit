# Release installation and publishing

Open Releases in the GitHub repository you are using. A published version includes a PowerShell command that downloads its installer and installs the server and local coding integrations together. Git must already be available for coding integrations. Copilot login and VS Code's MCP consent still require the user.

The installer accepts ServerOnly (false by default), Server, Model, ReasoningEffort, ModelDir, Port, ApiKeyEnv, NoOpen, and InstallDir. The generated QUICKSTART.md includes commands for local installation, a dedicated server, and a remote client.

Application files go into `%LOCALAPPDATA%\HindsightKit\versions\<version>-<package-hash>`. Python is managed under `%LOCALAPPDATA%\HindsightKit\python`. Dependencies and editor registrations refer to these installed paths, so a downloaded or cloned development repository can be removed. Memory and settings stay in their existing `~/.hindsightkit` and `~/.hindsight` locations.

Rerun a version's installer to retry setup. Run a newer version's installer to upgrade. The installer checks the application archive's SHA256 before extraction, keeps version directories separate, and preserves existing data and settings. Setup restarts this installation's server processes to load the selected version. Close coding sessions before upgrading and reload VS Code afterward. Old version directories remain available; automatic pruning and database downgrades are not implemented. Client-only setup does not install a database or model. Release installers download a verified PostgreSQL/pgvector package and do not install a compiler.

Retrying also checks the installed application files. If those files were edited or damaged, setup stops and preserves them; choose a new InstallDir to install a clean copy. Dependency downloads can be retried in the same directory.

## Two remotes

The same source commit is pushed to origin and enterprise. README content is identical in both repositories. It directs readers to the current repository's Releases instead of embedding one owner's download URL.

Each repository runs its own release workflow. The packager uses `GITHUB_SERVER_URL` and `GITHUB_REPOSITORY` to generate install.ps1, QUICKSTART.md, and release notes for that repository. All downloads inside an installer use the version tag that produced it. The generated URL is stored in the installer; it does not depend on the user's Git remotes or working directory.

Pushing a branch alone does not publish an installer. Push a version tag to each intended remote, or run the workflow manually for a tag already present there. Each workflow creates a draft prerelease. Review its assets and publish that draft in the corresponding repository. Both repositories must permit Actions and release uploads. Public release instructions use anonymous `irm`. Private and internal releases generate authenticated GitHub CLI download commands; users sign in with an account that can read that repository. The installer uses the same account to download both application and database assets.

If an interrupted upload leaves a draft, inspect that draft and remove it before rerunning the workflow for the same tag. The workflow does not overwrite an existing release. Use a new version tag for a release that has already been published.

## Build and release

1. Update the project version and dependency locks as needed. Create a matching tag such as v0.1.0.
2. Push the commit and tag to the intended remote. Release Windows installer also supports manual dispatch with an existing tag.
3. The Windows job installs locked dependencies, runs the test suite, builds official PostgreSQL/pgvector with Microsoft's toolchain, and checks a disposable database. It makes no Copilot model calls.
4. Packaging produces the application ZIP, PostgreSQL ZIP, install.ps1, QUICKSTART.md, release notes, and SHA256SUMS. The publish job uploads these to a draft release in that same repository.
5. Validate the public download path in a test repository before publishing the production releases. Draft assets are private, so their generated anonymous installer command cannot yet download them. A separate public test release gives the same workflow and installer a usable URL. On a clean x64 Windows machine with Copilot access, verify local installation, ServerOnly, remote client setup, repeat installation, and an upgrade preserving a test memory. Record actual results before describing a release as verified.

The PostgreSQL package contains the official distribution, the unmodified pgvector extension compiled for it, app-local Microsoft runtime DLLs, file hashes, and upstream notices. It never contains a database cluster, credentials, logs, or a developer's Python environment. Source installations continue to support building from the pinned upstream archives.

For a local packaging check, use an existing verified PostgreSQL distribution:

```powershell
.venv/Scripts/python.exe distribution/package_release.py --version v0.1.0 --repository OWNER/HindsightKit --server-url https://github.com --postgres-directory C:\path\to\server-18.6 --output dist/release
```

The output directory must be empty. The command packages files only; it does not publish a release or touch a database. The installer template in distribution/install.ps1 is not a standalone source installer. Use setup.ps1 from a checkout or the generated install.ps1 from a release.

## Local verification, September 17, 2026

The integrated suite passed 222 tests, including PowerShell pipe execution, both roles, repeat installation, upgrades into separate version directories, file integrity failures, and repository-specific packaging. The workflow YAML and PowerShell syntax checks passed. Both configured GitHub repositories produced their own fixed-tag installation commands and checksum files from the same source.

PostgreSQL and pgvector were rebuilt from the checked upstream archives. The first attempt to package an older local build found a developer path in vector.dll; compiler path mapping removed it from the rebuilt binary. Both the rebuilt distribution and the packaged ZIP passed disposable database checks for extensions, restricted permissions, restart, and persistence across repeated setup. The packaged installation used a checked local download cache and no compiler. Test databases were removed; no model calls or mailbox reads were made.

GitHub Actions execution, public release downloads, and a complete installation with fresh Python/npm/model downloads and Copilot login on a clean machine remain unverified. The local checks do not establish that those external steps have passed.

## Connection commands and authenticated releases

The final local suite passed 270 tests. Separate share/connect commands leave the installer unchanged. Tests cover direct discovery, invalid keys and certificates, failed-connection rollback, background process ownership, stable relay ports, and restoration of local memory. Private/internal release instructions and both authenticated asset download paths passed fixture checks.

A disposable private Microsoft tunnel forwarded a synthetic HTTP response through the real relay service on this machine. The managed host/client processes started without visible terminals, reused their saved instance, stopped cleanly, and restarted on the same local port. The CLI selected another forwarding port when the server port was occupied; the stable proxy continued to work. All test tunnels and workers were removed. This did not read or forward existing memory. It validates the real relay service and local wrapper, not a second machine's account or network policy.
