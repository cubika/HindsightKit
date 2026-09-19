"""Package a pinned Windows release without building or publishing components."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import time
import tomllib
from urllib.parse import urlsplit
import zipfile


APP_NAME = "hindsightkit-windows-x64.zip"
CLIENT_APP_NAME = "hindsightkit-client-windows-x64.zip"
POSTGRES_VERSION = "18.6"
VECTOR_VERSION = "0.8.6"
POSTGRES_NAME = f"postgresql-{POSTGRES_VERSION}-pgvector-{VECTOR_VERSION}-windows-x64.zip"
POSTGRES_MANIFEST = "hindsightkit-postgres.json"
POSTGRES_URL = "https://get.enterprisedb.com/postgresql/postgresql-18.6-1-windows-x64-binaries.zip"
POSTGRES_SHA256 = "fbe23da234ee31547bf8a36d29dfd81e82b849df2d2b78d2eecb43d360252f8c"
VECTOR_URL = "https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.6.zip"
VECTOR_SHA256 = "e93a1567219c9ce523ca16473f6c41cc80e01345b2d91ccdee40b473b7c5dd0a"
EXTENSIONS = ("vector", "pg_trgm", "btree_gin", "btree_gist", "pg_stat_statements",
              "unaccent", "pgcrypto", "uuid-ossp")
APP_FILES = ("setup.ps1", "pyproject.toml", "uv.lock", "README.md", "THIRD_PARTY_NOTICES.md")
APP_DIRECTORIES = ("src", "docs")
SKIP_DIRECTORIES = {"__pycache__", "node_modules", ".venv", ".runtime", ".git",
                    ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache"}
PRIVATE_NAMES = {"cluster.json", "pg_version", "pg_hba.conf", "pg_ident.conf",
                 "postmaster.pid", "postmaster.opts", "credentials.json", "secrets.json",
                 "secrets.dpapi", "connection.json", "installation.json", "active.json"}
PRIVATE_DIRECTORIES = {"data", "pgdata", "pg_wal", "pg_logical", "downloads", "logs"}
PRIVATE_SUFFIXES = {".pem", ".key", ".pfx", ".p12"}
PG_DIRECTORIES = {"bin", "lib", "share", "include", "doc"}
REQUIRED_POSTGRES = {"bin/postgres.exe", "bin/initdb.exe", "bin/pg_ctl.exe",
    "bin/pg_isready.exe", "bin/psql.exe", "bin/pg_dump.exe", "bin/pg_dumpall.exe",
    "bin/pg_restore.exe", "bin/pg_config.exe", "bin/vcruntime140.dll",
    "lib/postgres.lib", "include/server/postgres.h",
    f"share/extension/vector--{VECTOR_VERSION}.sql", "share/extension/vector-LICENSE",
    "server_license.txt"}
REQUIRED_POSTGRES.update(f"{folder}/{name}.{suffix}" for name in EXTENSIONS
                         for folder, suffix in (("lib", "dll"), ("share/extension", "control")))


def ordinary_path(path: Path) -> Path:
    """Reject links before resolving, including links in existing ancestors."""
    path = Path(os.path.abspath(path))
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError(f"Linked path is not a release input: {item}")
    return path


def relative_name(value: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value or ":" in value:
        raise ValueError("Invalid release file path")
    parts = value.split("/")
    if any(not part or part in {".", ".."} or part.endswith((".", " "))
           or re.search(r'[\x00-\x1f<>"|?*]', part)
           or re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part)
           for part in parts):
        raise ValueError(f"Invalid release file path: {value}")
    return value


def private_name(relative: str, *, application=False) -> bool:
    path = PurePosixPath(relative.lower())
    return (any(part in PRIVATE_DIRECTORIES for part in path.parts)
            or path.name in PRIVATE_NAMES or path.name == ".env"
            or path.name.startswith(".env.")
            or (application and path.suffix in PRIVATE_SUFFIXES))


def tree_files(root: Path, *, application=False):
    ordinary_path(root)
    if not root.is_dir():
        raise ValueError(f"Release input directory is missing: {root}")
    pending = [root]
    while pending:
        directory = pending.pop()
        for child in sorted(directory.iterdir()):
            ordinary_path(child)
            relative = relative_name(child.relative_to(root).as_posix())
            if application and (child.name.lower() in SKIP_DIRECTORIES
                                or child.name.endswith(".egg-info")
                                or child.suffix.lower() in {".pyc", ".pyo"}):
                continue
            if private_name(relative, application=application):
                raise ValueError(f"Private or runtime file in release input: {relative}")
            if child.is_dir():
                pending.append(child)
            elif child.is_file():
                yield child
            else:
                raise ValueError(f"Release input is not an ordinary file: {relative}")


def machine_paths(*roots: Path) -> tuple[bytes, ...]:
    candidates = {str(root) for root in roots}
    candidates.add(str(Path.home()))
    if os.environ.get("USERPROFILE"):
        candidates.add(os.environ["USERPROFILE"])
    needles = set()
    for path in candidates:
        for normalized in (path.replace("\\", "/"), path.replace("/", "\\")):
            for encoding in ("utf-8", "utf-16-le"):
                needles.add(normalized.encode(encoding).lower())
    return tuple(needles)


def inspect_file(path: Path, needles: tuple[bytes, ...] = ()) -> str:
    ordinary_path(path)
    digest = hashlib.sha256()
    tail = b""
    overlap = max(map(len, needles), default=1) - 1
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            if needles:
                lowered = (tail + chunk).lower()
                if any(needle in lowered for needle in needles):
                    raise ValueError(f"Machine-specific absolute path in release input: {path.name}")
                tail = lowered[-overlap:] if overlap else b""
    return digest.hexdigest()


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"Duplicate manifest key: {key}")
        value[key] = item
    return value


def postgres_files(root: Path, needles: tuple[bytes, ...]):
    files = list(tree_files(root))
    names = {path.relative_to(root).as_posix(): path for path in files}
    if POSTGRES_MANIFEST not in names:
        raise ValueError("PostgreSQL distribution manifest is missing")
    manifest = json.loads(names[POSTGRES_MANIFEST].read_text(encoding="utf-8-sig"),
                          object_pairs_hook=unique_object)
    expected = {"schema": 1, "postgres_version": POSTGRES_VERSION,
                "vector_version": VECTOR_VERSION, "architecture": "windows-x64",
                "postgres_url": POSTGRES_URL, "vector_url": VECTOR_URL}
    if any(manifest.get(key) != value for key, value in expected.items()):
        raise ValueError("PostgreSQL manifest differs from the pinned distribution")
    for key, value in (("postgres_sha256", POSTGRES_SHA256), ("vector_sha256", VECTOR_SHA256)):
        if str(manifest.get(key, "")).lower() != value:
            raise ValueError("PostgreSQL manifest source checksum differs from the pinned distribution")
    extensions = manifest.get("extensions", {})
    if not isinstance(extensions, dict) or extensions.get("vector") != VECTOR_VERSION \
            or not set(EXTENSIONS).issubset(extensions):
        raise ValueError("PostgreSQL manifest is missing required extensions")
    if not re.fullmatch(r"\d+(?:\.\d+){2,3}", str(manifest.get("msvc_runtime_version", ""))):
        raise ValueError("PostgreSQL manifest is missing the MSVC runtime version")
    declared = manifest.get("files")
    if not isinstance(declared, dict):
        raise ValueError("PostgreSQL manifest has no file hashes")
    seen = set()
    for name, digest in declared.items():
        relative_name(name)
        if name.lower() in seen:
            raise ValueError("Duplicate Windows path in PostgreSQL manifest")
        seen.add(name.lower())
        if not isinstance(digest, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", digest):
            raise ValueError(f"Invalid PostgreSQL file checksum: {name}")
    if set(declared) != set(names) - {POSTGRES_MANIFEST}:
        raise ValueError("PostgreSQL files differ from the distribution manifest")
    if not REQUIRED_POSTGRES.issubset(names):
        raise ValueError("Required PostgreSQL distribution files are missing")
    for extension in EXTENSIONS:
        control = names[f"share/extension/{extension}.control"].read_text(encoding="utf-8-sig")
        match = re.search(r"(?m)^default_version\s*=\s*'([^']+)'\s*$", control)
        if not match or match.group(1) != extensions[extension]:
            raise ValueError(f"PostgreSQL extension differs from its manifest: {extension}")
    for name in names:
        parts = PurePosixPath(name).parts
        if len(parts) > 1 and parts[0] not in PG_DIRECTORIES:
            raise ValueError(f"Unexpected PostgreSQL directory: {parts[0]}")
        if len(parts) == 1 and name != POSTGRES_MANIFEST \
                and not re.search(r"(?i)license|copyright|notice", name):
            raise ValueError(f"Unexpected PostgreSQL root file: {name}")
    result = {}
    for name, path in names.items():
        actual = inspect_file(path, needles)
        if name != POSTGRES_MANIFEST and actual != declared[name].lower():
            raise ValueError(f"PostgreSQL file failed SHA256 verification: {name}")
        result["pgsql/" + name] = (path, actual)
    return result


def python_bundle_module():
    spec = importlib.util.spec_from_file_location(
        "hindsightkit_python_bundle", Path(__file__).with_name("build_python_bundle.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_node_bundle(bundle_directory: Path, package_directory: Path, *, roles=("client", "server")) -> dict:
    spec = importlib.util.spec_from_file_location(
        "hindsightkit_node_bundle", Path(__file__).resolve().parents[1] / "src/hindsightkit/setup/node_bundle.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate_bundle(bundle_directory, package_directory, roles=roles)


def node_files(root: Path, package_directory: Path, needles: tuple[bytes, ...]):
    manifest_path = ordinary_path(root / "node-bundle.json")
    manifest_hash = inspect_file(manifest_path, needles)
    manifest = validate_node_bundle(root, package_directory)
    expected = {"node-bundle.json": manifest_hash,
                **{item["archive"]: item["sha256"] for item in manifest["bundles"].values()}}
    files = {}
    for path in tree_files(root):
        name = path.relative_to(root).as_posix()
        # Archives retain upstream bytes, licenses, and native Windows modules.
        digest = inspect_file(path, () if path.suffix == ".zip" else needles)
        if digest != expected.get(name):
            raise ValueError(f"Node bundle changed after validation: {name}")
        files["app/node/" + name] = (path, digest)
    if set(name.removeprefix("app/node/") for name in files) != set(expected):
        raise ValueError("Node bundle files changed after validation")
    return files, manifest


def validate_python_bundle(bundle_directory: Path, source_root: Path, *, profile="full") -> dict:
    return python_bundle_module().validate_bundle(bundle_directory, source_root, profile=profile)


def python_files(root: Path, source_root: Path, needles: tuple[bytes, ...], *, profile="full"):
    manifest_hash = inspect_file(root / "python-bundle.json", needles)
    manifest = (validate_python_bundle(root, source_root) if profile == "full" else
                validate_python_bundle(root, source_root, profile=profile))
    files = {}
    for path in tree_files(root):
        relative = path.relative_to(root).as_posix()
        if private_name(relative, application=True):
            raise ValueError(f"Private file in Python bundle: {relative}")
        # Wheels retain upstream bytes, including licenses and binary payloads.
        # The bundle validator checks their metadata, paths, and locked hashes.
        actual = inspect_file(path, () if path.suffix == ".whl" else needles)
        if relative == "python-bundle.json" and actual != manifest_hash:
            raise ValueError("Python bundle manifest changed during validation")
        if relative != "python-bundle.json" and actual != manifest["files"].get(relative):
            raise ValueError(f"Python bundle changed after validation: {relative}")
        files["app/python/" + relative] = (path, actual)
    if {name.removeprefix("app/python/") for name in files} != set(manifest["files"]) | {"python-bundle.json"}:
        raise ValueError("Python bundle files changed after validation")
    return files, {"version": manifest["python"], "platform": manifest["platform"],
                   "packages": sum(name.endswith(".whl") for name in manifest["files"])}


def release_identity(version: str, repository: str, server_url: str) -> str:
    if not re.fullmatch(r"v\d+\.\d+\.\d+(?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?", version):
        raise ValueError("Version must be a safe v-prefixed release tag")
    if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", repository):
        raise ValueError("Repository must be owner/repo")
    if repository.split("/")[1].endswith("."):
        raise ValueError("Invalid repository name")
    parsed = urlsplit(server_url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in {"", "/"}
            or not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/?", server_url)):
        raise ValueError("Server URL must be an HTTPS origin without credentials or a path")
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise ValueError("Invalid HTTPS server port")
    return f"{server_url.rstrip('/')}/{repository}/releases/download/{version}"


def write_archive(destination: Path, files, extra=None, *, progress_label=None):
    started = last_progress = time.monotonic()
    written = 0
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, (path, expected) in sorted(files.items()):
            relative_name(name)
            ordinary_path(path)
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            digest = hashlib.sha256()
            with path.open("rb") as source, archive.open(info, "w") as target:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
                    target.write(chunk)
            if digest.hexdigest() != expected:
                raise ValueError(f"Release input changed during packaging: {name}")
            written += 1
            if progress_label and time.monotonic() - last_progress >= 10:
                print(f"Packing {progress_label}: {written}/{len(files)} files (elapsed {time.monotonic() - started:.1f}s).", flush=True)
                last_progress = time.monotonic()
        for name, content in sorted((extra or {}).items()):
            relative_name(name)
            if name in files:
                raise ValueError(f"Duplicate release package entry: {name}")
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content)
    return inspect_file(destination)


def dependency_wheels(files):
    return {name: value for name, value in files.items()
            if name.startswith("app/python/wheels/")
            and not PurePosixPath(name).name.lower().startswith("hindsightkit-")}


def write_component(output: Path, name: str, files) -> dict:
    temporary = output / ("hindsightkit-" + name + ".zip")
    digest = write_archive(temporary, files)
    asset = f"hindsightkit-{name}-{digest}.zip"
    temporary.rename(output / asset)
    return {"name": name, "asset": asset, "sha256": digest,
            "files": {path.removeprefix("app/"): checksum
                      for path, (_, checksum) in sorted(files.items())}}


def installation_notes(version: str, release_url: str, repository: str, visibility: str) -> str:
    installer = release_url + "/install.ps1"
    tick = chr(96)
    fence = tick * 3
    login = ""
    if visibility == "public":
        local = f"irm '{installer}' | iex"
        server = f"& ([scriptblock]::Create((irm '{installer}'))) -ServerOnly"
        client = f"& ([scriptblock]::Create((irm '{installer}'))) -Server 'http://server-host:9077'"
        prepare_client = f"& ([scriptblock]::Create((irm '{installer}'))) -ClientOnly"
    else:
        host = urlsplit(release_url).netloc
        login = f"""
This {visibility} repository also requires GitHub CLI and an account with repository access.
Sign in once:

{fence}powershell
gh auth login --hostname '{host}'
if ($LASTEXITCODE -ne 0) {{ throw 'GitHub sign-in failed.' }}
{fence}
"""
        download = (f"$hindsightkitInstaller = gh release download '{version}' "
                    f"--repo '{host}/{repository}' --pattern 'install.ps1' --output - | Out-String\n"
                    "if ($LASTEXITCODE -ne 0) { throw 'Installer download failed.' }\n"
                    "if ([string]::IsNullOrWhiteSpace($hindsightkitInstaller)) { throw 'Installer download was empty.' }\n")
        local = download + "& ([scriptblock]::Create($hindsightkitInstaller))"
        server = "& ([scriptblock]::Create($hindsightkitInstaller)) -ServerOnly"
        client = "& ([scriptblock]::Create($hindsightkitInstaller)) -Server 'http://server-host:9077'"
        prepare_client = "& ([scriptblock]::Create($hindsightkitInstaller)) -ClientOnly"
    advanced = ("Use one of these commands instead of the default installation command."
                if visibility == "public" else
                "Download and check the installer as above, then replace its final invocation with one of these commands.")
    download_issue = ""
    if version == "v0.1.0":
        download_issue = f"""
## Known v0.1.0 download issue

Python dependency downloads have failed with {tick}TLS HandshakeFailure{tick} on some networks.
A retry using the system certificate store also failed in the reported case.
If this occurs, check access to {tick}files.pythonhosted.org{tick} and your proxy or certificate
configuration before rerunning setup. Keep TLS certificate verification enabled.
"""
    python_downloads = ("Python, Node.js dependencies, and the embedding model download during setup."
                        if version == "v0.1.0" else
                        "Pinned Python packages are bundled in dependency component archives; "
                        "setup installs them without contacting PyPI.\n"
                        "Separate Node component archives contain the locked Hindsight npm components. "
                        "Setup verifies and extracts these files without contacting npm.\n"
                        "The Python interpreter still downloads. Setup reuses suitable Node.js 22+ from PATH "
                        "or downloads the official portable runtime. "
                        "A local server also downloads the embedding model.")
    client_download = ("Run this on the other computer:" if visibility == "public" else
                       "Sign in and download the installer as above, then use this final invocation on the other computer:")
    return f"""# HindsightKit {version}

## Changes in this preview

{tick}recall{tick}, {tick}reflect{tick}, and automatic prompt recall now search imported connector
knowledge alongside repository and shared memory. Questions do not need to name the source.
The separate {tick}recall_mail{tick} tool has been removed. Reads preserve source evidence,
report partial failures, and respect fixed-bank restrictions. Pausing synchronization keeps
imported outcomes searchable. Restart the Hindsight MCP server or open a new Copilot session after upgrading.

Windows sign-in can resume HindsightKit through a per-user task. Explicit pauses and startup
opt-out settings are preserved. Installation and service startup report progress and failures,
and Copilot discovery skips broken launchers when a working CLI is available.
Optional cleanup of older installations uses a cooperative time limit and retains unfinished work for retry.

## Install

Requires Windows x64, Git, and a GitHub account with Copilot access.
Setup reuses an existing Copilot CLI. If it is missing, setup installs the official CLI globally
with npm using your registry and proxy settings. Copilot CLI is not included in the archive.
Use Windows PowerShell 5.1 or PowerShell 7. Setup asks you to sign in to Copilot if needed.

The default installation sets up the memory server and coding integrations on this computer in one run.
No repository download is needed.
{login}
{fence}powershell
{local}
{fence}

After setup, reload VS Code and allow its Hindsight MCP server when prompted.
Open a new Copilot CLI session. Setup checks a temporary memory through Copilot and removes it afterward;
this uses a small amount of Copilot allowance.

## Pause repository memory

Inside a Git repository, use {tick}hindsightkit memory off{tick} to pause hooks and MCP memory tools.
Use {tick}hindsightkit memory on{tick} to re-enable them or {tick}hindsightkit memory status{tick} to check.
The setting stays local to this clone and its worktrees. Existing stored memory is preserved.
After upgrading, restart the Hindsight MCP server and open a new Copilot CLI session once.
After re-enabling memory, use a new session for automatic capture; paused sessions are not imported retroactively.

## Connect another computer later

Run {tick}hindsightkit share{tick} on the memory server.
{client_download}

{fence}powershell
{prepare_client}
{fence}

This prepares the client command without installing a local memory server or model.
Then run {tick}hindsightkit connect{tick} and paste the connection code at the hidden prompt.
The code contains a server key; transfer it privately and keep it out of Git and command-line arguments.

If direct networking is unavailable, use {tick}hindsightkit share --relay{tick}.
The private relay uses Microsoft Dev Tunnels and requires the same account on both computers.

## Advanced installation

{advanced}

For a dedicated server:

{fence}powershell
{server}
{fence}

For a client without a local database or model, replace the example address with your server's address:

{fence}powershell
{client}
{fence}
{download_issue}
## Downloads

The installer verifies the application, dependency, and PostgreSQL archives with SHA256.
New clients download {tick}{CLIENT_APP_NAME}{tick} and the client dependency components.
The default installation uses {tick}{APP_NAME}{tick} and the client and server components.
Upgrades reuse verified dependency downloads when their contents have not changed.
When dependencies change, the installer downloads the affected components automatically.
Computers with an existing local server keep the server components so their server can still be managed.
PostgreSQL includes pgvector and its required C++ runtime DLLs; no C++ compiler is needed.
{python_downloads}

Assets come from [this release]({release_url.replace('/download/', '/tag/')}) and use the fixed {tick}{version}{tick} tag.
{tick}SHA256SUMS{tick} covers every ZIP package, {tick}install.ps1{tick}, {tick}QUICKSTART.md{tick},
and {tick}release-notes.md{tick}. It does not include itself or GitHub's source archives.
"""


def package_release(*, version: str, repository: str, server_url: str,
                    postgres_directory: Path, python_directory: Path, node_directory: Path,
                    output: Path, source_root: Path,
                    visibility: str = "public"):
    release_url = release_identity(version, repository, server_url)
    if visibility not in {"public", "private", "internal"}:
        raise ValueError("Release visibility must be public, private, or internal")
    requires_auth = visibility != "public"
    source_root = ordinary_path(source_root)
    postgres_directory = ordinary_path(postgres_directory)
    python_directory = ordinary_path(python_directory)
    node_directory = ordinary_path(node_directory)
    output = ordinary_path(output)
    if not source_root.is_dir():
        raise ValueError("Source root is missing")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError("Output must be a new or empty directory")
    for input_root in (postgres_directory, python_directory, node_directory, source_root / "src",
                       source_root / "docs", source_root / "distribution"):
        if output == input_root or output.is_relative_to(input_root) or input_root.is_relative_to(output):
            raise ValueError("Output overlaps release inputs")
    config_path = ordinary_path(source_root / "pyproject.toml")
    config = tomllib.loads(config_path.read_text(encoding="utf-8-sig"))
    if version != "v" + config.get("project", {}).get("version", ""):
        raise ValueError("Release tag does not match pyproject.toml version")
    needles = machine_paths(source_root, postgres_directory, python_directory, node_directory)
    application = {}
    for name in APP_FILES:
        path = ordinary_path(source_root / name)
        if not path.is_file():
            raise ValueError(f"Required application file is missing: {name}")
        application["app/" + name] = (path, inspect_file(path, needles))
    for name in APP_DIRECTORIES:
        for path in tree_files(source_root / name, application=True):
            relative = path.relative_to(source_root).as_posix()
            application["app/" + relative] = (path, inspect_file(path, needles))
    bundled_python, python_summary = python_files(python_directory, source_root, needles)
    bundled_node, node_manifest = node_files(node_directory, source_root / "src/hindsightkit", needles)
    all_files = {**application, **bundled_python, **bundled_node}
    if len({name.lower() for name in all_files}) != len(all_files):
        raise ValueError("Duplicate Windows path in application package")
    postgres = postgres_files(postgres_directory, needles)
    template_path = ordinary_path(source_root / "distribution/install.ps1")
    inspect_file(template_path, needles)
    template = template_path.read_text(encoding="utf-8-sig")
    options_path = source_root / "src/hindsightkit/scripts/install_options.ps1"
    if "app/src/hindsightkit/scripts/install_options.ps1" not in application:
        raise ValueError("Shared installation options are missing")
    substitutions = {"@@VERSION@@": version, "@@RELEASE_URL@@": release_url,
                     "@@PACKAGE_NAME@@": APP_NAME, "@@PACKAGE_SHA256@@": "",
                     "@@CLIENT_PACKAGE_NAME@@": CLIENT_APP_NAME, "@@CLIENT_PACKAGE_SHA256@@": "",
                     "@@REPOSITORY@@": repository,
                     "@@REQUIRES_AUTH@@": "$true" if requires_auth else "$false",
                     "@@INSTALL_OPTIONS@@": options_path.read_text(encoding="utf-8-sig").rstrip()}
    if any(template.count(token) != 1 for token in substitutions) \
            or set(re.findall(r"@@[A-Z0-9_]+@@", template)) != set(substitutions):
        raise ValueError("Installer template must contain each supported token exactly once")
    with tempfile.TemporaryDirectory(prefix="hindsightkit-client-package-") as temporary:
        client_directory = Path(temporary) / "python"
        python_bundle_module().create_client_bundle(python_directory, client_directory, source_root)
        client_python, client_summary = python_files(client_directory, source_root, needles, profile="client")
        client_node_manifest = {**node_manifest, "bundles": {"client": node_manifest["bundles"]["client"]}}
        client_node = {"app/node/" + item["archive"]: bundled_node["app/node/" + item["archive"]]
                       for item in client_node_manifest["bundles"].values()}
        python_dependencies = dependency_wheels(bundled_python)
        client_dependencies = dependency_wheels(client_python)
        server_dependencies = {name: value for name, value in python_dependencies.items()
                               if name not in client_dependencies}
        full_application = {name: value for name, value in all_files.items()
                            if name not in python_dependencies
                            and name not in {"app/node/client.zip", "app/node/server.zip"}}
        client_application = {**application, **{name: value for name, value in client_python.items()
                                               if name not in client_dependencies}}
        output.mkdir(parents=True, exist_ok=True)
        components = [write_component(output, "python-client", client_dependencies),
                      write_component(output, "python-server", server_dependencies),
                      write_component(output, "node-client", client_node),
                      write_component(output, "node-server",
                                      {"app/node/server.zip": bundled_node["app/node/server.zip"]})]
        pg_hash = write_archive(output / POSTGRES_NAME, postgres)
        release = {"schema": 1, "version": version, "repository": repository, "release_url": release_url,
                   "requires_auth": requires_auth, "package_role": "full",
                   "components": components,
                   "python": python_summary,
                   "node": {"platform": node_manifest["platform"], "components": sorted(node_manifest["bundles"])},
                   "postgres": {"url": release_url + "/" + POSTGRES_NAME, "sha256": pg_hash,
                                "postgres_version": POSTGRES_VERSION, "vector_version": VECTOR_VERSION}}
        app_hash = write_archive(output / APP_NAME, full_application,
                                 {"app/release.json": json.dumps(release, indent=2) + "\n"})
        client_release = {**release, "package_role": "client", "python": client_summary,
                          "components": [item for item in components if item["name"].endswith("-client")],
                          "node": {"platform": node_manifest["platform"], "components": ["client"]}}
        client_hash = write_archive(output / CLIENT_APP_NAME, client_application,
                                    {"app/release.json": json.dumps(client_release, indent=2) + "\n",
                                     "app/node/node-bundle.json": json.dumps(client_node_manifest, indent=2) + "\n"})
    substitutions["@@PACKAGE_SHA256@@"] = app_hash
    substitutions["@@CLIENT_PACKAGE_SHA256@@"] = client_hash
    for token, value in substitutions.items():
        template = template.replace(token, value)
    (output / "install.ps1").write_text(template, encoding="utf-8", newline="\n")
    notes = installation_notes(version, release_url, repository, visibility)
    for name in ("QUICKSTART.md", "release-notes.md"):
        (output / name).write_text(notes, encoding="utf-8", newline="\n")
    assets = sorted(path for path in output.iterdir() if path.is_file())
    checksums = "".join(f"{inspect_file(path)}  {path.name}\n" for path in assets)
    (output / "SHA256SUMS").write_text(checksums, encoding="utf-8", newline="\n")
    return release


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--server-url", default="https://github.com")
    parser.add_argument("--visibility", choices=("public", "private", "internal"), default="public")
    parser.add_argument("--postgres-directory", type=Path, required=True)
    parser.add_argument("--python-directory", type=Path, required=True)
    parser.add_argument("--node-directory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    try:
        release = package_release(**vars(args))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(1, f"Release packaging failed: {exc}\n")
    print(json.dumps(release, indent=2))


if __name__ == "__main__":
    main()
