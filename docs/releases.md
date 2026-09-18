# Release maintenance

This guide is for maintainers. Users should follow [installation](installation.md) and copy the command from their published release page. Validation results and publication status are recorded in [release validation](release-validation.md).

## Validate a candidate

1. Update the project version and dependency locks. The candidate version must match `pyproject.toml`, for example `v0.1.2` for `0.1.2`.
2. Push the candidate branch, then manually run the release workflow against that branch with the version in its `tag` input. Manual dispatch checks out the selected workflow ref. It uploads artifacts only and does not create a release or publish a tag.
3. Review the Windows test and packaging results, then download the `windows-release` artifact for installation acceptance. Keep the candidate unpublished until those checks pass.

The Windows job installs locked test dependencies, runs the repository suite, builds the pinned PostgreSQL/pgvector distribution, and checks a disposable database. It also builds the Python wheel bundle and checks fresh client and server environments with package-index access disabled. After packaging, it verifies the release checksums, assembles each application with its declared dependency components, and runs offline Python and Node installation checks. These CI steps do not make Copilot model calls.

The offline Python check uses separate empty caches, an unreachable proxy, `--offline`, `--no-index`, and `--require-hashes`. It imports the installed application and role-specific modules, runs `uv pip check` and CLI help, then repeats synchronization. This checks Python package installation; interpreter, npm, model, and interactive setup remain separate acceptance steps.

## Publish a validated version

Push the matching version tag only after candidate validation. The tag-triggered workflow rebuilds and verifies the assets, then creates a draft prerelease. Review its checks and assets before publishing the draft. A successful manual run does not trigger this publish job.

The workflow gets the repository address and visibility from GitHub context. Generated instructions reference only that release's repository. Public assets use anonymous downloads; restricted assets use the user's authenticated GitHub CLI. Keep account mappings and publication destinations in ignored local maintainer notes.

## Assets and integrity

| Asset | Contents |
| --- | --- |
| `install.ps1` | Generated bootstrap with the release address and application checksum |
| `hindsightkit-windows-x64.zip` | Application, its wheel, lockfiles, documentation, and full-profile dependency manifests |
| `hindsightkit-client-windows-x64.zip` | Application with client-profile dependency manifests, selected for a new client-only installation |
| `hindsightkit-python-client-<sha256>.zip` | Locked client dependency wheels, excluding the application wheel |
| `hindsightkit-python-server-<sha256>.zip` | Additional wheels needed by the local server |
| `hindsightkit-node-client-<sha256>.zip` and `hindsightkit-node-server-<sha256>.zip` | Locked npm archives for client and server integration |
| `postgresql-18.6-pgvector-0.8.6-windows-x64.zip` | Official PostgreSQL, the compiled unmodified pgvector extension, Microsoft runtime DLLs, upstream notices, and a file manifest |
| `QUICKSTART.md` and `release-notes.md` | Instructions generated for this release |
| `SHA256SUMS` | Checksums for the other release assets |

The full Python bundle contains `python-bundle.json`, `requirements-client.txt`, `requirements-server.txt`, and `wheels`. The client bundle contains its manifest, client requirements, and only the client wheels. Each manifest identifies its profile, Windows x64/Python 3.12, the project version, lockfile hash, and file hashes. The validator checks the corresponding dependency set against the lockfile, upstream wheel hashes, wheel paths, and the application wheel's source contents. Wheels retain their original bytes and license files. The installer uses the full archive on a computer with an existing local server profile to preserve management commands.

Component ZIPs contain no application version or release address, so identical dependencies produce the same SHA256 across application releases. The application manifest declares the component assets and every contained file hash. Each release publishes all required components; installers reuse matching local downloads and fetch changed components from that release.

The packager requires validated Python and Node bundles and a verified PostgreSQL distribution, then derives and validates the client bundle. It rejects private runtime files, linked paths, changed inputs, overlapping output directories, and detected local build paths. Archives exclude database clusters, credentials, logs, and a developer's Python environment. The Python interpreter and, when needed, Node.js still download during setup; local server setup also needs the embedding model and database distribution.

## Installation acceptance

Before describing a release as installed on a clean machine, check its downloads, Copilot login, model download, complete local setup, repeat setup, and an upgrade that preserves disposable test memory. Check offline Python installation on a connection that failed to download the v0.1.0 wheel. Preserve stage logs and relevant console output, then record each result and its limits in [release validation](release-validation.md).

For client installation changes, check fresh `-ClientOnly` preparation without an endpoint, the smaller client archive, later direct/code connection, and `-Server` as a shortcut. On an existing server installation, confirm that client setup preserves settings and memory without starting or reconfiguring server components. Exercise npm output, silent-process heartbeats, failures, retries, and reuse messages. The v0.1.2 results and the boundaries of its isolated tests are recorded in [release validation](release-validation.md); CI configuration alone does not establish a pass.

A draft in a public repository is not anonymously downloadable. Use a controlled test release for the public download path, or inspect draft assets with authenticated access. Restricted repositories require an account with access. Never change repository visibility as an installation workaround without the owner's authorization.

If an interrupted upload leaves an unpublished draft, inspect it before removing and rebuilding it. The workflow does not overwrite an existing release. Use a new version for software changes after publication. Documentation corrections can update the release-page body; they do not change ZIP contents, tags, or checksums already distributed.

## Package locally

Use Windows x64 CPython 3.12, the repository's prepared development environment, a verified PostgreSQL distribution, and new or empty output directories. Bundle construction downloads the locked wheels; the subsequent verifier disables network access for package installation.

```powershell
.venv/Scripts/python.exe distribution/build_python_bundle.py --source-root . --output dist/python
.venv/Scripts/python.exe distribution/verify_python_install.py --bundle dist/python --uv uv
.venv/Scripts/python.exe distribution/build_node_bundle.py --source-root . --output dist/node
.venv/Scripts/python.exe distribution/package_release.py --version v0.1.2 --repository OWNER/REPOSITORY --server-url https://github.com --visibility public --postgres-directory C:/path/to/server-18.6 --python-directory dist/python --node-directory dist/node --output dist/release
.venv/Scripts/python.exe distribution/verify_release_components.py --release-directory dist/release --output dist/verified-application
```

Check each command's exit status before continuing. Use `--visibility internal` or `--visibility private` when access is restricted. Packaging itself reads and validates the inputs; it does not upload a release or start a database. The template at `distribution/install.ps1` cannot be run directly before its release fields are generated.
