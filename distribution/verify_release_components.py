"""Verify and assemble release assets before testing offline installation."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import tomllib
import zipfile

from package_release import (APP_NAME, CLIENT_APP_NAME, inspect_file, ordinary_path,
                             relative_name, release_identity, unique_object,
                             validate_node_bundle, validate_python_bundle)


def archive_files(archive: zipfile.ZipFile) -> dict:
    files = {}
    seen = set()
    for item in archive.infolist():
        name = relative_name(item.filename)
        if (not name.startswith("app/") or item.is_dir()
                or stat.S_ISLNK(item.external_attr >> 16) or name.lower() in seen):
            raise ValueError(f"Unsafe or duplicate release archive entry: {name}")
        seen.add(name.lower())
        files[name] = item
    for name in files:
        if any(parent.as_posix().lower() in seen for parent in PurePosixPath(name).parents):
            raise ValueError(f"Release archive file overlaps a directory: {name}")
    return files


def checksums(release_directory: Path) -> dict:
    result = {}
    for line in (release_directory / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  ([A-Za-z0-9_.-]+)", line)
        if not match or match[2].lower() in {name.lower() for name in result}:
            raise ValueError("Invalid release SHA256SUMS entry")
        relative_name(match[2])
        result[match[2]] = match[1]
    assets = {path.name for path in release_directory.iterdir() if path.name != "SHA256SUMS"}
    if set(result) != assets:
        raise ValueError("Release assets differ from SHA256SUMS")
    for name, digest in result.items():
        if inspect_file(release_directory / name) != digest:
            raise ValueError(f"Release asset failed SHA256 verification: {name}")
    return result


def component_files(component: dict) -> dict:
    if not isinstance(component, dict) or set(component) != {"name", "asset", "sha256", "files"}:
        raise ValueError("Invalid release component manifest")
    name, digest = component["name"], component["sha256"]
    if (name not in {"python-client", "python-server", "node-client", "node-server"}
            or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
            or component["asset"] != f"hindsightkit-{name}-{digest}.zip"):
        raise ValueError("Invalid content-addressed release component")
    declared = component["files"]
    if not isinstance(declared, dict):
        raise ValueError("Release component has no file hashes")
    expected = {}
    for relative, checksum in declared.items():
        relative_name(relative)
        if not isinstance(checksum, str) or not re.fullmatch(r"[a-f0-9]{64}", checksum):
            raise ValueError("Invalid release component file checksum")
        if name.startswith("python-"):
            if (not re.fullmatch(r"python/wheels/[A-Za-z0-9_.+-]+\.whl", relative)
                    or Path(relative).name.lower().startswith("hindsightkit-")):
                raise ValueError("Python component must contain dependency wheels only")
        elif relative != "node/" + name.removeprefix("node-") + ".zip":
            raise ValueError("Node component contains an unexpected file")
        expected["app/" + relative] = checksum
    if name.startswith("node-") and len(expected) != 1:
        raise ValueError("Node component archive is missing")
    return expected


def extract(archive_path: Path, output: Path, written: set, expected=None):
    with zipfile.ZipFile(archive_path) as archive:
        files = archive_files(archive)
        if expected is not None and set(files) != set(expected):
            raise ValueError("Release component files differ from its manifest")
        for name, item in files.items():
            folded = name.lower()
            if (folded in written or any(parent.as_posix().lower() in written for parent in Path(name).parents)
                    or any(path.startswith(folded + "/") for path in written)):
                raise ValueError(f"Release assets contain overlapping files: {name}")
            target = ordinary_path(output / name)
            target.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            with archive.open(item) as source, target.open("xb") as destination:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
                    destination.write(chunk)
            if expected is not None and digest.hexdigest() != expected[name]:
                raise ValueError(f"Release component file failed SHA256 verification: {name}")
            written.add(folded)


def verify(*, release_directory: Path, application: str, output: Path) -> dict:
    release_directory, output = ordinary_path(release_directory), ordinary_path(output)
    if application not in {APP_NAME, CLIENT_APP_NAME}:
        raise ValueError("Unknown application archive")
    if output == release_directory or output.is_relative_to(release_directory) or release_directory.is_relative_to(output):
        raise ValueError("Verification output overlaps release assets")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError("Verification output must be new or empty")
    assets = checksums(release_directory)
    with zipfile.ZipFile(release_directory / application) as archive:
        archive_files(archive)
        release = json.loads(archive.read("app/release.json"), object_pairs_hook=unique_object)
    role = "client" if application == CLIENT_APP_NAME else "full"
    if release.get("schema") != 1 or release.get("package_role") != role:
        raise ValueError("Release application role differs from its archive")
    components = release.get("components")
    names = {"python-client", "node-client"}
    if role == "full":
        names |= {"python-server", "node-server"}
    if not isinstance(components, list) or len(components) != len(names):
        raise ValueError("Release component roles are incomplete")
    declared = [(component, component_files(component)) for component in components]
    if {component["name"] for component in components} != names:
        raise ValueError("Release component roles differ from its application")
    for component, _ in declared:
        if assets.get(component["asset"]) != component["sha256"]:
            raise ValueError("Release component differs from SHA256SUMS")
    output.mkdir(parents=True, exist_ok=True)
    written = set()
    extract(release_directory / application, output, written)
    for component, files in declared:
        extract(release_directory / component["asset"], output, written, files)
    source = output / "app"
    project = tomllib.loads((source / "pyproject.toml").read_text(encoding="utf-8-sig"))
    if release.get("version") != "v" + project["project"]["version"]:
        raise ValueError("Release version differs from its application")
    repository = release.get("repository", "")
    release_url = release.get("release_url", "")
    origin = "/".join(release_url.split("/")[:3])
    if release_url != release_identity(release["version"], repository, origin):
        raise ValueError("Release URL differs from its repository")
    validate_python_bundle(source / "python", source, profile=role)
    roles = ("client",) if role == "client" else ("client", "server")
    node = validate_node_bundle(source / "node", source / "src/hindsightkit", roles=roles)
    if set(node["bundles"]) != ({"client"} if role == "client" else {"client", "server"}):
        raise ValueError("Node bundle roles differ from its application")
    return release


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-directory", type=Path, required=True)
    parser.add_argument("--application", choices=(APP_NAME, CLIENT_APP_NAME), default=APP_NAME)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        release = verify(**vars(args))
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as exc:
        parser.exit(1, f"Release composition failed: {exc}\n")
    print(json.dumps({"version": release["version"], "role": release["package_role"],
                      "components": len(release["components"]), "verified": True}))


if __name__ == "__main__":
    main()
