# Release validation

## v0.1.5 candidate

The CLI cleanup passed 492 repository tests and 63 final regression checks. Release preparation passed another 83 packaging and installation tests. The offline Node verifier installed, reused, and repaired the official client and server archives in temporary directories; the dashboard and 17 static assets returned HTTP 200. The project version and dependency lock agree on 0.1.5.

These checks used isolated fixtures and cached official dependencies. They did not perform a new Copilot login, make model calls, or establish connectivity from a second computer. Hosted candidate builds and checks of their final release archives are required before publication.

## v0.1.3 local candidate

Copilot CLI is now installed separately. The revised package excludes its archive and lockfiles. All 369 tests passed, followed by 80 affected tests after integrating newer master changes. The existing Windows Copilot executable was reused; a separate installation into a disposable npm prefix and repeat reuse also passed. Authentication was excluded from those checks.

All 358 repository tests passed after integrating current master. A generated client installer completed twice with network access blocked, reused system Node.js, preserved the fixture connection, and verified its actual launcher; its temporary user PATH entry was removed. Separate offline checks passed for 194 Python wheels, client dependency repair, the Copilot executable and reuse, and the dashboard with 17 static assets. Full/client release archives were built locally and checked against their manifests. Publication, a fresh Copilot sign-in, and installation on the reporting machine remain unverified.

These records separate completed checks from pending acceptance work. They do not guarantee that every machine or network can finish installation. Connector-specific measurements are in [connector validation](connector-validation.md).

## v0.1.2: client preparation and npm progress

Client-installation acceptance passed within the scopes below, and v0.1.2 was published from product commit `4593b0d`. It adds `-ClientOnly` to prepare the command and Copilot components without selecting or contacting a memory server. A later `connect` accepts a connection code or `--server` address. The installer's existing `-Server` option selects client-only installation and connection in one run.

The hosted candidate build passed 323 tests. Its client archive was 24,706,898 bytes with 87 wheels; the full archive was 286,713,128 bytes with 194 wheels. Downloaded artifacts passed checksum verification. Offline installation and repeat synchronization passed from both final archives. A fresh client environment contained neither `hindsight-api-slim` nor `hindsight-embed`.

Seven targeted progress-helper tests passed using local synthetic processes. They covered silent-process heartbeats, stdout/stderr streaming before process completion, log append, nonzero exits with the first error and recent output, credential redaction, process-start errors, and interrupt ownership. The interrupt test confirmed that stopping the helper's own process left an unrelated process running. These tests made no npm network requests or real package installations.

The hosted run exercised real npm installation with ten-second heartbeats and visible output. Dashboard/server integration took 297.5 seconds; client integration took 29.1 seconds. A previous hosted log recorded 325.2 seconds between starting dashboard installation and moving to the client step. These measurements show that npm installation can take minutes; they do not diagnose a wait on another machine.

An isolated test used the actual client package and official npm client dependencies. It installed 98 npm packages from cache in 6.0 seconds, prepared the client without an endpoint, and created no dashboard runtime or database directory. Direct-address and connection-code registration passed against a disposable authenticated HTTP fixture. With that fixture stopped, rerunning client-only setup refreshed the official MCP configuration and hooks while preserving the connection file byte for byte.

That test mocked Copilot authentication and command registration to keep the user's global configuration unchanged. Its HTTP fixture simulated server discovery and registration; it did not exercise a remote Hindsight model, real cross-machine networking, or first-time Copilot login.

A separate run executed the actual generated bootstrap with `-ClientOnly` on an existing full installation. The installer selected the full package because the local server profile existed, updated the installed command, and ran no dashboard/server setup stage. Server-profile, client-configuration, and cluster-metadata SHA256 hashes were unchanged, and the run did not change server data. The already running local server components remained healthy afterward. Client setup preserved management dependencies without stopping, uninstalling, or restarting that server.

The final hosted builds passed 323 tests and verified offline installations from both archives. Downloaded release assets matched their checksums; each client archive was about 24.7 MB and contained 87 wheels, with no Hindsight API or embedded server wheel. The application wheel matched the full package. Published anonymous and authenticated installer downloads were verified, and the public client ZIP returned HTTP 200. The v0.1.1 results below describe the earlier server installation and memory-preservation checks.

## v0.1.1, September 17, 2026

Hosted packaging, affected-machine installation, and repeat-install acceptance passed for candidate commit `091711b`. Version 0.1.1 was then published from `3875b9d`; the intervening changes were validation documentation only. It includes a Python wheel bundle in the application archive, with separate client/server requirements and SHA256 hashes. Release setup uses that bundle with package-index access disabled. The Python interpreter, Node.js, npm components, and embedding model remain downloads. Source setup continues to use the dependency lock and package hosts.

The candidate also records installation stages and dependency-command output under `<InstallDir>\logs`, prints the failed stage and first matching dependency error, and distinguishes Node.js download, completed installation, and reuse. Interactive setup output is excluded from the log so Copilot login and connection-key prompts remain in the console.

The final targeted release-packaging run passed 20 tests using synthetic wheel and PostgreSQL fixtures. It checked mandatory bundle validation, missing or changed files, private files, changes after validation, path overlap, generated installation commands, deterministic archives, and byte-for-byte wheel preservation. This test run did not install the real dependency bundle or verify a user's setup.

The manual hosted build passed 303 repository tests and produced a verified bundle of 194 wheels. Fresh client and server Python environments passed installation, import checks, dependency consistency, CLI help, and repeat synchronization with separate empty caches, package-index access disabled, and an unreachable proxy. The checks passed both before packaging and from the final application archive. Manual dispatch uploaded candidate artifacts without creating a release.

The machine that reproduced the v0.1.0 wheel failure then passed the same isolated client/server package checks using its existing uv 0.8.18. These checks used new environments and empty caches, so they did not rely on its previously installed Python packages.

The generated candidate bootstrap was also executed with the exact application archive supplied through a local download cache. It created a new version directory under the default installation root, downloaded and verified Node.js, used Python 3.12.11, and installed all 194 Python packages with index access disabled. Copilot authentication checks, the temporary retain/recall test, client registration, and launcher verification completed with exit code 0. The installed services were healthy afterward.

The existing server-profile and database-cluster metadata hashes were unchanged. A synthetic memory created before installation was recalled afterward. This demonstrates preservation on the tested machine; the run reused its existing configuration and does not establish a first-ever Copilot sign-in or a fresh model download.

Repeating the same generated installer completed with exit code 0. It reported reuse of uv 0.8.18, Node.js 22.23.2, and Python 3.12.11, including their paths. The Python stage audited 194 packages in 92 ms without contacting PyPI. The real retain/recall check passed again, the server-profile and cluster-metadata hashes stayed unchanged, and the pre-install synthetic memory was recalled after the repeat. Its temporary bank was then deleted and absence confirmed through the official bank-list API. Client connection, API, dashboard, and database checks were healthy.

After installation, requesting the original v0.1.0 wheel URL still failed with `SSLV3_ALERT_HANDSHAKE_FAILURE`. The successful candidate installs therefore did not depend on that connection recovering.

The local cached archive preserved the candidate's exact packaged bytes and checksum checks. The final tag-triggered builds then passed 303 tests and repeated the client/server offline checks from their final ZIPs. Downloaded release assets passed all SHA256 checks, including the 194 Python wheels and 4,474 PostgreSQL files, and their application source matched the accepted candidate. Public and authenticated installer downloads were checked after publication. These results establish the installation fix on the tested machine and retain the fresh-sign-in and model-download limits described above.

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

The earlier documentation review applied no installation fix. The v0.1.1 candidate changes the Python package source; its installation results and remaining release steps are recorded above. See [troubleshooting](installation.md#troubleshooting) for the relevant log and console output.
