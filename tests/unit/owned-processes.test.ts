import { describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OwnedProvenLoopProcessController, type OwnedProvenLoopProcessOptions } from "../../packages/copilot-adapter/src/owned-processes.js";
import { SpawnCommandRunner, type CommandResult, type CommandRunner } from "../../packages/copilot-adapter/src/command-runner.js";

const node = "C:/Program Files/nodejs/node.exe";
const cli = "C:/Runtime/0.10/node_modules/@provenloop/cli/dist/bin.js";
const plugin = "C:/Copilot/plugins/provenloop";
const dataRoot = "C:/Local/ProvenLoop";
const powershell = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const copilot = "C:/Copilot/copilot.exe";
const bootstrap = "C:/Copilot/preloads/extension_bootstrap.mjs";
const sid = "S-1-5-21-123-456-789-1001";
const parentCreatedAt = "134330447371180000";
const mcpArgs = [node, cli, "mcp", "serve", "--data-root", dataRoot];
const launcherArgs = [powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", plugin + "/scripts/mcp-launcher.ps1"];
const identity = (pid: number, args: readonly string[], overrides: Record<string, unknown> = {}) => ({
  pid, parentPid: 200, createdAt: "134330447381180000", executable: args[0],
  commandLine: args.map((arg) => `"${arg}"`).join(" "), arguments: args, ownerSid: sid, ...overrides,
});
const snapshot = (processes: ReturnType<typeof identity>[]) => ({
  currentUserSid: sid,
  extensionParents: [identity(200, [copilot, "--log-dir", "C:/logs"], { parentPid: 0, createdAt: parentCreatedAt })],
  parents: [
    { pid: 100, parentPid: 50, executable: node }, { pid: 50, parentPid: 0, executable: powershell },
    { pid: 200, parentPid: 0, executable: copilot },
    ...processes.filter((entry) => ![50, 100, 200].includes(entry.pid)).map((entry) => ({ pid: entry.pid, parentPid: entry.parentPid, executable: entry.executable })),
  ],
  processes,
});
const harness = (responses: unknown[], overrides: Partial<OwnedProvenLoopProcessOptions> = {}) => {
  const calls: { readonly script: string; readonly payload: Record<string, unknown> }[] = [];
  const runner: CommandRunner = { run: async (executable, args, options) => {
    expect(executable).toBe(powershell); expect(options?.timeoutMs).toBe(15_000);
    const script = Buffer.from(args[3] ?? "", "base64").toString("utf16le");
    const encoded = script.split("FromBase64String(" + String.fromCharCode(39))[1]?.split(String.fromCharCode(39))[0];
    if (!encoded) throw new Error("Expected encoded structured scope.");
    calls.push({ script, payload: JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown> });
    if (responses.length === 0) throw new Error("Unexpected command.");
    return { exitCode: 0, stdout: JSON.stringify(responses.shift()), stderr: "" };
  } };
  return { controller: new OwnedProvenLoopProcessController({ dataRoot, launcherDataRoot: dataRoot, pluginRoots: [plugin], runtimes: [{ nodeExecutable: node, cliBinPath: cli }],
    currentProcessId: 100, powerShellExecutable: powershell, platform: "win32", runner, ...overrides }), calls };
};
const diagnostic = (overrides: Record<string, unknown> = {}) =>
  `PROVENLOOP_PROCESS_DIAGNOSTIC:${JSON.stringify({
    stage: "ancestry", reason: "ancestor-inaccessible", pid: 50, ancestorDepth: 2,
    nativeCode: 5, hresult: -2146233087, category: 14, line: 42, ...overrides,
  })}\n`;
const nativeFixture = process.platform === "win32" && process.env.PROVENLOOP_PROCESS_FIXTURE === "1";

describe("verified ProvenLoop process cleanup", () => {
  it("selects only exact runtime and launcher signatures, never hosts, ancestors, other roots or extra arguments", async () => {
    const { controller, calls } = harness([snapshot([
      identity(301, mcpArgs), identity(302, launcherArgs), identity(200, [copilot, "--resume"], { parentPid: 0 }),
      identity(50, launcherArgs, { parentPid: 0 }), identity(100, mcpArgs, { parentPid: 50 }), identity(303, [...mcpArgs, "--eval", "code"]),
      identity(304, [...mcpArgs.slice(0, 5), dataRoot + "Other"]),
      identity(305, mcpArgs, { ownerSid: "S-1-5-21-987" }), identity(306, [node, cli + ".other", ...mcpArgs.slice(2)]),
      identity(307, [powershell, "-Command", launcherArgs[6] ?? ""]),
      identity(308, [...launcherArgs.slice(0, 6), plugin + "Other/scripts/mcp-launcher.ps1"]),
    ])]);
    const inventory = await controller.inspect();
    expect(inventory.processes.map((entry) => [entry.pid, entry.kind])).toEqual([[301, "mcp"], [302, "launcher"]]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.script).not.toContain("::TerminateProcess($handle");
  });

  it("accepts only log-attested extension children with their exact live parent and creation identity", async () => {
    const worker = { pid: 401, parentPid: 200, createdAt: "134330447381180000", parentCreatedAt, ownerSid: sid, executable: copilot, bootstrapPath: bootstrap, extensionPath: plugin + "/extensions/event-capture/extension.mjs" };
    const { controller } = harness([snapshot([identity(401, [copilot, bootstrap]), identity(402, [copilot, bootstrap]), identity(200, [copilot, bootstrap], { parentPid: 0 })])], { extensionWorkers: [worker] });
    expect((await controller.inspect()).processes).toMatchObject([{ pid: 401, kind: "extension" }]);
    const stale = harness([snapshot([identity(401, [copilot, bootstrap], { createdAt: "134330447381180010" })])], { extensionWorkers: [worker] });
    expect((await stale.controller.inspect()).processes).toEqual([]);
    const precise = harness([snapshot([identity(401, [copilot, bootstrap], { createdAt: "134330447381180009" })])], { extensionWorkers: [worker] });
    expect((await precise.controller.inspect()).processes).toEqual([]);
    const wrongParent = snapshot([identity(401, [copilot, bootstrap])]);
    wrongParent.extensionParents[0] = identity(200, [copilot, "--log-dir", "C:/logs"], { parentPid: 0, createdAt: "134330447371180001" });
    expect((await harness([wrongParent], { extensionWorkers: [worker] }).controller.inspect()).processes).toEqual([]);
    wrongParent.extensionParents[0] = identity(200, [copilot, "--log-dir", "C:/logs"], { parentPid: 0, createdAt: parentCreatedAt, ownerSid: "S-1-5-21-987" });
    expect((await harness([wrongParent], { extensionWorkers: [worker] }).controller.inspect()).processes).toEqual([]);
  });

  it("rechecks each process and uses a pinned handle for exact single-process termination", async () => {
    const process = identity(301, mcpArgs);
    const { controller, calls } = harness([snapshot([process]), snapshot([process]), { status: "stopped" }]);
    const inventory = await controller.inspect();
    expect(await controller.stop(inventory)).toEqual([{ pid: 301, status: "stopped" }]);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.payload.target).toEqual(process);
    const script = calls[2]?.script ?? "";
    expect(script).toContain("::OpenProcess(0x101001");
    expect(script).toContain("::Creation($handle) -ne $target.createdAt");
    expect(script).toContain("$owner.Sid -ne $target.ownerSid");
    expect(script).toContain("$row.CommandLine -cne $target.commandLine");
    expect(script).toContain("::TerminateProcess($handle,0)");
    expect(script).not.toContain("taskkill"); expect(script).not.toContain("Stop-Process");
    await expect(controller.stop(inventory)).rejects.toThrow("Inspect owned processes");
  });

  it.each([
    { createdAt: "134330447381180001" }, { parentPid: 201 }, { commandLine: "changed" },
    { ownerSid: "S-1-5-21-987" },
  ])("does not terminate a changed process identity %j", async (change) => {
    const { controller, calls } = harness([snapshot([identity(301, mcpArgs)]), snapshot([identity(301, mcpArgs, change)])]);
    expect(await controller.stop(await controller.inspect())).toEqual([{ pid: 301, status: "identity_changed" }]);
    expect(calls).toHaveLength(2);
  });

  it("distinguishes an exited process from a live but newly unverified identity", async () => {
    const exited = harness([snapshot([identity(301, mcpArgs)]), snapshot([])]);
    expect(await exited.controller.stop(await exited.controller.inspect())).toEqual([{ pid: 301, status: "exited" }]);
    const changed = harness([snapshot([identity(301, mcpArgs)]), snapshot([identity(301, [node, "C:/unrelated.js"])])]);
    expect(await changed.controller.stop(await changed.controller.inspect())).toEqual([{ pid: 301, status: "identity_changed" }]);
    expect(changed.calls).toHaveLength(2);
  });

  it("does not select launchers without the verified locator data root", async () => {
    const { controller } = harness([snapshot([identity(301, launcherArgs)])], { launcherDataRoot: dataRoot + "Other" });
    expect((await controller.inspect()).processes).toEqual([]);
  });

  it("pins extension parent creation and owner again at termination", async () => {
    const worker = { pid: 401, parentPid: 200, createdAt: "134330447381180000", parentCreatedAt, ownerSid: sid, executable: copilot, bootstrapPath: bootstrap, extensionPath: plugin + "/extensions/event-capture/extension.mjs" };
    const observed = snapshot([identity(401, [copilot, bootstrap])]);
    const { controller, calls } = harness([observed, observed, { status: "identity_changed" }], { extensionWorkers: [worker] });
    expect(await controller.stop(await controller.inspect())).toEqual([{ pid: 401, status: "identity_changed" }]);
    expect(calls[2]?.payload.extensionParent).toEqual({ executable: copilot, createdAt: parentCreatedAt });
    expect(calls[2]?.script).toContain("::Creation($parentHandle) -ne $inputData.extensionParent.createdAt");
    expect(calls[2]?.script).toContain("$parentOwner.Sid -ne $target.ownerSid");
  });

  it("does not authorize a caller-fabricated or another controller's inventory", async () => {
    const { controller, calls } = harness([]);
    await expect(controller.stop({ processes: [] })).rejects.toThrow("Inspect owned processes");
    expect(calls).toHaveLength(0);
  });

  it("refuses incomplete ancestry and oversized inventory before selecting processes", async () => {
    const incomplete = snapshot([identity(301, mcpArgs)]);
    incomplete.parents = incomplete.parents.filter((row) => row.pid !== 50);
    await expect(harness([incomplete]).controller.inspect()).rejects.toThrow("ancestry cannot be verified");
    await expect(harness([snapshot(Array.from({ length: 65 }, (_, i) => identity(i + 300, mcpArgs)))]).controller.inspect()).rejects.toThrow("Invalid owned process inventory");
  });

  it.each([
    { createdAt: "9223372036854775808" }, { pid: 0 }, { arguments: ["a\0b"] },
    { executable: "C:/node.exe:alternate" }, { ownerSid: "S-1---" },
  ])("rejects malformed process inventory %j", async (change) => {
    await expect(harness([snapshot([identity(301, mcpArgs, change)])]).controller.inspect()).rejects.toThrow("Invalid process identity");
  });

  it("rejects malformed native ancestry attestations rather than silently ignoring them", async () => {
    await expect(harness([{ ...snapshot([]), protectedIds: [100, "50"] }]).controller.inspect()).rejects.toThrow("Invalid protected");
  });

  it.each(["C:relative", "C:/data/../elsewhere", "C:/data.", "\\\\server\\share"])(
    "rejects ambiguous cleanup scope %s", (path) => {
      expect(() => harness([], { dataRoot: path })).toThrow("absolute local Windows paths");
    },
  );

  it("stops following historical ancestors only after the native probe confirms they exited", async () => {
    const observed = snapshot([identity(301, mcpArgs)]);
    observed.parents = observed.parents.filter((row) => row.pid !== 50);
    const { controller } = harness([{ ...observed, protectedIds: [100, 50] }]);
    expect((await controller.inspect()).processes).toMatchObject([{ pid: 301, kind: "mcp" }]);
  });

  it.each([
    ["native failure", { exitCode: 1, stdout: "PRIVATE_PROCESS_INVENTORY", stderr:
      "PRIVATE_COMMAND_LINE\n" + diagnostic({ commandLine: "PRIVATE_COMMAND_LINE" }) + "PRIVATE_PATH" },
    "stage=ancestry; reason=ancestor-inaccessible; pid=50; ancestorDepth=2; nativeCode=5"],
    ["timeout", { exitCode: 124, stdout: "", stderr: "PRIVATE_PATH" }, "failure=timeout"],
    ["launch failure", { exitCode: 127, stdout: "", stderr: "PRIVATE_PATH" }, "failure=launch-failed"],
    ["output bound", { exitCode: 0, stdout: "PRIVATE_PROCESS_INVENTORY".repeat(24_000), stderr: "" }, "failure=output-bound"],
    ["malformed output", { exitCode: 0, stdout: "PRIVATE_PROCESS_INVENTORY", stderr: "PRIVATE_PATH" }, "Invalid owned process command output"],
    ["unstructured stderr", { exitCode: 1, stdout: "", stderr: "PRIVATE_COMMAND_LINE" }, "native=unavailable"],
    ["malformed diagnostic", { exitCode: 1, stdout: "", stderr: "PROVENLOOP_PROCESS_DIAGNOSTIC:{PRIVATE_PATH}\n" }, "native=invalid"],
    ["unknown stage", { exitCode: 1, stdout: "", stderr: diagnostic({ stage: "PRIVATE_PATH" }) }, "native=invalid"],
    ["unknown reason", { exitCode: 1, stdout: "", stderr: diagnostic({ reason: "PRIVATE_COMMAND_LINE" }) }, "native=invalid"],
    ["invalid diagnostic number", { exitCode: 1, stdout: "", stderr: diagnostic({ nativeCode: "PRIVATE_PATH" }) }, "native=invalid"],
    ["oversized diagnostic", { exitCode: 1, stdout: "", stderr: diagnostic({ secret: "PRIVATE_PATH".repeat(200) }) }, "native=unavailable"],
  ] satisfies readonly (readonly [string, CommandResult, string])[])(
    "fails closed with bounded, allowlisted diagnostics for %s", async (_name, result, expected) => {
      const run = vi.fn(async () => result);
      const { controller } = harness([], { runner: { run } });
      const failure = controller.inspect();
      await expect(failure).rejects.toThrow(expected);
      await expect(failure).rejects.toThrow("operation=inspect; exitCode=");
      await expect(failure).rejects.not.toThrow("PRIVATE");
      expect(run).toHaveBeenCalledTimes(1);
      const error: unknown = await failure.catch((caught: unknown) => caught);
      expect((error as Error).message.length).toBeLessThan(1024);
    },
  );

  it("does not expose a rejected runner's raw command or retry it", async () => {
    const run = vi.fn(async (): Promise<CommandResult> => { throw new Error("PRIVATE_COMMAND_LINE"); });
    const failure = harness([], { runner: { run } }).controller.inspect();
    await expect(failure).rejects.toThrow("Owned process inspect runner failed; no broader termination was attempted.");
    await expect(failure).rejects.not.toThrow("PRIVATE");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports native termination failures without retrying or authorizing another stop", async () => {
    const observed = { exitCode: 0, stdout: JSON.stringify(snapshot([identity(301, mcpArgs)])), stderr: "" };
    const run = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr:
      diagnostic({ stage: "terminate", reason: "termination-failed", pid: 301 }) }))
      .mockResolvedValueOnce(observed).mockResolvedValueOnce(observed);
    const { controller } = harness([], { runner: { run } });
    const inventory = await controller.inspect();
    const failure = controller.stop(inventory);
    await expect(failure).rejects.toThrow("operation=terminate; exitCode=1");
    await expect(failure).rejects.toThrow("stage=terminate; reason=termination-failed");
    await expect(controller.stop(inventory)).rejects.toThrow("Inspect owned processes");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it.skipIf(!nativeFixture).each([
    ["cyclic ancestry",
      "$all = @([pscustomobject]@{ProcessId=$inputData.currentProcessId;ParentProcessId=$inputData.currentProcessId})",
      "stage=ancestry; reason=ancestor-cycle"],
    ["an omitted but live ancestor",
      "$all = @([pscustomobject]@{ProcessId=$inputData.currentProcessId;ParentProcessId=$PID})",
      "stage=ancestry; reason=ancestor-incomplete"],
    ["native enumeration failure", "throw [ComponentModel.Win32Exception]::new(5,'PRIVATE_COMMAND_LINE')",
      "stage=enumerate; reason=native-error"],
  ])("reports %s from the actual native script without weakening protection", async (_name, replacement, expected) => {
    const native = new SpawnCommandRunner();
    const run = vi.fn(async (exe: string, args: readonly string[]) => {
      const script = Buffer.from(args[3] ?? "", "base64").toString("utf16le");
      const enumeration = "$all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5)";
      expect(script).toContain(enumeration);
      // No real inventory or termination: the missing live PID is this disposable PowerShell child itself.
      const injected = script.replace(enumeration, replacement);
      return native.run(exe, [...args.slice(0, 3), Buffer.from(injected, "utf16le").toString("base64")], { timeoutMs: 15_000 });
    });
    const failure = harness([], { currentProcessId: process.pid, runner: { run } }).controller.inspect();
    await expect(failure).rejects.toThrow(expected);
    await expect(failure).rejects.toThrow("operation=inspect; exitCode=1");
    await expect(failure).rejects.not.toThrow("PRIVATE");
    if (_name === "native enumeration failure") await expect(failure).rejects.toThrow("nativeCode=5");
    expect(run).toHaveBeenCalledTimes(1);
    process.kill(process.pid, 0);
  }, 30_000);

  it.skipIf(!nativeFixture)(
    "terminates only the exact owned Windows fixture and preserves unrelated processes", async () => {
      const root = await mkdtemp(join(process.cwd(), ".provenloop-owned-process-fixture-"));
      const fixtureBin = join(root, "dist", "bin.js");
      const fixtureData = join(root, "data");
      const children: { role: string; child: ChildProcess; stdoutBytes: number; stderrBytes: number }[] = [];
      const failures: unknown[] = [];
      let phase = "prepare";
      let fixtureState: string;
      const start = async (role: string, args: readonly string[]): Promise<ChildProcess> => {
        phase = `start-${role}`;
        const child = spawn(process.execPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        const state = { role, child, stdoutBytes: 0, stderrBytes: 0 };
        children.push(state);
        child.stdout?.on("data", (data: Buffer) => { state.stdoutBytes = Math.min(1024 * 1024, state.stdoutBytes + data.length); });
        child.stderr?.on("data", (data: Buffer) => { state.stderrBytes = Math.min(1024 * 1024, state.stderrBytes + data.length); });
        await new Promise<void>((resolveReady, reject) => {
          let output = "";
          const finish = (error?: Error) => {
            clearTimeout(timeout);
            child.removeListener("error", onError);
            child.removeListener("exit", onExit);
            child.stdout?.removeListener("data", onReady);
            if (error) reject(error);
            else resolveReady();
          };
          const onError = () => finish(new Error("Fixture spawn failed."));
          const onExit = () => finish(new Error("Fixture exited before readiness."));
          const onReady = (data: Buffer) => {
            output += data.toString("utf8");
            if (output === "ready\n") finish();
            else if (!"ready\n".startsWith(output)) finish(new Error("Invalid fixture readiness."));
          };
          const timeout = setTimeout(() => finish(new Error("Fixture startup timed out.")), 10_000);
          child.once("error", onError);
          child.once("exit", onExit);
          child.stdout?.on("data", onReady);
        });
        return child;
      };
      try {
        await mkdir(join(root, "dist"));
        await writeFile(fixtureBin, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);", "utf8");
        const owned = await start("owned", [fixtureBin, "mcp", "serve", "--data-root", fixtureData]);
        const unrelated = await start("unrelated", [fixtureBin, "unrelated", "--data-root", fixtureData]);
        const otherRoot = await start("other-root", [fixtureBin, "mcp", "serve", "--data-root", fixtureData + "-other"]);
        const native = new SpawnCommandRunner();
        const controller = new OwnedProvenLoopProcessController({
          dataRoot: fixtureData, pluginRoots: [], runtimes: [{ nodeExecutable: process.execPath, cliBinPath: fixtureBin }],
          // Allow CI startup contention without changing production inspection deadlines.
          runner: { run: (exe, args) => native.run(exe, args, { timeoutMs: 30_000 }) },
        });
        phase = "inspect";
        const inventory = await controller.inspect();
        expect(inventory.processes).toMatchObject([{ pid: owned.pid, kind: "mcp" }]);
        expect(inventory.processes).toHaveLength(1);
        phase = "stop";
        expect(await controller.stop(inventory)).toEqual([{ pid: owned.pid, status: "stopped" }]);
        phase = "preservation";
        await expect.poll(() => owned.exitCode).not.toBeNull();
        expect(unrelated.exitCode).toBeNull();
        expect(otherRoot.exitCode).toBeNull();
        expect(unrelated.signalCode).toBeNull();
        expect(otherRoot.signalCode).toBeNull();
        expect(unrelated.pid).toBeDefined();
        expect(otherRoot.pid).toBeDefined();
        process.kill(unrelated.pid as number, 0);
        process.kill(otherRoot.pid as number, 0);
        process.kill(process.pid, 0);
        process.kill(process.ppid, 0);
      } catch (error) {
        failures.push(error);
      } finally {
        // Capture only disposable child status, never stderr text or process command lines.
        const state = {
          phase, node: process.versions.node, arch: process.arch, pid: process.pid, parentPid: process.ppid,
          children: children.map(({ role, child, stdoutBytes, stderrBytes }) => ({
            role, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, stdoutBytes, stderrBytes,
          })),
        };
        fixtureState = JSON.stringify(state);
        const cleanup = await Promise.allSettled(children.map(async ({ child }) => {
          if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
          await new Promise<void>((resolveExit, reject) => {
            const finish = (error?: Error) => {
              clearTimeout(timeout);
              child.removeListener("exit", onExit);
              child.removeListener("error", onError);
              if (error) reject(error);
              else resolveExit();
            };
            const timeout = setTimeout(() => finish(new Error("Disposable child cleanup timed out.")), 10_000);
            const onExit = () => finish();
            const onError = () => finish(new Error("Disposable child cleanup failed."));
            child.once("exit", onExit);
            child.once("error", onError);
            if (!child.kill()) finish(new Error("Disposable child cleanup could not signal its child."));
          });
        }));
        failures.push(...cleanup.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []));
        try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) {
        throw new Error(`Native owned-process fixture failed: ${fixtureState}`, {
          cause: failures.length === 1 ? failures[0] : new AggregateError(failures, "Fixture and cleanup failures."),
        });
      }
    }, 120_000,
  );
});
