import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({
  open: undefined as undefined | ((path: string) => Promise<void>),
  handle: undefined as undefined | ((path: string, handle: FileHandle) => FileHandle),
  readHandle: undefined as undefined | ((path: string, handle: FileHandle) => FileHandle),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      if (args[1] === "r+") await faults.open?.(path);
      const handle = await actual.open(...args);
      return args[1] === "r+"
        ? faults.handle?.(path, handle) ?? handle
        : faults.readHandle?.(path, handle) ?? handle;
    },
  };
});
import { refreshPluginFiles } from "../../packages/copilot-adapter/src/refresh-plugin-files.js";

const roots: string[] = [];
afterEach(async () => {
  faults.open = undefined;
  faults.handle = undefined;
  faults.readHandle = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const files = [
  "plugin.json",
  ".mcp.json",
  "scripts/mcp-launcher.ps1",
  "extensions/event-capture/extension.mjs",
  "skills/provenloop-context/SKILL.md",
];
const sha256 = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const wrapHandle = (handle: FileHandle, overrides: object): FileHandle =>
  new Proxy(handle, {
    get(target, property) {
      const value: unknown = Reflect.get(overrides, property) ?? Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const fixture = async () => {
  const root = await mkdtemp(join(process.cwd(), ".refresh-plugin-"));
  roots.push(root);
  const copilotHome = join(root, "copilot");
  const pluginRoot = join(copilotHome, "installed-plugins", "provenloop-marketplace", "provenloop");
  const backupRoot = join(root, "backups");
  await mkdir(backupRoot);
  const previous: Record<string, string> = {};
  const assets: Record<string, string> = {};
  for (const path of files) {
    previous[path] = path === "plugin.json"
      ? JSON.stringify({ name: "provenloop", version: "0.1.0-alpha.0.10" })
      : "old-" + path;
    assets[path] = path === "plugin.json"
      ? JSON.stringify({ name: "provenloop", version: "0.1.0-alpha.0.12" })
      : "new-" + path;
    await mkdir(dirname(join(pluginRoot, path)), { recursive: true });
    await writeFile(join(pluginRoot, path), previous[path] ?? "");
  }
  const other = {
    name: "other", marketplace: "other-market", version: "2",
    cache_path: "untouched", source_sha: "keep",
  };
  const config = JSON.stringify({
    custom: "keep",
    installedPlugins: [
      other,
      {
        name: "provenloop",
        marketplace: "provenloop-marketplace",
        cache_path: pluginRoot,
        version: "0.1.0-alpha.0.10",
        source_sha: "old-digest",
        enabled: false,
        installed_at: "original",
      },
    ],
  });
  const settings = "// Keep this user comment.\r\n" + JSON.stringify({
    enabledPlugins: { "other@other-market": true },
    extraKnownMarketplaces: {
      "provenloop-marketplace": {
        source: {
          source: "github",
          repo: "cubika/ProvenLoop",
          ref: "v0.1.0-alpha.0.10",
          custom: "preserve-source-metadata",
        },
        keep: true,
      },
      other: { source: "untouched" },
    },
  }, null, 2).replaceAll("\n", "\r\n");
  await writeFile(join(copilotHome, "config.json"), config);
  await writeFile(join(copilotHome, "settings.json"), settings);
  return {
    options: {
      pluginRoot, copilotHome, assets,
      version: "0.1.0-alpha.0.12",
      marketplaceName: "provenloop-marketplace",
      marketplaceSource: "cubika/ProvenLoop#v0.1.0-alpha.0.12",
      backupRoot,
    },
    previous, config, settings, other,
  };
};

const expectOriginal = async (test: Awaited<ReturnType<typeof fixture>>): Promise<void> => {
  for (const path of files) {
    expect(await readFile(join(test.options.pluginRoot, path), "utf8")).toBe(test.previous[path]);
  }
  expect(await readFile(join(test.options.copilotHome, "config.json"), "utf8")).toBe(test.config);
  expect(await readFile(join(test.options.copilotHome, "settings.json"), "utf8")).toBe(test.settings);
};

describe("locked plugin file refresh", () => {
  it("backs up verified bytes, preserves unrelated settings, and supports repeat rollback", async () => {
    const test = await fixture();
    const { options, previous, other } = test;
    const result = await refreshPluginFiles(options);
    for (const path of files) {
      expect(await readFile(join(options.pluginRoot, path), "utf8")).toBe(options.assets[path]);
      expect(await readFile(join(result.backupDirectory, "plugin", path), "utf8")).toBe(previous[path]);
    }
    const updated = parse(await readFile(join(options.copilotHome, "config.json"), "utf8"));
    expect(updated.custom).toBe("keep");
    expect(updated.installedPlugins[0]).toEqual(other);
    expect(updated.installedPlugins[1]).toEqual({
      name: "provenloop",
      marketplace: "provenloop-marketplace",
      version: options.version,
      enabled: false,
      installed_at: "original",
      cache_path: options.pluginRoot,
    });
    const backup = JSON.parse(await readFile(join(result.backupDirectory, "manifest.json"), "utf8"));
    expect(backup.assetsSha256).toBe(result.assetsSha256);
    expect(backup.assetsSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(backup.source_sha).toBeUndefined();
    expect(backup.sourceSha).toBeUndefined();
    expect(backup.files).toHaveLength(7);
    for (const entry of backup.files) {
      expect(sha256(await readFile(entry.backup))).toBe(entry.beforeSha256);
      expect(sha256(await readFile(entry.path))).toBe(entry.afterSha256);
    }
    const updatedSettings = await readFile(join(options.copilotHome, "settings.json"), "utf8");
    expect(updatedSettings).toContain("// Keep this user comment.\r\n");
    expect(updatedSettings.replaceAll("\r\n", "")).not.toContain("\n");
    expect(parse(updatedSettings)).toEqual({
      enabledPlugins: { "other@other-market": true },
      extraKnownMarketplaces: {
        other: { source: "untouched" },
        "provenloop-marketplace": {
          source: {
            source: "github",
            repo: "cubika/ProvenLoop",
            ref: "v0.1.0-alpha.0.12",
            custom: "preserve-source-metadata",
          },
          keep: true,
        },
      },
    });
    await result.rollback();
    await result.rollback();
    await expectOriginal(test);
  });

  it.each(["EBUSY", "EACCES"])("restores completed writes after a later %s open failure", async (code) => {
    const test = await fixture();
    let failed = false;
    faults.open = async (path) => {
      if (!failed && path === join(test.options.pluginRoot, "scripts/mcp-launcher.ps1")) {
        failed = true;
        throw Object.assign(new Error("Simulated sharing violation."), { code });
      }
    };
    await expect(refreshPluginFiles(test.options)).rejects.toThrow("Simulated sharing violation");
    await expectOriginal(test);
    expect(await readdir(test.options.backupRoot)).toHaveLength(1);
  });

  it.each(["write", "zero-progress", "truncate", "sync"])(
    "restores acknowledged partial bytes after a %s failure",
    async (failure) => {
      const test = await fixture();
      test.options.assets[".mcp.json"] = "new";
      const target = join(test.options.pluginRoot, ".mcp.json");
      faults.handle = (path, handle) => {
        if (path !== target) return handle;
        faults.handle = undefined;
        let calls = 0;
        return wrapHandle(handle, {
          write: async (buffer: Buffer, offset: number, length: number, position: number) => {
            calls += 1;
            if (calls === 2 && failure === "write") throw new Error("write failed");
            if (calls === 2 && failure === "zero-progress") return { bytesWritten: 0, buffer };
            return handle.write(buffer, offset, Math.min(length, 1), position);
          },
          truncate: async (length: number) => {
            if (failure === "truncate") throw new Error("truncate failed");
            await handle.truncate(length);
          },
          sync: async () => {
            if (failure === "sync") throw new Error("sync failed");
            await handle.sync();
          },
        });
      };
      await expect(refreshPluginFiles(test.options)).rejects.toThrow(
        failure === "zero-progress" ? "no progress" : failure + " failed",
      );
      await expectOriginal(test);
    },
  );

  it("handles short successful writes, growing and shrinking files", async () => {
    const test = await fixture();
    test.options.assets[".mcp.json"] = "short";
    test.options.assets["scripts/mcp-launcher.ps1"] = "much-longer-new-runtime".repeat(5);
    faults.handle = (_path, handle) => wrapHandle(handle, {
      write: (buffer: Buffer, offset: number, length: number, position: number) =>
        handle.write(buffer, offset, Math.min(length, 7), position),
    });
    const result = await refreshPluginFiles(test.options);
    for (const file of files) {
      expect(await readFile(join(test.options.pluginRoot, file), "utf8")).toBe(test.options.assets[file]);
    }
    await result.rollback();
    await expectOriginal(test);
  });

  it("reports and preserves unacknowledged partial writes rather than claiming rollback", async () => {
    const test = await fixture();
    const target = join(test.options.pluginRoot, "scripts/mcp-launcher.ps1");
    faults.handle = (path, handle) => {
      if (path !== target) return handle;
      faults.handle = undefined;
      return wrapHandle(handle, {
        write: async (buffer: Buffer, offset: number, _length: number, position: number) => {
          await handle.write(buffer, offset, 3, position);
          throw new Error("write failed after modifying bytes");
        },
      });
    };
    const error = await refreshPluginFiles(test.options).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toContain("rollback needs review");
    expect((error as AggregateError).message).toContain(test.options.backupRoot);
    expect((error as AggregateError).errors[0].message).toContain("write failed");
    expect(await readFile(target, "utf8")).toBe(
      "new" + test.previous["scripts/mcp-launcher.ps1"]?.slice(3),
    );
    expect(await readFile(join(test.options.pluginRoot, ".mcp.json"), "utf8"))
      .toBe(test.previous[".mcp.json"]);
  });

  it("reports a failed rollback and retries only unrestored writes", async () => {
    const test = await fixture();
    const result = await refreshPluginFiles(test.options);
    const target = join(test.options.pluginRoot, "scripts/mcp-launcher.ps1");
    faults.open = async (path) => {
      if (path === target) throw new Error("rollback target locked");
    };
    await expect(result.rollback()).rejects.toThrow("rollback needs review");
    expect(await readFile(target, "utf8")).toBe(test.options.assets["scripts/mcp-launcher.ps1"]);
    expect(await readFile(join(test.options.pluginRoot, ".mcp.json"), "utf8"))
      .toBe(test.previous[".mcp.json"]);
    faults.open = undefined;
    await result.rollback();
    await expectOriginal(test);
  });

  it.each(["config.json", "settings.json"])(
    "preserves concurrent %s edits before the next runtime write",
    async (name) => {
      const test = await fixture();
      const target = join(test.options.copilotHome, name);
      const concurrent = (await readFile(target, "utf8")) + "\n// concurrent host edit";
      faults.open = async (path) => {
        if (path === join(test.options.pluginRoot, "scripts/mcp-launcher.ps1")) {
          faults.open = undefined;
          await writeFile(target, concurrent);
        }
      };
      await expect(refreshPluginFiles(test.options)).rejects.toThrow("configuration changed");
      expect(await readFile(target, "utf8")).toBe(concurrent);
      for (const file of files) {
        expect(await readFile(join(test.options.pluginRoot, file), "utf8")).toBe(test.previous[file]);
      }
    },
  );

  it.each(["config.json", ".mcp.json"])(
    "detects %s changes during the last write and preserves external bytes on rollback",
    async (name) => {
      const test = await fixture();
      const target = join(name === "config.json" ? test.options.copilotHome : test.options.pluginRoot, name);
      let concurrent = "";
      faults.handle = (path, handle) => {
        if (path !== join(test.options.copilotHome, "settings.json")) return handle;
        faults.handle = undefined;
        return wrapHandle(handle, {
          sync: async () => {
            await handle.sync();
            concurrent = (await readFile(target, "utf8")) + "\n// late external edit";
            await writeFile(target, concurrent);
          },
        });
      };
      await expect(refreshPluginFiles(test.options)).rejects.toThrow("rollback needs review");
      expect(await readFile(target, "utf8")).toBe(concurrent);
      expect(await readFile(join(test.options.copilotHome, "settings.json"), "utf8")).toBe(test.settings);
      expect(await readFile(join(test.options.pluginRoot, "plugin.json"), "utf8")).toBe(test.previous["plugin.json"]);
    },
  );

  it("preserves external file edits during a later explicit rollback", async () => {
    const { options } = await fixture();
    const result = await refreshPluginFiles(options);
    const path = join(options.pluginRoot, "scripts/mcp-launcher.ps1");
    await writeFile(path, "user-edited-after-refresh");
    await expect(result.rollback()).rejects.toThrow("rollback needs review");
    expect(await readFile(path, "utf8")).toBe("user-edited-after-refresh");
  });

  it("continues reporting external edits that arrive after a file was restored", async () => {
    const test = await fixture();
    const result = await refreshPluginFiles(test.options);
    const settingsPath = join(test.options.copilotHome, "settings.json");
    const concurrent = test.settings + "\n// edited during rollback";
    faults.handle = (path, handle) => {
      if (path !== join(test.options.pluginRoot, ".mcp.json")) return handle;
      faults.handle = undefined;
      return wrapHandle(handle, {
        sync: async () => {
          await handle.sync();
          await writeFile(settingsPath, concurrent);
        },
      });
    };
    await expect(result.rollback()).rejects.toThrow("rollback needs review");
    await expect(result.rollback()).rejects.toThrow("rollback needs review");
    expect(await readFile(settingsPath, "utf8")).toBe(concurrent);
  });

  it("refuses a byte-identical file replacement between snapshot and write", async () => {
    const test = await fixture();
    const target = join(test.options.pluginRoot, "scripts/mcp-launcher.ps1");
    faults.open = async (path) => {
      if (path !== target) return;
      faults.open = undefined;
      await rename(path, join(test.options.backupRoot, "external-original"));
      await writeFile(path, test.previous["scripts/mcp-launcher.ps1"] ?? "");
    };
    await expect(refreshPluginFiles(test.options)).rejects.toThrow("changed concurrently");
    await expectOriginal(test);
  });

  it("refuses a byte-identical replacement during explicit rollback", async () => {
    const test = await fixture();
    const result = await refreshPluginFiles(test.options);
    const target = join(test.options.pluginRoot, "scripts/mcp-launcher.ps1");
    await rename(target, join(test.options.backupRoot, "external-original"));
    await writeFile(target, test.options.assets["scripts/mcp-launcher.ps1"] ?? "");
    await expect(result.rollback()).rejects.toThrow("rollback needs review");
    expect(await readFile(target, "utf8")).toBe(test.options.assets["scripts/mcp-launcher.ps1"]);
  });

  it("rejects a file that becomes hard-linked immediately before opening", async () => {
    const test = await fixture();
    const target = join(test.options.pluginRoot, "scripts/mcp-launcher.ps1");
    const external = join(test.options.backupRoot, "external-link");
    faults.open = async (path) => {
      if (path !== target) return;
      faults.open = undefined;
      await link(target, external);
    };
    await expect(refreshPluginFiles(test.options)).rejects.toThrow("changed concurrently");
    await expectOriginal(test);
    expect(await readFile(external, "utf8")).toBe(test.previous["scripts/mcp-launcher.ps1"]);
  });

  it("validates backups before modifying installed files", async () => {
    const test = await fixture();
    faults.readHandle = (path, handle) => {
      if (!path.startsWith(test.options.backupRoot) || !path.endsWith(".mcp.json")) return handle;
      faults.readHandle = undefined;
      return wrapHandle(handle, {
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          await writeFile(path, "tampered backup");
          return handle.read(buffer, offset, length, position);
        },
      });
    };
    await expect(refreshPluginFiles(test.options)).rejects.toThrow("changed concurrently");
    await expectOriginal(test);
  });

  it.each(["file", "directory", "missing"])("rejects an unexpected installed %s layout", async (kind) => {
    const test = await fixture();
    const unexpected = join(test.options.pluginRoot, "unmanaged");
    if (kind === "directory") await mkdir(unexpected);
    else if (kind === "file") await writeFile(unexpected, "unmanaged");
    else await rm(join(test.options.pluginRoot, ".mcp.json"));
    await expect(refreshPluginFiles(test.options)).rejects.toThrow("exact installed five-file layout");
    expect(await readdir(test.options.backupRoot)).toEqual([]);
    expect(await readFile(join(test.options.pluginRoot, "plugin.json"), "utf8")).toBe(test.previous["plugin.json"]);
  });

  it("rejects traversal and mismatched packaged manifests before mutation", async () => {
    const test = await fixture();
    await expect(refreshPluginFiles({
      ...test.options, assets: { ...test.options.assets, "../outside": "bad" },
    })).rejects.toThrow("exact bounded packaged assets");
    await expect(refreshPluginFiles({
      ...test.options,
      assets: {
        ...test.options.assets,
        "plugin.json": JSON.stringify({ name: "other", version: test.options.version }),
      },
    })).rejects.toThrow("manifest identity mismatch");
    await expectOriginal(test);
    expect(await readdir(test.options.backupRoot)).toEqual([]);
  });

  it.each(["duplicate", "alias", "relative", "missing-version", "wrong-marketplace"])(
    "rejects %s installed registration",
    async (kind) => {
      const test = await fixture();
      const config = parse(test.config);
      if (kind === "duplicate") config.installedPlugins.push(config.installedPlugins[1]);
      if (kind === "alias") config.installedPlugins[0].cache_path = test.options.pluginRoot;
      if (kind === "relative") config.installedPlugins[1].cache_path = relative(process.cwd(), test.options.pluginRoot);
      if (kind === "missing-version") delete config.installedPlugins[1].version;
      if (kind === "wrong-marketplace") config.installedPlugins[1].marketplace = "other-market";
      await writeFile(join(test.options.copilotHome, "config.json"), JSON.stringify(config));
      await expect(refreshPluginFiles(test.options)).rejects.toThrow("does not prove");
      expect(await readdir(test.options.backupRoot)).toEqual([]);
    },
  );

  it.each(["repo", "source", "ref", "missing"])("rejects mismatched marketplace %s identity", async (kind) => {
    const test = await fixture();
    const settings = parse(test.settings);
    const marketplace = settings.extraKnownMarketplaces["provenloop-marketplace"];
    if (kind === "repo") marketplace.source.repo = "someone/unrelated";
    if (kind === "source") marketplace.source.source = "directory";
    if (kind === "ref") marketplace.source.ref = "main";
    if (kind === "missing") delete marketplace.source;
    await writeFile(join(test.options.copilotHome, "settings.json"), JSON.stringify(settings));
    await expect(refreshPluginFiles(test.options)).rejects.toThrow(/marketplace (?:identity|registration)/u);
    expect(await readdir(test.options.backupRoot)).toEqual([]);
  });

  it("rejects an inconsistent installed manifest", async () => {
    const test = await fixture();
    await writeFile(join(test.options.pluginRoot, "plugin.json"), JSON.stringify({
      name: "provenloop", version: "0.1.0-alpha.0.9",
    }));
    await expect(refreshPluginFiles(test.options)).rejects.toThrow("manifest and registration disagree");
    expect(await readdir(test.options.backupRoot)).toEqual([]);
  });

  it("rejects a registered plugin outside the canonical installation directory", async () => {
    const test = await fixture();
    const outside = join(test.options.copilotHome, "other-plugin-root");
    await rename(test.options.pluginRoot, outside);
    const config = parse(test.config);
    config.installedPlugins[1].cache_path = outside;
    await writeFile(join(test.options.copilotHome, "config.json"), JSON.stringify(config));
    await expect(refreshPluginFiles({ ...test.options, pluginRoot: outside }))
      .rejects.toThrow("installed marketplace layout");
    expect(await readdir(test.options.backupRoot)).toEqual([]);
  });

  it.each([".mcp.json", "config.json", "settings.json"])("refuses hard-linked %s", async (name) => {
    const test = await fixture();
    const target = join(name === ".mcp.json" ? test.options.pluginRoot : test.options.copilotHome, name);
    await link(target, join(test.options.backupRoot, "external-link"));
    await expect(refreshPluginFiles(test.options)).rejects.toThrow("unlinked regular file");
    await expectOriginal(test);
    expect(await readdir(test.options.backupRoot)).toEqual(["external-link"]);
  });

  it.each(["plugin", "nested", "backup"])("refuses linked %s directories", async (kind) => {
    const test = await fixture();
    const target = kind === "plugin"
      ? test.options.pluginRoot
      : kind === "backup"
        ? test.options.backupRoot
        : join(test.options.pluginRoot, "scripts");
    const external = join(test.options.copilotHome, "external");
    await rename(target, external);
    await symlink(external, target, "junction");
    await expect(refreshPluginFiles(test.options)).rejects.toThrow("Linked");
  });

  it("refuses backups inside the plugin directory", async () => {
    const test = await fixture();
    await expect(refreshPluginFiles({ ...test.options, backupRoot: test.options.pluginRoot }))
      .rejects.toThrow("outside the plugin directory");
    await expectOriginal(test);
  });

  it.each(["asset", "installed", "config"])("bounds oversized %s input", async (kind) => {
    const test = await fixture();
    if (kind === "asset") test.options.assets[".mcp.json"] = "x".repeat(256 * 1024 + 1);
    else await writeFile(
      kind === "installed"
        ? join(test.options.pluginRoot, ".mcp.json")
        : join(test.options.copilotHome, "config.json"),
      "x".repeat(1024 * 1024 + 1),
    );
    await expect(refreshPluginFiles(test.options)).rejects.toThrow(/bound/u);
    expect(await readdir(test.options.backupRoot)).toEqual([]);
  });

  it("bounds configuration growth caused by edits", async () => {
    const test = await fixture();
    const settings = test.settings + " ".repeat(1024 * 1024 - Buffer.byteLength(test.settings));
    await writeFile(join(test.options.copilotHome, "settings.json"), settings);
    await expect(refreshPluginFiles({
      ...test.options,
      version: "0.1.0-alpha.0.12345",
      marketplaceSource: "cubika/ProvenLoop#v0.1.0-alpha.0.12345",
      assets: {
        ...test.options.assets,
        "plugin.json": JSON.stringify({ name: "provenloop", version: "0.1.0-alpha.0.12345" }),
      },
    })).rejects.toThrow("configuration exceeds its size bound");
    expect(await readdir(test.options.backupRoot)).toEqual([]);
  });

  it("bounds reads even when a file grows after its stat", async () => {
    const test = await fixture();
    const target = join(test.options.copilotHome, "config.json");
    let bytesRequested = 0;
    faults.readHandle = (path, handle) => {
      if (path !== target) return handle;
      faults.readHandle = undefined;
      return wrapHandle(handle, {
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          bytesRequested += length;
          await writeFile(target, "x".repeat(2 * 1024 * 1024));
          return handle.read(buffer, offset, length, position);
        },
      });
    };
    await expect(refreshPluginFiles(test.options)).rejects.toThrow("size bound");
    expect(bytesRequested).toBe(1024 * 1024 + 1);
    expect(await readdir(test.options.backupRoot)).toEqual([]);
  });

  it.each(["duplicate", "invalid", "utf8", "deep"])("refuses ambiguous or invalid %s configuration", async (kind) => {
    const test = await fixture();
    const text = kind === "duplicate" ? '{"custom":"shadowed",' + test.config.slice(1)
      : kind === "invalid" ? test.config + "invalid"
        : kind === "deep" ? '{"nested":' + "[".repeat(65) + "0" + "]".repeat(65) + "}"
          : Buffer.concat([Buffer.from(test.config), Buffer.from([0xff])]);
    await writeFile(join(test.options.copilotHome, "config.json"), text);
    await expect(refreshPluginFiles(test.options)).rejects.toThrow();
    expect(await readdir(test.options.backupRoot)).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("refreshes while a native directory handle denies delete sharing", async () => {
    const test = await fixture();
    const startupTimeoutMs = 45_000;
    const teardownTimeoutMs = 10_000;
    const readinessToken = "directory-locked-" + randomUUID();
    const startedAt = Date.now();
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = "Stop"
[Console]::Out.WriteLine("fixture: PowerShell started")
[Console]::Out.Flush()
Add-Type @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DirectoryLock {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern SafeFileHandle CreateFile(string name, uint access, uint share,
    IntPtr security, uint disposition, uint flags, IntPtr template);
}
'@
[Console]::Out.WriteLine("fixture: native interop compiled")
[Console]::Out.Flush()
$handle = [DirectoryLock]::CreateFile($env:PROVENLOOP_TEST_PLUGIN_ROOT, 1, 3, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
if ($handle.IsInvalid) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "Could not lock fixture directory; Win32 error $code."
}
try {
  # Exercise readiness across separately flushed output chunks.
  $token = $env:PROVENLOOP_TEST_LOCK_TOKEN
  $split = [int]($token.Length / 2)
  [Console]::Out.Write($token.Substring(0, $split))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 25
  [Console]::Out.WriteLine($token.Substring($split))
  [Console]::Out.Flush()
  Start-Sleep -Seconds 120
} finally {
  $handle.Dispose()
}
`], {
      env: {
        ...process.env,
        PROVENLOOP_TEST_PLUGIN_ROOT: test.options.pluginRoot,
        PROVENLOOP_TEST_LOCK_TOKEN: readinessToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    let spawned = false;
    let closed = false;
    let terminationRequested = false;
    let processError: Error | undefined;
    let settleReady: ((error?: Error) => void) | undefined;
    let resolveClosed: (() => void) | undefined;
    const diagnostics = (): string =>
      `elapsed=${Date.now() - startedAt}ms, spawned=${String(spawned)}, ` +
      `pid=${String(child.pid)}, exitCode=${String(child.exitCode)}, ` +
      `signal=${String(child.signalCode)}, closed=${String(closed)}, terminationRequested=${String(terminationRequested)}, ` +
      `error=${processError?.message ?? "none"}\nstdout: ${stdout || "(empty)"}\nstderr: ${stderr || "(empty)"}`;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        settleReady?.(new Error(`Directory lock startup timed out after ${startupTimeoutMs}ms.\n${diagnostics()}`));
      }, startupTimeoutMs);
      settleReady = (error) => {
        clearTimeout(timer);
        settleReady = undefined;
        if (error) reject(error);
        else resolve();
      };
    });
    const exited = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const onSpawn = (): void => { spawned = true; };
    const onError = (error: Error): void => {
      processError ??= error;
      settleReady?.(new Error(`Directory lock process or stream failed.\n${diagnostics()}`, { cause: error }));
    };
    const onExit = (): void => {
      settleReady?.(new Error(`Directory lock exited before readiness.\n${diagnostics()}`));
    };
    const onClose = (): void => {
      closed = true;
      settleReady?.(new Error(`Directory lock closed before readiness.\n${diagnostics()}`));
      resolveClosed?.();
    };
    const onStdout = (chunk: string): void => {
      stdout = (stdout + chunk).slice(-8192);
      pendingLine += chunk;
      let newline: number;
      while ((newline = pendingLine.indexOf("\n")) !== -1) {
        const line = pendingLine.slice(0, newline).replace(/\r$/u, "");
        pendingLine = pendingLine.slice(newline + 1);
        if (line === readinessToken) {
          if (child.exitCode !== null || child.signalCode !== null || processError) {
            settleReady?.(new Error(`Directory lock was not alive at readiness.\n${diagnostics()}`));
          } else {
            settleReady?.();
          }
        }
      }
      pendingLine = pendingLine.slice(-8192);
    };
    const onStderr = (chunk: string): void => { stderr = (stderr + chunk).slice(-8192); };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.once("spawn", onSpawn);
    child.on("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.stdout.on("error", onError);
    child.stderr.on("error", onError);

    const assertDirectoryLocked = async (phase: string): Promise<void> => {
      if (closed || child.exitCode !== null || child.signalCode !== null || processError) {
        throw new Error(`Directory lock was lost ${phase}.\n${diagnostics()}`);
      }
      const denied = { code: expect.stringMatching(/^(?:EBUSY|EACCES|EPERM)$/u) };
      await expect(rename(test.options.pluginRoot, test.options.pluginRoot + "-moved")).rejects.toMatchObject(denied);
      await expect(rmdir(test.options.pluginRoot)).rejects.toMatchObject(denied);
    };
    const failures: unknown[] = [];
    try {
      await ready;
      await assertDirectoryLocked("before refresh");
      const result = await refreshPluginFiles(test.options);
      expect(await readFile(join(test.options.pluginRoot, "plugin.json"), "utf8"))
        .toBe(test.options.assets["plugin.json"]);
      await assertDirectoryLocked("after refresh");
      await result.rollback();
      await expectOriginal(test);
      await assertDirectoryLocked("after rollback");
    } catch (error) {
      failures.push(error);
    } finally {
      let timer: NodeJS.Timeout | undefined;
      try {
        if (!closed && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          terminationRequested = child.kill();
        }
        await Promise.race([
          exited,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(
              `Directory lock teardown timed out after ${teardownTimeoutMs}ms.\n${diagnostics()}`,
            )), teardownTimeoutMs);
          }),
        ]);
      } catch (error) {
        failures.push(error);
      } finally {
        clearTimeout(timer);
        child.off("spawn", onSpawn);
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("close", onClose);
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        child.stdout.off("error", onError);
        child.stderr.off("error", onError);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Native directory lock fixture failed, including teardown.");
    }
  }, 90_000);
});
