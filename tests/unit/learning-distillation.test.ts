import { describe, expect, it } from "vitest";
import {
  learningDistillationReviewSchema, learningDistillationSchema, learningDistillationSummarySchema, ruleProposalInputSchema,
  type LearningDistillation, type LearningDistillationCriteria, type RuleProposalInput,
} from "@provenloop/contracts";
import {
  createLearningDistillation, hasAcceptedLearningDistillation, learningDistillationInputDigest, sha256,
} from "@provenloop/domain";

const sourceDigests = [
  { eventId: "user", digest: sha256("captured user statement and its full context") },
  { eventId: "tool", digest: sha256("captured tool result and its metadata") },
];
const reviewer = { provider: "copilot-cli", model: "default", version: "distillation-review-1" };
const reviewedAt = "2026-09-11T08:00:00.000Z";
const criteria: LearningDistillationCriteria = {
  supported: true, scoped: true, reusable: true, actionable: true, concise: true, nonredundant: true,
};
const review = { criteria, rationale: "The stated repository convention determines the language of later API examples." };
const proposal = (): RuleProposalInput => ({
  rule: "Write repository API examples in English.", trigger: "Writing repository API examples",
  exclusions: ["Executable syntax and identifiers"], canonicalKey: "English repository API examples",
  userSource: { eventId: "user", quote: "Always write repository API examples in English. Preserve identifiers." },
  supportingSources: [{ eventId: "user", quote: "Always write repository API examples in English. Preserve identifiers." }],
  retention: { kind: "convention", lifetime: "durable",
    rationale: "A consistent language makes later API documentation usable across the team.",
    futureUse: "When writing API examples for another repository feature.",
    targetRepository: { status: "captured", repoId: "repo" } },
});
const accepted = (): RuleProposalInput & { distillation: LearningDistillation } => {
  const input = proposal();
  return { ...input, distillation: createLearningDistillation(input, sourceDigests, review, reviewer, reviewedAt) };
};

describe("model distillation assessment binding", () => {
  it("accepts a bound review without adding execution proof or user authority", () => {
    const input = accepted();
    expect(hasAcceptedLearningDistillation(input, sourceDigests)).toBe(true);
    expect(ruleProposalInputSchema.parse(input).distillation).toEqual(input.distillation);
    expect(input.distillation).toMatchObject({ schemaVersion: 1, comparisonBasis: "provided_material", reviewer, reviewedAt });
    expect(input).not.toHaveProperty("evidenceTier");
    expect(input).not.toHaveProperty("userConfirmed");
    expect(input).not.toHaveProperty("receipt");
  });

  it("keeps legacy proposals valid without treating them as reviewed", () => {
    const input = proposal();
    expect(ruleProposalInputSchema.safeParse(input).success).toBe(true);
    expect(hasAcceptedLearningDistillation(input, sourceDigests)).toBe(false);
  });

  it.each(Object.keys(criteria) as (keyof LearningDistillationCriteria)[])("requires an affirmative %s assessment", (criterion) => {
    const input = proposal();
    input.distillation = createLearningDistillation(input, sourceDigests, {
      ...review, criteria: { ...criteria, [criterion]: false },
    }, reviewer, reviewedAt);
    expect(hasAcceptedLearningDistillation(input, sourceDigests)).toBe(false);
  });

  it.each([
    ["rule", (input: RuleProposalInput) => { input.rule = "Write every document in English."; }],
    ["trigger", (input: RuleProposalInput) => { input.trigger = "Writing any content"; }],
    ["exclusions", (input: RuleProposalInput) => { input.exclusions = ["No exceptions"]; }],
    ["canonical meaning", (input: RuleProposalInput) => { input.canonicalKey = "English everywhere"; }],
    ["retrieval task scope", (input: RuleProposalInput) => { input.retrievalScope = { excludedTasks: ["all documentation"] }; }],
    ["replacement target", (input: RuleProposalInput) => { input.relations = [{ kind: "supersedes", knowledgeId: "old", targetDigest: "a".repeat(64), reason: "Changed policy" }]; }],
    ["query include phrase", (input: RuleProposalInput) => { input.queryTerms = { include: ["无关任务"], exclude: [] }; }],
    ["query exclusion phrase", (input: RuleProposalInput) => { input.queryTerms = { include: [], exclude: ["全部任务"] }; }],
    ["source quotation", (input: RuleProposalInput) => { input.userSource = { eventId: "user", quote: "Always write in English." }; }],
    ["support quotation", (input: RuleProposalInput) => { input.supportingSources = [{ eventId: "tool", quote: "A different source." }]; }],
    ["retention", (input: RuleProposalInput) => { if (input.retention) input.retention.kind = "reference"; }],
    ["repository", (input: RuleProposalInput) => { if (input.retention) input.retention.targetRepository.repoId = "other"; }],
    ["future use", (input: RuleProposalInput) => { if (input.retention) input.retention.futureUse = "Any future task in any workspace."; }],
    ["operation reference", (input: RuleProposalInput) => { input.failedOperationEventId = "invented-operation"; }],
    ["recovery predicate", (input: RuleProposalInput) => { input.predicate = { kind: "required_argument", serverName: "server", toolName: "read", argument: "path", contractDigest: sha256("contract") }; }],
  ] as const)("rejects later edits to %s", (_name, mutate) => {
    const input = accepted();
    mutate(input);
    expect(hasAcceptedLearningDistillation(input, sourceDigests)).toBe(false);
  });

  it("binds agent findings, their quoted evidence and every full-window digest", () => {
    const input = proposal();
    delete input.userSource;
    input.agentSource = { kind: "research", eventId: "agent", quote: "API examples consistently use English.",
      evidenceSources: [{ eventId: "tool", quote: "Repository API examples must use English." }] };
    const sources = [...sourceDigests, { eventId: "agent", digest: sha256("full agent finding") }];
    input.distillation = createLearningDistillation(input, sources, review, reviewer, reviewedAt);
    expect(hasAcceptedLearningDistillation(input, sources)).toBe(true);
    expect(hasAcceptedLearningDistillation(input, sources.slice(1))).toBe(false);
    expect(hasAcceptedLearningDistillation(input, sources.map((source, index) => index === 0 ? { ...source, digest: sha256("omitted exception changed") } : source))).toBe(false);
    input.agentSource.evidenceSources[0] = { eventId: "tool", quote: "All outputs must use English." };
    expect(hasAcceptedLearningDistillation(input, sources)).toBe(false);
  });

  it.each([
    ["criteria", (value: LearningDistillation) => { value.criteria.supported = false; }],
    ["rationale", (value: LearningDistillation) => { value.rationale = "The model now reports a different reason."; }],
    ["reviewer", (value: LearningDistillation) => { value.reviewer.model = "different-model"; }],
    ["review time", (value: LearningDistillation) => { value.reviewedAt = "2026-09-12T08:00:00.000Z"; }],
    ["reviewer whitespace", (value: LearningDistillation) => { value.reviewer.model += " "; }],
    ["input digest", (value: LearningDistillation) => { value.inputDigest = sha256("different input"); }],
    ["review digest", (value: LearningDistillation) => { value.reviewDigest = sha256("different review"); }],
  ] as const)("detects later edits to %s metadata", (_name, mutate) => {
    const input = accepted();
    mutate(input.distillation);
    expect(hasAcceptedLearningDistillation(input, sourceDigests)).toBe(false);
  });

  it("cannot turn a rejected review into an accepted one by editing the decision", () => {
    const input = proposal();
    input.distillation = createLearningDistillation(input, sourceDigests, { ...review, criteria: { ...criteria, supported: false } }, reviewer, reviewedAt);
    input.distillation.criteria.supported = true;
    expect(hasAcceptedLearningDistillation(input, sourceDigests)).toBe(false);
  });

  it("rejects empty, duplicate, malformed or missing source digests", () => {
    const input = accepted();
    for (const sources of [[], [sourceDigests[0], sourceDigests[0]], [{ eventId: "user", digest: "invalid" }]]) {
      const valid = sources.filter((source): source is { eventId: string; digest: string } => source !== undefined);
      expect(hasAcceptedLearningDistillation(input, valid)).toBe(false);
      expect(() => createLearningDistillation(input, valid, review, reviewer, reviewedAt)).toThrow("valid captured source digests");
    }
  });

  it("does not let the model supply binding, review identity, novelty or authority fields", () => {
    for (const extra of [{ inputDigest: sha256("invented") }, { reviewedAt }, { reviewer },
      { comparisonBasis: "all_project_instructions" }, { userConfirmed: true }, { evidenceTier: "externally_verified" }]) {
      expect(learningDistillationReviewSchema.safeParse({ ...review, ...extra }).success).toBe(false);
    }
    expect(learningDistillationSchema.safeParse({ ...accepted().distillation, comparisonBasis: "all_knowledge" }).success).toBe(false);
    expect(learningDistillationReviewSchema.safeParse({ ...review, criteria: { supported: true } }).success).toBe(false);
    expect(learningDistillationReviewSchema.safeParse({ ...review, rationale: "x".repeat(513) }).success).toBe(false);
  });

  it("hashes only reviewed content and provenance, excluding its own assessment", () => {
    const input = proposal();
    const original = learningDistillationInputDigest(input, sourceDigests);
    input.distillation = createLearningDistillation(input, sourceDigests, review, reviewer, reviewedAt);
    expect(learningDistillationInputDigest(input, sourceDigests)).toBe(original);
    const restored = JSON.parse(JSON.stringify(input)) as RuleProposalInput;
    expect(hasAcceptedLearningDistillation(restored, sourceDigests)).toBe(true);
  });

  it("accounts for rejected discoveries with bounded review summaries", () => {
    const summary = { proposed: 2, accepted: 0, rejected: 2, reasons: ["One claim is unsupported.", "One item repeats a task summary."] };
    expect(learningDistillationSummarySchema.parse(summary)).toEqual(summary);
    expect(learningDistillationSummarySchema.safeParse({ ...summary, accepted: 1 }).success).toBe(false);
    expect(learningDistillationSummarySchema.safeParse({ ...summary, proposed: 4, rejected: 4 }).success).toBe(false);
    expect(learningDistillationSummarySchema.safeParse({ ...summary, reasons: ["x".repeat(513)] }).success).toBe(false);
  });
});
