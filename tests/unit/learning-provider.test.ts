import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LearningWindow } from "@provenloop/contracts";
import { createCaptureEnvelope, learningSourceDigest, sha256 } from "@provenloop/domain";
import { CopilotLearningProvider } from "@provenloop/copilot-adapter";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "provenloop-provider-boundary-"));
  roots.push(directory);
  return directory;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const window = (): LearningWindow => {
  const event = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1",
    eventType: "prompt.submitted", trust: "user", sourceEventId: "source-1", sessionId: "session-1",
    repoId: "repo-1", repositoryState: "known_repo", worktree: "C:/repo", timestamp: "2026-09-07T00:00:00Z",
    content: { message: "Supply path before retrying." } });
  return { schemaVersion: 1, windowId: "learning-window-" + sha256(event.event.eventId).slice(0, 24), revision: sha256(event), sessionId: "session-1", repoId: "repo-1",
    worktree: "C:/repo", createdAt: event.event.timestamp,
    sources: [{ eventId: event.event.eventId, digest: learningSourceDigest(event) }], events: [event] };
};
const success = { exitCode: 0, stdout: '{"schemaVersion":1,"proposals":[]}', stderr: "" };

describe("Copilot provider error boundaries (injected runner, not native acceptance)", () => {
  it("does not dispatch after prior cancellation", async () => {
    const temporaryRoot = await root();
    const run = vi.fn(async () => success);
    const abort = new AbortController(); abort.abort();
    await expect(new CopilotLearningProvider({ temporaryRoot, runner: { run }, enabled: async () => true })
      .infer(window(), { signal: abort.signal })).rejects.toThrow("disabled");
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
  it.each([
    { exitCode: 1, stdout: "SOURCE_SNIPPET", stderr: "rate limit SOURCE_SNIPPET", expected: "rate_limited" },
    { exitCode: 1, stdout: "SOURCE_SNIPPET", stderr: "authentication SOURCE_SNIPPET", expected: "signed_out" },
    { exitCode: 1, stdout: "SOURCE_SNIPPET", stderr: "SOURCE_SNIPPET", expected: "unavailable" },
  ])("cleans up and hides provider text for $expected", async ({ expected, ...result }) => {
    const temporaryRoot = await root();
    const provider = new CopilotLearningProvider({ temporaryRoot, runner: { run: async () => result }, enabled: async () => true });
    const error = await provider.infer(window(), { signal: new AbortController().signal }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(expected);
    expect(String(error)).not.toContain("SOURCE_SNIPPET");
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
  it("cleans up after runner rejection without leaking captured content in diagnostics", async () => {
    const temporaryRoot = await root();
    const provider = new CopilotLearningProvider({ temporaryRoot, runner: { run: async () => {
      throw new Error("Runner failed while processing SOURCE_SNIPPET");
    } }, enabled: async () => true });
    const error = await provider.infer(window(), { signal: new AbortController().signal }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("SOURCE_SNIPPET");
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
  it("discards output and cleans up after in-flight abort", async () => {
    const temporaryRoot = await root();
    const controller = new AbortController();
    const provider = new CopilotLearningProvider({ temporaryRoot, enabled: async () => true, runner: { run: async () => {
      controller.abort();
      return success;
    } } });
    await expect(provider.infer(window(), { signal: controller.signal })).rejects.toThrow("stopped");
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
  it("selects bounded excerpts from oversized input and rejects more than three proposals", async () => {
    const temporaryRoot = await root();
    const run = vi.fn(async () => success);
    const large = window();
    const original = large.events[0];
    if (!original) throw new Error("Missing fixture anchor.");
    large.events = [original, ...Array.from({ length: 31 }, (_, index) => ({ ...original,
      event: { ...original.event, eventId: `tool-${index}`, trust: "tool" as const, eventType: "tool.completed" },
      content: { toolResult: "Routine diagnostic line\n".repeat(1000) + "Error: The path argument is required." },
    }))];
    const provider = new CopilotLearningProvider({ temporaryRoot, runner: { run }, enabled: async () => true });
    await expect(provider.infer(large, { signal: new AbortController().signal })).resolves.toEqual({ schemaVersion: 1, proposals: [] });
    expect(run).toHaveBeenCalledOnce();
    const invalid = new CopilotLearningProvider({ temporaryRoot, runner: { run: async () => ({ ...success,
      stdout: JSON.stringify({ schemaVersion: 1, proposals: [{}, {}, {}, {}] }) }) }, enabled: async () => true });
    await expect(invalid.infer(window(), { signal: new AbortController().signal })).rejects.toThrow("bounded JSON");
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
  it("keeps the complete final request within budget including the extraction instructions", async () => {
    const temporaryRoot = await root();
    const input = window();
    const anchor = input.events[0]; if (!anchor) throw new Error("Missing fixture anchor.");
    input.events.push({ ...anchor, event: { ...anchor.event, eventId: "log-result", trust: "tool", eventType: "tool.completed" },
      content: { toolResult: "普通日志😀\n".repeat(6000) + "Error: Supply path before retrying." } });
    const original = JSON.stringify(input);
    const run = vi.fn(async (_file: string, args: readonly string[]) => {
      const prompt = args[args.indexOf("--prompt") + 1] ?? "";
      expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(32 * 1024);
      expect(prompt.length).toBeLessThanOrEqual(24_000);
      expect(prompt).toContain("Supply path before retrying.");
      expect(prompt).toContain("Error: Supply path before retrying.");
      expect(prompt).not.toContain("普通日志😀\n".repeat(100));
      return success;
    });
    const provider = new CopilotLearningProvider({ temporaryRoot, enabled: async () => true, runner: { run } });
    provider.prepare(input);
    await provider.infer(input, { signal: new AbortController().signal });
    expect(run).toHaveBeenCalledOnce();
    expect(JSON.stringify(input)).toBe(original);
  });
  it("requires retention metadata from the production extractor and filters task-only output", async () => {
    const temporaryRoot = await root();
    const input = window();
    const event = input.events[0];
    if (!event?.content?.message) throw new Error("Expected fixture source.");
    const base = { rule: "Supply path.", trigger: "Reading repository files", exclusions: ["Other tools"],
      userSource: { eventId: event.event.eventId, quote: event.content.message } };
    const provider = (proposal: unknown) => new CopilotLearningProvider({ temporaryRoot, enabled: async () => true,
      runner: { run: async (_executable, args) => {
        const prompt = args[args.indexOf("--prompt") + 1] ?? "";
        expect(prompt).toContain("supportingSources");
        expect(prompt).toContain("targetRepository");
        expect(prompt).toContain("canonicalKey");
        return { ...success, stdout: JSON.stringify({ schemaVersion: 1, proposals: [proposal] }) };
      } } });
    await expect(provider(base).infer(input, { signal: new AbortController().signal })).rejects.toThrow("bounded JSON");
    const task = { ...base, retention: { kind: "convention", lifetime: "task", rationale: "This is the current task only.",
      futureUse: "No use after completing this task.", targetRepository: { status: "captured", repoId: input.repoId } },
      supportingSources: [base.userSource], canonicalKey: "path argument for current task" };
    expect(await provider(task).infer(input, { signal: new AbortController().signal })).toEqual({ schemaVersion: 1, proposals: [] });
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  it("enforces the documented 16 KiB response budget even for schema-valid output", async () => {
    const temporaryRoot = await root();
    const proposal = { rule: "r".repeat(2048), trigger: "t".repeat(2048), exclusions: Array.from({ length: 6 }, () => "x".repeat(2048)),
      userSource: { eventId: "source", quote: "q".repeat(2048) },
      failedOperationEventId: "failure", retryOperationEventId: "retry", completionEventId: "completion" };
    const stdout = JSON.stringify({ schemaVersion: 1, proposals: [proposal] });
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(16 * 1024);
    expect(Buffer.byteLength(stdout)).toBeLessThan(32 * 1024);
    const provider = new CopilotLearningProvider({ temporaryRoot, runner: { run: async () => ({ ...success, stdout }) }, enabled: async () => true });
    await expect(provider.infer(window(), { signal: new AbortController().signal })).rejects.toThrow("response budget");
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
});
