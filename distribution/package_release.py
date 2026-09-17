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
import tomllib
from urllib.parse import urlsplit
import zipfile


APP_NAME = "hindsightkit-windows-x64.zip"
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
APP_FILES = ("setup.ps1", "pyproject.toml", "uv.lock", "README.md")
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


def validate_python_bundle(bundle_directory: Path, source_root: Path) -> dict:
    spec = importlib.util.spec_from_file_location(
        "hindsightkit_python_bundle", Path(__file__).with_name("build_python_bundle.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate_bundle(bundle_directory, source_root)


def python_files(root: Path, source_root: Path, needles: tuple[bytes, ...]):
    manifest_hash = inspect_file(root / "python-bundle.json", needles)
    manifest = validate_python_bundle(root, source_root)
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


def write_archive(destination: Path, files, extra=None):
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
        for name, content in sorted((extra or {}).items()):
            relative_name(name)
            if name in files:
                raise ValueError(f"Duplicate release package entry: {name}")
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content)
    return inspect_file(destination)


def installation_notes(version: str, release_url: str, repository: str, visibility: str) -> str:
    installer = release_url + "/install.ps1"
    tick = chr(96)
    fence = tick * 3
    login = ""
    if visibility == "public":
        local = f"irm '{installer}' | iex"
        server = f"& ([scriptblock]::Create((irm '{installer}'))) -ServerOnly"
        client = f"& ([scriptblock]::Create((irm '{installer}'))) -Server 'http://server-host:9077'"
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
                        "Pinned Python packages are bundled in the application archive from this release; "
                        "setup installs them without contacting PyPI.\n"
                        "The Python interpreter, Node.js, npm dependencies, and the embedding model still download during setup.")
    return f"""# HindsightKit {version}

Requires Windows x64, Git, and a GitHub account with Copilot access.
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

## Connect another computer later

After installation, run {tick}hindsightkit share{tick} on the memory server and
{tick}hindsightkit connect{tick} on the other computer. Paste the connection code at the hidden prompt.
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

The installer verifies the application and PostgreSQL archives with SHA256.
PostgreSQL includes pgvector and its required C++ runtime DLLs; no C++ compiler is needed.
{python_downloads}

Assets come from [this release]({release_url.replace('/download/', '/tag/')}) and use the fixed {tick}{version}{tick} tag.
{tick}SHA256SUMS{tick} covers the two ZIP packages, {tick}install.ps1{tick}, {tick}QUICKSTART.md{tick},
and {tick}release-notes.md{tick}. It does not include itself or GitHub's source archives.
"""


def package_release(*, version: str, repository: str, server_url: str,
                    postgres_directory: Path, python_directory: Path, output: Path, source_root: Path,
                    visibility: str = "public"):
    release_url = release_identity(version, repository, server_url)
    if visibility not in {"public", "private", "internal"}:
        raise ValueError("Release visibility must be public, private, or internal")
    requires_auth = visibility != "public"
    source_root = ordinary_path(source_root)
    postgres_directory = ordinary_path(postgres_directory)
    python_directory = ordinary_path(python_directory)
    output = ordinary_path(output)
    if not source_root.is_dir():
        raise ValueError("Source root is missing")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError("Output must be a new or empty directory")
    for input_root in (postgres_directory, python_directory, source_root / "src",
                       source_root / "docs", source_root / "distribution"):
        if output == input_root or output.is_relative_to(input_root) or input_root.is_relative_to(output):
            raise ValueError("Output overlaps release inputs")
    config_path = ordinary_path(source_root / "pyproject.toml")
    config = tomllib.loads(config_path.read_text(encoding="utf-8-sig"))
    if version != "v" + config.get("project", {}).get("version", ""):
        raise ValueError("Release tag does not match pyproject.toml version")
    needles = machine_paths(source_root, postgres_directory, python_directory)
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
    application.update(bundled_python)
    if len({name.lower() for name in application}) != len(application):
        raise ValueError("Duplicate Windows path in application package")
    postgres = postgres_files(postgres_directory, needles)
    template_path = ordinary_path(source_root / "distribution/install.ps1")
    inspect_file(template_path, needles)
    template = template_path.read_text(encoding="utf-8-sig")
    substitutions = {"@@VERSION@@": version, "@@RELEASE_URL@@": release_url,
                     "@@PACKAGE_NAME@@": APP_NAME, "@@PACKAGE_SHA256@@": "",
                     "@@REPOSITORY@@": repository,
                     "@@REQUIRES_AUTH@@": "$true" if requires_auth else "$false"}
    if any(template.count(token) != 1 for token in substitutions) \
            or set(re.findall(r"@@[A-Z0-9_]+@@", template)) != set(substitutions):
        raise ValueError("Installer template must contain each supported token exactly once")
    output.mkdir(parents=True, exist_ok=True)
    pg_hash = write_archive(output / POSTGRES_NAME, postgres)
    release = {"schema": 1, "version": version, "repository": repository, "release_url": release_url,
               "requires_auth": requires_auth,
               "python": python_summary,
               "postgres": {"url": release_url + "/" + POSTGRES_NAME, "sha256": pg_hash,
                            "postgres_version": POSTGRES_VERSION, "vector_version": VECTOR_VERSION}}
    app_hash = write_archive(output / APP_NAME, application,
                             {"app/release.json": json.dumps(release, indent=2) + "\n"})
    substitutions["@@PACKAGE_SHA256@@"] = app_hash
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
