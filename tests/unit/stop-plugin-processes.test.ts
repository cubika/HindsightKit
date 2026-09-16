import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CommandRunner } from "../../packages/copilot-adapter/src/command-runner.js";
import { stopPluginProcesses } from "../../packages/copilot-adapter/src/stop-plugin-processes.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const write = async (path: string, content: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content), "utf8");
};
const packageAt = async (root: string, version: string) => {
  await write(join(root, "package.json"), { name: "@provenloop/cli", version });
  const cli = join(root, "dist", "bin.js");
  await write(cli, "// Disposable process-discovery fixture.");
  return cli;
};
const fixture = async (marketplaceName = "provenloop-marketplace") => {
  const root = await mkdtemp(join(process.cwd(), ".provenloop-stop-fixture-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  const localAppData = join(root, "local");
  const copilotHome = join(root, "copilot");
  const pluginRoot = join(copilotHome, "installed-plugins", marketplaceName, "provenloop");
  await mkdir(dataRoot);
  await mkdir(localAppData);
  const cliBinPath = await packageAt(join(root, "active"), "0.1.0-alpha.0.13");
  await write(join(pluginRoot, "plugin.json"), { name: "provenloop", version: "0.1.0-alpha.0.12" });
  await write(join(pluginRoot, "scripts", "mcp-launcher.ps1"), "# Disposable launcher fixture.");
  await write(join(pluginRoot, "extensions", "event-capture", "extension.mjs"), "// Disposable extension fixture.");
  const locatorPath = join(localAppData, "ProvenLoopIntegration", "runtime.json");
  const locator = {
    product: "ProvenLoopRuntime", schemaVersion: 1, version: "0.1.0-alpha.0.13",
    nodeExecutable: process.execPath, cliBinPath, dataRoot,
  };
  await write(locatorPath, locator);
  const slots = join(localAppData, "ProvenLoopRuntime", "versions");
  const addSlot = async (version: string) => packageAt(join(slots, version, "node_modules", "@provenloop", "cli"), version);
  return {
    root, slots, pluginRoot, locatorPath, locator, addSlot,
    options: { dataRoot, localAppData, copilotHome, cliBinPath, marketplaceName },
  };
};

const sid = "S-1-5-21-123-456-789-1001";
const identity = (pid: number, args: string[]) => ({
  pid, parentPid: 200, createdAt: "134330447381180000", executable: args[0],
  arguments: args, ownerSid: sid, commandLine: args.map((arg) => `"${arg}"`).join(" "),
});
const fakeController = (processes: ReturnType<typeof identity>[] = []) => {
  const calls: { script: string; payload?: Record<string, unknown> }[] = [];
  const live = new Map(processes.map((entry) => [entry.pid, entry]));
  const runner: CommandRunner = {
    run: async (_executable, args) => {
      const script = Buffer.from(args[3] ?? "", "base64").toString("utf16le");
      if (script.includes("$evidence = @()")) {
        calls.push({ script });
        return { exitCode: 0, stdout: JSON.stringify({ currentUserSid: sid, evidence: [] }), stderr: "" };
      }
      const encoded = /FromBase64String\('([^']+)'\)/u.exec(script)?.[1];
      if (!encoded) throw new Error("Missing structured cleanup scope.");
      const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
      calls.push({ script, payload });
      if (payload.target) {
        const target = payload.target as { pid: number };
        live.delete(target.pid);
        return { exitCode: 0, stdout: '{"status":"stopped"}', stderr: "" };
      }
      return {
        exitCode: 0, stderr: "", stdout: JSON.stringify({
          currentUserSid: sid, extensionParents: [],
          parents: [
            { pid: process.pid, parentPid: 0, executable: process.execPath },
            { pid: 200, parentPid: 0, executable: "C:\\Copilot\\copilot.exe" },
            ...[...live.values()].map((entry) => ({
              pid: entry.pid, parentPid: entry.parentPid, executable: entry.executable,
            })),
          ],
          processes: [...live.values()],
        }),
      };
    },
  };
  return { runner, calls };
};

describe.skipIf(process.platform !== "win32")("old plugin runtime discovery and cleanup", () => {
  it("resolves and inspects real 0.10/0.12 slots and stops only their exact MCP processes", async () => {
    const setup = await fixture();
    const old10 = await setup.addSlot("0.1.0-alpha.0.10");
    const old12 = await setup.addSlot("0.1.0-alpha.0.12");
    const args = (cli: string) => [process.execPath, cli, "mcp", "serve", "--data-root", setup.options.dataRoot];
    const fake = fakeController([
      identity(60101, args(old10)), identity(60102, args(old12)),
      identity(60103, [...args(old10).slice(0, 5), setup.options.dataRoot + "-other"]),
      identity(60104, [process.execPath, old12 + ".other", ...args(old12).slice(2)]),
      identity(60105, ["C:\\Copilot\\copilot.exe", "--resume"]),
      identity(60106, ["C:\\Copilot\\copilot.exe", "C:\\Copilot\\preloads\\extension_bootstrap.mjs"]),
    ]);
    const result = await stopPluginProcesses({ ...setup.options, runner: fake.runner });
    expect(result.stopped).toEqual([60101, 60102]);
    const inventories = fake.calls.filter((call) => call.payload?.paths);
    expect(inventories).toHaveLength(4);
    expect(inventories[0]?.payload?.paths).toEqual(expect.arrayContaining([old10, old12, setup.options.cliBinPath]));
    expect(fake.calls.filter((call) => call.payload?.target).map((call) => (call.payload?.target as { pid: number }).pid)).toEqual([60101, 60102]);
  });

  it("uses a custom marketplace and binds launcher permission to its validated locator", async () => {
    const setup = await fixture("team-marketplace");
    const fake = fakeController();
    const result = await stopPluginProcesses({ ...setup.options, runner: fake.runner });
    expect(result.pluginRoot).toBe(setup.pluginRoot);
    expect(fake.calls.find((call) => call.payload?.paths)?.payload?.paths).toContain(join(setup.pluginRoot, "scripts", "mcp-launcher.ps1"));
  });

  it("rediscovers restarted legacy workers instead of trusting only the original PID allowlist", async () => {
    const setup = await fixture();
    const fake = fakeController();
    const executable = "C:\\Copilot\\copilot.exe";
    const timestamp = "2026-09-08T01:02:03.123Z";
    const createdAt = BigInt(Date.parse(timestamp)) * 10000n + 116444736000000000n;
    const child = {
      ...identity(60101, [executable, "C:\\Copilot\\preloads\\extension_bootstrap.mjs"]),
      createdAt: createdAt.toString(),
    };
    const parent = {
      ...identity(200, [executable, "--log-dir", "C:\\logs"]), parentPid: 0,
      createdAt: (createdAt - 10000000n).toString(),
    };
    let discoveryCalls = 0;
    const runner: CommandRunner = {
      run: async (exe, args, options) => {
        const result = await fake.runner.run(exe, args, options);
        let stdout = result.stdout;
        const script = Buffer.from(args[3] ?? "", "base64").toString("utf16le");
        if (script.includes("$evidence = @()")) {
          discoveryCalls++;
          if (discoveryCalls === 2) {
            stdout = JSON.stringify({ currentUserSid: sid, evidence: [{
              child, parent, logPath: "C:\\logs\\process-fixture-200.log",
              line: `${timestamp} [INFO] [rust:copilot_runtime::extensions::host] [extension-bootstrap] starting: pid=60101, EXTENSION_PATH=${join(setup.pluginRoot, "extensions", "event-capture", "extension.mjs")}, SESSION_ID=restart`,
            }] });
          }
        } else if (discoveryCalls === 2) {
          const snapshot = JSON.parse(result.stdout) as {
            parents: unknown[]; processes: unknown[]; extensionParents: unknown[];
          };
          snapshot.parents.push({ pid: child.pid, parentPid: child.parentPid, executable });
          snapshot.processes.push(child);
          snapshot.extensionParents.push(parent);
          stdout = JSON.stringify(snapshot);
        }
        return { ...result, stdout };
      },
    };
    await expect(stopPluginProcesses({ ...setup.options, runner })).rejects.toThrow("changed or restarted");
    expect(discoveryCalls).toBe(2);
    expect(fake.calls.some((call) => call.payload?.target)).toBe(false);
  });

  it.each(["not-a-version", "01.0.0", "0.1.0-alpha.00", "0.1.0-alpha..12", "dddXdddXddd"])(
    "aborts invalid slot inventory %s before inspecting processes", async (version) => {
      const setup = await fixture();
      await setup.addSlot(version);
      const fake = fakeController();
      await expect(stopPluginProcesses({ ...setup.options, runner: fake.runner })).rejects.toThrow("Invalid ProvenLoop runtime slot inventory");
      expect(fake.calls).toEqual([]);
    },
  );

  it.each([
    { name: "@other/cli", version: "0.1.0-alpha.0.10" },
    { name: "@provenloop/cli", version: "0.1.0-alpha.0.12" },
    { name: "@provenloop/cli", version: 10 },
  ])("does not conceal a mismatched slot manifest %j", async (manifest) => {
    const setup = await fixture();
    const cli = await setup.addSlot("0.1.0-alpha.0.10");
    await write(join(dirname(dirname(cli)), "package.json"), manifest);
    const fake = fakeController();
    await expect(stopPluginProcesses({ ...setup.options, runner: fake.runner })).rejects.toThrow("manifest identity");
    expect(fake.calls).toEqual([]);
  });

  it("rejects an incomplete slot rather than reporting that no old process exists", async () => {
    const setup = await fixture();
    const cli = await setup.addSlot("0.1.0-alpha.0.10");
    await rm(cli);
    const fake = fakeController();
    await expect(stopPluginProcesses({ ...setup.options, runner: fake.runner })).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });

  it("rejects slots redirected through junctions, including intermediate package paths", async () => {
    const setup = await fixture();
    const external = join(setup.root, "redirected");
    await packageAt(join(external, "@provenloop", "cli"), "0.1.0-alpha.0.10");
    const slot = join(setup.slots, "0.1.0-alpha.0.10");
    await mkdir(slot, { recursive: true });
    await symlink(external, join(slot, "node_modules"), "junction");
    const fake = fakeController();
    await expect(stopPluginProcesses({ ...setup.options, runner: fake.runner })).rejects.toThrow("Indirect");
    expect(fake.calls).toEqual([]);
  });

  it("continues exact MCP discovery even when the installed plugin root is absent", async () => {
    const setup = await fixture();
    const cli = await setup.addSlot("0.1.0-alpha.0.10");
    await rm(setup.pluginRoot, { recursive: true });
    const fake = fakeController([identity(60101, [process.execPath, cli, "mcp", "serve", "--data-root", setup.options.dataRoot])]);
    expect((await stopPluginProcesses({ ...setup.options, runner: fake.runner })).stopped).toEqual([60101]);
    expect(fake.calls.every((call) => call.payload !== undefined)).toBe(true);
  });

  it.each(["dataRoot", "cliBinPath", "nodeExecutable", "version"])(
    "aborts a mismatched launcher locator %s before process inspection", async (field) => {
      const setup = await fixture();
      await write(setup.locatorPath, { ...setup.locator, [field]: field === "version" ? "0.1.0-alpha.0.12" : "C:\\other" });
      const fake = fakeController();
      await expect(stopPluginProcesses({ ...setup.options, runner: fake.runner })).rejects.toThrow();
      expect(fake.calls).toEqual([]);
    },
  );

  it("rejects oversized manifests and inventory rather than truncating them", async () => {
    const setup = await fixture();
    await write(setup.locatorPath, " ".repeat(65537));
    const fake = fakeController();
    await expect(stopPluginProcesses({ ...setup.options, runner: fake.runner })).rejects.toThrow("bound");
    await write(setup.locatorPath, setup.locator);
    await Promise.all(Array.from({ length: 16 }, (_, index) => setup.addSlot(`0.1.0-alpha.0.${index}`)));
    await expect(stopPluginProcesses({ ...setup.options, runner: fake.runner })).rejects.toThrow("inventory exceeds");
    expect(fake.calls).toEqual([]);
  });

  it("rejects marketplace traversal before process inspection", async () => {
    const setup = await fixture();
    const fake = fakeController();
    await expect(stopPluginProcesses({ ...setup.options, marketplaceName: "..\\outside", runner: fake.runner })).rejects.toThrow("marketplace name");
    expect(fake.calls).toEqual([]);
  });
});
