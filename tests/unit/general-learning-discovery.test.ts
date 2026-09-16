import { describe, expect, it } from "vitest";
import { captureQueueItemSchema, ruleProposalInputSchema } from "@provenloop/contracts";
import { buildLearningWindows, createCaptureEnvelope, learningKnowledgeCandidate, KnowledgeAdmissionPolicy, validateLearningResponse, verifyLearningRecovery } from "@provenloop/domain";
import { createGeneralLearningCorpus, GENERAL_LEARNING_EXAMPLES } from "@provenloop/evaluation";
import { LearningCoordinator } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

describe("general catalog candidate representation and isolation (provider substitute)", () => {
  it.each(GENERAL_LEARNING_EXAMPLES)("$id represents a source-backed semantic candidate without inventing a failure", async (example) => {
    const scenario = createGeneralLearningCorpus().cases.find((entry) => entry.id === `${example.id}-correction`);
    if (!scenario) throw new Error("Missing authored scenario.");
    const user = scenario.window.events.find((entry) => entry.event.trust === "user");
    if (!user) throw new Error("Missing original user source.");
    const output = { schemaVersion: 1, proposals: [{ rule: example.rule, trigger: `The corrected ${example.id} workflow in this repository`,
      exclusions: ["Different workflows and repositories"], userSource: { eventId: user.event.eventId, quote: example.correction } }] };
    const store = new CanonicalSqliteStore(":memory:");
    try {
      for (const [index, envelope] of scenario.window.events.entries()) store.ingestQueueItem(captureQueueItemSchema.parse({
        schemaVersion: 1, queueItemId: `${example.id}-${index}`, state: "pending", attemptCount: 0, failureCount: 0,
        createdAt: envelope.event.timestamp, updatedAt: envelope.event.timestamp, envelope,
      }));
      const coordinator = new LearningCoordinator({ store, now: () => new Date("2026-09-08T00:01:00Z"), enabled: async () => true,
        lease: { tryAcquire: async () => ({ release: async () => undefined }) },
        provider: { identity: { provider: "fixture", model: "fixture", version: "1" }, infer: async () => output } });
      expect(await coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1, qualified: 0 });
      const candidate = store.knowledgeCandidates()[0]; const proposal = store.learningProposals()[0];
      if (!candidate || !proposal) throw new Error("Candidate was not persisted.");
      expect(candidate).toMatchObject({ state: "candidate", scope: "repository", scopeId: scenario.window.repoId, evidenceTier: "inferred" });
      expect(proposal.failedOperationEventId).toBeUndefined();
      expect(store.learningReceipts()).toEqual([]);
      expect(new KnowledgeAdmissionPolicy().evaluate({ candidate, ...store.knowledgeAdmissionEvidence([candidate]) }).admitted).toBe(false);
      expect(store.pendingLearningActivationIds()).toEqual([]);
    } finally { store.close(); }
  });

  it("INT-07 captures a proactive plan correction at turn closure without a tool operation", () => {
    const user = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "plan-user", sessionId: "plan",
      repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo", eventType: "prompt.submitted", trust: "user",
      timestamp: "2026-09-08T00:00:00Z", content: { message: "Before editing, keep this API's omitted fields unchanged on PATCH requests." } });
    const closed = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "plan-end", sessionId: "plan",
      repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo", eventType: "agent.turn_completed", trust: "model",
      timestamp: "2026-09-08T00:00:01Z" });
    expect(buildLearningWindows([user], new Date("2026-09-08T00:00:10Z"))).toEqual([]);
    expect(buildLearningWindows([user, closed], new Date("2026-09-08T00:00:10Z"))).toHaveLength(1);
  });

  it("TRU-04/TRU-08 reject invented quotes and optional references, and require full typed evidence", () => {
    const scenario = createGeneralLearningCorpus().cases[0];
    if (!scenario) throw new Error("Missing scenario.");
    const user = scenario.window.events.find((entry) => entry.event.trust === "user");
    if (!user) throw new Error("Missing user.");
    const proposal = { rule: "Use net revenue.", trigger: "Revenue report", exclusions: ["Other reports"],
      userSource: { eventId: user.event.eventId, quote: user.content?.message ?? "" } };
    expect(() => validateLearningResponse(scenario.window, { schemaVersion: 1, proposals: [{ ...proposal, userSource: { ...proposal.userSource, quote: "Invented quote" } }] })).toThrow();
    expect(() => validateLearningResponse(scenario.window, { schemaVersion: 1, proposals: [{ ...proposal, completionEventId: "invented" }] })).toThrow();
    expect(() => validateLearningResponse(scenario.window, { schemaVersion: 1, proposals: [{ ...proposal, rule: "Use api_key=synthetic-secret-value-for-test" }] })).toThrow("sensitive content");
    expect(ruleProposalInputSchema.safeParse({ ...proposal, predicate: { kind: "required_argument", serverName: "files", toolName: "read", argument: "path", contractDigest: "a".repeat(64) } }).success).toBe(false);
    const parsed = validateLearningResponse(scenario.window, { schemaVersion: 1, proposals: [proposal] }).proposals[0];
    if (!parsed) throw new Error("Missing proposal.");
    const stored = { ...parsed, schemaVersion: 1 as const, proposalId: "proposal", jobId: "job", knowledgeId: "learning-knowledge-semantic",
      createdAt: scenario.window.createdAt, expiresAt: "2026-10-08T00:00:00Z", sourceDigests: scenario.window.sources };
    expect(verifyLearningRecovery(stored, scenario.window.events, [], new Date())).toBeUndefined();
    expect(learningKnowledgeCandidate(scenario.window, stored).state).toBe("candidate");
  });

  it("INT-04/05/08 keeps zero-proposal negative outputs empty without fabricated support", () => {
    for (const scenario of createGeneralLearningCorpus().cases.filter((entry) => entry.designStratum === "negative")) {
      expect(validateLearningResponse(scenario.window, { schemaVersion: 1, proposals: [] }).proposals).toEqual([]);
    }
  });
});
