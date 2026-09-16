import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { CaptureEnvelope, LearningWindow, RuleProposal, RuleProposalInput } from "@provenloop/contracts";
import { createCaptureEnvelope, learningSourceDigest, sha256, validateLearningResponse, verifyLearningRecovery } from "@provenloop/domain";
import { createAgentExperienceCorpus } from "@provenloop/evaluation";
import { prepareLearningInput, validateDisplayedLearningSources, type PreparedLearningInput } from "../../packages/copilot-adapter/src/learning-input.js";

const instructions = "Select only exact displayed evidence. ".repeat(160);
const source = (window: LearningWindow, suffix: string, eventType?: string): CaptureEnvelope => {
  const entry = window.events.find((event) => event.sourceEventId.endsWith(suffix) && (!eventType || event.event.eventType === eventType));
  assert(entry, `Missing fixture event ${suffix}.`); return entry;
};
const displayed = (prepared: PreparedLearningInput, eventId: string, contains: string) => {
  const excerpt = prepared.view.events.find((entry) => entry.event.eventId === eventId)?.excerpts.find((entry) => entry.text.includes(contains));
  assert(excerpt, `Expected displayed evidence ${contains}.`);
  return { eventId, quote: excerpt.text };
};
const digestWindow = (window: LearningWindow): LearningWindow => {
  const sources = window.events.map((entry) => ({ eventId: entry.event.eventId, digest: learningSourceDigest(entry) }));
  return { ...window, sources, revision: sha256(sources) };
};
const build = (scenario: "EXP-03" | "EXP-04", large = true) => {
  const item = createAgentExperienceCorpus().cases.find((entry) => entry.scenario === scenario);
  assert(item);
  const window = digestWindow({ ...item.window, events: item.window.events.map((entry) => {
    if (!large || !["tool.failed", "tool.completed"].includes(entry.event.eventType)) return entry;
    const initial = entry.content?.toolResult;
    const useful = typeof initial === "string" ? initial : initial && typeof initial === "object" && "content" in initial ? String(initial.content) : "";
    const log = `${"Unrelated build telemetry; no diagnostic finding.\n".repeat(2200)}${useful}\n${"Unrelated progress detail.\n".repeat(100)}`;
    return { ...entry, content: { ...entry.content, toolResult: typeof initial === "string" ? log : { ...initial as Record<string, unknown>, content: log } } } as CaptureEnvelope;
  }) });
  const prepared = prepareLearningInput(window, instructions);
  const summary = source(window, "-summary");
  const completion = source(window, scenario === "EXP-04" ? "-retry-result" : "-completion", "tool.completed");
  const quote = scenario === "EXP-04" ? "npm test completed successfully." : "Read docs/setup.md successfully.";
  const completionSource = displayed(prepared, completion.event.eventId, quote);
  const anchorSource = displayed(prepared, summary.event.eventId, scenario === "EXP-04" ? "pnpm test failed" : "The read failed");
  const common: RuleProposalInput = { rule: scenario === "EXP-04" ? "Use npm test for repository tests." : "Supply the required path argument.",
    trigger: "Invoking the captured repository tool", exclusions: ["Other repositories or versions"],
    agentSource: { kind: "recovery", ...anchorSource, evidenceSources: [completionSource] },
    retention: { kind: "recovery", lifetime: "durable", rationale: "The captured native retry establishes this narrow invocation requirement.",
      futureUse: "When invoking the same tool under its recorded contract.", targetRepository: { status: "captured", repoId: window.repoId } },
    supportingSources: [completionSource], canonicalKey: scenario === "EXP-04" ? "npm repository test command" : "required path tool argument",
    failedOperationEventId: source(window, "-failed-start").event.eventId,
    retryOperationEventId: source(window, scenario === "EXP-04" ? "-retry-start" : "-retry").event.eventId, completionEventId: completion.event.eventId };
  if (scenario === "EXP-04") common.shellPredicate = { kind: "repository_test_command", toolName: "powershell", failedCommand: "pnpm test", command: "npm test" };
  else {
    const contract = item.contracts[0]; assert(contract);
    common.predicate = { kind: "required_argument", serverName: contract.serverName, toolName: contract.toolName, argument: "path", contractDigest: contract.digest };
  }
  const retained = (input: RuleProposalInput): RuleProposal => ({ ...input, schemaVersion: 1, jobId: "job", proposalId: "proposal", knowledgeId: "learning-knowledge-recovery",
    createdAt: window.createdAt, expiresAt: "2026-10-08T00:00:00Z", sourceDigests: window.sources });
  return { window, prepared, common, retained, contracts: item.contracts };
};

describe("selected inference input preserves recovery proof", () => {
  it.each(["EXP-03", "EXP-04"] as const)("%s qualifies from shown excerpts while canonical evidence remains unchanged", (scenario) => {
    const f = build(scenario);
    const before = JSON.stringify(f.window);
    expect(Buffer.byteLength(before)).toBeGreaterThan(32 * 1024);
    expect(f.prepared.bytes).toBeLessThanOrEqual(32 * 1024); expect(f.prepared.characters).toBeLessThanOrEqual(24_000);
    expect(f.prepared.view.anchorEventId).toBe(f.window.anchorEventId);
    for (const record of f.prepared.view.events) {
      const original = f.window.events.find((entry) => entry.event.eventId === record.event.eventId); assert(original);
      for (const excerpt of record.excerpts) {
        let originalText: unknown = excerpt.field === "content.message" ? original.content?.message
          : excerpt.field.startsWith("content.toolResult") ? original.content?.toolResult : undefined;
        for (const key of excerpt.field.matchAll(/\[("(?:[^"\\]|\\.)*")\]/gu)) {
          assert(originalText && typeof originalText === "object");
          originalText = (originalText as Record<string, unknown>)[JSON.parse(String(key[1]))];
        }
        assert.equal(typeof originalText, "string");
        expect(String(originalText).slice(excerpt.offset, excerpt.offset + excerpt.text.length)).toBe(excerpt.text);
      }
    }
    expect(() => validateDisplayedLearningSources(f.prepared, [f.common])).not.toThrow();
    const validated = validateLearningResponse(f.window, { schemaVersion: 1, proposals: [f.common] }).proposals;
    expect(validated).toHaveLength(1); const proposal = validated[0]; assert(proposal);
    expect(verifyLearningRecovery(f.retained(proposal), f.window.events, f.contracts, new Date("2026-09-08T00:01:00Z")))
      .toMatchObject({ proves: scenario === "EXP-04" ? "repository_test_command" : "invocation_contract" });
    expect(JSON.stringify(f.window)).toBe(before);
  });

  it("rejects typed recovery when large changed start arguments were omitted from the view", () => {
    const f = build("EXP-03", false);
    const changed = digestWindow({ ...f.window, events: f.window.events.map((entry) => entry.event.eventType === "tool.started" ? { ...entry,
      event: { ...entry.event, redactedArguments: { ...entry.event.redactedArguments as Record<string, string>,
        unrelated: (entry.event.eventId === f.common.failedOperationEventId ? "old configuration;" : "new configuration;").repeat(300) } } } : entry) });
    const prepared = prepareLearningInput(changed, instructions);
    for (const id of [f.common.failedOperationEventId, f.common.retryOperationEventId]) {
      expect(prepared.view.events.find((entry) => entry.event.eventId === id)?.argumentsOmitted).toBe(true);
    }
    expect(() => validateDisplayedLearningSources(prepared, [f.common])).toThrow("omitted arguments");
    const persisted = { ...f.retained(f.common), sourceDigests: changed.sources };
    expect(verifyLearningRecovery(persisted, changed.events, f.contracts, new Date("2026-09-08T00:01:00Z"))).toBeUndefined();
  });

  it("shrinks a crowded multilingual log window while retaining the anchor and qualified chain", () => {
    const f = build("EXP-03");
    const extra = Array.from({ length: 24 }, (_, index) => {
      const entry = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: `background-${index}`,
        sessionId: f.window.sessionId, repoId: f.window.repoId, worktree: f.window.worktree, repositoryState: "known_repo",
        branch: "main", commitSha: "a".repeat(40), actorId: "foreground-agent", eventType: "tool.completed", trust: "tool",
        toolName: "unrelated-log-reader", operationId: `background-${index}`, timestamp: new Date(Date.parse("2026-09-08T00:00:00Z") + index + 1).toISOString() });
      return { ...entry, content: { toolResult: `${"后台编译日志；操作明细。🚀\n".repeat(1200)}End of unrelated telemetry.` } };
    });
    const window = digestWindow({ ...f.window, events: [...f.window.events, ...extra].sort((a, b) => Date.parse(a.event.timestamp) - Date.parse(b.event.timestamp)) });
    const prepared = prepareLearningInput(window, instructions);
    expect(prepared.bytes).toBeLessThanOrEqual(32 * 1024); expect(prepared.characters).toBeLessThanOrEqual(24_000);
    expect(prepared.view.events.some((event) => event.event.eventId === window.anchorEventId)).toBe(true);
    expect(prepared.view.events.some((event) => event.event.eventType === "agent.turn_completed")).toBe(true);
    const agent = f.common.agentSource; assert(agent);
    const selected = { ...f.common, agentSource: { ...agent, ...displayed(prepared, agent.eventId, "The read failed"),
      evidenceSources: [displayed(prepared, String(f.common.completionEventId), "Read docs/setup.md successfully.")] },
      supportingSources: [displayed(prepared, String(f.common.completionEventId), "Read docs/setup.md successfully.")] };
    expect(() => validateDisplayedLearningSources(prepared, [selected])).not.toThrow();
    expect(validateLearningResponse(window, { schemaVersion: 1, proposals: [selected] }).proposals).toHaveLength(1);
    expect(verifyLearningRecovery({ ...f.retained(selected), sourceDigests: window.sources }, window.events, f.contracts, new Date("2026-09-08T00:01:00Z")))
      .toMatchObject({ proves: "invocation_contract" });
  });

  it("rejects fabricated event identities and quotes spanning undisplayed text", () => {
    const f = build("EXP-03"); const agent = f.common.agentSource; assert(agent);
    const forged = { ...f.common, agentSource: { ...agent, eventId: "event-unseen" } };
    expect(() => validateDisplayedLearningSources(f.prepared, [forged])).toThrow("outside the selected excerpts");
    expect(() => validateDisplayedLearningSources(f.prepared, [{ ...f.common, completionEventId: "event-unseen" }])).toThrow("omitted operation");
    const sourceQuote = agent.evidenceSources[0]; assert(sourceQuote);
    const original = f.window.events.find((entry) => entry.event.eventId === sourceQuote.eventId); assert(original?.content);
    const whole = { eventId: sourceQuote.eventId, quote: String(original.content.toolResult) };
    expect(() => validateDisplayedLearningSources(f.prepared, [{ ...f.common, supportingSources: [whole] }])).toThrow("outside the selected excerpts");
  });
});
