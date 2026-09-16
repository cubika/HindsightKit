import {
  CURRENT_SCHEMA_VERSION,
  discoveryMetadataSchema,
  feedbackEventSchema,
  knowledgeCandidateSchema,
  type CaptureEnvelope,
  type ExperiencePurpose,
  type DiscoveryMetadata,
  type DiscoveryProfile,
  type FeedbackEvent,
  type KnowledgeCandidate,
  type RuleProposal,
  type Scope,
  type SourceReference,
} from "@provenloop/contracts";
import {
  buildDiscoveryProfile,
  containsPotentialSecret,
  directKnowledgeCounterevidence,
  hasAcceptedLearningDistillation,
  knowledgeEvidenceState,
  redactPotentialSecrets,
  sha256,
  validateDiscoveryMetadata,
  validateDiscoveryProfile,
} from "@provenloop/domain";

export interface KnowledgeControlStore {
  discoveryProfiles?(candidates: readonly KnowledgeCandidate[]): ReadonlyMap<string, DiscoveryProfile>;
  feedbackEvents?(targetId?: string): readonly FeedbackEvent[];
  knowledgeCandidates(
    ids?: readonly string[],
  ): readonly KnowledgeCandidate[];
  knowledgeAdmissionEvidence?(
    candidates: readonly KnowledgeCandidate[],
  ): { readonly envelopes: readonly CaptureEnvelope[]; readonly learningProposals?: readonly RuleProposal[] };
  recordKnowledgeFeedback(input: {
    readonly event: FeedbackEvent;
    readonly updateCandidate?: (
      candidate: KnowledgeCandidate,
    ) => KnowledgeCandidate;
  }): {
    readonly candidate: KnowledgeCandidate;
    readonly recorded: boolean;
  };
  upsertKnowledgeCandidates(
    candidates: readonly KnowledgeCandidate[],
  ): number;
  replaceKnowledgeWithConfirmedRule?(input: {
    readonly scopeChange?: { readonly previousScope: Scope; readonly previousScopeId?: string; readonly scope: Scope; readonly scopeId?: string };
    readonly previousKnowledgeId: string;
    readonly expectedDigest: string;
    readonly candidate: KnowledgeCandidate;
    readonly event: FeedbackEvent;
  }): {
    readonly candidate: KnowledgeCandidate;
    readonly recorded: boolean;
  };
}

export interface KnowledgeControlProjection {
  acquireLease(): Promise<{
    release(): Promise<void>;
  }>;
  rebuild(): Promise<void>;
}

export interface RememberKnowledgeInput {
  readonly appliesWhen: readonly string[];
  readonly content: string;
  readonly kind?: KnowledgeCandidate["kind"];
  readonly nonApplicability?: readonly string[];
  readonly scope: Scope;
  readonly scopeId?: string;
  readonly purposes?: readonly ExperiencePurpose[];
  readonly topics?: readonly string[];
  readonly sourceReferences?: readonly (Pick<SourceReference, "kind" | "locator"> &
    Partial<Pick<SourceReference, "repositoryId" | "anchor" | "relationship">>)[];
}

export interface KnowledgeControlResult {
  readonly candidate?: KnowledgeCandidate;
  readonly changed: boolean;
  readonly feedbackId?: string;
}

export interface KnowledgeControlServiceOptions {
  readonly now?: () => Date;
  readonly projection: KnowledgeControlProjection;
  readonly store: KnowledgeControlStore;
  readonly workflowScopeId?: string;
}

export interface KnowledgeReviewScope {
  readonly scope: Scope;
  readonly scopeId?: string;
}

export interface KnowledgeReview {
  readonly candidate: KnowledgeCandidate;
  readonly discoveryProfile?: DiscoveryProfile;
  readonly expectedDigest: string;
  readonly contradictoryKnowledgeIds: readonly string[];
  readonly feedback: readonly FeedbackEvent[];
  readonly unresolvedEvidenceIds: readonly string[];
}

const normalizedStrings = (
  values: readonly string[],
): readonly string[] =>
  [...new Set(
    values
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  )];

type DiscoveryInput = Pick<RememberKnowledgeInput, "purposes" | "topics" | "sourceReferences">;

const normalizeDiscovery = (
  semantic: { content: string; appliesWhen: readonly string[]; nonApplicability: readonly string[] },
  input: DiscoveryInput,
  previous?: DiscoveryMetadata,
): DiscoveryMetadata | undefined => {
  const purposes = [...new Set(input.purposes ?? [])].sort();
  const topics = normalizedStrings(input.topics ?? []).toSorted();
  if ((input.purposes?.length ?? 0) > 2 || (input.topics?.length ?? 0) > 8 ||
      (input.sourceReferences?.length ?? 0) > 16 || input.topics?.some((topic) => !topic.trim())) {
    throw new Error("Discovery fields exceed their limits or contain an empty topic.");
  }
  const sourceReferences = (input.sourceReferences ?? []).map((reference) => {
    const locator = reference.locator.trim();
    const anchor = reference.anchor?.trim();
    const repositoryId = reference.repositoryId?.trim();
    const navigation = {
      kind: reference.kind, locator,
      ...(anchor === undefined ? {} : { anchor }),
      ...(repositoryId === undefined ? {} : { repositoryId }),
      relationship: reference.relationship ?? (reference.kind === "directory" ? "investigation_start" as const : "background" as const),
    };
    return { ...navigation, sourceRefId: `source-${sha256(navigation).slice(0, 24)}`,
      availability: "pointer_only" as const, evidenceIds: [] };
  }).sort((left, right) => left.sourceRefId.localeCompare(right.sourceRefId));
  const discovery = previous || purposes.length || topics.length || sourceReferences.length
    ? discoveryMetadataSchema.parse({
      ...previous, producer: "user",
      ...(input.purposes !== undefined ? { purposes: purposes.map((value) => ({ value, basisIds: ["content:0"], polarity: "positive" })) } : {}),
      ...(input.topics !== undefined ? { topics: topics.map((value) => ({ value, basisIds: ["content:0"], polarity: "positive" })) } : {}),
      ...(input.sourceReferences !== undefined ? { sourceReferences: [...new Map(sourceReferences.map((reference) => [reference.sourceRefId, reference])).values()] } : {}),
    }) : undefined;
  if (discovery && !validateDiscoveryMetadata({ ...semantic, appliesWhen: [...semantic.appliesWhen], nonApplicability: [...semantic.nonApplicability] }, discovery)) {
    throw new Error("Discovery metadata must use known topics and preserve the lesson's conditions.");
  }
  if ([...topics, ...sourceReferences.flatMap((reference) => [reference.locator, reference.anchor ?? "", reference.repositoryId ?? ""])]
    .some(containsPotentialSecret) || sourceReferences.some((reference) => {
      if (reference.kind !== "url") return false;
      const url = new URL(reference.locator);
      return Boolean(url.username || url.password) || [...url.searchParams].some(([key, value]) => containsPotentialSecret(`${key}=${value}`));
    })) throw new Error("Discovery metadata may contain a secret.");
  return discovery;
};

const validateScope = (
  scope: Scope,
  scopeId: string | undefined,
): string | undefined => {
  const normalizedScopeId = scopeId?.trim();
  if (scope === "personal") {
    if (normalizedScopeId !== undefined) {
      throw new Error(
        "Personal Knowledge cannot have a scope ID.",
      );
    }
    return undefined;
  }
  if (normalizedScopeId === undefined || normalizedScopeId.length === 0) {
    throw new Error(
      `${scope} Knowledge requires a scope ID.`,
    );
  }
  return normalizedScopeId;
};

export class KnowledgeControlService {
  readonly #now: () => Date;
  readonly #projection: KnowledgeControlProjection;
  readonly #store: KnowledgeControlStore;
  readonly #workflowScopeId: string | undefined;

  public constructor(options: KnowledgeControlServiceOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#projection = options.projection;
    this.#store = options.store;
    this.#workflowScopeId = options.workflowScopeId;
  }

  public list(
    input: KnowledgeReviewScope & {
      readonly state?: KnowledgeCandidate["state"];
    },
  ): readonly KnowledgeReview[] {
    const scopeId = validateScope(input.scope, input.scopeId);
    const reviewApplicability = (candidate: KnowledgeCandidate): readonly string[] => {
      if (!candidate.knowledgeId.startsWith("learning-knowledge-")) return candidate.appliesWhen;
      const proposal = this.#store.knowledgeAdmissionEvidence?.([candidate]).learningProposals?.find((entry) =>
        entry.knowledgeId === candidate.knowledgeId && entry.sourceDigests.length === candidate.sourceEvidenceIds.length &&
        entry.sourceDigests.every((source) => candidate.sourceEvidenceIds.includes(source.eventId)));
      const digest = proposal?.predicate?.contractDigest;
      return digest === undefined ? candidate.appliesWhen : candidate.appliesWhen.map((value) => value.replaceAll(digest, "[tool contract digest]"));
    };
    const candidates = this.#store.knowledgeCandidates()
      .filter((candidate) =>
        candidate.scope === input.scope &&
        candidate.scopeId === scopeId &&
        (input.state === undefined || candidate.state === input.state) &&
        ![
          candidate.content,
          candidate.scopeId ?? "",
          ...reviewApplicability(candidate),
          ...candidate.nonApplicability,
        ].some(containsPotentialSecret),
      );
    const admission = candidates.length === 0 ? undefined : this.#store.knowledgeAdmissionEvidence?.(candidates);
    const enrichment = candidates.length === 0 ? undefined : this.#store.discoveryProfiles?.(candidates);
    const envelopes = admission?.envelopes ?? [];
    return candidates.map((candidate) => {
      const feedback = this.#store.feedbackEvents?.(candidate.knowledgeId) ?? [];
      const evidence = knowledgeEvidenceState({
        counters: directKnowledgeCounterevidence(
          envelopes,
          new Set(candidate.sourceEvidenceIds),
          candidate.createdAt,
        ),
        createdAt: candidate.createdAt,
        feedbackEvents: feedback,
        knowledgeId: candidate.knowledgeId,
      });
      const reviewed = admission?.learningProposals?.find((proposal) =>
        proposal.knowledgeId === candidate.knowledgeId && proposal.rule === candidate.content &&
        sha256([proposal.trigger]) === sha256(candidate.appliesWhen) && sha256(proposal.exclusions) === sha256(candidate.nonApplicability) &&
        sha256(proposal.discovery ?? null) === sha256(candidate.discovery ?? null) &&
        proposal.sourceDigests.length === candidate.sourceEvidenceIds.length &&
        proposal.sourceDigests.every((source) => candidate.sourceEvidenceIds.includes(source.eventId)) &&
        hasAcceptedLearningDistillation(proposal, proposal.sourceDigests));
      const overlay = enrichment?.get(candidate.knowledgeId);
      return {
        candidate,
        discoveryProfile: overlay && validateDiscoveryProfile(candidate, overlay) ? overlay : buildDiscoveryProfile(candidate, candidate.discovery, reviewed?.distillation ? {
          reviewedBy: reviewed.distillation.reviewer.provider + "/" + reviewed.distillation.reviewer.model,
          reviewVersion: reviewed.distillation.reviewer.version,
        } : {}),
        contradictoryKnowledgeIds: candidate.conflictsWith,
        expectedDigest: sha256(candidate),
        unresolvedEvidenceIds: evidence.unresolvedEvidenceIds,
        feedback: feedback
          .map((event) => ({
            ...event,
            ...(event.reason === undefined ? {} : {
              reason: redactPotentialSecrets(event.reason),
            }),
          })),
      };
    });
  }

  public review(
    input: KnowledgeReviewScope & { readonly knowledgeId: string },
  ): KnowledgeReview {
    const result = this.list(input).find((item) =>
      item.candidate.knowledgeId === input.knowledgeId.trim(),
    );
    if (result === undefined) {
      throw new Error("Knowledge is unavailable in the selected scope.");
    }
    return result;
  }

  public async resolve(
    input: KnowledgeReviewScope & {
      readonly replacementScope?: KnowledgeReviewScope;
      readonly knowledgeId: string;
      readonly expectedDigest: string;
      readonly userConfirmed: boolean;
      readonly content?: string;
      readonly appliesWhen?: readonly string[];
      readonly nonApplicability?: readonly string[];
      readonly reason?: string;
      readonly resolvesEvidenceIds?: readonly string[];
      readonly replacementDiscovery?: DiscoveryInput;
    },
  ): Promise<KnowledgeControlResult> {
    if (!input.userConfirmed) {
      throw new Error("Resolving Knowledge requires explicit user confirmation.");
    }
    const lease = await this.#projection.acquireLease();
    try {
      const review = this.review(input);
      const { candidate: previous, expectedDigest: currentDigest } = review;
      const expectedDigest = input.expectedDigest;
      const resolvesEvidenceIds = normalizedStrings(input.resolvesEvidenceIds ?? []).slice().sort();
      const content = (input.content ?? previous.content).trim();
      const appliesWhen = normalizedStrings(input.appliesWhen ?? previous.appliesWhen);
      const nonApplicability = normalizedStrings(
        input.nonApplicability ?? previous.nonApplicability,
      );
      const reason = input.reason?.trim();
      const targetScope = input.replacementScope ?? input;
      const targetScopeId = validateScope(targetScope.scope, targetScope.scopeId);
      const unchanged = content === previous.content && sha256(appliesWhen) === sha256(previous.appliesWhen) &&
        sha256(nonApplicability) === sha256(previous.nonApplicability) && targetScope.scope === previous.scope && targetScopeId === previous.scopeId;
      const discovery = input.replacementDiscovery === undefined
        ? unchanged ? previous.discovery : undefined
        : normalizeDiscovery({ content, appliesWhen, nonApplicability }, input.replacementDiscovery,
          unchanged && previous.discovery?.producer === "user" ? previous.discovery : undefined);
      if (
        content.length === 0 ||
        appliesWhen.length === 0 ||
        [content, ...appliesWhen, ...nonApplicability, reason ?? "", targetScopeId ?? ""]
          .some(containsPotentialSecret)
      ) {
        throw new Error("The confirmed rule needs non-empty, secret-free content and applicability.");
      }
      if (
        targetScope.scope === "workflow" &&
        this.#workflowScopeId !== targetScopeId
      ) {
        throw new Error("Workflow-scoped Knowledge requires a configured trusted workflow.");
      }
      const timestamp = this.#now().toISOString();
      const identity = {
        content,
        appliesWhen,
        nonApplicability,
        scope: targetScope.scope,
        scopeId: targetScopeId,
        previousKnowledgeId: previous.knowledgeId,
        expectedDigest,
        resolvesEvidenceIds,
        ...(discovery === undefined ? {} : { discovery }),
      };
      const knowledgeId = `manual-knowledge-${sha256(identity).slice(0, 24)}`;
      const candidate = knowledgeCandidateSchema.parse({
        ...previous,
        discovery,
        scope: targetScope.scope,
        scopeId: targetScopeId,
        content,
        appliesWhen,
        nonApplicability,
        conflictsWith: [],
        createdAt: timestamp,
        evidenceMarks: ["user_confirmed"],
        evidenceTier: "user_confirmed",
        expiresAt: undefined,
        knowledgeId,
        sourceEpisodeIds: [],
        sourceEvidenceIds: [],
        state: "active",
        supersedes: previous.knowledgeId,
        topicKey: `manual:${sha256(identity).slice(0, 24)}`,
        utility: { applied: 0, helpful: 0, harmful: 0 },
        coverage: { applicableOpportunities: 0, observedOutcomes: 0 },
        validatedAt: timestamp,
      });
      const existing = this.#store.knowledgeCandidates([knowledgeId])[0];
      if (existing?.supersedes === previous.knowledgeId) {
        await this.#projection.rebuild();
        return { candidate: existing, changed: false };
      }
      if (currentDigest !== expectedDigest) {
        throw new Error("Knowledge changed after review. Review it again before confirming.");
      }
      if (
        review.unresolvedEvidenceIds.some((id) => !resolvesEvidenceIds.includes(id)) ||
        resolvesEvidenceIds.some((id) => !review.unresolvedEvidenceIds.includes(id)) ||
        (previous.state === "disputed" && review.unresolvedEvidenceIds.length === 0)
      ) {
        throw new Error("Review and explicitly resolve the current counterevidence IDs before confirming.");
      }
      const feedbackId = `feedback-${sha256(identity).slice(0, 24)}`;
      const event = feedbackEventSchema.parse({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        evidenceRef: `control:${feedbackId}`,
        feedbackId,
        kind: "confirm",
        resolvesEvidenceIds,
        ...(reason ? { reason } : {}),
        source: "user",
        targetId: previous.knowledgeId,
        targetType: "knowledge",
        timestamp,
      });
      if (this.#store.replaceKnowledgeWithConfirmedRule === undefined) {
        throw new Error("Atomic Knowledge resolution is unavailable in this store.");
      }
      const result = this.#store.replaceKnowledgeWithConfirmedRule({
        ...(input.replacementScope ? { scopeChange: { previousScope: previous.scope, ...(previous.scopeId === undefined ? {} : { previousScopeId: previous.scopeId }), scope: targetScope.scope, ...(targetScopeId === undefined ? {} : { scopeId: targetScopeId }) } } : {}),
        candidate,
        event,
        expectedDigest,
        previousKnowledgeId: previous.knowledgeId,
      });
      await this.#projection.rebuild();
      return {
        candidate: result.candidate,
        changed: result.recorded,
        feedbackId,
      };
    } finally {
      await lease.release();
    }
  }

  public async revoke(
    input: KnowledgeReviewScope & {
      readonly knowledgeId: string;
      readonly expectedDigest: string;
      readonly userConfirmed: boolean;
      readonly reason?: string;
    },
  ): Promise<KnowledgeControlResult> {
    if (!input.userConfirmed) {
      throw new Error("Revoking Knowledge requires explicit user confirmation.");
    }
    const reason = input.reason?.trim();
    if (reason !== undefined && containsPotentialSecret(reason)) {
      throw new Error("Revoke rejected a reason that may contain a secret.");
    }
    const lease = await this.#projection.acquireLease();
    try {
      const review = this.review(input);
      if (review.candidate.state === "archived") {
        await this.#projection.rebuild();
        return { candidate: review.candidate, changed: false };
      }
      if (review.expectedDigest !== input.expectedDigest) {
        throw new Error("Knowledge changed after review. Review it again before revoking.");
      }
      const timestamp = this.#now().toISOString();
      const feedbackId = `feedback-${sha256({
        action: "revoke",
        knowledgeId: input.knowledgeId,
        expectedDigest: input.expectedDigest,
      }).slice(0, 24)}`;
      const result = this.#store.recordKnowledgeFeedback({
        event: feedbackEventSchema.parse({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          evidenceRef: `control:${feedbackId}`,
          feedbackId,
          kind: "revoke",
          ...(reason ? { reason } : {}),
          source: "user",
          targetId: input.knowledgeId,
          targetType: "knowledge",
          timestamp,
        }),
        updateCandidate: (candidate) => {
          if (sha256(candidate) !== input.expectedDigest) {
            throw new Error("Knowledge changed while revoking it.");
          }
          return { ...candidate, state: "archived", validatedAt: timestamp };
        },
      });
      await this.#projection.rebuild();
      return {
        candidate: result.candidate,
        changed: result.recorded,
        feedbackId,
      };
    } finally {
      await lease.release();
    }
  }

  public async remember(
    input: RememberKnowledgeInput,
  ): Promise<KnowledgeControlResult> {
    const content = input.content.trim();
    const appliesWhen = normalizedStrings(input.appliesWhen);
    const nonApplicability = normalizedStrings(
      input.nonApplicability ?? [],
    );
    if (content.length === 0 || appliesWhen.length === 0) {
      throw new Error(
        "Remember requires non-empty content and applicability.",
      );
    }
    const scopeId = validateScope(input.scope, input.scopeId);
    const discovery = normalizeDiscovery({ content, appliesWhen, nonApplicability }, input);
    if (
      [
        content,
        ...appliesWhen,
        ...nonApplicability,
        ...(scopeId === undefined ? [] : [scopeId]),
      ].some(containsPotentialSecret)
    ) {
      throw new Error(
        "Remember rejected content that may contain a secret.",
      );
    }
    if (
      input.scope === "workflow" &&
      this.#workflowScopeId !== scopeId
    ) {
      throw new Error("Workflow-scoped Knowledge requires a configured trusted workflow.");
    }
    const now = this.#now().toISOString();
    const identity = {
      appliesWhen,
      content,
      kind: input.kind ?? "procedural",
      nonApplicability,
      scope: input.scope,
      scopeId,
      ...(discovery === undefined ? {} : { discovery }),
    };
    const candidate = knowledgeCandidateSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appliesWhen,
      conflictsWith: [],
      content,
      ...(discovery === undefined ? {} : { discovery }),
      coverage: {
        applicableOpportunities: 0,
        observedOutcomes: 0,
      },
      createdAt: now,
      evidenceMarks: [
        "user_confirmed",
      ],
      evidenceTier: "user_confirmed",
      importance: 1,
      kind: identity.kind,
      knowledgeId:
        `manual-knowledge-${sha256(identity).slice(0, 24)}`,
      nonApplicability,
      scope: input.scope,
      ...(scopeId === undefined ? {} : { scopeId }),
      sourceEpisodeIds: [],
      sourceEvidenceIds: [],
      state: "active",
      topicKey:
        `manual:${sha256({
          content,
          scope: input.scope,
          scopeId,
        }).slice(0, 24)}`,
      utility: {
        applied: 0,
        harmful: 0,
        helpful: 0,
      },
      validatedAt: now,
    });
    const lease = await this.#projection.acquireLease();
    try {
      const existing = this.#store.knowledgeCandidates([
        candidate.knowledgeId,
      ])[0];
      if (existing === undefined) {
        this.#store.upsertKnowledgeCandidates([
          candidate,
        ]);
      }
      await this.#projection.rebuild();
      return {
        candidate: existing ?? candidate,
        changed: existing === undefined,
      };
    } finally {
      await lease.release();
    }
  }

  public async correct(input: {
    readonly knowledgeId: string;
    readonly reason?: string;
  }): Promise<KnowledgeControlResult> {
    const knowledgeId = input.knowledgeId.trim();
    if (knowledgeId.length === 0) {
      throw new Error(
        "Correct requires a Knowledge ID.",
      );
    }
    const reason = input.reason?.trim();
    if (
      reason !== undefined &&
      containsPotentialSecret(reason)
    ) {
      throw new Error(
        "Correct rejected a reason that may contain a secret.",
      );
    }
    const lease = await this.#projection.acquireLease();
    try {
      const current = this.#store.knowledgeCandidates([
        knowledgeId,
      ])[0];
      if (current === undefined) {
        throw new Error(
          `Knowledge ${knowledgeId} does not exist.`,
        );
      }
      if (
        current.state === "disputed" &&
        current.evidenceTier === "disputed"
      ) {
        await this.#projection.rebuild();
        return {
          candidate: current,
          changed: false,
        };
      }
      const timestamp = this.#now().toISOString();
      const feedbackId =
        `feedback-${sha256({
          action: "correct",
          knowledgeId,
          preimage: sha256(current),
          reason,
        }).slice(0, 24)}`;
      const event = feedbackEventSchema.parse({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        evidenceRef: `control:${feedbackId}`,
        feedbackId,
        kind: "correct",
        ...(reason === undefined || reason.length === 0
          ? {}
          : {
              reason,
            }),
        source: "user",
        targetId: knowledgeId,
        targetType: "knowledge",
        timestamp,
      });
      const result = this.#store.recordKnowledgeFeedback({
        event,
        updateCandidate: (candidate) =>
          knowledgeCandidateSchema.parse({
            ...candidate,
            evidenceTier: "disputed",
            state: "disputed",
            validatedAt: timestamp,
          }),
      });
      await this.#projection.rebuild();
      return {
        candidate: result.candidate,
        changed: result.recorded,
        feedbackId,
      };
    } finally {
      await lease.release();
    }
  }

  public async mute(input: {
    readonly knowledgeId: string;
    readonly sessionId: string;
  }): Promise<KnowledgeControlResult> {
    const knowledgeId = input.knowledgeId.trim();
    const sessionId = input.sessionId.trim();
    if (knowledgeId.length === 0 || sessionId.length === 0) {
      throw new Error(
        "Mute requires Knowledge and Session IDs.",
      );
    }
    const event = feedbackEventSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      evidenceRef: sessionId,
      feedbackId:
        `feedback-${sha256({
          action: "mute_session",
          knowledgeId,
          sessionId,
        }).slice(0, 24)}`,
      kind: "mute_session",
      source: "user",
      targetId: knowledgeId,
      targetType: "knowledge",
      timestamp: this.#now().toISOString(),
    });
    const lease = await this.#projection.acquireLease();
    try {
      const result = this.#store.recordKnowledgeFeedback({
        event,
      });
      return {
        candidate: result.candidate,
        changed: result.recorded,
        feedbackId: event.feedbackId,
      };
    } finally {
      await lease.release();
    }
  }
}
