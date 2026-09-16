export {
  BranchContextBuilder,
  type BranchContextBuilderOptions,
} from "./branch-context-builder.js";
export {
  CommitAncestryIndex,
  commitAncestryEdgesFromEnvelopes,
  type CommitAncestryEdge,
  type CommitAncestryQuery,
  type CommitAncestryResolver,
} from "./commit-ancestry.js";
export {
  createCaptureDeduplicationKey,
  createCaptureEnvelope,
  InternalCaptureEventError,
  InvalidCaptureIdentityError,
  isProvenLoopInternalEnvironment,
  redactCaptureEnvelopeForPersistence,
  type CaptureEventInput,
  type CaptureIdentityInput,
  type CreateCaptureEnvelopeOptions,
  type RedactedCaptureEnvelopeResult,
} from "./capture.js";
export {
  CorrectionCaptureBuilder,
  correctionKeyActivationEligible,
  formatExplicitCorrectionMessage,
  isExplicitCorrectionMessage,
  type CorrectionCaptureBuildInput,
  type CorrectionCaptureBuildResult,
  type CorrectionCaptureIssue,
  type CorrectionCaptureIssueCode,
  type ExplicitCorrectionFields,
} from "./correction-capture-builder.js";
export {
  deletionIdentityDigest,
  sha256,
  stableJson,
} from "./digest.js";
export {
  WorkEpisodeBuilder,
  type WorkEpisodeBuilderOptions,
  type WorkEpisodeBuildResult,
} from "./episode-builder.js";
export { isInternalWorkSource } from "./work-source.js";
export {
  KnowledgeAdmissionPolicy,
  refreshKnowledgeAdmissionDecision,
  type KnowledgeAdmissionBatchInput,
  type KnowledgeAdmissionDecision,
  type KnowledgeAdmissionInput,
  type KnowledgeAdmissionReason,
} from "./knowledge-admission-policy.js";
export {
  KnowledgeLifecycleBuilder,
  correctionKnowledgeTopicKey,
  type KnowledgeLifecycleBuildInput,
  type KnowledgeLifecycleBuildResult,
  type KnowledgeLifecycleBuilderOptions,
} from "./knowledge-lifecycle-builder.js";
export {
  directKnowledgeCounterevidence,
  knowledgeEvidenceState,
  type KnowledgeEvidenceState,
} from "./knowledge-evidence.js";
export {
  boundVerificationOperation,
  verificationOutcome,
  verificationProofEventIds,
  type VerificationBinding,
  type VerificationOutcome,
} from "./verification-proof.js";
export {
  containsKnownSecret,
  containsPotentialSecret,
  DEFAULT_CAPTURE_REDACTION_LIMITS,
  redactCaptureMetadata,
  redactCaptureContent,
  redactKnownSecrets,
  redactPotentialSecrets,
  sanitizeDiagnostic,
  type CaptureContentInput,
  type CaptureRedactionLimits,
  type RedactedCaptureMetadata,
  type RedactedCaptureContent,
} from "./redaction.js";

export * from "./automatic-learning.js";
export * from "./learning-retention.js";
export * from "./learning-distillation.js";
export * from "./agent-learning-source.js";
export * from "./agent-research-window.js";

export * from "./shell-learning.js";
export * from "./learning-source-use.js";
export * from "./knowledge-duplicates.js";
export * from "./discovery.js";
