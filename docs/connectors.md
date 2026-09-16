# Optional connectors

Here, registry means the Python list of supported adapters. It has no connection to the Windows Registry.

Connectors are optional adapters around the official memory service. Installing or starting ProvenLoop does not install WorkIQ, open its login flow, scan mail, or create a mail delivery ledger. Users can use all core memory features without a connector.

The connector registry declares each adapter's ID, settings view, data directory, and module. The shared host provides discovery, HTTP routing, and lifecycle management. Each adapter owns its prerequisites, settings validation, state, source access, and optional recall tools. Modules are loaded by registered ID; configuration cannot name arbitrary Python modules or executables. Adding another connector requires one adapter, a settings view, and a registry entry. Mail-specific parsing and ingestion stay in the WorkIQ adapter.

The settings catalog is available even when a dependency is missing. WorkIQ must already be installed at the supported version before its connector can discover the account, preview, start, or synchronize. The prerequisite check reads installed files without launching WorkIQ or installing anything. A missing dependency affects only that connector.

Opening a settings page can inspect saved configuration and dependency status, but does not create a delivery ledger or model client. Starting ProvenLoop resumes only connectors whose saved configuration is enabled. Pausing releases the WorkIQ process and stops future acquisition while preserving configuration and imported memory. Existing mail state remains in `~/.provenloop/mail`; no data migration or deletion is needed. Previously imported mail stays available through its read-only recall tool after acquisition is paused.

Tests cover unused connectors, missing dependencies, independent adapters, disabled and enabled restart behavior, unknown IDs, and cleanup after one adapter fails. Source extraction and model behavior are unchanged by this separation.

The local HTTP check loaded the catalog and WorkIQ settings, verified the installed prerequisite, and shut down successfully without creating a mail directory or fetching account data. Synthetic UI checks covered missing dependencies, disabled actions, navigation, and plain-text rendering. No browser was available for new screenshot checks of the catalog.
