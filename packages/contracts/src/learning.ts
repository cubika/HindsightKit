import { z } from "zod";
import { captureEnvelopeSchema } from "./capture.js";
import { identifierSchema, isoTimestampSchema, sha256DigestSchema } from "./common.js";
import { discoveryMetadataSchema } from "./discovery.js";

const text = z.string().trim().min(1).max(2048);
export const learningComparisonCandidateSchema = z.object({
  knowledgeId: identifierSchema, targetDigest: sha256DigestSchema,
  rule: text, trigger: z.array(text).max(16), exclusions: z.array(text).max(16),
  canonicalKey: text.optional(), state: text.max(64), evidenceTier: text.max(64),
  mutable: z.boolean().optional(),
}).strict();
export type LearningComparisonCandidate = z.infer<typeof learningComparisonCandidateSchema>;
export const learningDistillationCriteriaSchema = z.object({
  supported: z.boolean(), scoped: z.boolean(), reusable: z.boolean(),
  actionable: z.boolean(), concise: z.boolean(), nonredundant: z.boolean(),
}).strict();
// A model assessment of the supplied material, not proof or user confirmation.
export const learningDistillationReviewSchema = z.object({
  criteria: learningDistillationCriteriaSchema, rationale: text.max(512),
}).strict();
export const learningDistillationSchema = learningDistillationReviewSchema.extend({
  schemaVersion: z.literal(1), inputDigest: sha256DigestSchema, reviewDigest: sha256DigestSchema,
  // Nonredundancy covers the supplied evidence and peer proposals only. It does
  // not establish novelty against all knowledge or current project instructions.
  comparisonBasis: z.literal("provided_material"),
  reviewer: z.object({ provider: text.max(256), model: text.max(256), version: text.max(256) }).strict(),
  reviewedAt: isoTimestampSchema,
}).strict();
export const learningDistillationSummarySchema = z.object({
  proposed: z.number().int().min(0).max(3), accepted: z.number().int().min(0).max(3),
  rejected: z.number().int().min(0).max(3), reasons: z.array(text.max(512)).max(3),
}).strict().superRefine((value, context) => {
  if (value.accepted + value.rejected !== value.proposed) {
    context.addIssue({ code: "custom", message: "Reviewed proposal counts must account for every proposed lesson." });
  }
});
export const learningSupportingSourceSchema = z.object({
  eventId: identifierSchema, quote: text,
}).strict();
export const learningRetentionSchema = z.object({
  kind: z.enum(["convention", "reference", "recovery"]),
  lifetime: z.enum(["durable", "task"]),
  rationale: text, futureUse: text,
  targetRepository: z.object({
    status: z.enum(["captured", "unresolved"]), repoId: identifierSchema.optional(),
  }).strict(),
}).strict();
export const agentLearningSourceSchema = z.object({
  kind: z.enum(["research", "recovery"]), eventId: identifierSchema, quote: text,
  evidenceSources: z.array(z.object({ eventId: identifierSchema, quote: text }).strict()).min(1).max(8),
}).strict();
export const learningSourceSchema = z.object({
  eventId: identifierSchema, digest: sha256DigestSchema,
}).strict();
export const learningWindowSchema = z.object({
  schemaVersion: z.literal(1), windowId: identifierSchema, revision: sha256DigestSchema,
  sessionId: identifierSchema, repoId: identifierSchema, worktree: text,
  createdAt: isoTimestampSchema, sources: z.array(learningSourceSchema).min(1).max(32),
  events: z.array(captureEnvelopeSchema).min(1).max(32),
  origin: z.literal("agent").optional(), anchorEventId: identifierSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.origin === "agent") !== (value.anchorEventId !== undefined)) {
    context.addIssue({ code: "custom", message: "Agent windows require an explicit anchor event." });
  }
});
export const learningPredicateSchema = z.object({
  kind: z.enum(["required_argument", "absolute_path"]),
  serverName: text, toolName: text, argument: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  contractDigest: sha256DigestSchema,
}).strict();
export const shellLearningPredicateSchema = z.object({
  kind: z.literal("repository_test_command"), toolName: z.enum(["powershell", "bash"]),
  failedCommand: text.max(256), command: text.max(256),
}).strict();
export const ruleProposalInputSchema = z.object({
  rule: text, trigger: text, exclusions: z.array(text).min(1).max(8),
  retrievalScope: z.object({ excludedTasks: z.array(z.string().trim().min(2).max(128)).max(8) }).strict().optional(),
  relations: z.array(z.object({
    kind: z.enum(["equivalent", "supersedes"]), knowledgeId: identifierSchema,
    targetDigest: sha256DigestSchema, reason: text.max(512),
  }).strict()).max(3).optional(),
  // Original-language search phrases only; final lesson prose remains English.
  queryTerms: z.object({
    include: z.array(z.string().trim().min(2).max(64)).max(8),
    exclude: z.array(z.string().trim().min(2).max(64)).max(8),
  }).strict().optional(),
  discovery: discoveryMetadataSchema.optional(),
  distillation: learningDistillationSchema.optional(),
  retention: learningRetentionSchema.optional(),
  supportingSources: z.array(learningSupportingSourceSchema).min(1).max(8).optional(),
  canonicalKey: z.string().trim().min(1).max(256).optional(),
  userSource: z.object({ eventId: identifierSchema, quote: text }).strict().optional(),
  agentSource: agentLearningSourceSchema.optional(),
  failedOperationEventId: identifierSchema.optional(), retryOperationEventId: identifierSchema.optional(),
  completionEventId: identifierSchema.optional(), predicate: learningPredicateSchema.optional(),
  shellPredicate: shellLearningPredicateSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.relations?.filter((relation) => relation.kind === "equivalent").length ?? 0) > 0 && value.relations?.length !== 1) {
    context.addIssue({ code: "custom", message: "Equivalence requires exactly one comparison target and no supersession relations." });
  }
  if ((value.userSource === undefined) === (value.agentSource === undefined)) {
    context.addIssue({ code: "custom", message: "A proposal must name exactly one user or agent source." });
  }
  if (value.agentSource?.kind === "research" && (value.predicate || value.shellPredicate)) {
    context.addIssue({ code: "custom", message: "Research findings cannot nominate an automatic recovery predicate." });
  }
  if ((value.predicate || value.shellPredicate) &&
      (!value.failedOperationEventId || !value.retryOperationEventId || !value.completionEventId)) {
    context.addIssue({ code: "custom", message: "Typed recovery requires failed, retry and completion operation references." });
  }
});
export const learningInferenceResponseSchema = z.object({
  schemaVersion: z.literal(1), proposals: z.array(ruleProposalInputSchema).max(3),
  distillation: learningDistillationSummarySchema.optional(),
}).strict();
export const learningJobSchema = z.object({
  schemaVersion: z.literal(1), jobId: identifierSchema, windowId: identifierSchema,
  revision: sha256DigestSchema, state: z.enum(["pending", "running", "evaluated", "waiting_evidence", "paused", "failed", "cancelled", "archived", "superseded"]),
  attempts: z.number().int().min(0).max(3), createdAt: isoTimestampSchema, updatedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema, deadline: isoTimestampSchema.optional(),
  retryAfter: isoTimestampSchema.optional(),
  pauseReason: z.enum(["signed_out", "rate_limited", "unavailable", "daily_budget", "host_stopped", "learning_disabled"]).optional(),
  provider: text.optional(), model: text.optional(), extractorVersion: text,
  result: z.enum(["no_rule", "candidate", "qualified", "error"]).optional(),
  distillation: learningDistillationSummarySchema.optional(),
  error: z.string().max(512).optional(),
  failureKind: z.literal("input_too_large").optional(),
  preflightFailures: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  inputBudgetRecovery: z.object({
    fromExtractorVersion: text,
    previousAttempts: z.number().int().min(0).max(3),
    grantedAt: isoTimestampSchema,
    retryDispatched: z.boolean(),
  }).strict().optional(),
}).strict();
export const ruleProposalSchema = ruleProposalInputSchema.safeExtend({
  schemaVersion: z.literal(1), proposalId: identifierSchema, jobId: identifierSchema,
  knowledgeId: identifierSchema, createdAt: isoTimestampSchema, expiresAt: isoTimestampSchema,
  sourceDigests: z.array(learningSourceSchema).min(1).max(32),
}).strict();
// This contract is supplied by a native adapter registry, never by model output.
export const learningToolContractSchema = z.object({
  schemaVersion: z.literal(1), serverName: text, toolName: text, version: text,
  sourceSchemaDigest: sha256DigestSchema,
  digest: sha256DigestSchema, requiredArguments: z.array(text).max(64),
  absolutePathArguments: z.array(text).max(64),
}).strict();
export const mcpRecoveryReceiptSchema = z.object({
  schemaVersion: z.literal(1), receiptId: identifierSchema, proposalId: identifierSchema,
  predicate: learningPredicateSchema, contract: learningToolContractSchema,
  failureEventId: identifierSchema, userEventId: identifierSchema.optional(), agentEventId: identifierSchema.optional(),
  failedOperationEventId: identifierSchema, retryOperationEventId: identifierSchema,
  completionEventId: identifierSchema, sourceDigests: z.array(learningSourceSchema).min(5).max(32),
  verifiedAt: isoTimestampSchema, proves: z.literal("invocation_contract"),
}).strict().superRefine((value, context) => {
  if ((value.userEventId === undefined) === (value.agentEventId === undefined)) {
    context.addIssue({ code: "custom", message: "A recovery receipt must preserve one source role." });
  }
});
export const shellRecoveryReceiptSchema = z.object({
  schemaVersion: z.literal(1), receiptId: identifierSchema, proposalId: identifierSchema,
  predicate: shellLearningPredicateSchema, proves: z.literal("repository_test_command"),
  failureEventId: identifierSchema, userEventId: identifierSchema.optional(), agentEventId: identifierSchema.optional(), failedOperationEventId: identifierSchema,
  retryOperationEventId: identifierSchema, completionEventId: identifierSchema, nativeVerificationEventId: identifierSchema,
  repoId: identifierSchema, worktree: text, branch: text, commitSha: sha256DigestSchema.or(z.string().regex(/^[a-f0-9]{40}$/u)),
  sourceDigests: z.array(learningSourceSchema).min(6).max(32), verifiedAt: isoTimestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.userEventId === undefined) === (value.agentEventId === undefined)) {
    context.addIssue({ code: "custom", message: "A recovery receipt must preserve one source role." });
  }
});
export const learningRecoveryReceiptSchema = z.discriminatedUnion("proves", [mcpRecoveryReceiptSchema, shellRecoveryReceiptSchema]);
export type LearningWindow = z.infer<typeof learningWindowSchema>;
export type LearningDistillationCriteria = z.infer<typeof learningDistillationCriteriaSchema>;
export type LearningDistillationReview = z.infer<typeof learningDistillationReviewSchema>;
export type LearningDistillation = z.infer<typeof learningDistillationSchema>;
export type LearningDistillationSummary = z.infer<typeof learningDistillationSummarySchema>;
export type LearningRetention = z.infer<typeof learningRetentionSchema>;
export type LearningJob = z.infer<typeof learningJobSchema>;
export type LearningPredicate = z.infer<typeof learningPredicateSchema>;
export type LearningToolContract = z.infer<typeof learningToolContractSchema>;
export type RuleProposalInput = z.infer<typeof ruleProposalInputSchema>;
export type RuleProposal = z.infer<typeof ruleProposalSchema>;
export type McpRecoveryReceipt = z.infer<typeof mcpRecoveryReceiptSchema>;
export type ShellLearningPredicate = z.infer<typeof shellLearningPredicateSchema>;
export type ShellRecoveryReceipt = z.infer<typeof shellRecoveryReceiptSchema>;
export type LearningRecoveryReceipt = z.infer<typeof learningRecoveryReceiptSchema>;
export type AgentLearningSource = z.infer<typeof agentLearningSourceSchema>;
export const learningProposalSource = (proposal: RuleProposalInput): { eventId: string; quote: string } => {
  const source = proposal.userSource ?? proposal.agentSource;
  if (!source) throw new Error("Learning proposal source is missing.");
  return source;
};
