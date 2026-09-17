# Optional connectors

Connectors import selected sources into the official Hindsight memory service. Core memory works without them. WorkIQ email is the currently registered connector.

## Open connector settings

After installing HindsightKit, run this command on the computer hosting the server:

```powershell
hindsightkit connectors
```

The command opens a local settings catalog and starts the installed server if needed. Connector setup is unavailable on a client-only installation. The catalog remains available when an optional dependency is missing.

For mail, follow the [WorkIQ guide](workiq-mail.md). WorkIQ must already be installed at the supported version and signed in. Prerequisite checks inspect its executable without launching it. For an unused connector, installation and catalog viewing do not open a login flow or read mail. Account discovery, preview, and synchronization are explicit actions. A previously enabled connector resumes when HindsightKit starts.

Closing the browser leaves enabled synchronization running. Pausing stops acquisition and releases the WorkIQ process while preserving saved settings and imported outcomes. Previously imported mail remains available through the connector's read-only recall tool where that tool is registered. `hindsightkit stop` stops connector workers before the memory service.

## Stored state

Connector state belongs to the HindsightKit data directory, which defaults to `%USERPROFILE%\.hindsightkit` on Windows and can be changed with `HINDSIGHTKIT_HOME`. It is separate from downloaded release versions; see [installation](installation.md).

| Subdirectory | Contents |
| --- | --- |
| `connectors` | Settings host process record and log |
| `mail` | WorkIQ settings, source metadata, and delivery ledger |

Opening the catalog reads dependency status and saved settings without creating a mail ledger or model client. WorkIQ retains its credentials. Hindsight stores accepted mail outcomes in the `hindsightkit-mail` bank.

## Adapter contract

The connector registry is a Python list of supported adapters. It is unrelated to the Windows Registry. Each entry declares an ID, module, data subdirectory, settings view, and allowed web assets. The shared host handles catalog discovery, local HTTP routing, and lifecycle management.

Each adapter owns its prerequisite checks, configuration validation, source access, delivery state, and optional recall tools. Adding a connector requires an adapter, its settings view, and a registry entry. Source-specific parsing stays in the adapter. Configuration cannot name arbitrary Python modules or executables.

A missing dependency or a failed adapter must leave the rest of the catalog usable. The host resumes only enabled adapters, and each adapter must release its resources on pause or shutdown. Opening an unused connector's settings page must not start source acquisition.

Test scope, measured results, and limitations are recorded in [connector validation](connector-validation.md).
