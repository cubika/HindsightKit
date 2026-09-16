import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep, win32 } from "node:path";

import { SpawnCommandRunner, type CommandRunner } from "./command-runner.js";
import { discoverLegacyExtensionWorkers } from "./legacy-extension-workers.js";
import {
  canonicalWindowsProcessPath,
  OwnedProvenLoopProcessController,
  sameWindowsProcessPath,
  type OwnedProcessRuntime,
} from "./owned-processes.js";

export interface StopPluginProcessesOptions {
  readonly dataRoot: string;
  readonly copilotHome: string;
  readonly localAppData: string;
  readonly cliBinPath: string;
  readonly marketplaceName?: string;
  readonly nodeExecutable?: string;
  readonly runner?: CommandRunner;
}

const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(
  `^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)` +
  `(?:-${identifier}(?:[.]${identifier})*)?(?:[+][0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?$`, "u",
);
const validVersion = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 128 && SEMVER.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

const localPath = (path: string): string => {
  canonicalWindowsProcessPath(path);
  if (resolve(path) === parse(path).root) throw new Error("A ProvenLoop cleanup scope cannot be a drive root.");
  return resolve(path);
};

const exists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
};

const checkedPath = async (path: string, kind: "file" | "directory"): Promise<string> => {
  const absolute = localPath(path);
  const root = parse(absolute).root;
  let current = root;
  const parts = relative(root, absolute).split(sep);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
      throw new Error("Indirect ProvenLoop cleanup paths are not supported.");
    }
    if (index === parts.length - 1 && (kind === "file" ? !info.isFile() : !info.isDirectory())) {
      throw new Error(`Invalid ProvenLoop cleanup ${kind}.`);
    }
  }
  const actual = await realpath(absolute);
  if (!sameWindowsProcessPath(actual, absolute)) throw new Error("ProvenLoop cleanup path identity changed.");
  return actual;
};

const readManifest = async (path: string): Promise<Record<string, unknown>> => {
  await checkedPath(path, "file");
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    if (size === 0 || size > 65536) throw new Error("ProvenLoop manifest exceeds its bound.");
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > 65536) throw new Error("ProvenLoop manifest exceeds its bound.");
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    if (!record(value)) throw new Error("Invalid ProvenLoop manifest.");
    return value;
  } finally { await handle.close(); }
};

const checkedCli = async (cliBinPath: string, version?: string): Promise<string> => {
  const cli = await checkedPath(cliBinPath, "file");
  if (win32.basename(cli).toLowerCase() !== "bin.js" || win32.basename(dirname(cli)).toLowerCase() !== "dist") {
    throw new Error("Invalid ProvenLoop CLI entrypoint.");
  }
  const manifest = await readManifest(join(dirname(dirname(cli)), "package.json"));
  if (manifest.name !== "@provenloop/cli" || !validVersion(manifest.version) ||
    (version !== undefined && manifest.version !== version)) throw new Error("ProvenLoop runtime manifest identity does not match its slot.");
  return cli;
};

/** Call only after participating runtimes have been asked to drain cooperatively. */
export const stopPluginProcesses = async (options: StopPluginProcessesOptions) => {
  if (process.platform !== "win32") throw new Error("Owned process cleanup is Windows-only.");
  const marketplaceName = options.marketplaceName ?? "provenloop-marketplace";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(marketplaceName)) throw new Error("Invalid ProvenLoop marketplace name.");
  const dataRoot = await checkedPath(options.dataRoot, "directory");
  const copilotHome = await checkedPath(options.copilotHome, "directory");
  const localAppData = await checkedPath(options.localAppData, "directory");
  const nodeExecutable = await checkedPath(options.nodeExecutable ?? process.execPath, "file");
  if (win32.basename(nodeExecutable).toLowerCase() !== "node.exe") throw new Error("Expected the ProvenLoop Node executable.");
  const pluginRoot = join(copilotHome, "installed-plugins", marketplaceName, "provenloop");
  const runtimeRoot = join(localAppData, "ProvenLoopRuntime");
  const slots = join(runtimeRoot, "versions");
  const runtimes: OwnedProcessRuntime[] = [{
    nodeExecutable, cliBinPath: await checkedCli(options.cliBinPath),
  }];
  if (await exists(runtimeRoot)) {
    await checkedPath(runtimeRoot, "directory");
    if (await exists(slots)) {
      await checkedPath(slots, "directory");
      const entries = await readdir(slots, { withFileTypes: true });
      if (entries.length > 15) throw new Error("Runtime slot inventory exceeds its bound.");
      for (const entry of entries) {
        // A malformed/incomplete slot is not evidence that no old runtime exists.
        if (!validVersion(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error("Invalid ProvenLoop runtime slot inventory.");
        }
        const slot = await checkedPath(join(slots, entry.name), "directory");
        const cliBinPath = await checkedCli(
          join(slot, "node_modules", "@provenloop", "cli", "dist", "bin.js"), entry.name,
        );
        if (!runtimes.some((runtime) => sameWindowsProcessPath(runtime.cliBinPath, cliBinPath))) {
          runtimes.push({ nodeExecutable, cliBinPath });
        }
      }
    }
  }
  const pluginRoots: string[] = [];
  let launcherDataRoot: string | undefined;
  if (await exists(pluginRoot)) {
    await checkedPath(pluginRoot, "directory");
    const manifest = await readManifest(join(pluginRoot, "plugin.json"));
    if (manifest.name !== "provenloop") throw new Error("Installed plugin identity does not match ProvenLoop.");
    await checkedPath(join(pluginRoot, "scripts", "mcp-launcher.ps1"), "file");
    await checkedPath(join(pluginRoot, "extensions", "event-capture", "extension.mjs"), "file");
    pluginRoots.push(pluginRoot);
    const locator = await readManifest(join(localAppData, "ProvenLoopIntegration", "runtime.json"));
    if (locator.product !== "ProvenLoopRuntime" || locator.schemaVersion !== 1 || !validVersion(locator.version) ||
      typeof locator.nodeExecutable !== "string" || !sameWindowsProcessPath(locator.nodeExecutable, nodeExecutable) ||
      typeof locator.cliBinPath !== "string" || !runtimes.some((runtime) => sameWindowsProcessPath(runtime.cliBinPath, locator.cliBinPath as string)) ||
      typeof locator.dataRoot !== "string" || !sameWindowsProcessPath(locator.dataRoot, dataRoot)) {
      throw new Error("The plugin runtime locator does not match the cleanup data root and runtime.");
    }
    await checkedCli(locator.cliBinPath, locator.version);
    launcherDataRoot = dataRoot;
  }
  const runner = options.runner ?? new SpawnCommandRunner();
  const powerShellExecutable = join(
    process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
  const extensionWorkers = await discoverLegacyExtensionWorkers(runner, pluginRoots, powerShellExecutable);
  const controllerOptions = {
    dataRoot, pluginRoots, runtimes, extensionWorkers, runner, powerShellExecutable,
    ...(launcherDataRoot === undefined ? {} : { launcherDataRoot }),
  };
  const controller = new OwnedProvenLoopProcessController(controllerOptions);
  const inventory = await controller.inspect();
  const results = await controller.stop(inventory);
  const remainingWorkers = await discoverLegacyExtensionWorkers(runner, pluginRoots, powerShellExecutable);
  const remaining = await new OwnedProvenLoopProcessController({
    ...controllerOptions, extensionWorkers: remainingWorkers,
  }).inspect();
  if (results.some((entry) => entry.status === "identity_changed") || remaining.processes.length > 0) {
    throw new Error("ProvenLoop process identities changed or restarted during upgrade; retry after those plugin processes settle. Copilot sessions were preserved.");
  }
  return {
    stopped: results.filter((entry) => entry.status === "stopped").map((entry) => entry.pid),
    pluginRoot, runtimeRoot,
  };
};
