"""Build the locked official npm components for Windows release installation."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

from package_release import ordinary_path, relative_name, write_archive


ROLES = ("client", "server")
MANIFEST_NAME = "node-bundle.json"


def run(command, *, cwd, env=None, capture=False):
    result = subprocess.run([str(value) for value in command], cwd=cwd, env=env, check=True,
                            text=True, encoding="utf-8", errors="replace", capture_output=capture)
    return result.stdout.strip() if capture else None


def node_files(root: Path):
    """Keep upstream bytes and licenses; reject links and local npm settings."""
    pending = [ordinary_path(root / "node_modules")]
    files = {}
    seen = set()
    started = last_progress = time.monotonic()
    while pending:
        directory = pending.pop()
        for path in sorted(directory.iterdir()):
            ordinary_path(path)
            name = relative_name(path.relative_to(root).as_posix())
            if name.lower() in seen:
                raise ValueError(f"Duplicate Windows path in npm output: {name}")
            seen.add(name.lower())
            if path.name.lower() in {".npmrc", ".env", ".npm", ".cache"} or path.name.lower().startswith(".env."):
                raise ValueError(f"Local configuration or cache in npm output: {name}")
            if path.is_dir():
                pending.append(path)
            elif path.is_file():
                with path.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                files[name] = (path, digest)
                if time.monotonic() - last_progress >= 10:
                    print(f"Inspecting npm files: {len(files)} verified (elapsed {time.monotonic() - started:.1f}s).", flush=True)
                    last_progress = time.monotonic()
            else:
                raise ValueError(f"Non-file npm output: {name}")
    if not files:
        raise ValueError("npm produced an empty dependency tree")
    return files


def build_bundle(*, source_root: Path, output: Path, node: str = "node") -> dict:
    if sys.platform != "win32" or platform.machine().lower() not in {"amd64", "x86_64"}:
        raise ValueError("Build Node bundles on Windows x64")
    source_root, output = ordinary_path(source_root), ordinary_path(output)
    if output == source_root or source_root.is_relative_to(output):
        raise ValueError("Node bundle output overlaps its source root")
    for name in ("src", "docs", "distribution"):
        source = source_root / name
        if output == source or output.is_relative_to(source):
            raise ValueError("Node bundle output overlaps source inputs")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError("Node bundle output must be new or empty")
    binary = shutil.which(node)
    if not binary:
        raise ValueError("Node.js is required to build the dependency bundle")
    identity = json.loads(run([binary, "-p", "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})"],
                              cwd=source_root, capture=True))
    if identity.get("platform") != "win32" or identity.get("arch") != "x64" or int(identity["version"].split(".")[0]) < 22:
        raise ValueError("Node bundles require Windows x64 Node.js 22+")
    npm = Path(binary).resolve().parent / "node_modules/npm/bin/npm-cli.js"
    if not npm.is_file():
        raise ValueError("Cannot find npm beside the selected Node.js")
    package_directory = source_root / "src/hindsightkit"
    sys.path.insert(0, str(source_root / "src"))
    from hindsightkit.setup.node_bundle import package_directory as role_directory, validate_bundle

    with tempfile.TemporaryDirectory(prefix="hindsightkit-node-build-") as temporary:
        work = Path(temporary)
        bundled = work / "bundle"
        bundled.mkdir()
        user_config, global_config = work / "user.npmrc", work / "global.npmrc"
        user_config.write_text("", encoding="utf-8")
        global_config.write_text("", encoding="utf-8")
        env = os.environ.copy()
        env["PATH"] = str(Path(binary).parent) + os.pathsep + env.get("PATH", "")
        manifest = {"schema": 1, "platform": "windows-x64", "bundles": {}}
        for role in ROLES:
            print(f"Building {role} npm components...", flush=True)
            source = role_directory(package_directory, role)
            target = work / role
            target.mkdir()
            for name in ("package.json", "package-lock.json"):
                shutil.copyfile(ordinary_path(source / name), target / name)
            lock_bytes = (target / "package-lock.json").read_bytes()
            run([binary, npm, "ci", "--omit=dev", "--include=optional", "--ignore-scripts=false",
                 "--no-audit", "--no-fund", "--foreground-scripts", "--loglevel=info",
                 "--registry=https://registry.npmjs.org", "--userconfig", user_config,
                 "--globalconfig", global_config, "--cache", work / "cache"], cwd=target, env=env)
            if (target / "package-lock.json").read_bytes() != lock_bytes:
                raise ValueError(f"npm changed the locked {role} dependency graph")
            archive_name = role + ".zip"
            print(f"npm completed for {role}; inspecting files for {archive_name}...", flush=True)
            files = node_files(target)
            print(f"Packing {archive_name}: {len(files)} files...", flush=True)
            started = time.monotonic()
            digest = write_archive(bundled / archive_name, files, progress_label=archive_name)
            print(f"Packed {archive_name} (elapsed {time.monotonic() - started:.1f}s).", flush=True)
            manifest["bundles"][role] = {"archive": archive_name, "sha256": digest,
                                           "lock_sha256": hashlib.sha256(lock_bytes).hexdigest()}
        (bundled / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
        print("Validating npm archives...", flush=True)
        validate_bundle(bundled, package_directory)
        output.mkdir(parents=True, exist_ok=True)
        for path in bundled.iterdir():
            shutil.copyfile(path, output / path.name)
    manifest = validate_bundle(output, package_directory)
    print(f"Testing offline installation from {output}...", flush=True)
    try:
        run([sys.executable, source_root / "distribution/verify_node_install.py",
             "--bundle", output, "--package", package_directory], cwd=source_root, env=env)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ValueError(f"Offline Node installation validation failed. Build is incomplete; archives were retained at {output}. "
                         f"After fixing the failure, rerun distribution/verify_node_install.py --bundle \"{output}\" "
                         f"--package \"{package_directory}\".") from exc
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--node", default="node")
    args = parser.parse_args(argv)
    try:
        manifest = build_bundle(**vars(args))
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError, zipfile.BadZipFile) as exc:
        parser.exit(1, f"Node bundle build failed: {exc}\n")
    print(f"Verified Windows Node bundle: {len(manifest['bundles'])} component archives.")


if __name__ == "__main__":
    main()
