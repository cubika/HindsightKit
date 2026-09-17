"""Verify and install the official Windows npm components from release archives."""
from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import zipfile


MANIFEST = 'node-bundle.json'
ENTRYPOINTS = {
    'client': ('node_modules/@vectorize-io/hindsight-coding-agents/dist/installer.js',
               'node_modules/@vectorize-io/hindsight-coding-agents/dist/copilot-stop-hook.js',
               'node_modules/jsonc-parser/lib/umd/main.js'),
}
ENTRYPOINTS['server'] = ENTRYPOINTS['client'] + (
    'node_modules/@vectorize-io/hindsight-control-plane/standalone/server.js',)


def package_directory(package: Path, role: str) -> Path:
    if role not in ENTRYPOINTS:
        raise ValueError('Unknown npm bundle role')
    return package if role == 'server' else package / role


def sha256(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def ordinary_path(path: Path) -> Path:
    path = Path(os.path.abspath(path))
    for parent in (path, *path.parents):
        try:
            info = parent.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError(f'Linked npm bundle path: {parent}')
    return path


def _ordinary_files(directory: Path):
    # scandir supplies Windows file attributes without statting every ancestor
    # again for each of the dashboard's tens of thousands of files.
    pending = [ordinary_path(directory)]
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                info = entry.stat(follow_symlinks=False)
                path = Path(entry.path)
                if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                    raise ValueError(f'Linked npm bundle path: {path}')
                if stat.S_ISDIR(info.st_mode):
                    pending.append(path)
                elif stat.S_ISREG(info.st_mode):
                    yield path, info
                else:
                    raise ValueError(f'Npm bundle path is not an ordinary file: {path}')


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate npm manifest key')
        value[key] = item
    return value


def _read_json(content):
    return json.loads(content, object_pairs_hook=_unique)


def _members(archive):
    names = {}
    for item in archive.infolist():
        if item.orig_filename != item.filename:
            raise ValueError(f'Normalized npm archive entry: {item.orig_filename}')
        name = item.filename.rstrip('/')
        parts = PurePosixPath(name).parts
        if (not parts or parts[0] != 'node_modules' or name.startswith('/') or chr(92) in name or
                any(not part or part in ('.', '..') or part.rstrip(' .') != part or
                    re.search(r'[<>:"|?*\x00-\x1f]', part) or
                    re.fullmatch(r'(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part)
                    for part in name.split('/')) or
                stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1):
            raise ValueError(f'Unsafe npm archive entry: {item.filename}')
        key = name.casefold()
        if key in names:
            raise ValueError(f'Duplicate npm archive entry: {name}')
        names[key] = item
    for item in names.values():
        for parent in PurePosixPath(item.filename).parents:
            existing = names.get(str(parent).casefold())
            if existing and not existing.is_dir():
                raise ValueError('Npm archive file conflicts with a directory')
    return names


def _platform_matches(item):
    for key, expected in (('os', 'win32'), ('cpu', 'x64')):
        values = item.get(key, [])
        if '!' + expected in values or (any(not v.startswith('!') for v in values) and expected not in values):
            return False
    return True


def _check_packages(lock, read, exists):
    if not isinstance(lock.get('packages'), dict):
        raise ValueError('Npm lockfile has no packages')
    for name, item in lock['packages'].items():
        if not name or item.get('dev') or not _platform_matches(item):
            continue
        metadata = name + '/package.json'
        if item.get('optional') and not exists(metadata):
            continue
        installed = _read_json(read(metadata)) if exists(metadata) else None
        if not isinstance(installed, dict) or installed.get('version') != item.get('version'):
            raise ValueError(f'Npm bundle is missing locked package: {name}@{item.get("version")}')


def validate_bundle(bundle_directory: Path, package_directory: Path, roles=('client', 'server')) -> dict:
    root = ordinary_path(bundle_directory)
    manifest = _read_json(ordinary_path(root / MANIFEST).read_text(encoding='utf-8'))
    if manifest.get('schema') != 1 or manifest.get('platform') != 'windows-x64':
        raise ValueError('Npm bundle requires schema 1 and windows-x64')
    bundles = manifest.get('bundles')
    if not isinstance(bundles, dict) or not set(bundles).issubset(ENTRYPOINTS) or not set(roles).issubset(bundles):
        raise ValueError('The release npm bundle is incomplete; download a complete release')
    for role in roles:
        entry = bundles[role]
        source = package_directory if role == 'server' else package_directory / role
        lock_path = ordinary_path(source / 'package-lock.json')
        if (entry.get('archive') != role + '.zip' or entry.get('lock_sha256') != sha256(lock_path) or
                not re.fullmatch('[a-f0-9]{64}', str(entry.get('sha256', '')))):
            raise ValueError(f'Npm {role} bundle differs from its lockfile')
        path = ordinary_path(root / entry['archive'])
        with path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != entry['sha256']:
                raise ValueError(f'Npm {role} archive failed SHA256 verification')
            stream.seek(0)
            with zipfile.ZipFile(stream) as archive:
                members = _members(archive)
                exists = lambda name: name.casefold() in members and not members[name.casefold()].is_dir()
                if not all(exists(name) for name in ENTRYPOINTS[role]):
                    raise ValueError(f'Npm {role} entry point is missing')
                _check_packages(_read_json(lock_path.read_bytes()), archive.read, exists)
    return manifest


def release_bundle() -> Path | None:
    manifest = os.environ.get('HINDSIGHTKIT_RELEASE_MANIFEST')
    if manifest:
        return Path(manifest).resolve().parent / 'node'
    app = Path(sys.executable).resolve().parents[2]
    return app / 'node' if (app / 'release.json').is_file() else None


def verify_installed(directory: Path, package: Path, role: str, node: str):
    for name in ENTRYPOINTS[role]:
        if not (directory / name).is_file():
            raise ValueError(f'Npm {role} entry point is missing: {name}')
    lock = _read_json((package_directory(package, role) / 'package-lock.json').read_bytes())
    _check_packages(lock, lambda name: (directory / name).read_bytes(), lambda name: (directory / name).is_file())
    command = [node, '--input-type=module', '-e',
               'const modules=process.argv.slice(1); process.argv[1]="hindsightkit-verify"; for (const module of modules) await import(module);',
               (directory / ENTRYPOINTS[role][0]).resolve().as_uri(),
               (directory / ENTRYPOINTS[role][2]).resolve().as_uri()]
    result = subprocess.run(command, cwd=directory, capture_output=True,
                            text=True, encoding='utf-8', timeout=60,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        from .install_progress import redact
        raise ValueError(f'Npm {role} entry point failed: ' + redact((result.stderr or result.stdout)[-2000:]))


def verify_bundle_files(bundle: Path, package: Path, role: str, directory: Path):
    manifest = validate_bundle(bundle, package, roles=(role,))
    directory = ordinary_path(directory)
    with zipfile.ZipFile(bundle / manifest['bundles'][role]['archive']) as archive:
        remaining = {item.filename.casefold(): item for item in archive.infolist() if not item.is_dir()}
        total = len(remaining)
        checked = 0
        next_status = time.monotonic() + 10

        def check_file(pair):
            target, item = pair
            with archive.open(item) as expected, target.open('rb') as actual:
                if hashlib.file_digest(expected, 'sha256').digest() != hashlib.file_digest(actual, 'sha256').digest():
                    raise ValueError(f'Installed npm file changed: {item.filename}')

        # Windows file opens can wait for scanning. Overlap a bounded number of
        # reads; keep the archive open until all workers have finished.
        with ThreadPoolExecutor(max_workers=8) as workers:
            pending = []
            for target, info in _ordinary_files(directory / 'node_modules'):
                name = target.relative_to(directory).as_posix().casefold()
                item = remaining.pop(name, None)
                if item is None:
                    continue
                if info.st_size != item.file_size:
                    raise ValueError(f'Installed npm file is missing or changed: {item.filename}')
                pending.append((target, item))
                if len(pending) == 128:
                    for _ in workers.map(check_file, pending):
                        checked += 1
                        if time.monotonic() >= next_status:
                            print(f'Checking bundled {role} files: {checked}/{total}.', flush=True)
                            next_status = time.monotonic() + 10
                    pending.clear()
            for _ in workers.map(check_file, pending):
                pass
        if remaining:
            item = next(iter(remaining.values()))
            raise ValueError(f'Installed npm file is missing or changed: {item.filename}')


def _rename(source: Path, target: Path):
    # Windows may briefly hold a just-exited executable during antivirus scanning.
    deadline = time.monotonic() + 10
    while True:
        try:
            return source.rename(target)
        except PermissionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.25)


def install_bundle(bundle: Path, package: Path, role: str, directory: Path, node: str):
    manifest = validate_bundle(bundle, package, roles=(role,))
    directory = ordinary_path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    target = ordinary_path(directory / 'node_modules')
    previous = ordinary_path(directory / '.previous-node_modules')
    if previous.exists() and not target.exists():
        _rename(previous, target)
    if target.is_dir():
        for _ in _ordinary_files(target):
            pass
    with tempfile.TemporaryDirectory(prefix='.node-install-', dir=directory) as temporary:
        stage = Path(temporary)
        archive_path = bundle / manifest['bundles'][role]['archive']
        with archive_path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != manifest['bundles'][role]['sha256']:
                raise ValueError('Npm archive changed during installation')
            stream.seek(0)
            with zipfile.ZipFile(stream) as archive:
                _members(archive)
                next_status = time.monotonic() + 10
                for index, item in enumerate(archive.infolist(), 1):
                    archive.extract(item, stage)
                    if time.monotonic() >= next_status:
                        print(f'Unpacking bundled {role} files: {index}/{len(archive.infolist())}.', flush=True)
                        next_status = time.monotonic() + 10
        verify_installed(stage, package, role, node)
        if previous.exists():
            # A prior completed replacement may have been interrupted during cleanup.
            if previous.is_dir():
                for _ in _ordinary_files(previous):
                    pass
                shutil.rmtree(previous)
            else:
                previous.unlink()
        if target.exists():
            _rename(target, previous)
        try:
            _rename(stage / 'node_modules', target)
        except BaseException as exc:
            if previous.exists():
                try:
                    _rename(previous, target)
                except OSError:
                    raise RuntimeError(f'Could not restore dependencies; the previous runtime is preserved at {previous}. Rerun setup after releasing file locks.') from exc
            raise
        if previous.exists():
            try:
                if previous.is_dir():
                    shutil.rmtree(previous)
                else:
                    previous.unlink()
            except OSError:
                print(f'Installed dependencies are ready; old files remain at {previous} because they are in use.', flush=True)
