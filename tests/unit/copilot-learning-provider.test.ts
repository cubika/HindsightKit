import { mkdtemp, readdir, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CopilotLearningProvider, CopilotLearningToolRegistry } from "@provenloop/copilot-adapter";
import { createCaptureEnvelope, sha256 } from "@provenloop/domain";
import { createAgentExperienceCorpus } from "@provenloop/evaluation";
import type { LearningWindow } from "@provenloop/contracts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const window = (): LearningWindow => {
  const event = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "user", eventType: "prompt.submitted", trust: "user", sessionId: "s", timestamp: "2026-09-07T00:00:00.000Z", content: { message: "Supply the path argument." } });
  return { schemaVersion: 1, windowId: "window", revision: sha256(event), sessionId: "s", repoId: "r", worktree: "C:\repo", createdAt: "2026-09-07T00:00:00.000Z", events: [event], sources: [{ eventId: event.event.eventId, digest: sha256(event) }] };
};
describe("isolated Copilot learning provider", () => {
  it("removes only marker-verified orphan scratch before the next leased inference", async () => {
    const root=await mkdtemp(join(tmpdir(),"provenloop-learning-test-"));roots.push(root);
    const orphan=join(root,"learning-old123");await mkdir(orphan);await writeFile(join(orphan,"session"),"old excerpt");
    await writeFile(join(orphan,".provenloop-inference.json"),JSON.stringify({product:"ProvenLoop",root,directory:orphan,nonce:"orphan",supervisorPid:2147483647}));
    await utimes(orphan,new Date(0),new Date(0));await mkdir(join(root,"unrelated"));
    const provider=new CopilotLearningProvider({temporaryRoot:root,enabled:async()=>true,runner:{run:async()=>({exitCode:0,stdout:JSON.stringify({schemaVersion:1,proposals:[]}),stderr:""})}});
    await provider.infer(window(),{signal:new AbortController().signal});expect(await readdir(root)).toEqual(["unrelated"]);
  });
  it("runs without tools or ambient plugins and removes persisted prompt state", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-learning-test-")); roots.push(root);
    const provider = new CopilotLearningProvider({ temporaryRoot: root, enabled: async () => true, runner: { run: async (_exe, args, options) => {
      expect(args).toContain("--available-tools="); expect(args).toContain("--no-experimental");
      expect(options?.environment?.COPILOT_HOME).toBe(options?.cwd);
      await writeFile(join(options?.cwd ?? "", "session-state.json"), "sensitive probe");
      return { exitCode: 0, stdout: JSON.stringify({ schemaVersion: 1, proposals: [] }), stderr: "" };
    } } });
    expect(await provider.infer(window(), { signal: new AbortController().signal })).toEqual({ schemaVersion: 1, proposals: [] });
    expect(await readdir(root)).toEqual([]);
  });
  it("EXP-01/07 requests agent provenance without granting search or execution tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-agent-provider-")); roots.push(root);
    const input = createAgentExperienceCorpus().cases[0]?.window;
    if (!input || input.origin !== "agent") throw new Error("Expected a captured agent window.");
    const provider = new CopilotLearningProvider({ temporaryRoot: root, enabled: async () => true, runner: { run: async (_exe, args) => {
      const prompt = args[args.indexOf("--prompt") + 1] ?? "";
      expect(prompt).toContain("agentSource");
      expect(prompt).toContain("NEVER include userSource");
      expect(prompt).toContain("evidenceSources");
      expect(prompt).toContain(input.anchorEventId);
      expect(args).toContain("--available-tools=");
      expect(args).toContain("--disable-builtin-mcps");
      return { exitCode: 0, stdout: JSON.stringify({ schemaVersion: 1, proposals: [] }), stderr: "" };
    } } });
    expect(await provider.infer(input, { signal: new AbortController().signal })).toEqual({ schemaVersion: 1, proposals: [] });
    expect(await readdir(root)).toEqual([]);
  });
  it("drops disabled in-flight results and cleans malformed responses", async () => {
    for (const disable of [true, false]) {
      const root = await mkdtemp(join(tmpdir(), "provenloop-learning-test-")); roots.push(root); let enabled = true;
      const provider = new CopilotLearningProvider({ temporaryRoot: root, enabled: async () => enabled, runner: { run: async () => { enabled = !disable; return { exitCode: 0, stdout: "private malformed response", stderr: "" }; } } });
      await expect(provider.infer(window(), { signal: new AbortController().signal })).rejects.toThrow(disable ? "stopped" : "bounded JSON");
      expect(await readdir(root)).toEqual([]);
    }
  });
  it("changes applicability identity when the actual input schema changes", () => {
    const registry = new CopilotLearningToolRegistry();
    const tool = { name: "server-tool", mcpServerName: "server", mcpToolName: "tool", input_schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } };
    registry.replace([tool], "1.0.84-1"); const previous = registry.find(tool.name)?.digest;
    registry.replace([{ ...tool, input_schema: { ...tool.input_schema, additionalProperties: false } }], "1.0.84-1");
    expect(registry.find(tool.name)?.digest).not.toBe(previous);
    registry.replace([], "1.0.84-1"); expect(registry.find(tool.name)).toBeUndefined();
  });
});
