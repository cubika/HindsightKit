import {
  captureEnvelopeSchema,
  contextUseRecordSchema,
  correctionKeySchema,
  correctionOpportunitySchema,
  CURRENT_SCHEMA_VERSION,
  feedbackEventSchema,
  knowledgeCandidateSchema,
  workEpisodeSchema,
  type CaptureEnvelope,
  type ContextUseRecord,
  type CorrectionKey,
  type CorrectionOpportunity,
  type EvidenceMark,
  type EvidenceTier,
  type FeedbackEvent,
  type KnowledgeCandidate,
  type WorkEpisode,
} from "@provenloop/contracts";

import { sha256 } from "./digest.js";
import {
  directKnowledgeCounterevidence,
  knowledgeEvidenceState,
} from "./knowledge-evidence.js";
import {
  boundVerificationOperation,
  independentlyVerifiedCorrections,
  verificationBinding,
  verificationOutcome,
  verificationProofEventIds,
} from "./verification-proof.js";
import {
  KnowledgeAdmissionPolicy,
  refreshKnowledgeAdmissionDecision,
  type KnowledgeAdmissionDecision,
} from "./knowledge-admission-policy.js";

export interface KnowledgeLifecycleBuildInput {
  readonly contextUseRecords?: readonly ContextUseRecord[];
  readonly correctionKeys: readonly CorrectionKey[];
  readonly correctionOpportunities: readonly CorrectionOpportunity[];
  readonly envelopes: readonly CaptureEnvelope[];
  readonly feedbackEvents: readonly FeedbackEvent[];
  readonly workEpisodes: readonly WorkEpisode[];
}

export interface KnowledgeLifecycleBuildResult {
  readonly admissionDecisions: readonly KnowledgeAdmissionDecision[];
  readonly candidates: readonly KnowledgeCandidate[];
}

export interface KnowledgeLifecycleBuilderOptions {
  readonly admissionPolicy?: KnowledgeAdmissionPolicy;
}

interface KnowledgeVersion {
  readonly candidateId: string;
  readonly correctionKeys: readonly CorrectionKey[];
  readonly expectedBehavior: string;
  readonly topicKey: string;
}

const normalizeDisplay = (value: string): string =>
  value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();

const normalizeIdentity = (value: string): string =>
  normalizeDisplay(value).toLocaleLowerCase("en-US");

const sortedUnique = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort();

const byTimestampAndId = (
  left: FeedbackEvent,
  right: FeedbackEvent,
): number =>
  Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
  left.feedbackId.localeCompare(right.feedbackId);

const latestTimestamp = (
  timestamps: readonly string[],
): string | undefined =>
  [...timestamps].sort(
    (left, right) =>
      Date.parse(left) - Date.parse(right) ||
      left.localeCompare(right),
  ).at(-1);

const earliestTimestamp = (
  timestamps: readonly string[],
): string | undefined =>
  [...timestamps].sort(
    (left, right) =>
      Date.parse(left) - Date.parse(right) ||
      left.localeCompare(right),
  )[0];

export const correctionKnowledgeTopicKey = (
  key: CorrectionKey,
): string =>
  `correction:${sha256({
    scope: key.scope,
    scopeId: key.scopeId,
    subsystem:
      key.subsystem === undefined
        ? undefined
        : normalizeIdentity(key.subsystem),
    taskFamily:
      key.taskFamily === undefined
        ? undefined
        : normalizeIdentity(key.taskFamily),
    trigger: normalizeIdentity(key.trigger),
    violatedConstraint: normalizeIdentity(key.violatedConstraint),
  }).slice(0, 24)}`;

const correctionKnowledgeId = (
  topicKey: string,
  expectedBehavior: string,
): string =>
  `correction-knowledge-${sha256({
    expectedBehavior: normalizeIdentity(expectedBehavior),
    topicKey,
  }).slice(0, 24)}`;

const versionsFromKeys = (
  keys: readonly CorrectionKey[],
): readonly KnowledgeVersion[] => {
  const topics = new Map<string, Map<string, CorrectionKey[]>>();
  for (const key of keys) {
    const topicKey = correctionKnowledgeTopicKey(key);
    const expectedIdentity = normalizeIdentity(key.expectedBehavior);
    const topic = topics.get(topicKey) ?? new Map();
    const version = topic.get(expectedIdentity) ?? [];
    version.push(key);
    topic.set(expectedIdentity, version);
    topics.set(topicKey, topic);
  }
  return [...topics.entries()]
    .flatMap(([topicKey, versions]) =>
      [...versions.values()].map((versionKeys) => {
        const ordered = [...versionKeys].sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
            left.correctionKeyId.localeCompare(right.correctionKeyId),
        );
        const first = ordered[0];
        if (first === undefined) {
          throw new Error(`Knowledge topic ${topicKey} has no keys.`);
        }
        return {
          candidateId: correctionKnowledgeId(
            topicKey,
            first.expectedBehavior,
          ),
          correctionKeys: ordered,
          expectedBehavior: first.expectedBehavior,
          topicKey,
        };
      }),
    )
    .sort(
      (left, right) =>
        left.topicKey.localeCompare(right.topicKey) ||
        left.candidateId.localeCompare(right.candidateId),
    );
};

const evidenceMarks = (
  verifiedCorrectionEventIds: readonly string[],
): readonly EvidenceMark[] => {
  const marks: EvidenceMark[] = [];
  if (verifiedCorrectionEventIds.length > 0) {
    marks.push("externally_verified");
  }
  if (verifiedCorrectionEventIds.length >= 2) {
    marks.push("repeated_evidence");
  }
  return marks;
};

const verifiedCorrectionEventIds = (
  correctionEventIds: readonly string[],
  verificationEvidenceIds: readonly string[],
  eventsById: ReadonlyMap<string, CaptureEnvelope>,
): readonly string[] =>
  independentlyVerifiedCorrections(
    correctionEventIds.flatMap((id) => {
      const envelope = eventsById.get(id);
      return envelope === undefined ? [] : [envelope];
    }),
    verificationEvidenceIds.flatMap((id) => {
      const envelope = eventsById.get(id);
      return envelope === undefined ? [] : [envelope];
    }),
    eventsById,
  );

const tierFromMarks = (
  marks: readonly EvidenceMark[],
): EvidenceTier =>
  marks.includes("repeated_evidence")
    ? "repeated_evidence"
    : marks.includes("externally_verified")
      ? "externally_verified"
      : marks.includes("user_confirmed")
        ? "user_confirmed"
        : "inferred";

const sourceEpisodes = (
  sourceEvidenceIds: ReadonlySet<string>,
  episodes: readonly WorkEpisode[],
): readonly string[] =>
  sortedUnique(
    episodes.flatMap((episode) =>
      episode.sourceEventIds.some((eventId) =>
        sourceEvidenceIds.has(eventId),
      )
        ? [episode.episodeId]
        : [],
    ),
  );

const appliesWhen = (
  key: CorrectionKey,
): readonly string[] => [
  key.trigger,
  ...(key.taskFamily === undefined
    ? []
    : [
        `Task Family: ${key.taskFamily}`,
      ]),
  ...(key.subsystem === undefined
    ? []
    : [
        `Subsystem: ${key.subsystem}`,
      ]),
];

const applyFeedback = (
  candidate: KnowledgeCandidate,
  feedback: FeedbackEvent,
): KnowledgeCandidate => {
  const marks = new Set(candidate.evidenceMarks);
  let state = candidate.state;
  let evidenceTier = candidate.evidenceTier;
  let scope = candidate.scope;
  let scopeId = candidate.scopeId;
  let expiresAt = candidate.expiresAt;
  const applied = candidate.utility.applied;
  let harmful = candidate.utility.harmful;
  let helpful = candidate.utility.helpful;
  switch (feedback.kind) {
    case "confirm":
      if (feedback.source !== "user") {
        return candidate;
      }
      marks.add("user_confirmed");
      evidenceTier = tierFromMarks([...marks]);
      state =
        marks.has("externally_verified") ||
        marks.has("repeated_evidence")
          ? "active"
          : "candidate";
      break;
    case "strengthen":
      if (feedback.source === "user") {
        helpful += 1;
      }
      break;
    case "correct":
      if (feedback.source === "user") {
        harmful += 1;
      }
      state = "disputed";
      evidenceTier = "disputed";
      break;
    case "conflict":
    case "weaken":
      state = "disputed";
      evidenceTier = "disputed";
      break;
    case "stale":
    case "revoke":
      state = "archived";
      expiresAt = feedback.timestamp;
      break;
    case "set_scope":
      if (
        feedback.source !== "user" ||
        feedback.scopeChange === undefined
      ) {
        return candidate;
      }
      scope = feedback.scopeChange.scope;
      scopeId = feedback.scopeChange.scopeId;
      break;
    case "irrelevant":
    case "mute_session":
      break;
  }
  const {
    expiresAt: previousExpiresAt,
    scopeId: previousScopeId,
    ...withoutOptional
  } = candidate;
  void previousExpiresAt;
  void previousScopeId;
  return knowledgeCandidateSchema.parse({
    ...withoutOptional,
    evidenceMarks: sortedUnique(marks),
    evidenceTier,
    ...(expiresAt === undefined
      ? {}
      : {
          expiresAt,
        }),
    scope,
    ...(scopeId === undefined
      ? {}
      : {
          scopeId,
        }),
    state,
    utility: {
      applied,
      harmful,
      helpful,
    },
    validatedAt: feedback.timestamp,
  });
};

const reconcileTopicVersions = (
  input: readonly KnowledgeCandidate[],
  versionTimestamps: ReadonlyMap<string, string>,
): readonly KnowledgeCandidate[] => {
  const byTopic = new Map<string, KnowledgeCandidate[]>();
  for (const candidate of input) {
    const topic = byTopic.get(candidate.topicKey) ?? [];
    topic.push(candidate);
    byTopic.set(candidate.topicKey, topic);
  }
  const result: KnowledgeCandidate[] = [];
  for (const candidates of byTopic.values()) {
    const active = candidates
      .filter((candidate) => candidate.state === "active")
      .sort(
        (left, right) =>
          Date.parse(
            versionTimestamps.get(right.knowledgeId) ?? right.createdAt,
          ) -
            Date.parse(versionTimestamps.get(left.knowledgeId) ?? left.createdAt) ||
          right.knowledgeId.localeCompare(left.knowledgeId),
      );
    const selected = active[0];
    const superseded = new Set(
      active.slice(1).map((candidate) => candidate.knowledgeId),
    );
    const previous = active[1];
    for (const candidate of candidates) {
      const {
        supersedes: previousSupersedes,
        ...withoutSupersedes
      } = candidate;
      void previousSupersedes;
      result.push(
        knowledgeCandidateSchema.parse({
          ...withoutSupersedes,
          ...(selected?.knowledgeId === candidate.knowledgeId &&
          previous !== undefined
            ? {
                supersedes: previous.knowledgeId,
              }
            : {}),
          state: superseded.has(candidate.knowledgeId)
            ? "superseded"
            : candidate.state,
        }),
      );
    }
  }
  return result.sort((left, right) =>
    left.knowledgeId.localeCompare(right.knowledgeId),
  );
};

export class KnowledgeLifecycleBuilder {
  readonly #admissionPolicy: KnowledgeAdmissionPolicy;

  public constructor(
    options: KnowledgeLifecycleBuilderOptions = {},
  ) {
    this.#admissionPolicy =
      options.admissionPolicy ?? new KnowledgeAdmissionPolicy();
  }

  public build(
    input: KnowledgeLifecycleBuildInput,
  ): KnowledgeLifecycleBuildResult {
    const correctionKeys = input.correctionKeys.map((key) =>
      correctionKeySchema.parse(key),
    );
    const contextUseRecords = (input.contextUseRecords ?? []).map(
      (record) => contextUseRecordSchema.parse(record),
    );
    const opportunities = input.correctionOpportunities.map(
      (opportunity) =>
        correctionOpportunitySchema.parse(opportunity),
    );
    const envelopes = input.envelopes.map((envelope) =>
      captureEnvelopeSchema.parse(envelope),
    );
    const feedbackEvents = input.feedbackEvents
      .map((event) => feedbackEventSchema.parse(event))
      .filter((event) =>
        !["irrelevant", "mute_session"].includes(event.kind) &&
        (!["confirm", "set_scope", "strengthen"].includes(event.kind) || event.source === "user"),
      )
      .sort(byTimestampAndId);
    const workEpisodes = input.workEpisodes.map((episode) =>
      workEpisodeSchema.parse(episode),
    );
    const eventsById = new Map(
      envelopes.map((envelope) => [
        envelope.event.eventId,
        envelope,
      ]),
    );
    const correctionSourceEventIds = new Set(
      envelopes
        .filter(
          (envelope) =>
            envelope.event.eventType === "user.corrected",
        )
        .map((envelope) => envelope.event.eventId),
    );
    const versions = versionsFromKeys(correctionKeys);
    const versionTimestamps = new Map(versions.map((version) => [
      version.candidateId,
      latestTimestamp(version.correctionKeys.flatMap((key) =>
        key.sourceCorrectionEventIds.flatMap((eventId) => {
          const event = eventsById.get(eventId);
          return event === undefined ? [] : [event.event.timestamp];
        }),
      )) ?? version.correctionKeys[0]?.createdAt ?? new Date(0).toISOString(),
    ]));
    const candidates = versions.map((version) => {
      const keyIds = new Set(
        version.correctionKeys.map((key) => key.correctionKeyId),
      );
      const correctionEventIds = sortedUnique(
        version.correctionKeys.flatMap(
          (key) => key.sourceCorrectionEventIds,
        ),
      );
      const verificationEvidenceIds = sortedUnique(
        version.correctionKeys.flatMap(
          (key) => key.verificationEvidenceIds,
        ),
      );
      const baseEvidenceIds = new Set([
        ...correctionEventIds,
        ...verificationEvidenceIds,
        ...verificationEvidenceIds.flatMap((eventId) => {
          const event = eventsById.get(eventId);
          const binding = event === undefined ? undefined : verificationBinding(event);
          const correction = binding === undefined
            ? undefined
            : eventsById.get(binding.correctionEventId);
          return binding === undefined ? [] : [
            binding.operationEventId,
            ...(correction === undefined || event === undefined
              ? []
              : verificationProofEventIds(correction, event, eventsById)),
          ];
        }),
      ]);
      const createdAt =
        earliestTimestamp(
          version.correctionKeys.map((key) => key.createdAt),
        ) ?? new Date(0).toISOString();
      const counters = directKnowledgeCounterevidence(
        envelopes,
        baseEvidenceIds,
        createdAt,
      );
      const sourceEvidenceIds = new Set([
        ...baseEvidenceIds,
        ...counters.map((counter) => counter.event.eventId),
      ]);
      const relatedOpportunities = opportunities.filter(
        (opportunity) => keyIds.has(opportunity.correctionKeyId),
      );
      const applicableOpportunities = relatedOpportunities.filter(
        (opportunity) => opportunity.applicable,
      );
      const appliedOpportunities = applicableOpportunities.filter(
        (opportunity) =>
          opportunity.knowledgeAppliedBeforeCorrection,
      );
      const verificationTimestamps =
        verificationEvidenceIds.flatMap((eventId) => {
          const event = eventsById.get(eventId);
          const binding = event === undefined ? undefined : verificationBinding(event);
          const correction = binding === undefined ? undefined : eventsById.get(binding.correctionEventId);
          return event === undefined ||
            correction === undefined ||
            verificationOutcome(event) !== "succeeded" ||
            boundVerificationOperation(correction, event, eventsById) === undefined
            ? []
            : [event.event.timestamp];
        });
      const counterevidenceTimestamps = [
        ...counters.map((counter) => counter.event.timestamp),
      ];
      const validatedAt = latestTimestamp([
        ...verificationTimestamps,
        ...counterevidenceTimestamps,
      ]);
      const marks = evidenceMarks(
        verifiedCorrectionEventIds(
          correctionEventIds,
          verificationEvidenceIds,
          eventsById,
        ),
      );
      const tier = tierFromMarks(marks);
      const firstKey = version.correctionKeys[0];
      if (firstKey === undefined) {
        throw new Error(
          `Knowledge version ${version.candidateId} has no key.`,
        );
      }
      let candidate = knowledgeCandidateSchema.parse({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        appliesWhen: appliesWhen(firstKey),
        conflictsWith: versions
          .filter(
            (other) =>
              other.topicKey === version.topicKey &&
              other.candidateId !== version.candidateId,
          )
          .map((other) => other.candidateId)
          .sort(),
        content: version.expectedBehavior,
        coverage: {
          applicableOpportunities: applicableOpportunities.length,
          observedOutcomes: applicableOpportunities.filter(
            (opportunity) => opportunity.outcomeKnown,
          ).length,
        },
        createdAt,
        evidenceMarks: marks,
        evidenceTier: tier,
        importance: 1,
        kind: "procedural",
        knowledgeId: version.candidateId,
        nonApplicability: [],
        scope: firstKey.scope,
        ...(firstKey.scopeId === undefined
          ? {}
          : {
              scopeId: firstKey.scopeId,
            }),
        sourceEpisodeIds: sourceEpisodes(
          sourceEvidenceIds,
          workEpisodes,
        ),
        sourceEvidenceIds: sortedUnique(sourceEvidenceIds),
        state: tier === "inferred" ? "candidate" : "active",
        topicKey: version.topicKey,
        utility: {
          applied: appliedOpportunities.length,
          harmful: 0,
          helpful: 0,
        },
        ...(validatedAt === undefined
          ? {}
          : {
              validatedAt,
            }),
      });
      for (const feedback of feedbackEvents) {
        if (
          feedback.targetType === "knowledge" &&
          feedback.targetId === candidate.knowledgeId &&
          Date.parse(feedback.timestamp) >= Date.parse(candidate.createdAt)
        ) {
          candidate = applyFeedback(candidate, feedback);
        }
      }
      const state = knowledgeEvidenceState({
        counters,
        createdAt,
        feedbackEvents,
        knowledgeId: candidate.knowledgeId,
      });
      const latestValidation = latestTimestamp([
        ...verificationTimestamps,
        ...counterevidenceTimestamps,
        ...feedbackEvents.filter((feedback) =>
          feedback.targetType === "knowledge" &&
          feedback.targetId === candidate.knowledgeId &&
          Date.parse(feedback.timestamp) >= Date.parse(createdAt),
        ).map((feedback) => feedback.timestamp),
      ]);
      const { expiresAt, ...withoutExpiry } = candidate;
      const referencesCandidate = (references: readonly string[]): boolean =>
        references.some((reference) =>
          reference === candidate.knowledgeId ||
          reference === `knowledge:${candidate.knowledgeId}`,
        );
      const uses = contextUseRecords.filter((record) =>
        referencesCandidate(record.appliedKnowledgeIds) &&
        Date.parse(record.createdAt) >= Date.parse(createdAt),
      );
      const opinions = new Map<string, FeedbackEvent>();
      for (const feedback of feedbackEvents) {
        if (
          feedback.targetType === "knowledge" &&
          feedback.targetId === candidate.knowledgeId &&
          feedback.source === "user" &&
          (feedback.kind === "strengthen" || feedback.kind === "correct") &&
          Date.parse(feedback.timestamp) >= Date.parse(createdAt)
        ) {
          opinions.set(feedback.evidenceRef, feedback);
        }
      }
      const applicationRefs = new Set([
        ...uses.map((record) => record.requestId),
        ...opinions.keys(),
        ...appliedOpportunities
          .filter((opportunity) =>
            !uses.some((record) => record.episodeId === opportunity.episodeId),
          )
          .map((opportunity) => `episode:${opportunity.episodeId}`),
      ]);
      candidate = knowledgeCandidateSchema.parse({
        ...withoutExpiry,
        ...(state.archived && expiresAt !== undefined ? { expiresAt } : {}),
        ...(state.unresolvedEvidenceIds.length === 0
          ? {}
          : {
              evidenceTier: "disputed",
              state: state.archived ? "archived" : "disputed",
            }),
        ...(latestValidation === undefined ? {} : { validatedAt: latestValidation }),
        utility: {
          applied: applicationRefs.size,
          harmful: [...opinions.values()].filter((feedback) => feedback.kind === "correct").length,
          helpful: [...opinions.values()].filter((feedback) => feedback.kind === "strengthen").length,
        },
      });
      return candidate;
    });
    const admissionInput = {
      contextUseRecords,
      correctionKeys,
      correctionSourceEventIds,
      envelopes,
      feedbackEvents,
      workEpisodes,
    };
    const preliminaryAdmission =
      this.#admissionPolicy.evaluateAll({
        ...admissionInput,
        candidates,
      });
    const admittedCandidates = candidates.map((candidate, index) => {
      const admission = preliminaryAdmission[index];
      return candidate.state === "active" &&
        admission?.admitted === false
        ? knowledgeCandidateSchema.parse({
            ...candidate,
            state: "candidate",
          })
        : candidate;
    });
    const reconciled = reconcileTopicVersions(admittedCandidates, versionTimestamps);
    const admissionById = new Map(
      preliminaryAdmission.map((admission) => [
        admission.knowledgeId,
        admission,
      ]),
    );
    return {
      admissionDecisions: reconciled.map((candidate) => {
        const admission = admissionById.get(candidate.knowledgeId);
        if (admission === undefined) {
          throw new Error(
            `Knowledge ${candidate.knowledgeId} has no admission decision.`,
          );
        }
        return refreshKnowledgeAdmissionDecision(
          admission,
          candidate,
        );
      }),
      candidates: reconciled,
    };
  }
}
