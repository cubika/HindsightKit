# Optional connectors

Connectors import selected sources into the official Hindsight memory service. Core memory works without them. WorkIQ email is the currently registered connector.

## Open connector settings

After installing HindsightKit, run this command on the computer hosting the server:

```powershell
hindsightkit connectors
```

The command opens a local settings catalog and starts the installed server if needed. Connector setup is unavailable on a client-only installation. The catalog remains available when an optional dependency is missing.

For mail, follow the [WorkIQ guide](workiq-mail.md). WorkIQ must already be installed at the supported version and signed in. Prerequisite checks inspect its executable without launching it. For an unused connector, installation and catalog viewing do not open a login flow or read mail. Account discovery, preview, and synchronization are explicit actions. A previously enabled connector resumes when HindsightKit starts.

Closing the browser leaves enabled synchronization running. Pausing stops acquisition and releases the WorkIQ process while preserving saved settings and imported outcomes. Previously imported content remains available through `recall`, `reflect`, and automatic prompt recall. `hindsightkit stop` stops connector workers before the memory service.

## Search imported knowledge

Ordinary questions search the current repository, shared memory, and available connector imports together. No source name or special wording is required. Each source receives part of the total result budget. Responses identify the source and bank and preserve the evidence returned by Hindsight. Recall and automatic prompt context retain document IDs, source metadata, and evidence dates. Reflection returns a separate answer and supporting facts for each bank.

Retrieval uses the selected Hindsight server and does not read the source mailbox. Remote clients discover readable connectors from that server on each read; local importer state does not affect a remote connection. A client restricted to one bank continues to read only that bank. Retention still writes only to the selected repository or shared bank.

If discovery or one source fails, available results are returned with `complete: false` and an error identifying the missing source. An empty source is separate from a failed read. Imported evidence reflects completed synchronization and does not establish that newer source material has been checked.

## Stored state

Connector state belongs to the HindsightKit data directory, which defaults to `%USERPROFILE%\.hindsightkit` on Windows and can be changed with `HINDSIGHTKIT_HOME`. It is separate from downloaded release versions; see [installation](installation.md).

| Subdirectory | Contents |
| --- | --- |
| `connectors` | Settings host process record and log |
| `mail` | WorkIQ settings, source metadata, and delivery ledger |

Opening the catalog reads dependency status and saved settings without creating a mail ledger or model client. WorkIQ retains its credentials. Hindsight stores accepted mail outcomes in the `hindsightkit-mail` bank.

## Adapter contract

The connector registry is a Python list of supported adapters. It is unrelated to the Windows Registry. Each entry declares an ID, module, data subdirectory, settings view, allowed web assets, and an optional readable bank with retrieval options and a saved-state marker. Readable imports are discovered independently of whether synchronization is enabled. The shared host handles catalog discovery, local HTTP routing, and lifecycle management.

Each adapter owns its prerequisite checks, configuration validation, source access, and delivery state. Adding a connector requires an adapter, its settings view, and a registry entry. Source-specific parsing stays in the adapter. Configuration cannot name arbitrary Python modules or executables. Unified retrieval reads the registered banks through the official Hindsight SDK without loading the acquisition adapters.

A missing dependency or a failed adapter must leave the rest of the catalog usable. The host resumes only enabled adapters, and each adapter must release its resources on pause or shutdown. Opening an unused connector's settings page must not start source acquisition.

Test scope, measured results, and limitations are recorded in [connector validation](connector-validation.md).
