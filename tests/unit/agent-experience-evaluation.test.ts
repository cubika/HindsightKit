import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureQueueItemSchema, type CaptureEnvelope, type RuleProposal, type RuleProposalInput } from "@provenloop/contracts";
import { buildLearningWindows, learningSourceDigest, validateLearningResponse, verifyLearningRecovery } from "@provenloop/domain";
import { createAgentExperienceCorpus, createFrozenLearningCorpus, createGeneralLearningCorpus, exportInstalledLearningCorpus,
  frozenLearningCorpusSchema, prepareFrozenLearningEvaluation, runFrozenLearningEvaluation, type FrozenLearningCorpus } from "@provenloop/evaluation";
import { LearningCoordinator } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

type CorpusCase = FrozenLearningCorpus["cases"][number];
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const temp = async () => { const root = await mkdtemp(join(tmpdir(), "pl-agent-eval-")); roots.push(root); return root; };
const source = (item: CorpusCase, suffix: string): CaptureEnvelope => {
  const event = item.window.events.find((entry) => entry.sourceEventId === `${item.id}-${suffix}`);
  if (!event) throw new Error(`Missing authored source ${suffix}.`); return event;
};
const textLeaf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) { const text = textLeaf(child); if (text) return text; }
  }
  return "";
};
// Substitute proposals exercise source/receipt plumbing, not real extraction quality.
const proposed = (item: CorpusCase): RuleProposalInput => {
  const summary = source(item, "summary");
  const result = item.scenario === "EXP-04" ? source(item, "retry-result") :
    item.contracts.length > 0 ? source(item, "completion") : source(item, "result");
  const recovery = item.contracts.length > 0 || item.scenario === "EXP-04";
  const common = { rule: recovery ? "Retain the verified invocation requirement." : "Keep the finding for review within this repository.",
    trigger: "Working in this repository.", exclusions: ["Other repositories and unsupported versions."],
    agentSource: { kind: recovery ? "recovery" as const : "research" as const, eventId: summary.event.eventId, quote: summary.content?.message ?? "",
      evidenceSources: [{ eventId: result.event.eventId, quote: textLeaf(result.content?.toolResult) }] } };
  if (item.scenario === "EXP-04") return { ...common, failedOperationEventId: source(item, "failed-start").event.eventId,
    retryOperationEventId: source(item, "retry-start").event.eventId, completionEventId: result.event.eventId,
    shellPredicate: { kind: "repository_test_command", toolName: "powershell", failedCommand: "pnpm test", command: "npm test" } };
  const contract = item.contracts[0];
  if (contract) return { ...common, failedOperationEventId: source(item, "failed-start").event.eventId,
    retryOperationEventId: source(item, "retry").event.eventId, completionEventId: result.event.eventId,
    predicate: { kind: "required_argument", serverName: contract.serverName, toolName: contract.toolName, argument: "path", contractDigest: contract.digest } };
  return common;
};
const retained = (item: CorpusCase, input: RuleProposalInput): RuleProposal => ({ ...input, schemaVersion: 1, proposalId: `${item.id}-proposal`,
  jobId: `${item.id}-job`, knowledgeId: `${item.id}-knowledge`, createdAt: item.window.createdAt, expiresAt: "2026-10-08T00:00:00Z", sourceDigests: item.window.sources });

describe("agent-experience authored evaluation", () => {
  it("freezes EXP families and agent provenance without changing correction corpora or assigning human labels", async () => {
    const corpus = createAgentExperienceCorpus();
    expect(corpus).toEqual(createAgentExperienceCorpus());
    expect(corpus.cases).toHaveLength(12); expect(corpus.tasks).toHaveLength(8);
    expect(corpus.cases.filter((item) => item.designStratum === "experience")).toHaveLength(4);
    expect(new Set(corpus.cases.map((item) => item.scenario))).toEqual(new Set(["EXP-01", "EXP-02", "EXP-03", "EXP-04", "EXP-05", "EXP-06", "EXP-07", "EXP-08", "EXP-12"]));
    for (const item of frozenLearningCorpusSchema.parse(JSON.parse(JSON.stringify(corpus))).cases) {
      expect(item.window.origin).toBe("agent");
      expect(item.window.anchorEventId).toBe(source(item, "summary").event.eventId);
      expect(item.window.events.length).toBeLessThanOrEqual(32);
      expect(item.window.sources.every((digest) => { const entry = item.window.events.find((event) => event.event.eventId === digest.eventId);
        return entry !== undefined && learningSourceDigest(entry) === digest.digest; })).toBe(true);
    }
    expect(createFrozenLearningCorpus().cases).toHaveLength(40);
    expect(createGeneralLearningCorpus().cases).toHaveLength(40);
    const outputDirectory = join(await temp(), "prepared");
    await prepareFrozenLearningEvaluation({ outputDirectory, corpus });
    const labels = JSON.parse(await readFile(join(outputDirectory, "input-review-a.json"), "utf8"));
    expect(labels.reviewerId).toBeNull(); expect(labels.windows.every((item: { reusable: unknown }) => item.reusable === null)).toBe(true);
  });
  it("EXP-01/03/04 replay retains agent roles and typed receipts while native acceptance remains unknown", async () => {
    const corpus = createAgentExperienceCorpus(); const root = await temp();
    const preparedDirectory = join(root, "prepared"), outputDirectory = join(root, "run");
    await prepareFrozenLearningEvaluation({ outputDirectory: preparedDirectory, corpus });
    const run = await runFrozenLearningEvaluation({ preparedDirectory, outputDirectory, codeVersion: "fixture-agent", executableDigest: "a".repeat(64),
      providerMode: "test_substitute", maxRequests: 12, provider: { identity: { provider: "fixture", model: "fixture", version: "1" },
        infer: async (window) => { const item = corpus.cases.find((entry) => entry.window.windowId === window.windowId);
          if (!item) throw new Error("Unknown authored window.");
          return { schemaVersion: 1, proposals: item.designStratum === "experience" ? [proposed(item)] : [] }; } } });
    expect(run.complete).toBe(true); expect(run.evidenceKind).toBe("synthetic_provider_replay");
    expect(run.attempts.filter((item) => item.status === "extracted")).toHaveLength(4);
    expect(run.attempts.reduce((count, item) => count + item.receiptCount, 0)).toBe(2);
    expect(run.attempts.filter((item) => item.caseId.startsWith("EXP-01")).every((item) => item.receiptCount === 0)).toBe(true);
    for (const attempt of run.attempts.filter((item) => item.proposalCount > 0)) {
      expect(attempt.proposals[0]).toMatchObject({ agentSource: { eventId: expect.any(String), evidenceSources: [expect.any(Object)] } });
      expect(attempt.proposals[0]).not.toHaveProperty("userSource");
    }
    expect(JSON.parse(await readFile(join(outputDirectory, "acceptance-summary.json"), "utf8"))).toMatchObject({ status: "insufficient_evidence", tasksObserved: 0, humanLabelsFrozen: false });
  });
  it("EXP-02/05/06 reject borrowed sources and unsupported recovery proof", () => {
    const corpus = createAgentExperienceCorpus();
    for (const id of ["EXP-05-confounded-changes", "EXP-05-ambiguous-retries", "EXP-12-transient-retry"]) {
      const item = corpus.cases.find((entry) => entry.id === id); if (!item) throw new Error("Missing boundary fixture.");
      const input = proposed(item);
      expect(validateLearningResponse(item.window, { schemaVersion: 1, proposals: [input] }).proposals).toHaveLength(id === "EXP-05-confounded-changes" ? 0 : 1);
      expect(verifyLearningRecovery(retained(item, input), item.window.events, item.contracts, new Date("2026-09-08T00:01:00Z"))).toBeUndefined();
    }
    const research = corpus.cases[0]; if (!research) throw new Error("Missing research fixture.");
    const input = proposed(research); if (!input.agentSource) throw new Error("Missing agent source.");
    input.agentSource.evidenceSources[0] = { eventId: "unseen-source", quote: "A finding from a URL never captured." };
    expect(() => validateLearningResponse(research.window, { schemaVersion: 1, proposals: [input] })).toThrow("agent source");
    const premature = corpus.cases.find((entry) => entry.id === "EXP-06-premature-summary"); if (!premature) throw new Error("Missing premature fixture.");
    expect(() => validateLearningResponse(premature.window, { schemaVersion: 1, proposals: [proposed(premature)] })).toThrow("agent source");
  });
  it("EXP-03 capture exports preserve the agent receipt contract and source role", async () => {
    const item = createAgentExperienceCorpus().cases.find((entry) => entry.scenario === "EXP-03");
    if (!item) throw new Error("Missing MCP recovery fixture.");
    const root = await temp(); const databasePath = join(root, "capture.db"), outputDirectory = join(root, "captured");
    const now = () => new Date("2026-09-08T00:01:00Z");
    expect(buildLearningWindows(item.window.events, now()).some((window) => window.windowId === item.window.windowId)).toBe(true);
    const store = new CanonicalSqliteStore(databasePath);
    try {
      for (const envelope of item.window.events) store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `queue-${envelope.event.eventId}`,
        state: "pending", attemptCount: 0, failureCount: 0, createdAt: envelope.event.timestamp, updatedAt: envelope.event.timestamp, envelope }));
      const coordinator = new LearningCoordinator({ store, enabled: async () => true, now, contracts: () => item.contracts,
        lease: { tryAcquire: async () => ({ release: async () => undefined }) },
        provider: { identity: { provider: "fixture", model: "fixture", version: "1" }, infer: async (window) => ({ schemaVersion: 1, proposals: window.origin === "agent" ? [proposed(item)] : [] }) } });
      for (let attempt = 0; attempt < 3 && store.learningReceipts().length === 0; attempt += 1) await coordinator.run();
      expect(store.learningReceipts()[0]).toMatchObject({ agentEventId: item.window.anchorEventId, proves: "invocation_contract" });
      expect(store.learningReceipts()[0]).not.toHaveProperty("userEventId");
    } finally { store.close(); }
    await exportInstalledLearningCorpus({ databasePath, outputDirectory, now });
    const captured = frozenLearningCorpusSchema.parse(JSON.parse(await readFile(join(outputDirectory, "corpus.json"), "utf8")));
    const agent = captured.cases.find((entry) => entry.window.origin === "agent");
    expect(agent).toMatchObject({ scenario: "captured-agent-experience", designStratum: "unlabeled_capture", contracts: item.contracts });
    expect(captured.sourceKind).toBe("captured_installed"); expect(captured.tasks).toEqual([]);
  });
});
