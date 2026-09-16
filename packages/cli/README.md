# @provenloop/cli

Windows Design Partner Preview `0.1.0-alpha.0.16` for ProvenLoop and GitHub
Copilot CLI (2026-09-11). M0/MVP remain No-Go for quality release; controlled
benefit has not been established.

Install or upgrade through the versioned bootstrap:

```powershell
irm https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.16/install.ps1 | iex
```

The installer verifies the GitHub Release tarball checksum and uses npm as
the local package installer. This preview is not published to the public npm
registry. This release migrates to schema 23 from schema 16 in 0.15 (0.12 through
0.14 used schema 14). Retain the prior runtime and verified snapshots before upgrading; older
readers cannot open the new schema.

## Browse local knowledge and evidence

Version 0.16 adds purpose/topic classification, concept-assisted retrieval, and
`provenloop_search` for deeper queries. Existing lessons can gain independently
reviewed search metadata during idle learning. Use `provenloop learning status`
to inspect enrichment counts. Learning opt-out also disables model enrichment.
`remember` and reviewed `knowledge replace` accept `--purpose`, `--topics`,
`--source`, and `--source-kind`; source pointers are not fetched automatically.

```powershell
provenloop ui
```

The command opens the local viewer in the default browser. Search knowledge,
follow evidence references, inspect learning jobs, and review usage. Knowledge
forms support explicit adoption, content and scope edits, archiving, and deletion.
Keep the terminal running; Ctrl+C stops the viewer. Run `provenloop ui` again
to reopen it after shutdown, using the new URL printed by the command.

Use `--no-open` to open the URL yourself, `--port 4317` to choose a port, or
`--data-root` to inspect another local installation. The viewer binds only to
`127.0.0.1`. Evidence pages stay read only; writes require the corresponding
review form and confirmation. The viewer includes its own assets and needs no
separate UI installation.

Overview also provides **Clear all records**, which requires typing `CLEAR` and
selecting a confirmation checkbox. It preserves installation and capability
settings, repository files, and Copilot history. The CLI equivalent is:

```powershell
provenloop records clear
provenloop records clear --confirm
```

The first command previews the data location and counts. The second permanently
clears records and stops ProvenLoop extension activity. Restart Copilot to begin
collecting new records. An interrupted reset remains paused until the same clear
action completes.

## Automatic learning

Automatic collection is enabled on a fresh install. The bootstrap enables
retrieval and correction-learning capabilities unless `-NoLearning` is used,
and preserves existing settings on upgrade. Use `-NoAutoCollect` with the
bootstrap or `provenloop collection disable` to opt out of collection.

Background learning starts automatically when
installation, capture, worker, and correction learning are enabled. An explicit
`provenloop learning disable` persists across restarts, upgrades, and capability
changes. Use `provenloop learning enable` to resume; `--confirm` remains accepted
for compatibility.

Inspect learning status and grant the separate repository hook permission:

```powershell
provenloop learning status
provenloop learning approve-hooks --cwd C:/path/to/repository --confirm
provenloop learning status
```

Background learning sends bounded, redacted conversation and tool excerpts to
Copilot with the existing sign-in and service quota. Background requests have no tools or plugins.
Automatic hooks are verified on Copilot CLI `1.0.84-1`; approve each repository
root and restart its session. Qualified lasting conventions and tool-source
references may be returned with their `inferred` label. Research references include
an unverified finding and original source excerpts in the captured worktree.
Changed revisions require revalidation. Long investigations select relevant
source events automatically; no request to save notes is required. Task-local
constraints remain in their source session. Automatic activation requires
supported recovery proof. Source excerpts
do not establish that broader lessons have been learned. Actual model quality
remains unvalidated because a working model host was unavailable for this check.

Upgrade coordinates participating runtimes and retires only verified ProvenLoop
helpers. Foreground Copilot sessions do not all need to close, but old tools
may disconnect. Open a new session or use a host-supported reload afterward;
hot reconnection is not guaranteed.

See the [release notes](https://github.com/cubika/ProvenLoop/blob/v0.1.0-alpha.0.16/docs/releases/0.1.0-alpha.0.16.md),
[viewer guide](https://github.com/cubika/ProvenLoop/blob/v0.1.0-alpha.0.16/docs/local-viewer.md),
and [installation guide](https://github.com/cubika/ProvenLoop/blob/v0.1.0-alpha.0.16/docs/alpha-installation.md).
