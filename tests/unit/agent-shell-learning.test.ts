import { describe, expect, it } from "vitest";
import { CopilotEventMapper, type CopilotSessionEvent } from "@provenloop/copilot-adapter";
import { captureQueueItemSchema, type CaptureEnvelope, type RuleProposal } from "@provenloop/contracts";
import { buildLearningWindows, createCaptureEnvelope, KnowledgeAdmissionPolicy, learningKnowledgeCandidate, learningSourceDigest, verifyShellRecovery } from "@provenloop/domain";
import { LearningCoordinator } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { ContextRetrievalService, knowledgeProjectionFromCandidate, type KnowledgeBackend } from "@provenloop/retrieval";

const now = new Date("2026-09-08T00:01:00Z");
const fixture = () => {
  const mapper = new CopilotEventMapper({ adapterVersion: "1.0.84-1", sessionId: "agent-shell", copyLimits: { maxStringChars: 16_384 },
    workspace: { cwd: "C:/repo", worktree: "C:/repo", repoId: "repo", repositoryState: "known_repo", branch: "main", commitSha: "a".repeat(40) } });
  const native: CopilotSessionEvent[] = [
    { id: "task", type: "user.message", data: { content: "Run the package tests." } },
    { id: "failed", type: "tool.execution_start", data: { toolCallId: "first", toolName: "powershell", arguments: { command: "pnpm test", cwd: "C:/repo" } } },
    { id: "failure", type: "tool.execution_complete", data: { toolCallId: "first", success: true, result: { content: "pnpm test failed", contents: [{ type: "shell_exit", shellId: "first", cwd: "C:/repo", exitCode: 1 }] } } },
    { id: "retry", type: "tool.execution_start", data: { toolCallId: "second", toolName: "powershell", arguments: { command: "npm test", cwd: "C:/repo" } } },
    { id: "completion", type: "tool.execution_complete", data: { toolCallId: "second", success: true, result: { content: "npm test completed with exit code zero", contents: [{ type: "shell_exit", shellId: "second", cwd: "C:/repo", exitCode: 0 }] } } },
    { id: "summary", type: "assistant.message", data: { messageId: "summary", content: "For this repository revision, npm test works where pnpm test failed. Use npm test for this package." } },
    { id: "end", type: "assistant.turn_end", data: { turnId: "turn" } },
  ];
  const events: CaptureEnvelope[] = native.flatMap((event, i) => {
    const mapped = mapper.map({ ...event, parentId: i ? native[i - 1]?.id ?? null : null, timestamp: new Date(Date.UTC(2026, 8, 8, 0, 0, i)).toISOString() });
    if (mapped.status !== "mapped") throw new Error(`Unmapped fixture ${event.type}`);
    return [mapped.value, ...(mapped.additionalEvents ?? [])].map((value) => createCaptureEnvelope(value));
  });
  const get = (id: string, type: string) => {
    const value = events.find((entry) => entry.sourceEventId === id && entry.event.eventType === type);
    if (!value) throw new Error("Missing fixture event"); return value;
  };
  const summary = get("summary", "agent.message");
  const proposal: RuleProposal = { schemaVersion: 1, proposalId: "agent-shell-proposal", jobId: "agent-job", knowledgeId: "learning-knowledge-agent-shell",
    createdAt: summary.event.timestamp, expiresAt: "2026-10-08T00:00:00Z", rule: "Use npm test for this package.", trigger: "Running package tests", exclusions: ["Other revisions"],
    agentSource: { kind: "recovery", eventId: summary.event.eventId, quote: summary.content?.message ?? "",
      evidenceSources: [{ eventId: get("failure", "tool.completed").event.eventId, quote: "pnpm test failed" },
        { eventId: get("completion", "tool.completed").event.eventId, quote: "npm test completed with exit code zero" }] },
    failedOperationEventId: get("failed", "tool.started").event.eventId, retryOperationEventId: get("retry", "tool.started").event.eventId,
    completionEventId: get("completion", "tool.completed").event.eventId, shellPredicate: { kind: "repository_test_command", toolName: "powershell", failedCommand: "pnpm test", command: "npm test" },
    sourceDigests: events.map((event) => ({ eventId: event.event.eventId, digest: learningSourceDigest(event) })) };
  return { events, proposal, get };
};

describe("agent self-directed shell recovery", () => {
  it("EXP-04/09 qualifies native recovery without a user correction and preserves source role", () => {
    const { events, proposal } = fixture();
    const receipt = verifyShellRecovery(proposal, events, now);
    expect(receipt).toMatchObject({ proves: "repository_test_command", agentEventId: proposal.agentSource?.eventId });
    expect(receipt?.userEventId).toBeUndefined();
    const window = buildLearningWindows(events, now).find((entry) => entry.origin === "agent");
    if (!receipt || !window) throw new Error("Missing qualified agent window");
    const candidate = learningKnowledgeCandidate(window, proposal, receipt);
    expect(new KnowledgeAdmissionPolicy().evaluate({ candidate, envelopes: events, correctionKeys: [], correctionSourceEventIds: new Set(), workEpisodes: [], learningProposals: [proposal], learningReceipts: [receipt] }).admitted).toBe(true);
  });
  it.each(["unseen-source", "user-intervention", "summary-before-result", "wrong-revision", "no-native-proof"])("EXP-02/05/06 rejects %s", (variant) => {
    const f = fixture(); let { events, proposal } = f;
    if (variant === "unseen-source" && proposal.agentSource) proposal = { ...proposal, agentSource: { ...proposal.agentSource, evidenceSources: [{ eventId: "invented", quote: "passed" }] } };
    if (variant === "user-intervention") {
      const correction = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "intervention", sessionId: "agent-shell",
        repoId: "repo", repositoryState: "known_repo", worktree: "C:/repo", branch: "main", commitSha: "a".repeat(40),
        eventType: "prompt.submitted", trust: "user", timestamp: "2026-09-08T00:00:02.500Z", parentEventId: f.get("failure", "tool.completed").event.eventId, content: { message: "Use npm test." } });
      events = [...events.map((entry) => entry.sourceEventId === "retry" ? { ...entry, event: { ...entry.event, parentEventId: correction.event.eventId } } : entry), correction];
    }
    if (variant === "summary-before-result") events = events.map((entry) => entry.sourceEventId === "summary" ? { ...entry, event: { ...entry.event, timestamp: "2026-09-08T00:00:03.500Z" } } : entry);
    if (variant === "wrong-revision") events = events.map((entry) => entry.sourceEventId === "completion" ? { ...entry, event: { ...entry.event, commitSha: "b".repeat(40) } } : entry);
    if (variant === "no-native-proof") events = events.filter((entry) => entry.event.eventType !== "test.completed");
    proposal = { ...proposal, sourceDigests: events.map((entry) => ({ eventId: entry.event.eventId, digest: learningSourceDigest(entry) })) };
    expect(verifyShellRecovery(proposal, events, now)).toBeUndefined();
  });
  it.each(["2026-09-08T00:00:00.500Z", "2026-09-08T00:00:02.500Z"])("EXP-08 rejects a recovery assisted by the same recalled rule at %s", (recalledAt) => {
    const { events, proposal } = fixture(); const receipt = verifyShellRecovery(proposal, events, now);
    const window = buildLearningWindows(events, now).find((entry) => entry.origin === "agent");
    if (!receipt || !window) throw new Error("Missing fixture proof");
    const candidate = learningKnowledgeCandidate(window, proposal, receipt);
    const decision = new KnowledgeAdmissionPolicy().evaluate({ candidate, envelopes: events, correctionKeys: [], correctionSourceEventIds: new Set(), workEpisodes: [],
      learningProposals: [proposal], learningReceipts: [receipt], contextUseRecords: [{ schemaVersion: 1, requestId: "assisted", sessionId: "agent-shell",
        createdAt: recalledAt, appliedKnowledgeIds: [], candidateKnowledgeIds: [], returnedKnowledgeIds: [proposal.knowledgeId], latencyMs: 1, renderedTokens: 10, retrievalStatus: "provided" }] });
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toContain("recalled_knowledge_evidence");
  });
  it("EXP-10/11 persists through the coordinator and removes all derived agent evidence on source deletion", async () => {
    const { events, proposal } = fixture();const store = new CanonicalSqliteStore(":memory:");
    try {
      for (const [i, envelope] of events.entries()) store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `agent-${i}`, state: "pending", attemptCount: 0, failureCount: 0, createdAt: envelope.event.timestamp, updatedAt: envelope.event.timestamp, envelope }));
      let calls = 0; const coordinator = new LearningCoordinator({ store, now: () => now, enabled: async () => true, lease: { tryAcquire: async () => ({ release: async () => undefined }) }, provider: { identity: { provider: "fixture", model: "fixture", version: "1" }, infer: async (window) => {
        calls++; return { schemaVersion: 1, proposals: window.origin === "agent" ? [{ rule: proposal.rule, trigger: proposal.trigger, exclusions: proposal.exclusions, agentSource: proposal.agentSource,
          failedOperationEventId: proposal.failedOperationEventId, retryOperationEventId: proposal.retryOperationEventId, completionEventId: proposal.completionEventId, shellPredicate: proposal.shellPredicate }] : [] };
      } } });
      for (let i = 0; i < 4; i++) await coordinator.run();
      expect(store.knowledgeCandidates().filter((entry) => entry.state === "active")).toHaveLength(1);
      expect(store.learningReceipts()[0]?.agentEventId).toBe(proposal.agentSource?.eventId);
      const candidate = store.knowledgeCandidates()[0];
      if (!candidate) throw new Error("Missing persisted learning");
      const projected = { ...knowledgeProjectionFromCandidate(candidate), score: 1 };
      const backend: KnowledgeBackend = { get: async () => projected, search: async () => [projected],
        index: async () => undefined, rebuild: async () => undefined, remove: async () => undefined,
        health: async () => ({ fts5Available: true, quickCheck: "ok", recordCount: 1, status: "healthy" }) };
      const service = new ContextRetrievalService({ store, backend, now: () => now, timeoutMs: 5000 });
      const context = await service.context({ cwd: "C:/repo", repoId: "repo", sessionId: "later-task", prompt: "Run npm test for this repository", tokenBudget: 600,
        shellInvocation: { toolName: "powershell", command: "npm test", cwd: "C:/repo", branch: "main", commitSha: "a".repeat(40) } });
      expect(context.items).toHaveLength(1);
      const explanation = service.explain({ explanationRef: context.items[0]?.explanationRef ?? "", sessionId: "later-task" });
      expect(JSON.stringify(explanation)).toContain("agentSource");
      expect(JSON.stringify(explanation)).toContain("agentEventId");
      expect(JSON.stringify(explanation)).not.toContain("userSource");
      const priorCalls = calls; await coordinator.run(); expect(calls).toBe(priorCalls);
      const target = { targetType: "source" as const, targetId: proposal.agentSource?.eventId ?? "" }; const deletion = store.beginDeletion(target); store.deleteCanonicalTarget(deletion.deletionId, target);
      expect(store.knowledgeCandidates()).toEqual([]); expect(store.learningReceipts()).toEqual([]);
    } finally { store.close(); }
  });
});
