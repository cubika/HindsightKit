import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SpawnCommandRunner } from "../../packages/copilot-adapter/src/command-runner.js";
import {
  discoverLegacyExtensionWorkers,
  parseLegacyExtensionEvidence,
} from "../../packages/copilot-adapter/src/legacy-extension-workers.js";
import { OwnedProvenLoopProcessController } from "../../packages/copilot-adapter/src/owned-processes.js";

const plugin = "C:\\Copilot\\plugins\\provenloop";
const extension = plugin + "\\extensions\\event-capture\\extension.mjs";
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const copilot = "C:\\Copilot\\copilot.exe";
const bootstrap = "C:\\Copilot\\preloads\\extension_bootstrap.mjs";
const sid = "S-1-5-21-123-456-789-1001";
const timestamp = "2026-09-08T01:02:03.123Z";
const createdAt = (BigInt(Date.parse(timestamp)) * 10000n + 116444736000000000n).toString();
const parentCreatedAt = (BigInt(createdAt) - 10000000n).toString();
const processIdentity = (pid: number, parentPid: number, args: string[], creation: string) => ({
  pid, parentPid, arguments: args, createdAt: creation, executable: copilot,
  ownerSid: sid, commandLine: args.map((arg) => `"${arg}"`).join(" "),
});
const evidence = () => ({
  child: processIdentity(401, 200, [copilot, bootstrap], createdAt),
  parent: processIdentity(200, 0, [copilot, "--log-dir", "C:\\logs"], parentCreatedAt),
  logPath: "C:\\logs\\process-2026-09-08-200.log",
  line: `${timestamp} [INFO] [rust:copilot_runtime::extensions::host] [extension-bootstrap] starting: pid=401, EXTENSION_PATH=${extension}, SESSION_ID=session-1`,
});
const output = (entries: unknown[] = [evidence()]) => JSON.stringify({ currentUserSid: sid, evidence: entries });

describe("legacy extension provenance discovery", () => {
  it("uses bounded native evidence and parses the real discovery result before authorizing an extension", async () => {
    const run = vi.fn(async (_exe: string, args: readonly string[]) => {
      const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1] ?? "", "base64").toString("utf16le");
      expect(script).toContain("[rust:copilot_runtime::extensions::host]");
      expect(script).toContain("Read-Identity $parentRow");
      expect(script).toContain("$files.Count -gt 4");
      expect(script).toContain("$read -gt 8388608");
      expect(script).toContain("$totalBytes -gt 33554432");
      expect(script).toContain("Text.UTF8Encoding($false,$true)");
      expect(script).not.toContain("::TerminateProcess($handle");
      return { exitCode: 0, stdout: output(), stderr: "" };
    });
    const workers = await discoverLegacyExtensionWorkers({ run }, [plugin], powershell);
    expect(workers).toEqual([{
      pid: 401, parentPid: 200, createdAt, parentCreatedAt, ownerSid: sid,
      executable: copilot, bootstrapPath: bootstrap, extensionPath: extension,
    }]);
    const observed = evidence();
    const controller = new OwnedProvenLoopProcessController({
      dataRoot: "C:\\data", runtimes: [], pluginRoots: [plugin], extensionWorkers: workers,
      currentProcessId: 100, powerShellExecutable: powershell, platform: "win32",
      runner: { run: async () => ({
        exitCode: 0, stderr: "", stdout: JSON.stringify({
          currentUserSid: sid,
          parents: [
            { pid: 100, parentPid: 0, executable: "C:\\node.exe" },
            { pid: 200, parentPid: 0, executable: copilot },
            { pid: 401, parentPid: 200, executable: copilot },
            { pid: 402, parentPid: 200, executable: copilot },
          ],
          extensionParents: [observed.parent],
          processes: [observed.child, { ...observed.child, pid: 402 }, observed.parent],
        }),
      }) },
    });
    expect((await controller.inspect()).processes).toEqual([{
      pid: 401, parentPid: 200, createdAt, executable: copilot, kind: "extension",
    }]);
  });

  it.each([
    (entry: ReturnType<typeof evidence>) => { entry.line = entry.line.replace("2026-09-08", "2026-02-30"); },
    (entry: ReturnType<typeof evidence>) => { entry.line = entry.line.replace("01:02:03", "01:02:09"); },
    (entry: ReturnType<typeof evidence>) => { entry.line = entry.line.replace("pid=401,", "pid=4010,"); },
    (entry: ReturnType<typeof evidence>) => { entry.line = entry.line.replace(extension, extension + ".other"); },
    (entry: ReturnType<typeof evidence>) => { entry.line = entry.line.replace("[INFO]", "[ERROR]"); },
    (entry: ReturnType<typeof evidence>) => { entry.line = entry.line.replace("[rust:copilot_runtime::extensions::host]", "[other]"); },
    (entry: ReturnType<typeof evidence>) => { entry.line = "untrusted prefix " + entry.line; },
  ])("leaves unknown or stale log evidence unselected (%#)", (alter) => {
    const entry = evidence();
    alter(entry);
    expect(parseLegacyExtensionEvidence(output([entry]), [plugin])).toEqual([]);
  });

  it.each([
    (entry: ReturnType<typeof evidence>) => { entry.parent.createdAt = entry.child.createdAt; },
    (entry: ReturnType<typeof evidence>) => { entry.parent.ownerSid = "S-1-5-21-999"; },
    (entry: ReturnType<typeof evidence>) => { entry.child.parentPid = 201; },
    (entry: ReturnType<typeof evidence>) => { entry.child.arguments.push("--resume"); },
    (entry: ReturnType<typeof evidence>) => { entry.child.arguments[1] = "C:\\Other\\preloads\\extension_bootstrap.mjs"; },
    (entry: ReturnType<typeof evidence>) => { entry.logPath = "C:\\logs\\process-2026-09-08-201.log"; },
    (entry: ReturnType<typeof evidence>) => { entry.logPath = "C:\\other\\process-2026-09-08-200.log"; },
    (entry: ReturnType<typeof evidence>) => { entry.parent.arguments.push("--log-dir", "C:\\logs"); },
    (entry: ReturnType<typeof evidence>) => { entry.child.createdAt = "9223372036854775808"; },
    (entry: ReturnType<typeof evidence>) => { entry.line += "\n"; },
  ])("rejects malformed or mismatched evidence inventory (%#)", (alter) => {
    const entry = evidence();
    alter(entry);
    expect(() => parseLegacyExtensionEvidence(output([entry]), [plugin])).toThrow();
  });

  it("checks byte, row and line bounds and rejects malformed JSON", () => {
    expect(() => parseLegacyExtensionEvidence(" ".repeat(512 * 1024 + 1), [plugin])).toThrow("bound");
    expect(() => parseLegacyExtensionEvidence(output(Array.from({ length: 129 }, evidence)), [plugin])).toThrow("inventory");
    expect(() => parseLegacyExtensionEvidence(output([{ ...evidence(), line: "x".repeat(8193) }]), [plugin])).toThrow("log evidence");
    expect(() => parseLegacyExtensionEvidence("{broken", [plugin])).toThrow("command output");
    expect(() => parseLegacyExtensionEvidence('{"workers":[]}', [plugin])).toThrow("inventory");
    expect(() => parseLegacyExtensionEvidence(output([null]), [plugin])).toThrow("log evidence");
  });

  it("deduplicates identical evidence but rejects conflicting PID observations", () => {
    expect(parseLegacyExtensionEvidence(output([evidence(), evidence()]), [plugin])).toHaveLength(1);
    const conflicting = evidence();
    conflicting.child.createdAt = (BigInt(createdAt) + 1n).toString();
    expect(() => parseLegacyExtensionEvidence(output([evidence(), conflicting]), [plugin])).toThrow("Conflicting");
  });

  it("fails explicitly on a failed probe, without exposing private stderr", async () => {
    await expect(discoverLegacyExtensionWorkers(
      { run: async () => ({ exitCode: 1, stdout: "", stderr: "private" }) }, [plugin], powershell,
    )).rejects.toThrow("Cannot verify legacy");
  });

  it("does not probe arbitrary Copilot workers when no plugin installation exists", async () => {
    const run = vi.fn();
    expect(await discoverLegacyExtensionWorkers({ run }, [], powershell)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "win32" || process.env.PROVENLOOP_PROCESS_FIXTURE !== "1")(
    "verifies disposable native log evidence while preserving its Copilot host and unknown bootstrap", async () => {
      const root = await mkdtemp(join(process.cwd(), ".provenloop-legacy-fixture-"));
      const executable = join(root, "copilot.exe");
      const bootstrapPath = join(root, "preloads", "extension_bootstrap.mjs");
      const logDirectory = join(root, "logs");
      const hostPath = join(root, "host.mjs");
      const pluginRoot = join(root, "plugin");
      const extensionPath = join(pluginRoot, "extensions", "event-capture", "extension.mjs");
      let host: ReturnType<typeof spawn> | undefined;
      try {
        await mkdir(join(root, "preloads"));
        await mkdir(logDirectory);
        await copyFile(process.execPath, executable);
        await writeFile(bootstrapPath, "process.stdout.write('ready'); setInterval(() => {}, 1000);", "utf8");
        await writeFile(hostPath, `
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const children = [];
process.on("exit", () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
process.stdin.once("data", async () => {
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }));
  process.exit(0);
});
for (let index = 0; index < 2; index++) {
  const child = spawn(process.execPath, [${JSON.stringify(bootstrapPath)}], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  children.push(child);
  await once(child.stdout, "data");
}
await writeFile(join(${JSON.stringify(logDirectory)}, "process-fixture-" + process.pid + ".log"),
  new Date().toISOString() + " [INFO] [rust:copilot_runtime::extensions::host] [extension-bootstrap] starting: pid=" +
  children[0].pid + ", EXTENSION_PATH=" + ${JSON.stringify(extensionPath)} + ", SESSION_ID=fixture\\n");
process.stdout.write(JSON.stringify(children.map((child) => child.pid)) + "\\n");
`, "utf8");
        host = spawn(executable, [hostPath, "--log-dir", logDirectory], {
          stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        });
        const fixtureHost = host;
        const fixturePids = await new Promise<number[]>((resolveReady, reject) => {
          let output = "";
          const finish = (error?: Error, pids?: number[]) => {
            clearTimeout(timeout);
            fixtureHost.removeListener("error", onError);
            fixtureHost.removeListener("exit", onExit);
            fixtureHost.stdout?.removeListener("data", onData);
            if (error) reject(error);
            else resolveReady(pids ?? []);
          };
          const onError = (error: Error) => finish(error);
          const onExit = () => finish(new Error("Disposable host exited before startup."));
          const onData = (data: Buffer) => {
            output += data.toString("utf8");
            if (output.length > 4096) { finish(new Error("Disposable host output exceeds its bound.")); return; }
            if (!output.includes("\n")) return;
            try {
              const pids: unknown = JSON.parse(output.trim());
              if (!Array.isArray(pids) || pids.length !== 2 || !pids.every((pid: unknown) =>
                typeof pid === "number" && Number.isInteger(pid) && pid > 0)) throw new Error("Invalid fixture PIDs.");
              finish(undefined, pids as number[]);
            } catch (error) {
              finish(error instanceof Error ? error : new Error("Invalid fixture readiness."));
            }
          };
          const timeout = setTimeout(() => finish(new Error("Disposable host startup timed out.")), 10_000);
          fixtureHost.once("error", onError);
          fixtureHost.once("exit", onExit);
          fixtureHost.stdout?.on("data", onData);
        });
        const native = new SpawnCommandRunner();
        const fixtureRunner = {
          run: async (exe: string, args: readonly string[]) => {
            const script = Buffer.from(args[3] ?? "", "base64").toString("utf16le");
            const inventory = "$all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5)";
            expect(script).toContain(inventory);
            // Never read real user host logs: this probe can see only disposable fixture identities.
            const scopedScript = script.replace(inventory,
              `$all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5 | Where-Object { $_.ProcessId -eq ${fixtureHost.pid} -or $_.ParentProcessId -eq ${fixtureHost.pid} })`);
            return native.run(exe, [...args.slice(0, 3), Buffer.from(scopedScript, "utf16le").toString("base64")], { timeoutMs: 30_000 });
          },
        };
        const workers = await discoverLegacyExtensionWorkers(fixtureRunner, [pluginRoot], powershell);
        expect(workers.map((worker) => worker.pid)).toEqual([fixturePids[0]]);
        const controller = new OwnedProvenLoopProcessController({
          dataRoot: join(root, "data"), runtimes: [], pluginRoots: [pluginRoot], extensionWorkers: workers,
          powerShellExecutable: powershell,
          runner: { run: (exe, args) => native.run(exe, args, { timeoutMs: 30_000 }) },
        });
        const inventory = await controller.inspect();
        expect(inventory.processes.map((entry) => entry.pid)).toEqual([fixturePids[0]]);
        expect(await controller.stop(inventory)).toEqual([{ pid: fixturePids[0], status: "stopped" }]);
        expect(fixtureHost.exitCode).toBeNull();
        process.kill(fixturePids[1] as number, 0);
        process.kill(fixtureHost.pid as number, 0);
        process.kill(process.pid, 0);
      } finally {
        if (host?.pid && host.exitCode === null && host.signalCode === null) {
          const fixtureHost = host;
          await new Promise<void>((resolveExit, reject) => {
            const timeout = setTimeout(() => reject(new Error("Disposable host cleanup timed out.")), 10_000);
            fixtureHost.once("exit", () => { clearTimeout(timeout); resolveExit(); });
            fixtureHost.stdin?.end("stop\n");
          });
        }
        await rm(root, { recursive: true, force: true });
      }
    }, 150_000,
  );
});
