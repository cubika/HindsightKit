import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  applyEdits,
  getNodeValue,
  modify,
  parseTree,
  type Node,
  type ParseError,
} from "jsonc-parser";

const FILES = [
  "plugin.json",
  ".mcp.json",
  "scripts/mcp-launcher.ps1",
  "extensions/event-capture/extension.mjs",
  "skills/provenloop-context/SKILL.md",
] as const;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 256 * 1024;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const digest = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const equalPath = (a: string, b: string): boolean =>
  process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
const sameFile = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino;

export interface RefreshPluginFilesOptions {
  readonly pluginRoot: string;
  readonly copilotHome: string;
  readonly assets: Readonly<Record<string, string>>;
  readonly version: string;
  readonly marketplaceName: string;
  readonly marketplaceSource: string;
  readonly backupRoot: string;
}

export interface RefreshedPluginFiles {
  readonly backupDirectory: string;
  readonly assetsSha256: string;
  readonly rollback: () => Promise<void>;
}

interface Snapshot {
  readonly bytes: Buffer;
  readonly identity: BigIntStats;
}

interface Change {
  readonly path: string;
  readonly backup: string;
  readonly before: Snapshot;
  readonly after: Buffer;
  written: Buffer | undefined;
}

const plainPath = async (
  path: string,
  kind: "file" | "directory",
): Promise<BigIntStats> => {
  const absolute = resolve(path);
  const target = await lstat(absolute, { bigint: true });
  for (let cursor = absolute;; cursor = dirname(cursor)) {
    const info = cursor === absolute
      ? target
      : await lstat(cursor, { bigint: true });
    if (info.isSymbolicLink()) {
      throw new Error("Linked plugin or configuration paths cannot be refreshed.");
    }
    if (cursor === absolute && kind === "file") {
      if (!info.isFile() || info.nlink !== 1n) {
        throw new Error("Plugin refresh requires an unlinked regular file.");
      }
    } else if (!info.isDirectory()) {
      throw new Error("Unexpected plugin refresh directory.");
    }
    if (dirname(cursor) === cursor) break;
  }
  if (!equalPath(await realpath(absolute), absolute)) {
    throw new Error("Plugin refresh path ownership is ambiguous.");
  }
  return target;
};

const readHandle = async (handle: FileHandle): Promise<Buffer> => {
  const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer, offset, buffer.length - offset, offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_FILE_BYTES) {
    throw new Error("Plugin refresh file exceeds its size bound.");
  }
  return Buffer.from(buffer.subarray(0, offset));
};

const readSnapshot = async (
  path: string,
  handle: FileHandle,
  identity: BigIntStats,
): Promise<Snapshot> => {
  const before = await handle.stat({ bigint: true });
  if (
    !before.isFile() || before.nlink !== 1n ||
    !sameFile(before, identity) || before.size > BigInt(MAX_FILE_BYTES)
  ) {
    throw new Error("Plugin refresh target changed concurrently or exceeds its size bound.");
  }
  const bytes = await readHandle(handle);
  const after = await handle.stat({ bigint: true });
  const current = await plainPath(path, "file");
  if (
    !sameFile(after, current) || after.nlink !== 1n ||
    before.size !== after.size || after.size !== BigInt(bytes.length) ||
    before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error("Plugin refresh target changed concurrently.");
  }
  return { bytes, identity: after };
};

const boundedRead = async (path: string): Promise<Snapshot> => {
  const identity = await plainPath(path, "file");
  const handle = await open(path, "r");
  try {
    return await readSnapshot(path, handle, identity);
  } finally {
    await handle.close();
  }
};

const objectFrom = (content: Buffer | string): Record<string, unknown> => {
  const text = typeof content === "string"
    ? content
    : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || tree?.type !== "object") {
    throw new Error("Invalid plugin refresh JSON document.");
  }
  const validate = (node: Node, depth = 0): void => {
    if (depth > 64) throw new Error("Plugin refresh JSON nesting exceeds its bound.");
    if (node.type === "object") {
      const names = new Set<unknown>();
      for (const property of node.children ?? []) {
        const name: unknown = property.children?.[0]?.value;
        if (names.has(name)) throw new Error("Ambiguous duplicate plugin refresh JSON property.");
        names.add(name);
      }
    }
    for (const child of node.children ?? []) validate(child, depth + 1);
  };
  validate(tree);
  const value: unknown = getNodeValue(tree);
  if (!record(value)) throw new Error("Invalid plugin refresh JSON document.");
  return value;
};

const edited = (
  text: string,
  path: readonly (string | number)[],
  value: unknown,
): string => applyEdits(text, modify(text, [...path], value, {
  formattingOptions: {
    insertSpaces: true,
    tabSize: 2,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  },
}));

const verifyLayout = async (pluginRoot: string): Promise<void> => {
  const visit = async (directory: string, names: readonly string[]): Promise<void> => {
    await plainPath(directory, "directory");
    const entries = await readdir(directory);
    const expected = [...new Set(names.map((name) => name.split("/")[0]))].sort();
    if (JSON.stringify(entries.sort()) !== JSON.stringify(expected)) {
      throw new Error("Plugin refresh requires the exact installed five-file layout.");
    }
    for (const entry of entries) {
      const children = names
        .filter((name) => name.startsWith(entry + "/"))
        .map((name) => name.slice(entry.length + 1));
      if (children.length > 0) await visit(join(directory, entry), children);
      else await plainPath(join(directory, entry), "file");
    }
  };
  await visit(pluginRoot, FILES);
};

const verifyExpected = async (
  change: Change,
  expected: Buffer,
): Promise<void> => {
  const current = await boundedRead(change.path);
  if (
    !sameFile(current.identity, change.before.identity) ||
    !current.bytes.equals(expected)
  ) {
    throw new Error("Plugin refresh target changed concurrently.");
  }
};

const replaceExpected = async (
  change: Change,
  expected: Buffer,
  replacement: Buffer,
  guard?: () => Promise<void>,
): Promise<void> => {
  await plainPath(change.path, "file");
  const handle = await open(change.path, "r+");
  try {
    await guard?.();
    const current = await readSnapshot(change.path, handle, change.before.identity);
    if (!current.bytes.equals(expected)) {
      throw new Error("Plugin refresh target changed concurrently.");
    }
    // Record only acknowledged writes, so rollback never adopts arbitrary external bytes.
    change.written = expected;
    const progress = Buffer.alloc(Math.max(expected.length, replacement.length));
    expected.copy(progress);
    let length = expected.length;
    let offset = 0;
    while (offset < replacement.length) {
      const { bytesWritten } = await handle.write(
        replacement, offset, replacement.length - offset, offset,
      );
      if (bytesWritten === 0) throw new Error("Plugin refresh write made no progress.");
      replacement.copy(progress, offset, offset, offset + bytesWritten);
      offset += bytesWritten;
      length = Math.max(length, offset);
      change.written = Buffer.from(progress.subarray(0, length));
      const observed = await readSnapshot(change.path, handle, change.before.identity);
      if (!observed.bytes.equals(change.written)) {
        throw new Error("Plugin refresh target changed during a write.");
      }
    }
    await handle.truncate(replacement.length);
    change.written = replacement;
    await handle.sync();
    const verified = await readSnapshot(change.path, handle, change.before.identity);
    if (!verified.bytes.equals(replacement)) {
      throw new Error("Plugin refresh verification failed.");
    }
  } finally {
    await handle.close();
  }
};

/** Refresh the known five-file plugin layout without renaming its locked directory. */
export const refreshPluginFiles = async (
  options: RefreshPluginFilesOptions,
): Promise<RefreshedPluginFiles> => {
  const assets = { ...options.assets };
  if (
    ![options.pluginRoot, options.copilotHome, options.backupRoot].every(isAbsolute) ||
    !VERSION.test(options.version) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(options.marketplaceName)
  ) {
    throw new Error("Invalid plugin refresh scope.");
  }
  if (
    JSON.stringify(Object.keys(assets).sort()) !== JSON.stringify([...FILES].sort()) ||
    Object.values(assets).some(
      (text) => typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_ASSET_BYTES,
    )
  ) {
    throw new Error("Plugin refresh requires the exact bounded packaged assets.");
  }
  const pluginIdentity = await plainPath(options.pluginRoot, "directory");
  await plainPath(options.copilotHome, "directory");
  await plainPath(options.backupRoot, "directory");
  const installedRoot = join(
    options.copilotHome, "installed-plugins", options.marketplaceName, "provenloop",
  );
  if (
    !equalPath(options.pluginRoot, installedRoot) ||
    !sameFile(pluginIdentity, await plainPath(installedRoot, "directory"))
  ) {
    throw new Error("Plugin refresh target does not match the installed marketplace layout.");
  }
  const backupRelation = relative(options.pluginRoot, options.backupRoot);
  if (
    !backupRelation ||
    (!backupRelation.startsWith(".." + sep) && backupRelation !== ".." && !isAbsolute(backupRelation))
  ) {
    throw new Error("Plugin backup must be outside the plugin directory.");
  }
  await verifyLayout(options.pluginRoot);
  const manifest = objectFrom(assets["plugin.json"] ?? "");
  if (manifest.name !== "provenloop" || manifest.version !== options.version) {
    throw new Error("Packaged plugin manifest identity mismatch.");
  }
  const sourceMatch = options.marketplaceSource.match(
    /^([A-Za-z0-9][A-Za-z0-9_.-]*[/][A-Za-z0-9][A-Za-z0-9_.-]*)#(v[A-Za-z0-9._-]+)$/u,
  );
  const repo = sourceMatch?.[1];
  const ref = sourceMatch?.[2];
  if (!repo || !ref || options.marketplaceSource.length > 300 || ref !== "v" + options.version) {
    throw new Error("Plugin refresh requires a version-pinned GitHub marketplace.");
  }
  const configPath = join(options.copilotHome, "config.json");
  const settingsPath = join(options.copilotHome, "settings.json");
  const configSnapshot = await boundedRead(configPath);
  const settingsSnapshot = await boundedRead(settingsPath);
  const config = objectFrom(configSnapshot.bytes);
  const settings = objectFrom(settingsSnapshot.bytes);
  if (!Array.isArray(config.installedPlugins)) {
    throw new Error("Installed plugin registration is unavailable.");
  }
  const matches = config.installedPlugins
    .map((entry: unknown, index: number) => ({ entry, index }))
    .filter(({ entry }) => record(entry) &&
      entry.name === "provenloop" && entry.marketplace === options.marketplaceName);
  const match = matches[0];
  if (
    matches.length !== 1 || !match || !record(match.entry) ||
    typeof match.entry.cache_path !== "string" || !isAbsolute(match.entry.cache_path) ||
    !equalPath(match.entry.cache_path, options.pluginRoot) ||
    typeof match.entry.version !== "string" || !VERSION.test(match.entry.version) ||
    config.installedPlugins.some((entry: unknown, index: number) =>
      index !== match.index && record(entry) && typeof entry.cache_path === "string" &&
      equalPath(entry.cache_path, options.pluginRoot))
  ) {
    throw new Error("Installed plugin registration does not prove the target directory.");
  }
  if (!sameFile(pluginIdentity, await plainPath(match.entry.cache_path, "directory"))) {
    throw new Error("Installed plugin registration directory identity is ambiguous.");
  }
  const marketplaces = settings.extraKnownMarketplaces;
  const marketplace = record(marketplaces) ? marketplaces[options.marketplaceName] : undefined;
  if (!record(marketplace) || !record(marketplace.source)) {
    throw new Error("Existing marketplace registration is unavailable.");
  }
  const source = marketplace.source;
  if (
    source.source !== "github" || typeof source.repo !== "string" ||
    source.repo.toLowerCase() !== repo.toLowerCase() ||
    source.ref !== "v" + match.entry.version
  ) {
    throw new Error("Existing marketplace identity does not match the installed plugin.");
  }

  const pluginSnapshots = new Map<string, Snapshot>();
  for (const name of FILES) {
    pluginSnapshots.set(name, await boundedRead(join(options.pluginRoot, name)));
  }
  const oldManifest = objectFrom(pluginSnapshots.get("plugin.json")?.bytes ?? "");
  if (oldManifest.name !== "provenloop" || oldManifest.version !== match.entry.version) {
    throw new Error("Installed plugin manifest and registration disagree.");
  }
  const assetsSha256 = digest(JSON.stringify(
    FILES.map((name) => [name, digest(assets[name] ?? "")]),
  ));
  let configAfter = edited(
    configSnapshot.bytes.toString("utf8"),
    ["installedPlugins", match.index, "version"],
    options.version,
  );
  // Copilot's native source_sha algorithm is unspecified; our digest is backup metadata only.
  configAfter = edited(configAfter, ["installedPlugins", match.index, "source_sha"], undefined);
  let settingsAfter = settingsSnapshot.bytes.toString("utf8");
  for (const [key, value] of [["repo", repo], ["ref", ref]] as const) {
    settingsAfter = edited(
      settingsAfter,
      ["extraKnownMarketplaces", options.marketplaceName, "source", key],
      value,
    );
  }
  if (Buffer.byteLength(configAfter) > MAX_FILE_BYTES || Buffer.byteLength(settingsAfter) > MAX_FILE_BYTES) {
    throw new Error("Updated plugin configuration exceeds its size bound.");
  }
  const backupDirectory = join(options.backupRoot, "plugin-refresh-" + randomUUID());
  const changes: Change[] = [];
  // Activate the new manifest only after all runtime files are present.
  for (const name of [...FILES.filter((entry) => entry !== "plugin.json"), "plugin.json"]) {
    const before = pluginSnapshots.get(name);
    if (!before) throw new Error("Plugin refresh snapshot is unavailable.");
    changes.push({
      path: join(options.pluginRoot, name),
      backup: join(backupDirectory, "plugin", name),
      before,
      after: Buffer.from(assets[name] ?? "", "utf8"),
      written: undefined,
    });
  }
  const configChange: Change = {
    path: configPath,
    backup: join(backupDirectory, "config.json"),
    before: configSnapshot,
    after: Buffer.from(configAfter),
    written: undefined,
  };
  const settingsChange: Change = {
    path: settingsPath,
    backup: join(backupDirectory, "settings.json"),
    before: settingsSnapshot,
    after: Buffer.from(settingsAfter),
    written: undefined,
  };
  changes.push(configChange, settingsChange);
  await mkdir(backupDirectory);
  for (const change of changes) {
    await mkdir(dirname(change.backup), { recursive: true });
    await plainPath(dirname(change.backup), "directory");
    await writeFile(change.backup, change.before.bytes, { flag: "wx", flush: true });
    if (!(await boundedRead(change.backup)).bytes.equals(change.before.bytes)) {
      throw new Error("Plugin refresh backup verification failed.");
    }
  }
  await writeFile(join(backupDirectory, "manifest.json"), JSON.stringify({
    version: options.version,
    assetsSha256,
    files: changes.map((change) => ({
      path: change.path,
      backup: change.backup,
      beforeSha256: digest(change.before.bytes),
      afterSha256: digest(change.after),
    })),
  }, null, 2), { flag: "wx", flush: true });

  const rollback = async (): Promise<void> => {
    const failures: unknown[] = [];
    const attempted = changes.filter((change) => change.written !== undefined).reverse();
    for (const change of attempted) {
      try {
        const current = await boundedRead(change.path);
        if (!sameFile(current.identity, change.before.identity)) {
          throw new Error("Plugin refresh rollback target was replaced.");
        }
        if (!current.bytes.equals(change.before.bytes)) {
          if (!change.written?.equals(current.bytes)) {
            throw new Error("Concurrent or unacknowledged partial writes were preserved.");
          }
          await replaceExpected(change, current.bytes, change.before.bytes);
        }
        change.written = undefined;
      } catch (error) {
        failures.push(new Error(`Could not restore ${change.path}`, { cause: error }));
      }
    }
    for (const change of attempted) {
      try {
        await verifyExpected(change, change.before.bytes);
      } catch (error) {
        change.written ??= change.before.bytes;
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Plugin refresh rollback needs review; some files could not be restored. Backup: ${backupDirectory}`,
      );
    }
  };
  const guardConfiguration = async (): Promise<void> => {
    for (const change of [configChange, settingsChange]) {
      try {
        await verifyExpected(change, change.written ?? change.before.bytes);
      } catch (error) {
        throw new Error("Copilot configuration changed during plugin refresh.", { cause: error });
      }
    }
  };
  try {
    for (const change of changes) {
      await replaceExpected(change, change.before.bytes, change.after, guardConfiguration);
    }
    await guardConfiguration();
    await verifyLayout(options.pluginRoot);
    for (const change of changes) await verifyExpected(change, change.after);
    return { backupDirectory, assetsSha256, rollback };
  } catch (error) {
    try {
      await rollback();
    } catch (recovery) {
      throw new AggregateError(
        [error, recovery],
        recovery instanceof Error ? recovery.message : "Plugin refresh rollback failed.",
        { cause: recovery },
      );
    }
    throw error;
  }
};
