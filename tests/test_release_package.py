from pathlib import Path
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("package_release", ROOT / "distribution/package_release.py")
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)


def write(root, name, content="fixture"):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


class ReleasePackageTests(unittest.TestCase):
    def fixture(self, root):
        source, postgres, python, node = root / "source", root / "postgres", root / "python", root / "node"
        for name in package.APP_FILES:
            write(source, name)
        write(source, "pyproject.toml", '[project]\nname = "hindsightkit"\nversion = "0.1.1"\n'
              'requires-python = ">=3.12,<3.13"\ndependencies = []\n'
              '[project.optional-dependencies]\nserver = []\n')
        write(source, "uv.lock", 'version = 1\nrevision = 3\nrequires-python = "==3.12.*"\n'
              '[[package]]\nname = "hindsightkit"\nversion = "0.1.1"\nsource = { editable = "." }\n'
              'dependencies = []\n[package.optional-dependencies]\nserver = []\n')
        write(source, "src/hindsightkit/__init__.py")
        write(source, "docs/install.md")
        write(source, "distribution/install.ps1", "\n".join([
            "$version = '@@VERSION@@'", "$url = '@@RELEASE_URL@@'",
            "$name = '@@PACKAGE_NAME@@'", "$sha = '@@PACKAGE_SHA256@@'",
            "$clientName = '@@CLIENT_PACKAGE_NAME@@'", "$clientSha = '@@CLIENT_PACKAGE_SHA256@@'",
            "$repository = '@@REPOSITORY@@'", "$requiresAuth = @@REQUIRES_AUTH@@",
        ]))
        for name in package.REQUIRED_POSTGRES:
            write(postgres, name)
        for extension in package.EXTENSIONS:
            version = "0.8.6" if extension == "vector" else "1.0"
            write(postgres, f"share/extension/{extension}.control", f"default_version = '{version}'\n")
        self.manifest(postgres)
        self.node_bundle(node, source)
        self.python_bundle(python, source)
        return {"version": "v0.1.1", "repository": "release-owner/HindsightKit", "server_url": "https://github.com",
                "postgres_directory": postgres, "python_directory": python, "node_directory": node,
                "output": root / "release", "source_root": source}

    def node_bundle(self, directory, source):
        directory.mkdir(parents=True)
        manifest = {"schema": 1, "platform": "windows-x64", "bundles": {}}
        for role in ("client", "server", "copilot"):
            root = source / "src/hindsightkit"
            if role != "server":
                root /= role
            dependencies = ({"@github/copilot": "1.0.85"} if role == "copilot" else
                            {"@vectorize-io/hindsight-coding-agents": "0.6.1", "jsonc-parser": "3.3.1"})
            if role == "server":
                dependencies["@vectorize-io/hindsight-control-plane"] = "0.10.0"
            if role == "copilot":
                dependencies["@github/copilot-win32-x64"] = "1.0.85"
            project = {"name": "fixture-" + role, "version": "1.0.0", "private": True, "dependencies": dependencies}
            lock = {**project, "lockfileVersion": 3, "requires": True, "packages": {"": project}}
            files = {}
            for name, version in dependencies.items():
                path = "node_modules/" + name
                lock["packages"][path] = {"version": version, "resolved": f"https://registry.npmjs.org/{name}/-/fixture.tgz",
                                            "integrity": "sha512-" + base64.b64encode(bytes(64)).decode()}
                files[path + "/package.json"] = json.dumps({"name": name, "version": version})
                files[path + "/LICENSE"] = "Original fixture license.\n"
                if role == "copilot":
                    files[path + "/LICENSE.md"] = "Original Copilot fixture license.\n"
            entries = (["@github/copilot/npm-loader.js"] if role == "copilot" else
                       ["@vectorize-io/hindsight-coding-agents/dist/installer.js",
                        "@vectorize-io/hindsight-coding-agents/dist/copilot-stop-hook.js",
                        "jsonc-parser/lib/umd/main.js"])
            if role == "server":
                entries.append("@vectorize-io/hindsight-control-plane/standalone/server.js")
            files.update({"node_modules/" + entry: "// upstream fixture\n" for entry in entries})
            write(root, "package.json", json.dumps(project))
            lock_path = write(root, "package-lock.json", json.dumps(lock))
            archive_path = directory / (role + ".zip")
            with zipfile.ZipFile(archive_path, "w") as archive:
                for name, content in sorted(files.items()):
                    info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                    info.external_attr = 0o100644 << 16
                    archive.writestr(info, content)
            manifest["bundles"][role] = {"archive": archive_path.name, "sha256": package.inspect_file(archive_path),
                                           "lock_sha256": package.inspect_file(lock_path)}
        write(directory, "node-bundle.json", json.dumps(manifest, sort_keys=True))
        return manifest

    def python_bundle(self, directory, source):
        wheel = directory / "wheels/hindsightkit-0.1.1-py3-none-any.whl"
        wheel.parent.mkdir(parents=True, exist_ok=True)
        dist_info = "hindsightkit-0.1.1.dist-info"
        content = {
            **{path.relative_to(source / "src").as_posix(): path.read_bytes()
               for path in (source / "src/hindsightkit").rglob("*") if path.is_file()},
            dist_info + "/METADATA": b"Metadata-Version: 2.4\nName: hindsightkit\nVersion: 0.1.1\nRequires-Python: >=3.12,<3.13\nProvides-Extra: server\n\n",
            dist_info + "/WHEEL": b"Wheel-Version: 1.0\nGenerator: release-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
            dist_info + "/licenses/LICENSE": b"Test fixture license retained byte for byte.\n",
        }
        records = []
        for name, payload in sorted(content.items()):
            digest = base64.urlsafe_b64encode(hashlib.sha256(payload).digest()).rstrip(b"=").decode()
            records.append(f"{name},sha256={digest},{len(payload)}\n")
        content[dist_info + "/RECORD"] = ("".join(records) + f"{dist_info}/RECORD,,\n").encode()
        with zipfile.ZipFile(wheel, "w") as archive:
            for name, payload in content.items():
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.external_attr = 0o100644 << 16
                archive.writestr(info, payload)
        requirement = f"hindsightkit==0.1.1 --hash=sha256:{package.inspect_file(wheel)}\n"
        for role in ("client", "server"):
            write(directory, f"requirements-{role}.txt", requirement)
        manifest = {"schema": 1, "python": "3.12", "platform": "windows-x64", "profile": "full",
                    "project_version": "0.1.1", "lock_sha256": package.inspect_file(source / "uv.lock"),
                    "files": {path.relative_to(directory).as_posix(): package.inspect_file(path)
                              for path in directory.rglob("*") if path.is_file()}}
        write(directory, "python-bundle.json", json.dumps(manifest, sort_keys=True))
        return manifest

    def manifest(self, postgres, **overrides):
        manifest = {"schema": 1, "postgres_version": package.POSTGRES_VERSION,
                    "vector_version": package.VECTOR_VERSION, "architecture": "windows-x64",
                    "postgres_url": package.POSTGRES_URL, "postgres_sha256": package.POSTGRES_SHA256,
                    "vector_url": package.VECTOR_URL, "vector_sha256": package.VECTOR_SHA256,
                    "msvc_runtime_version": "14.44.35211.0",
                    "extensions": {name: "0.8.6" if name == "vector" else "1.0" for name in package.EXTENSIONS},
                    "files": {path.relative_to(postgres).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                              for path in postgres.rglob("*") if path.is_file()
                              and path.name != package.POSTGRES_MANIFEST}}
        manifest.update(overrides)
        write(postgres, package.POSTGRES_MANIFEST, json.dumps(manifest))
        return manifest

    def test_builds_pinned_complete_assets_and_excludes_development_files(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            source, output = args["source_root"], args["output"]
            for name in (".env", ".runtime/secret.json", "tests/secret.py",
                         "src/hindsightkit/__pycache__/compiled.pyc", "src/hindsightkit/node_modules/index.js"):
                write(source, name, "excluded")
            with patch.object(subprocess, "run", side_effect=AssertionError("Packaging must not run tools")):
                release = package.package_release(**args)
            self.assertEqual({path.name for path in output.iterdir()}, {
                package.APP_NAME, package.CLIENT_APP_NAME, package.POSTGRES_NAME, "install.ps1", "QUICKSTART.md",
                "release-notes.md", "SHA256SUMS"})
            with zipfile.ZipFile(output / package.APP_NAME) as archive:
                self.assertEqual(set(archive.namelist()), {"app/" + name for name in package.APP_FILES} | {
                    "app/src/hindsightkit/__init__.py",
                    *("app/src/hindsightkit/" + prefix + name for prefix in ("", "client/", "copilot/")
                      for name in ("package.json", "package-lock.json")),
                    "app/docs/install.md", "app/release.json", "app/python/python-bundle.json",
                    "app/python/requirements-client.txt", "app/python/requirements-server.txt",
                    "app/python/wheels/hindsightkit-0.1.1-py3-none-any.whl",
                    "app/node/node-bundle.json", "app/node/client.zip", "app/node/server.zip", "app/node/copilot.zip"})
                self.assertEqual(json.loads(archive.read("app/release.json")), release)
                self.assertEqual(release["package_role"], "full")
                self.assertTrue(all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in archive.infolist()))
                for path in args["node_directory"].iterdir():
                    self.assertEqual(archive.read("app/node/" + path.name), path.read_bytes())
                for path in args["python_directory"].rglob("*"):
                    if path.is_file():
                        self.assertEqual(archive.read("app/python/" + path.relative_to(args["python_directory"]).as_posix()),
                                         path.read_bytes())
            with zipfile.ZipFile(output / package.CLIENT_APP_NAME) as archive:
                client_release = json.loads(archive.read("app/release.json"))
                self.assertEqual(client_release["package_role"], "client")
                self.assertNotIn("app/node/server.zip", archive.namelist())
                client_node = json.loads(archive.read("app/node/node-bundle.json"))
                self.assertEqual(set(client_node["bundles"]), {"client", "copilot"})
                self.assertEqual(client_release["node"]["components"], ["client", "copilot"])
                for role in ("client", "copilot"):
                    self.assertEqual(archive.read("app/node/" + role + ".zip"),
                                     (args["node_directory"] / (role + ".zip")).read_bytes())
                self.assertNotIn("app/python/requirements-server.txt", archive.namelist())
                self.assertEqual(json.loads(archive.read("app/python/python-bundle.json"))["profile"], "client")
                self.assertEqual(archive.read("app/python/wheels/hindsightkit-0.1.1-py3-none-any.whl"),
                                 (args["python_directory"] / "wheels/hindsightkit-0.1.1-py3-none-any.whl").read_bytes())
            with zipfile.ZipFile(output / package.POSTGRES_NAME) as archive:
                self.assertEqual(set(archive.namelist()), {"pgsql/" + name for name in package.REQUIRED_POSTGRES}
                                 | {"pgsql/" + package.POSTGRES_MANIFEST})
            base = "https://github.com/release-owner/HindsightKit/releases/download/v0.1.1"
            self.assertEqual(release["release_url"], base)
            self.assertEqual(release["python"], {"version": "3.12", "platform": "windows-x64", "packages": 1})
            self.assertEqual(release["node"], {"platform": "windows-x64", "components": ["client", "copilot", "server"]})
            self.assertIs(release["requires_auth"], False)
            self.assertEqual(release["postgres"]["url"], base + "/" + package.POSTGRES_NAME)
            self.assertEqual(release["postgres"]["sha256"], package.inspect_file(output / package.POSTGRES_NAME))
            installer = (output / "install.ps1").read_text()
            self.assertNotIn("@@", installer)
            self.assertIn("$requiresAuth = $false", installer)
            self.assertIn(package.inspect_file(output / package.APP_NAME), installer)
            self.assertIn(package.inspect_file(output / package.CLIENT_APP_NAME), installer)
            notes = (output / "QUICKSTART.md").read_text()
            self.assertIn(f"irm '{base}/install.ps1' | iex", notes)
            self.assertNotIn("gh auth login", notes)
            self.assertIn("-ServerOnly", notes)
            self.assertIn("-ClientOnly", notes)
            self.assertIn("-Server 'http://server-host:9077'", notes)
            self.assertIn("Windows x64, Git, and a GitHub account with Copilot access", notes)
            self.assertLess(notes.index("hindsightkit share"), notes.index("Advanced installation"))
            self.assertIn("hindsightkit connect", notes)
            self.assertIn("Pinned Python packages are bundled", notes)
            self.assertIn("without contacting PyPI", notes)
            self.assertIn("local server also downloads the embedding model", notes)
            self.assertNotIn("Known v0.1.0 download issue", notes)
            self.assertIn("It does not include itself or GitHub's source archives", notes)
            checksums = dict(line.split("  ", 1)[::-1] for line in (output / "SHA256SUMS").read_text().splitlines())
            self.assertEqual(set(checksums), {path.name for path in output.iterdir()} - {"SHA256SUMS"})
            for name, checksum in checksums.items():
                self.assertEqual(checksum, package.inspect_file(output / name))

    def test_repository_and_server_context_changes_only_its_generated_release_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.fixture(root)
            original_readme = (args["source_root"] / "README.md").read_bytes()
            package.package_release(**args)
            second = {**args, "output": root / "restricted", "repository": "restricted-owner/HindsightKit",
                      "server_url": "https://git.example.test", "visibility": "internal"}
            release = package.package_release(**second)
            self.assertIs(release["requires_auth"], True)
            self.assertEqual((args["source_root"] / "README.md").read_bytes(), original_readme)
            self.assertEqual((args["output"] / package.POSTGRES_NAME).read_bytes(),
                             (second["output"] / package.POSTGRES_NAME).read_bytes())
            expected = "https://git.example.test/restricted-owner/HindsightKit/releases/download/v0.1.1"
            self.assertEqual(release["release_url"], expected)
            for name in ("install.ps1", "QUICKSTART.md", "release-notes.md"):
                content = (second["output"] / name).read_text()
                self.assertIn(expected if name == "install.ps1" else expected.replace("/download/", "/tag/"), content)
                self.assertNotIn("release-owner", content)
            self.assertIn("$requiresAuth = $true", (second["output"] / "install.ps1").read_text())
            notes = (second["output"] / "QUICKSTART.md").read_text()
            self.assertIn("gh auth login --hostname 'git.example.test'", notes)
            self.assertIn("--repo 'git.example.test/restricted-owner/HindsightKit'", notes)
            self.assertEqual(notes.count("gh release download"), 1)
            self.assertNotIn("irm ", notes)
            self.assertNotIn("two remotes", notes)
            self.assertNotIn("enterprise", notes.lower())
            repeated = {**args, "output": root / "repeated"}
            package.package_release(**repeated)
            for path in args["output"].iterdir():
                self.assertEqual(path.read_bytes(), (repeated["output"] / path.name).read_bytes())

    def test_client_archive_omits_server_dependencies_from_the_full_wheel_pool(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            source, pool = args["source_root"], args["python_directory"]
            server = pool / "wheels/hindsight_api_slim-0.10.0-py3-none-any.whl"
            with zipfile.ZipFile(server, "w") as archive:
                archive.writestr("hindsight_api/__init__.py", "SERVER = True\n")
                archive.writestr("hindsight_api_slim-0.10.0.dist-info/METADATA",
                                 "Metadata-Version: 2.4\nName: hindsight-api-slim\nVersion: 0.10.0\n")
                archive.writestr("hindsight_api_slim-0.10.0.dist-info/WHEEL",
                                 "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
                archive.writestr("hindsight_api_slim-0.10.0.dist-info/RECORD", "")
                archive.writestr("hindsight_api_slim-0.10.0.dist-info/licenses/LICENSE", "Original fixture license.\n")
            digest = package.inspect_file(server)
            lock = source / "uv.lock"
            lock.write_text(lock.read_text().replace("server = []", 'server = [{name = "hindsight-api-slim"}]') +
                            '\n[[package]]\nname = "hindsight-api-slim"\nversion = "0.10.0"\n'
                            'source = {registry = "https://pypi.org/simple"}\n'
                            f'wheels = [{{url = "https://files.pythonhosted.org/{server.name}", hash = "sha256:{digest}"}}]\n')
            requirements = pool / "requirements-server.txt"
            requirements.write_text(requirements.read_text() + f"hindsight-api-slim==0.10.0 --hash=sha256:{digest}\n")
            manifest_path = pool / "python-bundle.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["lock_sha256"] = package.inspect_file(lock)
            manifest["files"] = {path.relative_to(pool).as_posix(): package.inspect_file(path)
                                 for path in pool.rglob("*") if path.is_file() and path != manifest_path}
            write(pool, "python-bundle.json", json.dumps(manifest))
            package.package_release(**args)
            with zipfile.ZipFile(args["output"] / package.APP_NAME) as full, \
                    zipfile.ZipFile(args["output"] / package.CLIENT_APP_NAME) as client:
                full_wheels = {name for name in full.namelist() if name.endswith(".whl")}
                client_wheels = {name for name in client.namelist() if name.endswith(".whl")}
                self.assertEqual(full_wheels - client_wheels, {"app/python/wheels/" + server.name})
                self.assertEqual(json.loads(full.read("app/release.json"))["python"]["packages"], 2)
                self.assertEqual(json.loads(client.read("app/release.json"))["python"]["packages"], 1)
                self.assertNotIn("hindsight-api-slim", client.read("app/python/requirements-client.txt").decode())
                self.assertNotIn("app/python/requirements-server.txt", client.namelist())
                self.assertEqual(full.read(next(iter(client_wheels))), client.read(next(iter(client_wheels))))
                self.assertEqual(full.read("app/python/wheels/" + server.name), server.read_bytes())
            self.assertLess((args["output"] / package.CLIENT_APP_NAME).stat().st_size,
                            (args["output"] / package.APP_NAME).stat().st_size)

    def test_historical_notes_keep_the_v010_download_limitation(self):
        notes = package.installation_notes("v0.1.0",
            "https://github.com/release-owner/HindsightKit/releases/download/v0.1.0",
            "release-owner/HindsightKit", "public")
        self.assertIn("TLS HandshakeFailure", notes)
        self.assertIn("Keep TLS certificate verification enabled", notes)
        self.assertNotIn("without contacting PyPI", notes)

    def test_missing_tampered_or_private_python_bundle_is_rejected_before_output(self):
        changes = (lambda root: (root / "python-bundle.json").unlink(),
                   lambda root: (root / "wheels/hindsightkit-0.1.1-py3-none-any.whl").unlink(),
                   lambda root: write(root, "wheels/hindsightkit-0.1.1-py3-none-any.whl", "tampered"),
                   lambda root: write(root, "requirements-client.txt", "different==1.0\n"),
                   lambda root: write(root, "credentials.json", "must never ship"),
                   lambda root: write(root, "wheels/.env", "must never ship"))
        for index, change in enumerate(changes):
            with self.subTest(change=index), tempfile.TemporaryDirectory() as directory:
                args = self.fixture(Path(directory))
                change(args["python_directory"])
                with self.assertRaises((ValueError, OSError)):
                    package.package_release(**args)
                self.assertFalse(args["output"].exists())

    def test_python_bundle_validator_receives_exact_inputs_and_cannot_be_bypassed(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            with patch.object(package, "validate_python_bundle", side_effect=ValueError("invalid bundle")) as validate:
                with self.assertRaisesRegex(ValueError, "invalid bundle"):
                    package.package_release(**args)
            validate.assert_called_once_with(args["python_directory"], args["source_root"])
            self.assertFalse(args["output"].exists())

    def test_python_bundle_changed_after_validation_is_rejected(self):
        for changed in ("wheels/hindsightkit-0.1.1-py3-none-any.whl", "python-bundle.json", "unexpected.txt"):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                args = self.fixture(Path(directory))
                original = package.validate_python_bundle
                def validate_then_change(root, source):
                    manifest = original(root, source)
                    write(root, changed, "changed after validation")
                    return manifest
                with patch.object(package, "validate_python_bundle", side_effect=validate_then_change):
                    with self.assertRaisesRegex(ValueError, "changed"):
                        package.package_release(**args)
                self.assertFalse(args["output"].exists())

    def test_python_bundle_output_overlap_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            args["output"] = args["python_directory"] / "release"
            with self.assertRaisesRegex(ValueError, "overlaps"):
                package.package_release(**args)
            self.assertFalse(args["output"].exists())

    def test_missing_tampered_or_private_node_bundle_is_rejected_before_output(self):
        changes = (lambda root: (root / "node-bundle.json").unlink(),
                   lambda root: (root / "copilot.zip").unlink(),
                   lambda root: write(root, "client.zip", "tampered"),
                   lambda root: write(root, ".npmrc", "//registry.example.test/:_authToken=secret"))
        for index, change in enumerate(changes):
            with self.subTest(change=index), tempfile.TemporaryDirectory() as directory:
                args = self.fixture(Path(directory))
                change(args["node_directory"])
                with self.assertRaises((ValueError, OSError)):
                    package.package_release(**args)
                self.assertFalse(args["output"].exists())

    def test_node_bundle_validator_receives_exact_inputs_and_cannot_be_bypassed(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            with patch.object(package, "validate_node_bundle", side_effect=ValueError("invalid bundle")) as validate:
                with self.assertRaisesRegex(ValueError, "invalid bundle"):
                    package.package_release(**args)
            validate.assert_called_once_with(args["node_directory"], args["source_root"] / "src/hindsightkit")
            self.assertFalse(args["output"].exists())

    def test_node_bundle_changed_after_validation_is_rejected(self):
        for changed in ("client.zip", "node-bundle.json", "unexpected.txt"):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                args = self.fixture(Path(directory))
                original = package.validate_node_bundle
                def validate_then_change(root, source):
                    manifest = original(root, source)
                    write(root, changed, "changed after validation")
                    return manifest
                with patch.object(package, "validate_node_bundle", side_effect=validate_then_change):
                    with self.assertRaisesRegex(ValueError, "changed"):
                        package.package_release(**args)
                self.assertFalse(args["output"].exists())

    def test_node_bundle_lock_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            manifest_path = args["node_directory"] / "node-bundle.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["bundles"]["client"]["lock_sha256"] = "0" * 64
            manifest_path.write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                package.package_release(**args)
            self.assertFalse(args["output"].exists())

    def test_node_bundle_output_overlap_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            args["output"] = args["node_directory"] / "release"
            with self.assertRaisesRegex(ValueError, "overlaps"):
                package.package_release(**args)
            self.assertFalse(args["output"].exists())

    def test_node_builder_uses_clean_isolated_configs_and_retains_upstream_files(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            spec = importlib.util.spec_from_file_location("build_node_bundle", ROOT / "distribution/build_node_bundle.py")
            builder = importlib.util.module_from_spec(spec)
            with patch.dict(sys.modules, {"package_release": package}):
                spec.loader.exec_module(builder)
            from hindsightkit import node_bundle
            binary = write(Path(directory), "tools/node.exe")
            write(binary.parent, "node_modules/npm/bin/npm-cli.js")
            output = Path(directory) / "built-node"
            installs = []
            checked = []
            def run(command, *, cwd, env=None, capture=False):
                values = [str(value) for value in command]
                if capture:
                    return json.dumps({"version": "22.23.2", "platform": "win32", "arch": "x64"})
                if "ci" in values:
                    role = Path(cwd).name
                    installs.append(role)
                    user_config = Path(values[values.index("--userconfig") + 1])
                    global_config = Path(values[values.index("--globalconfig") + 1])
                    self.assertNotEqual(user_config, global_config)
                    self.assertEqual(user_config.read_text(), "")
                    self.assertEqual(global_config.read_text(), "")
                    self.assertIn("--registry=https://registry.npmjs.org", values)
                    self.assertIn("--include=optional", values)
                    self.assertIn("--ignore-scripts=false", values)
                    with zipfile.ZipFile(args["node_directory"] / (role + ".zip")) as archive:
                        archive.extractall(cwd)
                else:
                    self.assertTrue(values[1].endswith("verify_node_install.py"))
                    self.assertTrue(output.is_dir())
                    checked.append(node_bundle.validate_bundle(
                        Path(values[values.index("--bundle") + 1]), args["source_root"] / "src/hindsightkit"))
            output_text = io.StringIO()
            with (patch.object(builder.sys, "platform", "win32"),
                  patch.object(builder.platform, "machine", return_value="AMD64"),
                  patch.object(builder.shutil, "which", return_value=str(binary)),
                  patch.object(builder, "run", side_effect=run), patch.object(sys, "path", list(sys.path)),
                  contextlib.redirect_stdout(output_text)):
                manifest = builder.build_bundle(source_root=args["source_root"], output=output)
            self.assertEqual(installs, ["client", "server", "copilot"])
            self.assertEqual(len(checked), 1)
            self.assertEqual(set(manifest["bundles"]), set(installs))
            self.assertIn("npm completed for server; inspecting files", output_text.getvalue())
            self.assertIn("Packing server.zip:", output_text.getvalue())
            self.assertIn("Packed copilot.zip", output_text.getvalue())
            for role in installs:
                with (zipfile.ZipFile(args["node_directory"] / (role + ".zip")) as original,
                      zipfile.ZipFile(output / (role + ".zip")) as built):
                    self.assertEqual(set(original.namelist()), set(built.namelist()))
                    for name in original.namelist():
                        self.assertEqual(original.read(name), built.read(name))
                    self.assertTrue(any(name.endswith("/LICENSE") for name in built.namelist()))
                    self.assertTrue(all(name.startswith("node_modules/") for name in built.namelist()))

    def test_archive_progress_reports_files_written(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = {}
            for index in range(2):
                path = write(root, f"file-{index}.txt")
                files[path.name] = (path, package.inspect_file(path))
            with (patch.object(package.time, "monotonic", side_effect=range(0, 100, 11)),
                  contextlib.redirect_stdout(io.StringIO()) as output):
                package.write_archive(root / "progress.zip", files, progress_label="fixture.zip")
            self.assertIn("Packing fixture.zip: 1/2 files", output.getvalue())
            self.assertIn("Packing fixture.zip: 2/2 files", output.getvalue())

    def test_node_builder_retains_archives_when_offline_runtime_verification_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            spec = importlib.util.spec_from_file_location("build_node_bundle", ROOT / "distribution/build_node_bundle.py")
            builder = importlib.util.module_from_spec(spec)
            with patch.dict(sys.modules, {"package_release": package}):
                spec.loader.exec_module(builder)
            from hindsightkit import node_bundle
            binary = write(Path(directory), "tools/node.exe")
            write(binary.parent, "node_modules/npm/bin/npm-cli.js")
            output = Path(directory) / "failed-build"
            def run(command, *, cwd, env=None, capture=False):
                values = [str(value) for value in command]
                if capture:
                    return json.dumps({"version": "22.23.2", "platform": "win32", "arch": "x64"})
                if "ci" in values:
                    with zipfile.ZipFile(args["node_directory"] / (Path(cwd).name + ".zip")) as archive:
                        archive.extractall(cwd)
                    return
                self.assertEqual(Path(values[values.index("--bundle") + 1]), output)
                raise subprocess.CalledProcessError(7, values)
            with (patch.object(builder.sys, "platform", "win32"),
                  patch.object(builder.platform, "machine", return_value="AMD64"),
                  patch.object(builder.shutil, "which", return_value=str(binary)),
                  patch.object(builder, "run", side_effect=run), patch.object(sys, "path", list(sys.path)),
                  contextlib.redirect_stdout(io.StringIO())):
                with self.assertRaisesRegex(ValueError, "Build is incomplete; archives were retained") as failure:
                    builder.build_bundle(source_root=args["source_root"], output=output)
                self.assertIn("verify_node_install.py --bundle", str(failure.exception))
                manifest = node_bundle.validate_bundle(output, args["source_root"] / "src/hindsightkit")
                self.assertEqual(set(manifest["bundles"]), {"client", "server", "copilot"})
                original = {path.name: path.read_bytes() for path in output.iterdir()}
                with self.assertRaisesRegex(ValueError, "must be new or empty"):
                    builder.build_bundle(source_root=args["source_root"], output=output)
                self.assertEqual(original, {path.name: path.read_bytes() for path in output.iterdir()})

    def test_node_builder_rejects_missing_copilot_redistribution_licenses(self):
        spec = importlib.util.spec_from_file_location("build_node_bundle", ROOT / "distribution/build_node_bundle.py")
        builder = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"package_release": package}):
            spec.loader.exec_module(builder)
        for missing in ("@github/copilot", "@github/copilot-win32-x64"):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for name in ("@github/copilot", "@github/copilot-win32-x64"):
                    write(root, f"node_modules/{name}/LICENSE.md", "Upstream license\n")
                (root / "node_modules" / missing / "LICENSE.md").unlink()
                with self.assertRaisesRegex(ValueError, "redistribution license is missing"):
                    builder.check_copilot_licenses(root)

    def test_packaging_rejects_rehashed_bundle_missing_copilot_license(self):
        for missing in ("@github/copilot", "@github/copilot-win32-x64"):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as directory:
                args = self.fixture(Path(directory))
                path = args["node_directory"] / "copilot.zip"
                with zipfile.ZipFile(path) as original:
                    retained = {name: original.read(name) for name in original.namelist()
                                if name != "node_modules/" + missing + "/LICENSE.md"}
                with zipfile.ZipFile(path, "w") as archive:
                    for name, content in retained.items():
                        archive.writestr(name, content)
                manifest_path = args["node_directory"] / "node-bundle.json"
                manifest = json.loads(manifest_path.read_text())
                manifest["bundles"]["copilot"]["sha256"] = package.inspect_file(path)
                manifest_path.write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, "redistribution license is missing"):
                    package.package_release(**args)
                self.assertFalse(args["output"].exists())

    def test_tag_mismatch_and_template_injection_are_rejected_before_output(self):
        invalid = (("version", "v0.2.0"), ("version", "v0.1.1'; Write-Host 'bad"),
                   ("repository", "owner/repo'"), ("repository", "owner/../repo"),
                   ("server_url", "https://example.test/with/path"),
                   ("server_url", "https://name:pass@example.test"),
                   ("server_url", "https://example.test?x='"), ("server_url", "http://example.test"),
                   ("visibility", "unknown"))
        for field, value in invalid:
            with self.subTest(field=field, value=value), tempfile.TemporaryDirectory() as directory:
                args = self.fixture(Path(directory))
                args[field] = value
                with self.assertRaises(ValueError):
                    package.package_release(**args)
                self.assertFalse(args["output"].exists())

    def test_private_repository_requires_authenticated_downloads(self):
        with tempfile.TemporaryDirectory() as directory:
            args = {**self.fixture(Path(directory)), "visibility": "private"}
            release = package.package_release(**args)
            self.assertIs(release["requires_auth"], True)
            with zipfile.ZipFile(args["output"] / package.APP_NAME) as archive:
                self.assertIs(json.loads(archive.read("app/release.json"))["requires_auth"], True)
            notes = (args["output"] / "release-notes.md").read_text()
            self.assertIn("private repository", notes)
            self.assertIn("gh auth login --hostname 'github.com'", notes)
            self.assertIn("--repo 'github.com/release-owner/HindsightKit'", notes)
            self.assertNotIn("irm ", notes)

    @unittest.skipUnless(os.name == "nt", "Generated Windows installation commands")
    def test_authenticated_commands_check_download_before_running_each_role(self):
        shell = shutil.which("powershell.exe")
        if not shell:
            self.skipTest("Windows PowerShell is not available")
        notes = package.installation_notes("v0.1.1",
            "https://github.com/restricted-owner/HindsightKit/releases/download/v0.1.1",
            "restricted-owner/HindsightKit", "internal")
        blocks = re.findall(chr(96) * 3 + r"powershell\n(.*?)\n" + chr(96) * 3, notes, re.S)
        self.assertEqual(len(blocks), 5)
        download = blocks[1].rsplit("& ([scriptblock]::Create($hindsightkitInstaller))", 1)[0]
        commands = [blocks[1], *(download + command for command in blocks[2:])]
        self.assertEqual(notes.count("gh release download"), 1)
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "command.ps1"
            for role, command in enumerate(commands):
                for outcome in ("success", "failed", "empty"):
                    with self.subTest(role=role, outcome=outcome):
                        payload = ("param([switch]$ClientOnly,[switch]$ServerOnly,[string]$Server) "
                                   "Write-Output ('EXECUTED:' + [string]$ClientOnly + ':' + [string]$ServerOnly + ':' + $Server)")
                        output = "" if outcome == "empty" else "Write-Output @'\n" + payload + "\n'@"
                        code = 1 if outcome == "failed" else 0
                        script.write_text("$ErrorActionPreference = 'Stop'\n"
                            "function gh {\n" + output + f"\n$global:LASTEXITCODE = {code}\n}}\n" + command,
                            encoding="utf-8")
                        result = subprocess.run([shell, "-NoProfile", "-ExecutionPolicy", "Bypass",
                            "-File", str(script)], capture_output=True, text=True, timeout=30)
                        if outcome == "success":
                            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                            expected = ("False:False:", "True:False:", "False:True:", "False:False:http://server-host:9077")[role]
                            self.assertIn("EXECUTED:" + expected, result.stdout)
                        else:
                            self.assertNotEqual(result.returncode, 0)
                            self.assertNotIn("EXECUTED:", result.stdout)

    def test_changed_missing_untracked_or_private_postgres_files_are_rejected(self):
        changes = (lambda pg: write(pg, "bin/postgres.exe", "tampered"),
                   lambda pg: (pg / "bin/psql.exe").unlink(),
                   lambda pg: write(pg, "bin/untracked.dll"),
                   lambda pg: write(pg, "data/PG_VERSION", "18"),
                   lambda pg: write(pg, "cluster.json", "secret"))
        for index, change in enumerate(changes):
            with self.subTest(change=index), tempfile.TemporaryDirectory() as directory:
                args = self.fixture(Path(directory))
                change(args["postgres_directory"])
                with self.assertRaises(ValueError):
                    package.package_release(**args)
                self.assertFalse(args["output"].exists())

    def test_pins_and_manifest_file_paths_are_checked(self):
        for override in ({"postgres_version": "18.5"}, {"vector_sha256": "0" * 64},
                         {"architecture": "windows-arm64"}, {"files": {"../secret": "0" * 64}},
                         {"extensions": {"vector": "0.8.6"}}, {"msvc_runtime_version": "unknown"}):
            with self.subTest(override=override), tempfile.TemporaryDirectory() as directory:
                args = self.fixture(Path(directory))
                self.manifest(args["postgres_directory"], **override)
                with self.assertRaises(ValueError):
                    package.package_release(**args)

    def test_rehashed_wrong_extension_version_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            write(args["postgres_directory"], "share/extension/vector.control", "default_version = '0.8.5'\n")
            self.manifest(args["postgres_directory"])
            with self.assertRaisesRegex(ValueError, "extension differs"):
                package.package_release(**args)

    def test_verified_postgres_certificate_files_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            write(args["postgres_directory"], "share/certificates/root.pem", "upstream certificate fixture")
            self.manifest(args["postgres_directory"])
            package.package_release(**args)
            with zipfile.ZipFile(args["output"] / package.POSTGRES_NAME) as archive:
                self.assertIn("pgsql/share/certificates/root.pem", archive.namelist())

    def test_existing_output_and_input_overlap_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            marker = write(args["output"], "already-published.zip", "preserve")
            with self.assertRaisesRegex(ValueError, "empty directory"):
                package.package_release(**args)
            self.assertEqual(marker.read_text(), "preserve")
            args["output"] = args["source_root"] / "docs/release"
            with self.assertRaisesRegex(ValueError, "overlaps"):
                package.package_release(**args)

    def test_missing_or_unknown_template_tokens_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            write(args["source_root"], "distribution/install.ps1", "@@VERSION@@\n@@SURPRISE@@")
            with self.assertRaisesRegex(ValueError, "template"):
                package.package_release(**args)
            self.assertFalse(args["output"].exists())

    def test_local_paths_and_private_application_files_are_rejected(self):
        for name, contents in (("docs/leak.md", None), ("src/hindsightkit/.env", "secret"),
                               ("src/hindsightkit/secret.key", "secret")):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                args = self.fixture(Path(directory))
                write(args["source_root"], name, contents or str(args["source_root"]))
                with self.assertRaises(ValueError):
                    package.package_release(**args)
                self.assertFalse(args["output"].exists())

    def test_links_and_junctions_are_rejected_without_following_the_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.fixture(root)
            target = root / "outside"
            write(target, "private.txt", "preserve")
            link = args["source_root"] / "src/linked"
            junction = False
            try:
                link.symlink_to(target, target_is_directory=True)
            except OSError:
                if os.name != "nt":
                    raise
                result = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                    "New-Item -ItemType Junction -Path $args[0] -Target $args[1] | Out-Null",
                    str(link), str(target)], capture_output=True, text=True)
                if result.returncode:
                    self.skipTest("Creating a link is unavailable: " + result.stderr)
                junction = True
            try:
                with self.assertRaisesRegex(ValueError, "Linked path"):
                    package.package_release(**args)
                self.assertEqual((target / "private.txt").read_text(), "preserve")
            finally:
                if junction:
                    os.rmdir(link)
                else:
                    link.unlink()

    def test_cli_packages_fixture_without_building(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            args["visibility"] = "internal"
            command = [sys.executable, str(ROOT / "distribution/package_release.py")]
            for name, value in args.items():
                command.extend(["--" + name.replace("_", "-"), str(value)])
            result = subprocess.run(command, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["repository"], "release-owner/HindsightKit")
            self.assertIs(json.loads(result.stdout)["requires_auth"], True)

    def test_cli_requires_verified_python_bundle_input(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            command = [sys.executable, str(ROOT / "distribution/package_release.py")]
            for name, value in args.items():
                if name != "python_directory":
                    command.extend(["--" + name.replace("_", "-"), str(value)])
            result = subprocess.run(command, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("--python-directory", result.stderr)
            self.assertFalse(args["output"].exists())


if __name__ == "__main__":
    unittest.main()
