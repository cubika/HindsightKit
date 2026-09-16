import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultCopilotAdapterState, SpawnCommandRunner, writeCopilotAdapterState,
  type CommandRunner, type PersistedCopilotAdapterState } from "@provenloop/copilot-adapter";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { resolveWindowsProvenLoopPaths } from "@provenloop/platform-windows";
import { readLearningReadiness } from "../../packages/cli/src/run-learning.js";
import { runCli } from "../../packages/cli/src/run-cli.js";
import type { AgentAdapter } from "@provenloop/contracts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    const path = relative(process.cwd(), root);
    assert(path && !isAbsolute(path) && !path.startsWith(".."));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

const readyState = (): PersistedCopilotAdapterState => {
  const initial = createDefaultCopilotAdapterState(new Date());
  return { ...initial, installed: true, pluginInstalled: true, pluginEnabled: true, detectedCopilotVersion: "1.0.84-1",
    capabilities: { ...initial.capabilities, capture: { enabled: true }, worker: { enabled: true },
      correction_learning: { enabled: true }, retrieval: { enabled: true } } };
};
const fixture = async () => {
  const root = await mkdtemp(join(process.cwd(), ".learning-readiness-")); roots.push(root);
  const copilotHome = join(root, "copilot"); await mkdir(copilotHome);
  const repositoryPath = join(root, "repo");
  const runner: CommandRunner = { run: vi.fn(async () => ({ exitCode: 0, stdout: repositoryPath + "\n", stderr: "" })) };
  const approvalPath = join(copilotHome, "permissions-config.json");
  const approve = (location = repositoryPath) => writeFile(approvalPath, JSON.stringify({ locations: { [location]: {
    tool_approvals: [{ kind: "extension-permission-access", extensionName: "plugin:provenloop:event-capture" }],
  } } }));
  return { root, copilotHome, repositoryPath, runner, approvalPath, approve };
};

describe("first reuse readiness", () => {
  it("shows repository setup after CLI install without granting hook permission", async () => {
    const f = await fixture();
    const paths = resolveWindowsProvenLoopPaths(f.root);
    await writeCopilotAdapterState(paths.adapterState, readyState());
    vi.stubEnv("COPILOT_HOME", f.copilotHome);
    vi.spyOn(SpawnCommandRunner.prototype, "run").mockImplementation(f.runner.run);
    const logs: string[] = [];
    const installed = vi.fn(async () => ({ status: "changed" as const, message: "Integration installed." }));
    expect(await runCli(["install", "--data-root", f.root], { log: (value) => { logs.push(value); }, error: () => undefined }, {
      createAdapter: () => ({ install: installed }) as unknown as AgentAdapter, runMcpServer: async () => undefined,
    })).toBe(0);
    expect(installed).toHaveBeenCalledOnce();
    const message = logs.join("\n");
    expect(message).toContain("Collection: configured. Extraction: eligible. Automatic reuse: blocked.");
    expect(message).toContain("approve-hooks --cwd ");
    expect(message).toContain(f.repositoryPath);
    expect(message).toContain("Restart Copilot");
    await expect(readFile(f.approvalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(paths.adapterState, "utf8")).toContain('"installed": true');
  });

  it("distinguishes extraction eligibility from missing repository hook approval without granting permission", async () => {
    const f = await fixture();
    await f.approve(join(f.root, "other-repository"));
    const before = await readFile(f.approvalPath, "utf8");
    const result = await readLearningReadiness(readyState(), { ...f, cwd: join(f.repositoryPath, "src") });
    expect(result.repositoryPath).toBe(f.repositoryPath);
    expect(result.capture.status).toBe("configured");
    expect(result.extraction.status).toBe("eligible");
    expect(result.automaticReuse).toMatchObject({ status: "blocked", hookApproval: "missing", blockedBy: ["repository_hook_approval_missing"] });
    expect(result.nextSteps.join(" ")).toContain("approve-hooks --cwd '" + f.repositoryPath + "' --confirm");
    expect(result.nextSteps.join(" ")).toContain("Restart Copilot");
    expect(await readFile(f.approvalPath, "utf8")).toBe(before);
  });

  it("treats approved configuration as ready for a new session without claiming observed reuse", async () => {
    const f = await fixture(); await f.approve();
    const result = await readLearningReadiness(readyState(), f);
    expect(result.automaticReuse).toEqual({ status: "configured_for_next_session", blockedBy: [], hookApproval: "approved", sessionHooks: "unverified" });
    expect(result.detail).toContain("does not verify a running Copilot session");
    expect(result.nextSteps.join(" ")).toContain("guidance provided; explicit adoption is recorded separately");
    expect(result.nextSteps.join(" ")).not.toContain("approve-hooks");
  });

  it("keeps unsupported host versions blocked even when the permission record exists", async () => {
    const f = await fixture(); await f.approve();
    const result = await readLearningReadiness({ ...readyState(), detectedCopilotVersion: "1.0.85-1" }, f);
    expect(result.extraction.status).toBe("eligible");
    expect(result.automaticReuse).toMatchObject({ status: "blocked", hookApproval: "unverified", blockedBy: ["copilot_version_unverified"] });
    expect(result.nextSteps.join(" ")).toContain("copilot --version");
    expect(result.nextSteps.join(" ")).not.toContain("approve-hooks");
  });

  it("does not suggest a repository permission grant when Git cannot identify the repository", async () => {
    const f = await fixture(); await f.approve();
    const result = await readLearningReadiness(readyState(), { ...f,
      runner: { run: async () => ({ exitCode: 128, stdout: "", stderr: "not a repository" }) } });
    expect(result.repositoryPath).toBeNull();
    expect(result.automaticReuse).toMatchObject({ status: "blocked", hookApproval: "repository_unknown" });
    expect(result.nextSteps.join(" ")).toContain("Open a Git repository");
    expect(result.nextSteps.join(" ")).not.toContain("approve-hooks");
  });

  it("explains disabled extraction and retrieval without conflating them with collection", async () => {
    const f = await fixture(); await f.approve(); const state = readyState();
    const result = await readLearningReadiness({ ...state, automaticLearning: { enabled: false, notificationsEnabled: true },
      capabilities: { ...state.capabilities, retrieval: { enabled: false } } }, { ...f, dataRoot: f.root });
    expect(result.capture.status).toBe("configured");
    expect(result.extraction).toEqual({ status: "blocked", blockedBy: ["explicitly_disabled"] });
    expect(result.automaticReuse.blockedBy).toEqual(["explicitly_disabled", "retrieval_disabled"]);
    expect(result.nextSteps.join(" ")).toContain("provenloop learning enable --data-root '");
    expect(result.nextSteps.join(" ")).toContain("provenloop enable retrieval --data-root '");
  });

  it("adds repository diagnostics to CLI status while preserving preferences and legacy status fields", async () => {
    const f = await fixture(); await f.approve();
    const paths = resolveWindowsProvenLoopPaths(f.root); await mkdir(paths.data);
    await writeFile(paths.rootMarker, "{}");
    await writeCopilotAdapterState(paths.adapterState, readyState());
    new CanonicalSqliteStore(paths.database).close();
    const before = await readFile(paths.adapterState, "utf8");
    vi.stubEnv("COPILOT_HOME", f.copilotHome);
    const run = vi.spyOn(SpawnCommandRunner.prototype, "run").mockImplementation(f.runner.run);
    const logs: string[] = []; const errors: string[] = [];
    expect(await runCli(["learning", "status", "--cwd", join(f.repositoryPath, "src"), "--data-root", f.root],
      { log: (value) => { logs.push(value); }, error: (value) => { errors.push(value); } })).toBe(0);
    expect(errors).toEqual([]);
    const output = JSON.parse(logs.join(""));
    expect(output.automaticLearning).toMatchObject({ enabled: true, mode: "automatic" });
    expect(output.hostHooks.status).toBe("requires_repository_approval");
    expect(output.jobs).toEqual([]);
    expect(output.readiness.automaticReuse).toMatchObject({ hookApproval: "approved", sessionHooks: "unverified" });
    expect(run).toHaveBeenCalledWith("git", ["-C", resolve(join(f.repositoryPath, "src")), "rev-parse", "--show-toplevel"], { timeoutMs: 5_000 });
    expect(await readFile(paths.adapterState, "utf8")).toBe(before);
  });

  it.each([["status", "--cwd"], ["status", "--cwd", "repo", "--cwd", "other"], ["enable", "--cwd", "repo"]].map((args) => ({ args })))(
    "rejects invalid or unsupported repository options: $args", async ({ args }) => {
      expect(await runCli(["learning", ...args], { log: () => undefined, error: () => undefined })).toBe(2);
    });
});
