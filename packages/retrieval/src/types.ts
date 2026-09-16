import type {
  BranchContext,
  CaptureEnvelope,
  ContextUseRecord,
  CorrectionKey,
  EvidenceTier,
  FeedbackEvent,
  KnowledgeCandidate,
  LearningRecoveryReceipt,
  RuleProposal,
  RepositoryState,
  Scope,
  WorkEpisode,
  DiscoveryProfile,
  ExperiencePurpose,
  SourceReference,
} from "@provenloop/contracts";
import type { DiscoveryRelevance } from "@provenloop/domain";

export interface KnowledgeProjection {
  readonly discoveryProfile?: DiscoveryProfile;
  readonly appliesWhen: readonly string[];
  readonly content: string;
  readonly knowledgeId: string;
  readonly nonApplicability: readonly string[];
  readonly projectionVersion: 1;
  readonly sourceDigest: string;
  readonly searchAliases?: readonly string[];
  readonly searchExclusions?: readonly string[];
  readonly retrievalMetadata?: {
    readonly scope: Scope;
    readonly scopeId?: string;
    readonly eligible: boolean;
    readonly expiresAt?: string;
    readonly discoveryVersion?: string;
  };
  readonly topicKey: string;
}

export interface KnowledgeRecord extends KnowledgeProjection {
  readonly score: number;
}

export interface KnowledgeQuery {
  readonly limit: number;
  readonly match?: "all" | "any";
  readonly offset?: number;
  readonly filter?: {
    readonly now: string;
    readonly scopes: readonly { readonly scope: Scope; readonly scopeId?: string }[];
  };
  readonly text: string;
}

export interface KnowledgeProjectionSnapshot {
  readonly records: readonly KnowledgeProjection[];
}

export interface KnowledgeBackendHealth {
  readonly fts5Available: boolean;
  readonly quickCheck: string;
  readonly recordCount: number;
  readonly status: "healthy" | "unhealthy";
}

export interface KnowledgeBackend {
  get(id: string): Promise<KnowledgeRecord | undefined>;
  health(): Promise<KnowledgeBackendHealth>;
  healthWithTimeout?(
    timeoutMs: number,
  ): Promise<KnowledgeBackendHealth>;
  index(records: readonly KnowledgeProjection[]): Promise<void>;
  rebuild(snapshot: KnowledgeProjectionSnapshot): Promise<void>;
  synchronize?(snapshot: KnowledgeProjectionSnapshot): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  search(query: KnowledgeQuery): Promise<readonly KnowledgeRecord[]>;
  searchWithTimeout?(
    query: KnowledgeQuery,
    timeoutMs: number,
  ): Promise<readonly KnowledgeRecord[]>;
}

export interface CanonicalKnowledgeStore {
  discoveryProfiles?(candidates: readonly KnowledgeCandidate[]): ReadonlyMap<string, DiscoveryProfile>;
  learningProposals?(knowledgeIds?: readonly string[]): readonly RuleProposal[];
  knowledgeCandidates(
    ids?: readonly string[],
  ): readonly KnowledgeCandidate[];
  knowledgeCandidatesWithUnavailableSources(
    candidates: readonly KnowledgeCandidate[],
  ): ReadonlySet<string>;
}

export interface KnowledgeAdmissionEvidence {
  readonly learningProposals?: readonly RuleProposal[];
  readonly learningReceipts?: readonly LearningRecoveryReceipt[];
  readonly contextUseRecords: readonly ContextUseRecord[];
  readonly correctionKeys: readonly CorrectionKey[];
  readonly correctionSourceEventIds: ReadonlySet<string>;
  readonly envelopes: readonly CaptureEnvelope[];
  readonly feedbackEvents: readonly FeedbackEvent[];
  readonly workEpisodes: readonly WorkEpisode[];
}

export interface CanonicalKnowledgeAdmissionStore
extends CanonicalKnowledgeStore {
  knowledgeAdmissionEvidence(
    candidates: readonly KnowledgeCandidate[],
  ): KnowledgeAdmissionEvidence;
}

export interface CanonicalContextStore
extends CanonicalKnowledgeAdmissionStore {
  contextUseRecord?(requestId: string): ContextUseRecord | undefined;
  appendContextUseRecord(record: ContextUseRecord): boolean;
  branchContextFor(input: {
    readonly branch: string;
    readonly headSha: string;
    readonly now?: Date;
    readonly repoId: string;
  }): BranchContext | undefined;
  branchContexts(): readonly BranchContext[];
  contextUseRecords(
    sessionId?: string,
  ): readonly ContextUseRecord[];
  episodeSourceEnvelopes(): readonly CaptureEnvelope[];
  feedbackEvents(targetId?: string): readonly FeedbackEvent[];
  recordContextFeedback?(input: {
    readonly contextRequestId: string;
    readonly event: FeedbackEvent;
    readonly updateContextUseRecord: (
      record: ContextUseRecord,
    ) => ContextUseRecord;
  }): { readonly recorded: boolean };
  recordKnowledgeFeedback(input: {
    readonly contextRequestId?: string;
    readonly event: FeedbackEvent;
    readonly updateCandidate?: (
      candidate: KnowledgeCandidate,
    ) => KnowledgeCandidate;
    readonly updateContextUseRecord?: (
      record: ContextUseRecord,
    ) => ContextUseRecord;
  }): {
    readonly candidate: KnowledgeCandidate;
    readonly recorded: boolean;
  };
  sessionMuted(sessionId: string): boolean;
  workEpisodes(): readonly WorkEpisode[];
}

export interface KnowledgeRetrievalQuery {
  readonly routes?: readonly { readonly route: "lexical" | "concept"; readonly text: string }[];
  readonly worktree?: string;
  readonly headSha?: string;
  readonly shellInvocation?: TrustedShellInvocation;
  readonly toolInvocation?: TrustedToolInvocation;
  readonly projectInstructions?: readonly string[];
  readonly branchScopeId?: string;
  readonly limit: number;
  readonly match?: "all" | "any";
  readonly now?: Date;
  readonly repositoryScopeId?: string;
  readonly text: string;
  readonly workflowScopeId?: string;
}

export interface RetrievedKnowledge {
  readonly displayApplicability?: readonly string[];
  readonly discoveryProfile?: DiscoveryProfile;
  readonly routeRanks?: Readonly<Partial<Record<"lexical" | "concept", number>>>;
  readonly candidate: KnowledgeCandidate;
  readonly retrievalScope?: RuleProposal["retrievalScope"];
  readonly searchAliases?: readonly string[];
  readonly searchExclusions?: readonly string[];
  readonly score: number;
  readonly deliveryMode?: "convention" | "reference";
  readonly sources?: readonly { eventId: string; quote: string; role: "user" | "tool" }[];
  readonly researchSummary?: string;
  readonly distilledLesson?: string;
  readonly reference?: ReferenceContextMetadata;
}

export interface ReferenceContextMetadata {
  readonly capturedCommitSha: string;
  readonly currentCommitSha: string;
  readonly revisionStatus: "unchanged" | "changed";
  readonly requiresRevalidation: true;
  readonly summaryTruncated?: true;
  readonly omittedSourceCount?: number;
  readonly applicabilityOmitted?: true;
}

export interface ContextRequest {
  readonly continuationEpisodeId?: string;
  readonly shellInvocation?: TrustedShellInvocation;
  readonly toolInvocation?: TrustedToolInvocation;
  readonly projectInstructions?: readonly string[];
  readonly branch?: string;
  readonly cwd: string;
  readonly fileHints?: readonly string[];
  readonly headSha?: string;
  readonly now?: Date;
  readonly prompt: string;
  readonly repoId?: string;
  readonly sessionId: string;
  readonly tokenBudget: number;
  readonly trustedWorkspace?: TrustedWorkspaceIdentity;
  readonly workflowScopeId?: string;
}

export interface ContextSearchRequest extends ContextRequest {
  readonly protocolVersion: 1;
  readonly alternateQueries?: readonly string[];
  readonly conceptHints?: readonly string[];
  readonly entityHints?: readonly string[];
  readonly purposes?: readonly ExperiencePurpose[];
  readonly topics?: readonly string[];
  readonly limit?: number;
}

export interface TrustedToolInvocation {
  readonly serverName: string;
  readonly toolName: string;
  readonly contractDigest: string;
}

export interface TrustedShellInvocation {
  readonly toolName: "powershell" | "bash";
  readonly command: string;
  readonly cwd: string;
  readonly branch: string;
  readonly commitSha: string;
}

export interface TrustedWorkspaceIdentity {
  readonly repositoryState: RepositoryState;
  readonly repositoryObservedAt: string;
  readonly repositoryId?: string;
  readonly branch?: string;
  readonly commitSha?: string;
}

export type ContextItemKind = "branch_context" | "knowledge";

export interface ContextItem {
  readonly relevance?: Pick<DiscoveryRelevance, "band" | "unresolvedConditions">;
  readonly classification?: { readonly purposes: readonly string[]; readonly topics: readonly string[] };
  readonly sourceReferences?: readonly SourceReference[];
  readonly deliveryMode?: "convention" | "reference";
  readonly sources?: readonly { eventId: string; quote: string; role: "user" | "tool"; truncated?: true }[];
  readonly reference?: ReferenceContextMetadata;
  readonly applicabilitySummary: string;
  readonly evidenceTier?: EvidenceTier;
  readonly explanationRef: string;
  readonly guidance: string;
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly rank: number;
  readonly scope: Scope;
  readonly scopeId?: string;
}

export interface ContextResponse {
  readonly retrievalMode?: "context" | "search";
  readonly moreAvailable?: boolean;
  readonly truncatedByBudget?: boolean;
  readonly items: readonly ContextItem[];
  readonly latencyMs: number;
  readonly renderedTokens: number;
  readonly requestId: string;
  readonly status:
    | "degraded"
    | "muted"
    | "ok";
  readonly statusDetail?: string;
}

export interface ExplainRequest {
  readonly explanationRef: string;
  readonly sessionId: string;
}

export interface ContextExplanation {
  readonly applicability?: Readonly<Record<string, unknown>>;
  readonly contradictoryEvidence?: readonly Readonly<
    Record<string, unknown>
  >[];
  readonly currentState?: string;
  readonly evidenceTier?: EvidenceTier;
  readonly explanationRef: string;
  readonly id?: string;
  readonly kind?: ContextItemKind;
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly unresolvedEvidenceIds?: readonly string[];
  readonly status:
    | "available"
    | "not_found"
    | "not_previously_retrieved";
}

export type ContextFeedbackAction =
  | "confirm"
  | "helpful"
  | "irrelevant"
  | "mute_session"
  | "revoke"
  | "set_scope"
  | "stale"
  | "wrong";

export interface ContextFeedbackRequest {
  readonly action: ContextFeedbackAction;
  readonly branchScopeId?: string;
  readonly cwd?: string;
  readonly evidenceRef?: string;
  readonly reason?: string;
  readonly repositoryScopeId?: string;
  readonly requestId: string;
  readonly resolvesEvidenceIds?: readonly string[];
  readonly scope?: Scope;
  readonly sessionId: string;
  readonly source?: FeedbackEvent["source"];
  readonly targetId: string;
  readonly targetKind?: ContextItemKind;
  readonly trustedWorkspace?: TrustedWorkspaceIdentity;
  readonly userReportedApplied?: boolean;
  readonly workflowScopeId?: string;
}

export interface ContextFeedbackResponse {
  readonly adoption?: "user_reported" | "not_reported";
  readonly outcome?: "unknown";
  readonly candidate?: KnowledgeCandidate;
  readonly feedbackId?: string;
  readonly projectionStatus?: "degraded" | "synchronized";
  readonly recordedKind?: FeedbackEvent["kind"];
  readonly status:
    | "already_recorded"
    | "not_found"
    | "not_previously_retrieved"
    | "recorded";
  readonly statusDetail?: string;
}

export const AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS =
  new Set<EvidenceTier>([
    "externally_verified",
    "locked_preference",
    "repeated_evidence",
    "user_confirmed",
  ]);

export const branchScopeIdFor = (
  repositoryScopeId: string,
  branchScopeId: string,
): string => JSON.stringify([
  repositoryScopeId,
  branchScopeId,
]);

export const scopeMatches = (
  scope: Scope,
  scopeId: string | undefined,
  query: KnowledgeRetrievalQuery,
): boolean => {
  switch (scope) {
    case "personal":
      return true;
    case "workflow":
      return scopeId !== undefined &&
        scopeId === query.workflowScopeId;
    case "repository":
      return scopeId !== undefined &&
        scopeId === query.repositoryScopeId;
    case "branch":
      return scopeId !== undefined &&
        query.repositoryScopeId !== undefined &&
        query.branchScopeId !== undefined &&
        scopeId === branchScopeIdFor(
          query.repositoryScopeId,
          query.branchScopeId,
        );
  }
};
