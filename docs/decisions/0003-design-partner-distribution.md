# ADR 0003: Design Partner distribution through GitHub Release tarballs

**Status:** Accepted for the 0.1 Design Partner preview
**Date:** 2026-09-04

## Context

ProvenLoop is packaged as a self-contained npm tarball containing the CLI,
Extension runtime, MCP server, worker, SQLite implementation, and evaluation
fixtures. npm provides the tested global command shim and installation layout,
but the product does not require an npm registry at runtime.

Microsoft-managed devices cannot directly consume newly published packages
from npmjs. The corporate public-package proxy may hold new versions during
CFS quarantine. Publishing through an O365 Azure Artifacts path would require
an approved producer Feed and pipeline. Enzyme is primarily a consolidated
consumption surface; direct publication is not assumed without approval from
its owners.

The initial audience is a small group of Microsoft Design Partners. Rapid,
version-bound installation and rollback are more important than establishing
a shared internal Feed before product evidence is collected.

## Decision

The canonical runtime source for the 0.1 Design Partner preview is the exact
tarball attached to an immutable GitHub Release.

Users download the tarball and its SHA-256 file, verify the checksum, and
install the local file with npm:

```powershell
npm install --global <verified-provenloop-tarball> --no-audit --no-fund
provenloop install
provenloop doctor
```

The supported bootstrap entry point automates this sequence:

```powershell
irm https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.7/install.ps1 | iex
```

npm is used only as the local file installer. Installation must not require
resolving ProvenLoop through npmjs, `packagefeedproxy.microsoft.io`, Enzyme, or
another Azure Artifacts Feed.

The public npm package remains an optional developer and external-user
channel. It is not the dependency for Microsoft-internal preview installation.

## Consequences

- Preview releases are immediately available after GitHub Release publication.
- Package, checksum, source tag, commit, and release notes share one
  provenance boundary.
- Existing package verification, command shims, lifecycle commands, automatic
  collection, upgrade, uninstall, and rollback behavior are preserved.
- Preview users still need the supported Node.js and npm versions.
- Installation documentation must use exact versioned Release URLs rather
  than mutable `latest` URLs.
- Release tarballs and checksum files must remain immutable.
- A future one-line PowerShell installer may automate download, checksum
  verification, local tarball installation, `provenloop install`, and Doctor.

## Future internal scale

If the internal audience grows, ProvenLoop may add an Azure Artifacts
distribution path. The expected O365 model is:

```text
GitHub source
  -> approved producer pipeline
  -> designated producer Feed, normally Common
  -> Enzyme consumption
```

Direct publication to Enzyme requires explicit approval and publisher
provisioning from Enzyme owners. Any internal and public destinations must
receive the same immutable tarball rather than separately rebuilt packages.

## Alternatives rejected for the preview

### Direct Enzyme publication

Rejected as the default because Enzyme is a shared consumption surface and
publisher onboarding, ownership, retention, and support responsibilities have
not been approved for ProvenLoop.

### Dedicated Azure Artifacts Feed

Deferred because it adds Feed ownership, permissions, publishing pipeline,
authentication, retention, and support work before the small pilot needs it.

### Self-contained MSI or ZIP

Deferred because the current tarball already provides the required runtime
and lifecycle behavior. A signed Windows installer remains the preferred
long-term public distribution experience.
