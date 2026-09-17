# Release maintenance

This guide is for maintainers. Users should follow [installation](installation.md) and copy the command from the release page they are using.

## Create a release

1. Update the project version and dependency locks as needed. Use a matching tag, such as `v0.1.0` for project version `0.1.0`.
2. Push the commit and tag to the publishing repository. The release workflow also accepts manual dispatch with an existing tag.
3. The Windows job checks out that tag, installs locked dependencies, runs the test suite, builds the pinned PostgreSQL/pgvector distribution, and checks a disposable database. These CI checks do not make Copilot model calls.
4. The publish job uploads the assets and creates a draft prerelease. Inspect the checks and assets before publishing the draft.

The workflow obtains the repository address and visibility from its GitHub context. Generated instructions reference only that release's repository. Public assets use anonymous downloads; restricted assets use the user's authenticated GitHub CLI. Do not put local remote names, account relationships, or publishing topology in user-facing documentation.

## Assets and integrity

| Asset | Contents |
| --- | --- |
| `install.ps1` | Generated bootstrap with the release address and application checksum |
| `hindsightkit-windows-x64.zip` | Application, lockfiles, documentation, and release metadata |
| `postgresql-18.6-pgvector-0.8.6-windows-x64.zip` | Official PostgreSQL, the compiled unmodified pgvector extension, Microsoft runtime DLLs, upstream notices, and a file manifest |
| `QUICKSTART.md` and `release-notes.md` | Instructions generated for this release |
| `SHA256SUMS` | Checksums for the other release assets |

The packager rejects changed PostgreSQL files, private runtime files, linked paths, and detected local build paths. The archives exclude database clusters, credentials, logs, and a developer's Python environment. The application archive still downloads Python/npm dependencies and the embedding model during installation.

## Validation and publication

CI covers package construction and isolated runtime checks. Before describing a release as fully installed on a clean machine, also check its downloads, Copilot login, model download, local installation, repeat setup, and an upgrade that preserves a disposable test memory. Keep these results separate from CI success; [release validation](release-validation.md) records the current evidence and known failures.

A draft in a public repository is not anonymously downloadable. Use a controlled test release for the public download path, or inspect draft assets with authenticated access. Restricted repositories always require an account with access. Never change a repository's visibility as an installation workaround without the owner's authorization.

If an interrupted upload leaves an unpublished draft, inspect that draft before removing and rebuilding it. The workflow does not overwrite an existing release. Use a new version for software changes after publication. Documentation corrections can update the release-page body; they do not change ZIP contents, tags, or checksums already distributed.

## Package locally

Use an existing verified PostgreSQL distribution and a new or empty output directory:

```powershell
.venv/Scripts/python.exe distribution/package_release.py --version v0.1.0 --repository OWNER/REPOSITORY --server-url https://github.com --visibility public --postgres-directory C:\path\to\server-18.6 --output dist/release
```

Use `--visibility internal` or `--visibility private` when access is restricted. Packaging reads and validates the inputs; it does not upload a release or start a database. The template at `distribution/install.ps1` cannot be run directly before its release fields are generated.
