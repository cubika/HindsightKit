"""Build and verify the Windows Python wheels installed by a release."""
from __future__ import annotations

import argparse
from email.parser import BytesParser
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import stat
import struct
import subprocess
import sys
import tempfile
import tomllib
from urllib.parse import unquote, urlsplit
import zipfile

from packaging.markers import Marker, default_environment
from packaging.requirements import Requirement
from packaging.tags import compatible_tags, cpython_tags
from packaging.utils import canonicalize_name, parse_wheel_filename


MANIFEST_NAME = "python-bundle.json"
PROFILES = ("client", "server")
PIP_VERSION = "26.2.1"
BUILD_CONSTRAINTS = "setuptools==84.0.0\nwheel==0.48.0\n"
TARGET = {**default_environment(), "implementation_name": "cpython",
          "implementation_version": "3.12.0", "os_name": "nt",
          "platform_machine": "AMD64", "platform_python_implementation": "CPython",
          "platform_system": "Windows", "python_full_version": "3.12.0",
          "python_version": "3.12", "sys_platform": "win32", "extra": ""}
WINDOWS_TAGS = set(cpython_tags((3, 12), platforms=["win_amd64"])) | set(
    compatible_tags((3, 12), interpreter="cp312", platforms=["win_amd64"]))
APP_SUFFIXES = {".py", ".mjs", ".json", ".ps1", ".html", ".css", ".js"}
PRIVATE_NAMES = {"credentials.json", "secrets.json", "secrets.dpapi", "connection.json",
                 "installation.json", "active.json", "cluster.json", "pg_hba.conf",
                 "pg_ident.conf", "postmaster.pid", "postmaster.opts"}
SKIP_DIRECTORIES = {"__pycache__", "node_modules", ".venv", ".runtime", ".git",
                    ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache"}


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def ordinary_path(path: Path) -> Path:
    path = Path(os.path.abspath(path))
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError(f"Linked path is not a Python bundle input: {item}")
    return path


def applies(marker: str | None) -> bool:
    return not marker or Marker(marker).evaluate(TARGET)


def identity(package: dict) -> tuple[str, str]:
    return canonicalize_name(package["name"]), package["version"]


def locked_profiles(lock: dict) -> dict[str, dict[tuple[str, str], dict]]:
    """Select the two Windows dependency closures without resolving new versions."""
    candidates = {}
    for package in lock["package"]:
        candidates.setdefault(canonicalize_name(package["name"]), []).append(package)
    roots = candidates.get("hindsightkit", [])
    if len(roots) != 1 or roots[0].get("source") != {"editable": "."}:
        raise ValueError("Lockfile must contain the local HindsightKit project")
    profiles = {}
    for profile in PROFILES:
        pending = [(roots[0], ("server",) if profile == "server" else ())]
        selected, visited = {}, set()
        while pending:
            package, extras = pending.pop()
            key = identity(package)
            selected[key] = package
            visit = (key, tuple(sorted(extras)))
            if visit in visited:
                continue
            visited.add(visit)
            dependencies = list(package.get("dependencies", []))
            for extra in extras:
                dependencies.extend(package.get("optional-dependencies", {}).get(extra, []))
            for dependency in dependencies:
                if not applies(dependency.get("marker")):
                    continue
                matches = [item for item in candidates.get(canonicalize_name(dependency["name"]), [])
                           if (not dependency.get("version") or item["version"] == dependency["version"])
                           and (not dependency.get("source") or item["source"] == dependency["source"])
                           and (not item.get("resolution-markers")
                                or any(applies(marker) for marker in item["resolution-markers"]))]
                if len(matches) != 1:
                    raise ValueError(f"Ambiguous locked dependency: {dependency['name']}")
                pending.append((matches[0], tuple(dependency.get("extra", []))))
        profiles[profile] = selected
    return profiles


def parse_requirements(content: str) -> dict[tuple[str, str], set[str]]:
    result = {}
    for line in re.sub(r"\\\r?\n\s*", " ", content).splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        pieces = re.split(r"\s+--hash=sha256:", line)
        requirement = Requirement(pieces[0])
        if requirement.url or requirement.extras or len(requirement.specifier) != 1:
            raise ValueError("Bundle requirements must be exact package pins")
        specifier = next(iter(requirement.specifier))
        if specifier.operator != "==" or "*" in specifier.version:
            raise ValueError("Bundle requirements must be exact package pins")
        hashes = set(pieces[1:])
        if not hashes or any(not re.fullmatch(r"[a-f0-9]{64}", value) for value in hashes):
            raise ValueError("Bundle requirements must contain SHA256 hashes")
        if requirement.marker and not requirement.marker.evaluate(TARGET):
            continue
        key = canonicalize_name(requirement.name), specifier.version
        if key in result:
            raise ValueError(f"Duplicate bundle requirement: {key[0]}")
        result[key] = hashes
    return result


def wheel_identity(path: Path, *, source_root: Path | None = None) -> tuple[str, str]:
    name, version, _, tags = parse_wheel_filename(path.name)
    if not tags & WINDOWS_TAGS:
        raise ValueError(f"Wheel is incompatible with Windows x64 CPython 3.12: {path.name}")
    with zipfile.ZipFile(path) as archive:
        seen = set()
        for item in archive.infolist():
            relative = item.filename.rstrip("/")
            parts = relative.split("/")
            if not relative or any(part in {"", ".", ".."} or part.endswith((".", " "))
                                   or re.search(r'[\x00-\x1f<>:"|?*\\]', part)
                                   or re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part)
                                   for part in parts) or relative.lower() in seen:
                raise ValueError(f"Unsafe or duplicate wheel path: {item.filename}")
            seen.add(relative.lower())
            if stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError(f"Linked file in wheel: {item.filename}")
            if name == "hindsightkit":
                member = PurePosixPath(relative.lower())
                if member.name in PRIVATE_NAMES or member.name == ".env" or member.name.startswith(".env.") \
                        or member.suffix in {".pem", ".key", ".pfx", ".p12"} \
                        or any(part in SKIP_DIRECTORIES for part in member.parts):
                    raise ValueError(f"Private or runtime file in application wheel: {relative}")
        metadata_names = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
        if len(metadata_names) != 1:
            raise ValueError(f"Wheel must contain one package metadata file: {path.name}")
        metadata = BytesParser().parsebytes(archive.read(metadata_names[0]))
        if canonicalize_name(metadata.get("Name", "")) != name or metadata.get("Version") != str(version):
            raise ValueError(f"Wheel metadata differs from its filename: {path.name}")
        if name == "hindsightkit" and source_root is not None:
            source_package = source_root / "src/hindsightkit"
            expected = {}
            if source_package.is_dir():
                pending = [source_package]
                while pending:
                    for source in pending.pop().iterdir():
                        ordinary_path(source)
                        if source.name in SKIP_DIRECTORIES:
                            continue
                        if source.is_dir():
                            pending.append(source)
                        elif source.suffix in APP_SUFFIXES:
                            expected[source.relative_to(source_root / "src").as_posix()] = source
                actual = {item.filename for item in archive.infolist()
                          if not item.is_dir() and item.filename.startswith("hindsightkit/")}
                if actual != set(expected):
                    raise ValueError("Application wheel files differ from the current source files")
                for relative, source in expected.items():
                    if hashlib.sha256(archive.read(relative)).hexdigest() != sha256(source):
                        raise ValueError(f"Application wheel contains stale source: {relative}")
    return name, str(version)


def source_metadata(source_root: Path):
    config = tomllib.loads((source_root / "pyproject.toml").read_text(encoding="utf-8-sig"))
    lock = tomllib.loads((source_root / "uv.lock").read_text(encoding="utf-8-sig"))
    project_version = config["project"]["version"]
    profiles = locked_profiles(lock)
    if ("hindsightkit", project_version) not in profiles["server"]:
        raise ValueError("Project and lockfile versions differ")
    return project_version, profiles


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate Python bundle manifest key: {key}")
        result[key] = value
    return result


def validate_bundle(bundle_directory: Path, source_root: Path) -> dict:
    """Verify complete locked profiles, unmodified upstream wheels, and file hashes."""
    bundle_directory, source_root = ordinary_path(bundle_directory), ordinary_path(source_root)
    project_version, profiles = source_metadata(source_root)
    manifest_path = ordinary_path(bundle_directory / MANIFEST_NAME)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    expected = {"schema": 1, "python": "3.12", "platform": "windows-x64",
                "project_version": project_version, "lock_sha256": sha256(source_root / "uv.lock")}
    if set(manifest) != set(expected) | {"files"} or any(manifest.get(key) != value for key, value in expected.items()):
        raise ValueError("Python bundle manifest differs from the project or lockfile")
    declared = manifest["files"]
    if not isinstance(declared, dict) or not {f"requirements-{profile}.txt" for profile in PROFILES} <= set(declared):
        raise ValueError("Python bundle manifest is missing profile requirements")
    actual_files = {}
    for path in bundle_directory.rglob("*"):
        ordinary_path(path)
        relative = path.relative_to(bundle_directory).as_posix()
        if path.is_dir():
            if relative != "wheels":
                raise ValueError(f"Unexpected Python bundle directory: {relative}")
            continue
        if relative == MANIFEST_NAME:
            continue
        if not re.fullmatch(r"requirements-(?:client|server)\.txt|wheels/[A-Za-z0-9_.+-]+\.whl", relative):
            raise ValueError(f"Unexpected Python bundle file: {relative}")
        actual_files[relative] = sha256(path)
    if len({name.lower() for name in declared}) != len(declared) or actual_files != declared:
        raise ValueError("Python bundle files failed SHA256 verification")
    wheels = {}
    for relative, digest in actual_files.items():
        if not relative.startswith("wheels/"):
            continue
        path = bundle_directory / relative
        key = wheel_identity(path, source_root=source_root)
        if key in wheels:
            raise ValueError(f"Duplicate package wheel: {key[0]}")
        if key not in profiles["server"]:
            raise ValueError(f"Wheel is not in the server dependency lock: {path.name}")
        if key[0] != "hindsightkit":
            package = profiles["server"][key]
            sources = {unquote(Path(urlsplit(item["url"]).path).name): item["hash"]
                       for item in package.get("wheels", [])}
            if sources.get(path.name) != "sha256:" + digest:
                raise ValueError(f"Wheel differs from the upstream dependency lock: {path.name}")
        wheels[key] = digest
    if set(wheels) != set(profiles["server"]):
        raise ValueError("Python bundle is missing locked server wheels")
    for profile in PROFILES:
        requirements = parse_requirements((bundle_directory / f"requirements-{profile}.txt").read_text(encoding="utf-8"))
        if set(requirements) != set(profiles[profile]):
            raise ValueError(f"Python {profile} requirements differ from the locked dependency graph")
        if any(hashes != {wheels[key]} for key, hashes in requirements.items()):
            raise ValueError(f"Python {profile} requirement hashes differ from the bundled wheels")
    return manifest


def run(arguments, *, cwd: Path, capture=False):
    result = subprocess.run([str(value) for value in arguments], cwd=cwd, check=True,
                            text=True, encoding="utf-8", capture_output=capture)
    return result.stdout if capture else None


def build_bundle(*, source_root: Path, output: Path, uv: str = "uv") -> dict:
    if sys.platform != "win32" or platform.python_implementation() != "CPython" \
            or sys.version_info[:2] != (3, 12) or struct.calcsize("P") != 8 \
            or platform.machine().lower() not in {"amd64", "x86_64"}:
        raise ValueError("Build Python bundles with Windows x64 CPython 3.12")
    source_root, output = ordinary_path(source_root), ordinary_path(output)
    if output == source_root or source_root.is_relative_to(output):
        raise ValueError("Python bundle output overlaps its source root")
    for name in ("src", "docs", "distribution"):
        input_directory = source_root / name
        if output == input_directory or output.is_relative_to(input_directory):
            raise ValueError("Python bundle output overlaps source inputs")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError("Python bundle output must be new or empty")
    project_version, profiles = source_metadata(source_root)
    output.mkdir(parents=True, exist_ok=True)
    wheels_directory = output / "wheels"
    wheels_directory.mkdir()
    with tempfile.TemporaryDirectory(prefix="hindsightkit-python-") as temporary:
        work = Path(temporary)
        for profile in PROFILES:
            args = [uv, "export", "--project", source_root, "--frozen", "--no-dev",
                    "--no-emit-project", "--no-header", "--no-annotate", "--format", "requirements-txt"]
            if profile == "server":
                args += ["--extra", "server"]
            exported = run(args, cwd=source_root, capture=True)
            if set(parse_requirements(exported)) != set(profiles[profile]) - {("hindsightkit", project_version)}:
                raise ValueError(f"uv export differs from the locked {profile} dependency graph")
            (work / f"{profile}.txt").write_text(exported, encoding="utf-8")
        run([uv, "run", "--no-project", "--isolated", "--python", sys.executable,
             "--with", f"pip=={PIP_VERSION}", "python", "-m", "pip", "download",
             "--disable-pip-version-check", "--no-deps", "--only-binary=:all:",
             "--require-hashes", "--dest", wheels_directory, "--requirement", work / "server.txt"], cwd=source_root)
        constraints = work / "build-constraints.txt"
        constraints.write_text(BUILD_CONSTRAINTS, encoding="utf-8")
        run([uv, "build", source_root, "--wheel", "--out-dir", wheels_directory,
             "--no-create-gitignore", "--python", sys.executable, "--build-constraints", constraints], cwd=source_root)
    wheels = {}
    for path in wheels_directory.iterdir():
        if path.suffix != ".whl":
            raise ValueError(f"Builder produced a non-wheel file: {path.name}")
        key = wheel_identity(path)
        if key in wheels:
            raise ValueError(f"Builder produced duplicate package wheels: {key[0]}")
        wheels[key] = sha256(path)
    if set(wheels) != set(profiles["server"]):
        raise ValueError("Downloaded wheels differ from the locked Windows server dependencies")
    for profile in PROFILES:
        requirements = "".join(f"{name}=={version} --hash=sha256:{wheels[(name, version)]}\n"
                               for name, version in sorted(profiles[profile]))
        (output / f"requirements-{profile}.txt").write_text(requirements, encoding="utf-8", newline="\n")
    manifest = {"schema": 1, "python": "3.12", "platform": "windows-x64",
                "project_version": project_version, "lock_sha256": sha256(source_root / "uv.lock"),
                "files": {path.relative_to(output).as_posix(): sha256(path)
                          for path in sorted(output.rglob("*")) if path.is_file()}}
    (output / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
    return validate_bundle(output, source_root)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--uv", default="uv")
    args = parser.parse_args(argv)
    try:
        manifest = build_bundle(**vars(args))
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError, zipfile.BadZipFile) as exc:
        parser.exit(1, f"Python bundle build failed: {exc}\n")
    print(f"Verified Windows Python bundle: {len(manifest['files']) - 2} wheels.")


if __name__ == "__main__":
    main()
