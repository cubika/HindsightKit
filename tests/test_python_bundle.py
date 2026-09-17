from pathlib import Path
import importlib.util
import json
import shutil
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_python_bundle", ROOT / "distribution/build_python_bundle.py")
bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle)


def write(root, name, content):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def wheel(root, name, version, *, tag="py3-none-any", metadata_name=None):
    basename = name.replace("-", "_")
    path = root / f"{basename}-{version}-{tag}.whl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(f"{basename}.py", "VALUE = 1\n")
        prefix = f"{basename}-{version}.dist-info"
        archive.writestr(prefix + "/METADATA", "Metadata-Version: 2.1\n"
                         f"Name: {metadata_name or name}\nVersion: {version}\n")
        archive.writestr(prefix + "/WHEEL", "Wheel-Version: 1.0\nRoot-Is-Purelib: true\n"
                         f"Tag: {tag}\n")
        archive.writestr(prefix + "/RECORD", "")
        archive.writestr(prefix + "/licenses/LICENSE", "Fixture license must remain unchanged.\n")
    return path


def refresh_manifest(directory, source):
    manifest = {"schema": 1, "python": "3.12", "platform": "windows-x64", "profile": "full",
                "project_version": "0.1.1", "lock_sha256": bundle.sha256(source / "uv.lock"),
                "files": {path.relative_to(directory).as_posix(): bundle.sha256(path)
                          for path in sorted(directory.rglob("*"))
                          if path.is_file() and path.name != bundle.MANIFEST_NAME}}
    write(directory, bundle.MANIFEST_NAME, json.dumps(manifest))
    return manifest


def fixture(root):
    source, directory = root / "source", root / "bundle"
    write(source, "pyproject.toml", '[project]\nname = "hindsightkit"\nversion = "0.1.1"\n')
    paths = {name: wheel(directory / "wheels", name, version, tag=tag)
             for name, version, tag in (("hindsightkit", "0.1.1", "py3-none-any"),
                                        ("client-dependency", "1.0", "py3-none-any"),
                                        ("server-dependency", "2.0", "cp310-abi3-win_amd64"))}
    records = ['version = 1\nrevision = 3\nrequires-python = "==3.12.*"\n',
               '[[package]]\nname = "hindsightkit"\nversion = "0.1.1"\nsource = { editable = "." }\n'
               'dependencies = [{ name = "client-dependency" }, { name = "unix-only", marker = "sys_platform != \'win32\'" }]\n'
               '[package.optional-dependencies]\nserver = [{ name = "server-dependency" }]\n']
    for name, version in (("client-dependency", "1.0"), ("server-dependency", "2.0")):
        path = paths[name]
        records.append(f'[[package]]\nname = "{name}"\nversion = "{version}"\n'
                       'source = { registry = "https://pypi.org/simple" }\n'
                       f'wheels = [{{ url = "https://files.pythonhosted.org/{path.name}", '
                       f'hash = "sha256:{bundle.sha256(path)}" }}]\n')
    write(source, "uv.lock", "\n".join(records))
    for profile in bundle.PROFILES:
        names = ["client-dependency", "hindsightkit"] + (["server-dependency"] if profile == "server" else [])
        lines = []
        for name in names:
            path = paths[name]
            key = bundle.wheel_identity(path)
            lines.append(f"{name}=={key[1]} --hash=sha256:{bundle.sha256(path)}\n")
        write(directory, f"requirements-{profile}.txt", "".join(lines))
    refresh_manifest(directory, source)
    return source, directory


class PythonBundleTests(unittest.TestCase):
    def test_client_bundle_contains_only_exact_client_closure_and_unchanged_wheels(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, full = fixture(Path(temporary))
            client = Path(temporary) / "client"
            manifest = bundle.create_client_bundle(full, client, source)
            self.assertEqual(manifest["profile"], "client")
            self.assertEqual(set(manifest["files"]), {"requirements-client.txt",
                "wheels/hindsightkit-0.1.1-py3-none-any.whl", "wheels/client_dependency-1.0-py3-none-any.whl"})
            self.assertFalse((client / "requirements-server.txt").exists())
            self.assertEqual(manifest, bundle.validate_bundle(client, source, profile="client"))
            for relative in manifest["files"]:
                self.assertEqual((client / relative).read_bytes(), (full / relative).read_bytes())
            self.assertLess(sum(path.stat().st_size for path in client.rglob("*") if path.is_file()),
                            sum(path.stat().st_size for path in full.rglob("*") if path.is_file()))
            self.assertEqual(bundle.validate_bundle(full, source)["profile"], "full")

    def test_client_bundle_rejects_server_wheels_and_requirements_even_with_updated_manifest(self):
        for relative in ("requirements-server.txt", "wheels/server_dependency-2.0-cp310-abi3-win_amd64.whl"):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as temporary:
                source, full = fixture(Path(temporary))
                client = Path(temporary) / "client"
                manifest = bundle.create_client_bundle(full, client, source)
                shutil.copyfile(full / relative, client / relative)
                manifest["files"][relative] = bundle.sha256(client / relative)
                write(client, bundle.MANIFEST_NAME, json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, "Unexpected requirements|not in the client"):
                    bundle.validate_bundle(client, source, profile="client")

    def test_client_bundle_is_not_accepted_as_full_and_missing_client_wheel_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, full = fixture(Path(temporary))
            client = Path(temporary) / "client"
            manifest = bundle.create_client_bundle(full, client, source)
            with self.assertRaisesRegex(ValueError, "manifest differs"):
                bundle.validate_bundle(client, source)
            relative = "wheels/client_dependency-1.0-py3-none-any.whl"
            (client / relative).unlink()
            del manifest["files"][relative]
            write(client, bundle.MANIFEST_NAME, json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "missing locked client wheels"):
                bundle.validate_bundle(client, source, profile="client")

    def test_client_copy_rejects_unverified_input_and_unsafe_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, full = fixture(Path(temporary))
            for output in (full / "client", source / "src/client", source):
                with self.subTest(output=output), self.assertRaisesRegex(ValueError, "overlap"):
                    bundle.create_client_bundle(full, output, source)
            existing = Path(temporary) / "existing"
            write(existing, "keep.txt", "preserve")
            with self.assertRaisesRegex(ValueError, "new or empty"):
                bundle.create_client_bundle(full, existing, source)
            self.assertEqual((existing / "keep.txt").read_text(), "preserve")
            write(full, "requirements-client.txt", "tampered")
            with self.assertRaisesRegex(ValueError, "SHA256"):
                bundle.create_client_bundle(full, Path(temporary) / "uncreated", source)
            self.assertFalse((Path(temporary) / "uncreated").exists())

    def test_accepts_complete_client_and_server_profiles_with_original_wheels(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, directory = fixture(Path(temporary))
            manifest = bundle.validate_bundle(directory, source)
            self.assertEqual(len(manifest["files"]), 5)
            self.assertEqual(manifest["project_version"], "0.1.1")
            with zipfile.ZipFile(directory / "wheels/client_dependency-1.0-py3-none-any.whl") as archive:
                self.assertIn("Fixture license", archive.read("client_dependency-1.0.dist-info/licenses/LICENSE").decode())

    def test_rejects_corrupted_download_even_after_manifest_is_rewritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, directory = fixture(Path(temporary))
            path = directory / "wheels/client_dependency-1.0-py3-none-any.whl"
            with zipfile.ZipFile(path, "a") as archive:
                archive.writestr("unexpected.py", "changed")
            refresh_manifest(directory, source)
            with self.assertRaisesRegex(ValueError, "upstream dependency lock"):
                bundle.validate_bundle(directory, source)

    def test_rejects_missing_runtime_dependency_even_if_file_manifest_matches(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, directory = fixture(Path(temporary))
            path = directory / "wheels/server_dependency-2.0-cp310-abi3-win_amd64.whl"
            path.unlink()
            refresh_manifest(directory, source)
            with self.assertRaisesRegex(ValueError, "missing locked server wheels"):
                bundle.validate_bundle(directory, source)

    def test_rejects_incomplete_requirements_even_with_all_wheels_present(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, directory = fixture(Path(temporary))
            path = directory / "requirements-server.txt"
            path.write_text("\n".join(line for line in path.read_text().splitlines() if not line.startswith("server-dependency")))
            refresh_manifest(directory, source)
            with self.assertRaisesRegex(ValueError, "locked dependency graph"):
                bundle.validate_bundle(directory, source)

    def test_rejects_server_dependencies_in_client_profile(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, directory = fixture(Path(temporary))
            shutil.copyfile(directory / "requirements-server.txt", directory / "requirements-client.txt")
            refresh_manifest(directory, source)
            with self.assertRaisesRegex(ValueError, "client requirements differ"):
                bundle.validate_bundle(directory, source)

    def test_rejects_requirement_hash_that_would_bypass_the_bundled_wheel(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, directory = fixture(Path(temporary))
            path = directory / "requirements-client.txt"
            path.write_text(path.read_text().replace(" --hash=", " --hash=sha256:" + "a" * 64 + " --hash=", 1))
            refresh_manifest(directory, source)
            with self.assertRaisesRegex(ValueError, "requirement hashes differ"):
                bundle.validate_bundle(directory, source)

    def test_rejects_stale_bundle_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, directory = fixture(Path(temporary))
            with (source / "uv.lock").open("a") as stream:
                stream.write("\n# dependency lock changed\n")
            with self.assertRaisesRegex(ValueError, "manifest differs"):
                bundle.validate_bundle(directory, source)

    def test_rejects_extra_files_and_linked_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, directory = fixture(Path(temporary))
            extra = write(directory, "credentials.json", "secret")
            refresh_manifest(directory, source)
            with self.assertRaisesRegex(ValueError, "Unexpected Python bundle file"):
                bundle.validate_bundle(directory, source)
            extra.unlink()
            with patch.object(bundle.Path, "lstat", return_value=type("Info", (), {"st_mode": 0, "st_file_attributes": 0x400})()):
                with self.assertRaisesRegex(ValueError, "Linked path"):
                    bundle.ordinary_path(directory)

    def test_rejects_duplicate_json_keys(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, directory = fixture(Path(temporary))
            path = directory / bundle.MANIFEST_NAME
            path.write_text(path.read_text().replace('{"schema": 1', '{"schema": 1, "schema": 1', 1))
            with self.assertRaisesRegex(ValueError, "Duplicate Python bundle manifest key"):
                bundle.validate_bundle(directory, source)

    def test_only_accepts_windows_cpython312_compatible_wheels(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for tag in ("cp312-cp312-win_amd64", "cp310-abi3-win_amd64", "py3-none-any"):
                self.assertEqual(bundle.wheel_identity(wheel(directory, "fixture", "1.0", tag=tag)), ("fixture", "1.0"))
            for tag in ("cp313-cp313-win_amd64", "cp312-cp312-win_arm64", "cp312-cp312-manylinux_2_17_x86_64"):
                with self.assertRaisesRegex(ValueError, "incompatible"):
                    bundle.wheel_identity(wheel(directory, "fixture", "1.0", tag=tag))
            with self.assertRaisesRegex(ValueError, "metadata differs"):
                bundle.wheel_identity(wheel(directory, "fixture", "1.0", metadata_name="another-package"))

    def test_rejects_unsafe_wheel_paths_and_private_application_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for member in ("../escape.py", "/absolute.py", "folder/FILE.py", "C:/secret.py"):
                path = wheel(directory, "fixture", "1.0")
                with zipfile.ZipFile(path, "a") as archive:
                    archive.writestr("folder/file.py", "fixture")
                    archive.writestr(member, "fixture")
                with self.subTest(member=member), self.assertRaisesRegex(ValueError, "Unsafe or duplicate"):
                    bundle.wheel_identity(path)
            for member in ("hindsightkit/.env", "hindsightkit/connection.json", "hindsightkit/private.key",
                           "hindsightkit/.runtime/log.txt"):
                path = wheel(directory, "hindsightkit", "0.1.1")
                with zipfile.ZipFile(path, "a") as archive:
                    archive.writestr(member, "private fixture")
                with self.subTest(member=member), self.assertRaisesRegex(ValueError, "Private or runtime"):
                    bundle.wheel_identity(path)

    def test_rejects_stale_or_missing_application_source_in_prebuilt_wheel(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            write(source, "src/hindsightkit/__init__.py", "CURRENT = True\n")
            path = wheel(source, "hindsightkit", "0.1.1")
            with self.assertRaisesRegex(ValueError, "files differ"):
                bundle.wheel_identity(path, source_root=source)
            with zipfile.ZipFile(path, "a") as archive:
                archive.writestr("hindsightkit/__init__.py", "CURRENT = False\n")
            with self.assertRaisesRegex(ValueError, "stale source"):
                bundle.wheel_identity(path, source_root=source)

    def test_requirement_parser_rejects_urls_unpinned_packages_and_missing_hashes(self):
        for requirement in ("fixture>=1.0", "fixture==1.*", "fixture==1.0",
                            "fixture @ https://example.invalid/fixture.whl", "-r remote.txt"):
            with self.subTest(requirement=requirement), self.assertRaises(ValueError):
                bundle.parse_requirements(requirement)

    def test_build_uses_frozen_exports_and_preserves_hashed_wheel_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, existing = fixture(root)
            output, commands = root / "output", []

            def fake_run(arguments, *, cwd, capture=False):
                commands.append([str(value) for value in arguments])
                if arguments[1] == "export":
                    profile = "server" if "--extra" in arguments else "client"
                    content = (existing / f"requirements-{profile}.txt").read_text()
                    return "\n".join(line for line in content.splitlines() if not line.startswith("hindsightkit"))
                if arguments[1] == "run":
                    for path in (existing / "wheels").glob("*.whl"):
                        if not path.name.startswith("hindsightkit"):
                            shutil.copyfile(path, output / "wheels" / path.name)
                if arguments[1] == "build":
                    constraints = Path(arguments[arguments.index("--build-constraints") + 1]).read_text()
                    self.assertEqual(constraints, bundle.BUILD_CONSTRAINTS)
                    path = existing / "wheels/hindsightkit-0.1.1-py3-none-any.whl"
                    shutil.copyfile(path, output / "wheels" / path.name)

            with patch.object(bundle, "run", side_effect=fake_run), patch.object(bundle.sys, "platform", "win32"):
                manifest = bundle.build_bundle(source_root=source, output=output, uv="fixture-uv")
            self.assertEqual(manifest, bundle.validate_bundle(output, source))
            self.assertTrue(all("--frozen" in command for command in commands if command[1] == "export"))
            download = next(command for command in commands if command[1] == "run")
            self.assertIn("--require-hashes", download)
            self.assertIn("--only-binary=:all:", download)
            self.assertIn("--no-deps", download)
            self.assertIn("pip==" + bundle.PIP_VERSION, download)
            for path in (existing / "wheels").glob("*.whl"):
                self.assertEqual(path.read_bytes(), (output / "wheels" / path.name).read_bytes())


if __name__ == "__main__":
    unittest.main()
