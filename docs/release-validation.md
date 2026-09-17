# Release validation

These records separate completed checks from pending acceptance work. They do not guarantee that every machine or network can finish installation. Connector-specific measurements are in [connector validation](connector-validation.md).

## v0.1.1 candidate, September 17, 2026

Release acceptance is pending. The candidate includes a Python wheel bundle in the application archive, with separate client/server requirements and SHA256 hashes. Release setup uses that bundle with package-index access disabled. The Python interpreter, Node.js, npm components, and embedding model remain downloads. Source setup continues to use the dependency lock and package hosts.

The candidate also records installation stages and dependency-command output under `<InstallDir>\logs`, prints the failed stage and first matching dependency error, and distinguishes Node.js download, completed installation, and reuse. Interactive setup output is excluded from the log so Copilot login and connection-key prompts remain in the console.

The final targeted release-packaging run passed 20 tests using synthetic wheel and PostgreSQL fixtures. It checked mandatory bundle validation, missing or changed files, private files, changes after validation, path overlap, generated installation commands, deterministic archives, and byte-for-byte wheel preservation. This test run did not install the real dependency bundle or verify a user's setup.

The workflow now supports manual candidate builds that upload artifacts without creating a release. It is configured to validate new client and server Python environments with separate empty caches, package-index access disabled, and an unreachable proxy. It repeats installation, checks imports and dependency consistency, and runs again from the final application archive. These are validation procedures; a configured CI step is not a recorded pass.

Still pending for this candidate: the complete hosted build, installation from its real bundle on an affected connection, and full setup through model download, Copilot authentication, retain/recall, repeat installation, and preservation of existing memory. Record actual outcomes before publishing or describing the installation fix as accepted.

## v0.1.0, September 17, 2026

The Windows x64 preview was built from product commit `7a5bf66`. Successful hosted builds passed 270 tests, rebuilt the pinned PostgreSQL/pgvector distribution, and checked extensions, restricted permissions, restart, and persistence across repeated setup in disposable databases. Release downloads matched SHA256SUMS, and all 4,474 database file hashes were checked. Anonymous and authenticated installer downloads were verified.

Earlier CI attempts found 8.3 short-path comparison failures and an absent `_CL_` variable under PowerShell 7 StrictMode. File checks now compare identity, and compilation uses long paths while handling an empty compiler environment. Regression checks compile with Windows PowerShell and PowerShell 7, long and short paths, and absent or present compiler options. Unpublished draft assets and superseded tags were removed before the successful build.

## Remote connection checks

Local tests cover direct discovery, key and protocol errors, TLS certificate failures, restoration of the previous selected connection, process ownership, and stable relay ports.

A disposable private Microsoft tunnel carried only a synthetic HTTP response. The managed host/client processes started without visible terminals, reused their saved instance, stopped, and restarted on the same local proxy port. The CLI selected another forwarding port when the server port was occupied. Test tunnels and workers were removed. This verifies the relay service and local wrapper on one machine; a second machine's account, policy, and network conditions remain separate checks.

## v0.1.0 Python wheel download failure

Subsequent v0.1.0 installation attempts stopped during Python dependency download. A read-only diagnostic reproduced TLS `HandshakeFailure` for the locked `hindsight-api-slim 0.10.0` wheel on `files.pythonhosted.org`. The package index was reachable and uv's dependency plan succeeded. The same wheel request failed with uv, PowerShell, and a system-certificate comparison. These checks did not identify which network component or remote route caused the alert.

The initial second-machine report contained only the final uv failure and dependency explanation. The user later supplied its complete log, which also showed TLS `HandshakeFailure` for the same wheel. That is evidence from the user's run; the diagnostic was not independently executed on the second machine.

### Why the earlier local environment differed

A read-only inspection found `hindsight-api-slim 0.10.0` already installed in the source checkout's Python environment. Its installer metadata named uv, and the distribution directory was created on September 16 at 20:34:48 local time. The corresponding unpacked wheel was already in that checkout's cache. Its package metadata hash matched the installed copy. The cache contained 196 archive directories and 208 distribution-metadata directories.

The failed release environment contained only the two virtualenv initialization files and no installed distribution metadata. Its corresponding wheel cache contained an empty lock file, with no unpacked wheel archive. Setup assigns a cache under each installation directory, so the new release did not reuse the source checkout's cache.

These files explain why an environment with existing dependencies can continue without a fresh download while a new release encounters the failing wheel request. They do not identify the network cause or prove the earlier download route. The installed distribution had no `direct_url.json`, and this inspection did not rerun the old service.

The earlier documentation review applied no installation fix. The v0.1.1 candidate now changes the Python package source, but its remaining acceptance checks are recorded above. See [troubleshooting](installation.md#troubleshooting) for the relevant log and console output.
