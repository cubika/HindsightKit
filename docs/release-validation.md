# Release validation

These records describe completed checks and their limits. They are not a guarantee that every machine or network can finish installation. Connector-specific measurements are in [connector validation](connector-validation.md).

## v0.1.0, September 17, 2026

The Windows x64 preview was built from product commit `7a5bf66`. Successful hosted builds passed 270 tests, rebuilt the pinned PostgreSQL/pgvector distribution, and checked extensions, restricted permissions, restart, and persistence across repeated setup in disposable databases. Release downloads matched SHA256SUMS, and all 4,474 database file hashes were checked. Anonymous and authenticated installer downloads were verified.

Earlier CI attempts found 8.3 short-path comparison failures and an absent `_CL_` variable under PowerShell 7 StrictMode. File checks now compare identity, and compilation uses long paths while handling an empty compiler environment. Regression checks compile with Windows PowerShell and PowerShell 7, long and short paths, and absent or present compiler options. Unpublished draft assets and superseded tags were removed before the successful build.

## Remote connection checks

Local tests cover direct discovery, key and protocol errors, TLS certificate failures, restoration of the previous selected connection, process ownership, and stable relay ports.

A disposable private Microsoft tunnel carried only a synthetic HTTP response. The managed host/client processes started without visible terminals, reused their saved instance, stopped, and restarted on the same local proxy port. The CLI selected another forwarding port when the server port was occupied. Test tunnels and workers were removed. This verifies the relay service and local wrapper on one machine; a second machine's account, policy, and network conditions remain separate checks.

## Reported installation failure

Subsequent v0.1.0 installation attempts stopped during Python dependency download. A read-only diagnostic reproduced TLS `HandshakeFailure` for the locked `hindsight-api-slim 0.10.0` wheel on `files.pythonhosted.org`. The package index was reachable and uv's dependency plan succeeded. The same wheel request failed with uv, PowerShell, and a system-certificate comparison. These checks did not identify which network component or remote route caused the alert.

The reported second-machine output contained the final uv failure and dependency explanation, but not its original transport error. That machine's underlying TLS failure has not been independently established.

No installation fix was applied by the documentation review. Complete interactive installation with model downloads and Copilot login on an affected fresh machine remains unverified. See [troubleshooting](installation.md#troubleshooting) for the relevant output to capture.
