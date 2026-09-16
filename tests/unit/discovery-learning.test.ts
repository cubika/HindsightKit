import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  captureQueueItemSchema, contextUseRecordSchema, knowledgeCandidateSchema, learningWindowSchema, ruleProposalInputSchema,
  type CaptureEnvelope, type DiscoveryMetadata, type RuleProposal, type RuleProposalInput,
} from "@provenloop/contracts";
import {
  createCaptureEnvelope, createLearningDistillation, hasAcceptedLearningDistillation, learningKnowledgeCandidate,
  learningSourceUse, sha256, validateLearningResponse, validLearningDiscoveryMetadata,
} from "@provenloop/domain";
import { LearningCoordinator } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { DISTILLATION_INSTRUCTIONS, REVIEW_INSTRUCTIONS } from "../../packages/copilot-adapter/src/distillation-instructions.js";
import { prepareLearningReviewInput } from "../../packages/copilot-adapter/src/learning-review-input.js";

const now = new Date("2026-09-11T08:00:10.000Z");
const reviewer = { provider: "fixture", model: "fixture", version: "discovery-review-1" };
const criteria = { supported: true, scoped: true, reusable: true, actionable: true, concise: true, nonredundant: true };
const review = { criteria, rationale: "The user states a lasting retry condition and supplies the policy locator." };
const message = "Always keep the same idempotency key when retrying PaymentClient writes after an ambiguous timeout. " +
  "Do not apply this rule to read-only queries. The policy is at docs/retry-policy.md.";
const metadata = (): DiscoveryMetadata => ({
  purposes: [{ value: "constraint", basisIds: ["content:0"], polarity: "positive" }],
  entities: [{ value: { kind: "component", value: "PaymentClient" }, basisIds: ["content:0"], polarity: "positive" }],
  paraphrases: [{ value: { language: "zh", text: "PaymentClient 写入发生不确定超时后，重试必须使用相同的幂等键。不适用于只读查询。" },
    basisIds: ["content:0", "appliesWhen:0"], polarity: "positive" }],
  sourceReferences: [{ sourceRefId: "retry-policy", kind: "file", locator: "docs/retry-policy.md", repositoryId: "repo",
    evidenceIds: [], availability: "pointer_only", relationship: "background" }],
});

const fixture = () => {
  const events: CaptureEnvelope[] = [
    createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "discovery-user", sessionId: "source-session",
      repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo", branch: "main", commitSha: "a".repeat(40),
      timestamp: "2026-09-11T08:00:00.000Z", eventType: "prompt.submitted", trust: "user", content: { message } }),
    createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "discovery-complete", sessionId: "source-session",
      repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo", branch: "main", commitSha: "a".repeat(40),
      timestamp: "2026-09-11T08:00:01.000Z", eventType: "agent.turn_completed", trust: "model" }),
  ];
  const source = events[0]; assert(source);
  const sources = events.map((entry) => ({ eventId: entry.event.eventId, digest: sha256(entry) }));
  const window = learningWindowSchema.parse({ schemaVersion: 1, windowId: "learning-window-" + sha256(source.event.eventId).slice(0, 24),
    revision: sha256(sources), sessionId: "source-session", repoId: "repo", worktree: "C:/repo", createdAt: source.event.timestamp, sources, events });
  const input: RuleProposalInput = {
    rule: "Keep the same idempotency key when retrying PaymentClient writes after an ambiguous timeout.",
    trigger: "Retrying PaymentClient writes after an ambiguous timeout.", exclusions: ["Read-only queries"],
    canonicalKey: "PaymentClient write retry idempotency key after an ambiguous timeout",
    userSource: { eventId: source.event.eventId, quote: message }, supportingSources: [{ eventId: source.event.eventId, quote: message }],
    retention: { kind: "convention", lifetime: "durable", rationale: "A retry must not repeat a write that already succeeded.",
      futureUse: "When implementing timeout retries for PaymentClient writes.", targetRepository: { status: "captured", repoId: "repo" } },
    discovery: metadata(),
  };
  const bind = (value: RuleProposalInput = input): RuleProposal => ({ ...value, schemaVersion: 1, proposalId: "proposal",
    jobId: "job", knowledgeId: "knowledge", createdAt: source.event.timestamp, expiresAt: "2026-10-11T08:00:00.000Z", sourceDigests: sources,
    distillation: createLearningDistillation(value, sources, review, reviewer, now.toISOString()) });
  return { events, input, bind, window, sources };
};

describe("reviewed learning discovery metadata", () => {
  it("persists optional reviewed facets without promoting evidence", () => {
    const f = fixture(); const proposal = f.bind();
    expect(ruleProposalInputSchema.safeParse(f.input).success).toBe(true);
    expect(validLearningDiscoveryMetadata(proposal, f.events)).toBe(true);
    const candidate = learningKnowledgeCandidate(f.window, proposal);
    expect(knowledgeCandidateSchema.parse(candidate)).toMatchObject({ discovery: metadata(), state: "candidate", evidenceTier: "inferred", evidenceMarks: [] });
    expect(learningSourceUse(candidate, [proposal], f.events)).toMatchObject({ mode: "convention", distilledLesson: proposal.rule });
  });

  it("leaves legacy lessons valid and drops unreviewed or rejected enrichment", () => {
    const f = fixture(); const legacy = { ...f.input }; delete legacy.discovery;
    expect(ruleProposalInputSchema.safeParse(legacy).success).toBe(true);
    const unreviewed = f.bind(); delete unreviewed.distillation;
    const rejected = f.bind();
    rejected.distillation = createLearningDistillation(f.input, f.sources, { ...review, criteria: { ...criteria, supported: false } }, reviewer, now.toISOString());
    for (const proposal of [unreviewed, rejected]) expect(learningKnowledgeCandidate(f.window, proposal).discovery).toBeUndefined();
    expect(learningKnowledgeCandidate(f.window, f.bind(legacy)).discovery).toBeUndefined();
  });

  it.each([
    ["purpose", (value: DiscoveryMetadata) => { value.purposes = [{ value: "procedure", basisIds: ["content:0"], polarity: "positive" }]; }],
    ["entity case", (value: DiscoveryMetadata) => { if (value.entities?.[0]) value.entities[0].value.value = "paymentclient"; }],
    ["paraphrase", (value: DiscoveryMetadata) => { if (value.paraphrases?.[0]) value.paraphrases[0].value.text = "Retry every request."; }],
    ["basis", (value: DiscoveryMetadata) => { if (value.entities?.[0]) value.entities[0].basisIds = ["appliesWhen:0"]; }],
    ["polarity", (value: DiscoveryMetadata) => { if (value.purposes?.[0]) value.purposes[0].polarity = "required_condition"; }],
    ["locator", (value: DiscoveryMetadata) => { if (value.sourceReferences?.[0]) value.sourceReferences[0].locator = "docs/invented.md"; }],
  ] as const)("invalidates the independent review after a %s edit", (_name, mutate) => {
    const f = fixture(); const proposal = f.bind(); assert(proposal.discovery); mutate(proposal.discovery);
    expect(hasAcceptedLearningDistillation(proposal, f.sources)).toBe(false);
    expect(learningKnowledgeCandidate(f.window, proposal).discovery).toBeUndefined();
  });

  it("rejects editing candidate metadata while retaining the reviewed proposal", () => {
    const f = fixture(); const proposal = f.bind(); const candidate = learningKnowledgeCandidate(f.window, proposal);
    const changed = structuredClone(candidate); assert(changed.discovery?.entities?.[0]);
    changed.discovery.entities[0].value.value = "AnotherClient";
    expect(learningSourceUse(changed, [proposal], f.events)).toBeUndefined();
  });

  it.each(["user", "deterministic"] as const)("cannot claim %s metadata authority in model output", (producer) => {
    const f = fixture(); assert(f.input.discovery); f.input.discovery.producer = producer;
    expect(validLearningDiscoveryMetadata(f.input, f.events)).toBe(false);
    expect(() => validateLearningResponse(f.window, { schemaVersion: 1, proposals: [f.input] }, { sourcesOnly: true })).toThrow("discovery metadata");
    expect(learningKnowledgeCandidate(f.window, f.bind()).discovery).toBeUndefined();
  });

  it("rejects unsupported feature bases, positive exclusions, and lost paraphrase conditions", () => {
    const f = fixture();
    for (const invalid of [
      { entities: [{ value: { kind: "component", value: "PaymentClient" }, basisIds: ["content:7"], polarity: "positive" }] },
      { entities: [{ value: { kind: "context", value: "Read-only queries" }, basisIds: ["nonApplicability:0"], polarity: "positive" }] },
      { paraphrases: [{ value: { language: "en", text: "Preserve idempotency keys." }, basisIds: ["content:0"], polarity: "positive" }] },
    ] as DiscoveryMetadata[]) {
      expect(validLearningDiscoveryMetadata({ ...f.input, discovery: invalid }, f.events)).toBe(false);
    }
  });

  it("allows reviewed paraphrases while keeping queryTerms verbatim", () => {
    const f = fixture();
    expect(validateLearningResponse(f.window, { schemaVersion: 1, proposals: [f.input] }, { sourcesOnly: true }).proposals).toHaveLength(1);
    expect(() => validateLearningResponse(f.window, { schemaVersion: 1, proposals: [{ ...f.input, queryTerms: { include: ["幂等键"], exclude: [] } }] },
      { sourcesOnly: true })).toThrow("quoted evidence");
  });

  it("rejects invented locators, versions, observations, evidence IDs, and captured status", () => {
    const f = fixture(); const reference = metadata().sourceReferences?.[0]; assert(reference);
    for (const override of [{ locator: "docs/other.md" }, { locator: "retry-policy.md" }, { anchor: "never-captured-heading" },
      { revision: "invented-version" }, { observedAt: now.toISOString() }, { contentDigest: "b".repeat(64) },
      { repositoryId: "another-repo" }, { evidenceIds: ["unknown"] }, { availability: "captured" as const }]) {
      const discovery = { ...metadata(), sourceReferences: [{ ...reference, ...override }] };
      expect(validLearningDiscoveryMetadata({ ...f.input, discovery }, f.events), JSON.stringify(override)).toBe(false);
    }
  });

  it("accepts captured metadata only when the related tool supplied cited material", () => {
    const f = fixture(); const quote = "A retry must preserve the original idempotency key because the first write may have succeeded.";
    const tool = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "read-policy",
      sessionId: "source-session", repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo", branch: "main", commitSha: "a".repeat(40),
      timestamp: "2026-09-11T08:00:00.500Z", eventType: "tool.completed", trust: "tool", toolName: "read",
      content: { toolResult: quote, toolArguments: { path: "docs/actual-policy.md" } } });
    const proposal: RuleProposalInput = { ...f.input, supportingSources: [...(f.input.supportingSources ?? []), { eventId: tool.event.eventId, quote }],
      discovery: { ...metadata(), sourceReferences: [{ sourceRefId: "actual-policy", kind: "file", locator: "docs/actual-policy.md",
        repositoryId: "repo", evidenceIds: [tool.event.eventId], availability: "captured", relationship: "supports", revision: "a".repeat(40) }] } };
    expect(validLearningDiscoveryMetadata(proposal, [...f.events, tool])).toBe(true);
    expect(validLearningDiscoveryMetadata(proposal, f.events)).toBe(false);
    const prompt = prepareLearningReviewInput({ ...f.window, events: [...f.events, tool] }, [proposal], [], "");
    const data = JSON.parse(prompt);
    expect(data.sourceMetadata).toContainEqual(expect.objectContaining({ eventId: tool.event.eventId, locators: ["docs/actual-policy.md"], commitSha: "a".repeat(40) }));
    expect(data.citations).toContainEqual({ eventId: tool.event.eventId, quote });
    const invented = { ...proposal, discovery: { sourceReferences: [{ ...proposal.discovery?.sourceReferences?.[0], locator: "docs/invented.md" }] } };
    const rejectedData = JSON.parse(prepareLearningReviewInput({ ...f.window, events: [...f.events, tool] }, [invented as RuleProposalInput], [], ""));
    expect(rejectedData.sourceMetadata.flatMap((entry: { locators: string[] }) => entry.locators)).not.toContain("docs/invented.md");
  });

  it("round-trips learned metadata and relevance records through canonical JSON storage", async () => {
    const f = fixture(); const store = new CanonicalSqliteStore(":memory:");
    try {
      for (const [index, envelope] of f.events.entries()) store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1,
        queueItemId: "discovery-queue-" + index, state: "pending", attemptCount: 0, failureCount: 0, createdAt: envelope.event.timestamp,
        updatedAt: envelope.event.timestamp, envelope }));
      const coordinator = new LearningCoordinator({ store, now: () => now, enabled: async () => true,
        lease: { tryAcquire: async () => ({ release: async () => undefined }) },
        provider: { identity: reviewer, infer: async (window) => ({ schemaVersion: 1, proposals: [{ ...f.input,
          distillation: createLearningDistillation(f.input, window.sources, review, reviewer, now.toISOString()) }] }) } });
      expect(await coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1 });
      const candidate = store.knowledgeCandidates()[0]; assert(candidate);
      expect(candidate.discovery).toEqual(metadata());
      expect(store.learningProposals()[0]?.discovery).toEqual(metadata());
      const record = contextUseRecordSchema.parse({ schemaVersion: 1, appliedKnowledgeIds: [], candidateKnowledgeIds: [candidate.knowledgeId],
        createdAt: now.toISOString(), latencyMs: 1, repoId: "repo", renderedTokens: 100, requestId: "discovery-request",
        returnedKnowledgeIds: [candidate.knowledgeId], sessionId: "later-session", retrievalMode: "search",
        relevance: [{ knowledgeId: candidate.knowledgeId, knowledgeDigest: sha256(candidate), querySignature: sha256("query concepts"),
          policyVersion: "discovery-1", matchedConcepts: ["idempotency"], matchedEntities: ["PaymentClient"], unresolvedConditions: [candidate.appliesWhen[0]] }] });
      store.appendContextUseRecord(record);
      expect(store.contextUseRecord(record.requestId)).toMatchObject(record);
      const legacy = { ...record }; delete legacy.relevance; delete legacy.retrievalMode;
      expect(contextUseRecordSchema.safeParse(legacy).success).toBe(true);
    } finally { store.close(); }
  });

  it("requires metadata support and polarity review in the independent review instructions", () => {
    expect(DISTILLATION_INSTRUCTIONS).toContain("queryTerms still require verbatim source phrases");
    expect(REVIEW_INSTRUCTIONS).toContain("every discovery feature");
    expect(REVIEW_INSTRUCTIONS).toContain("Reject the proposal when any discovery metadata fails");
  });
});
