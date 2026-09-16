import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  captureQueueItemSchema,
  CURRENT_SCHEMA_VERSION,
  type CaptureEnvelope,
  type CorrectionOpportunity,
  type EvidenceTier,
  type KnowledgeCandidate,
  type WorkEpisode,
} from "@provenloop/contracts";
import {
  boundVerificationOperation,
  containsPotentialSecret,
  CorrectionCaptureBuilder,
  createCaptureEnvelope,
  KnowledgeLifecycleBuilder,
} from "@provenloop/domain";
import {
  ContextRetrievalService,
  KnowledgeProjectionManager,
  SqliteFtsKnowledgeBackend,
  knowledgeProjectionFromCandidate,
} from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const correctionTraceSchema = z.enum([
  "correction_repeated",
  "success_without_correction",
]);

const evaluationIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u,
    "Evaluation identifiers must use only letters, numbers, dots, underscores, and hyphens.",
  );

const opportunityCaseSchema = z
  .object({
    baselineTrace: correctionTraceSchema,
    caseId: evaluationIdentifierSchema,
    contextTrace: correctionTraceSchema,
    expectedEvidenceTier: z.enum([
      "externally_verified",
      "repeated_evidence",
    ]),
    trainingOccurrences: z.number().int().min(1).max(3),
  })
  .strict();

const negativeScenarioSchema = z.enum([
  "counterevidence",
  "scope_mismatch",
  "unverified",
]);

const negativeCaseSchema = z
  .object({
    caseId: evaluationIdentifierSchema,
    queryCaseId: evaluationIdentifierSchema.optional(),
    scenario: negativeScenarioSchema,
  })
  .strict();

const normalizeCorrectionIdentity = (value: string): string =>
  value
    .normalize("NFKC")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");

export const correctionRecurrenceDatasetSchema = z
  .object({
    evidenceKind: z.literal("synthetic").default("synthetic"),
    evaluationPurpose: z.literal("regression").default("regression"),
    datasetId: evaluationIdentifierSchema,
    datasetVersion: z.number().int().positive(),
    negativeCases: z.array(negativeCaseSchema).min(3).max(50),
    opportunities: z.array(opportunityCaseSchema).min(20).max(100),
  })
  .strict()
  .superRefine((dataset, context) => {
    const caseIds = [
      ...dataset.opportunities.map((testCase) => testCase.caseId),
      ...dataset.negativeCases.map((testCase) => testCase.caseId),
    ];
    const normalizedCaseIds = caseIds.map(normalizeCorrectionIdentity);
    if (
      new Set(normalizedCaseIds).size !== normalizedCaseIds.length
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Correction Recurrence case IDs must be unique after identity normalization.",
        path: [
          "opportunities",
        ],
      });
    }
    dataset.opportunities.forEach((testCase, index) => {
      const expectedTier =
        testCase.trainingOccurrences >= 2
          ? "repeated_evidence"
          : "externally_verified";
      if (testCase.expectedEvidenceTier !== expectedTier) {
        context.addIssue({
          code: "custom",
          message:
            "Expected Evidence Tier must match the training occurrence count.",
          path: [
            "opportunities",
            index,
            "expectedEvidenceTier",
          ],
        });
      }
    });
    if (
      !dataset.opportunities.some(
        (testCase) =>
          testCase.baselineTrace === "correction_repeated",
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Correction Recurrence baseline must contain at least one repeated correction.",
        path: [
          "opportunities",
        ],
      });
    }
    for (const scenario of negativeScenarioSchema.options) {
      if (
        !dataset.negativeCases.some(
          (testCase) => testCase.scenario === scenario,
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            `Correction Recurrence dataset requires a ${scenario} negative case.`,
          path: [
            "negativeCases",
          ],
        });
      }
    }
    for (
      const [index, testCase] of dataset.negativeCases.entries()
    ) {
      if (
        testCase.queryCaseId !== undefined &&
        !caseIds.includes(testCase.queryCaseId)
      ) {
        context.addIssue({
          code: "custom",
          message:
            `Negative query case ${testCase.queryCaseId} does not exist.`,
          path: [
            "negativeCases",
            index,
            "queryCaseId",
          ],
        });
      }
    }
  });

export type CorrectionRecurrenceDataset = z.infer<
  typeof correctionRecurrenceDatasetSchema
>;
export type CorrectionRecurrenceNegativeScenario = z.infer<
  typeof negativeScenarioSchema
>;
export type CorrectionRecurrenceTrace = z.infer<
  typeof correctionTraceSchema
>;

export interface CorrectionOpportunityCaseResult {
  readonly actualEvidenceTier?: EvidenceTier;
  readonly admitted: boolean;
  readonly baselineCorrectionRepeated: boolean;
  readonly baselineKnowledgeAppliedBeforeCorrection: boolean;
  readonly caseId: string;
  readonly contextCorrectionRepeated: boolean;
  readonly contextKnowledgeAppliedBeforeCorrection: boolean;
  readonly expectedEvidenceTier: EvidenceTier;
  readonly knowledgeId?: string;
  readonly knowledgeReturned: boolean;
  readonly matched: boolean;
  readonly provenanceComplete: boolean;
  readonly returnedKnowledgeIds: readonly string[];
  readonly retrievalStatus: "degraded" | "muted" | "ok";
  readonly statusDetail?: string;
  readonly unexpectedKnowledgeIds: readonly string[];
}

export interface CorrectionNegativeCaseResult {
  readonly actualEvidenceTier?: EvidenceTier;
  readonly candidateState?: KnowledgeCandidate["state"];
  readonly caseId: string;
  readonly counterevidenceStopped: boolean;
  readonly expectedEvidenceTier: EvidenceTier;
  readonly knowledgeId?: string;
  readonly knowledgeReturned: boolean;
  readonly matched: boolean;
  readonly returnedKnowledgeIds: readonly string[];
  readonly retrievalStatus: "degraded" | "muted" | "ok";
  readonly scenario: CorrectionRecurrenceNegativeScenario;
  readonly statusDetail?: string;
  readonly unexpectedKnowledgeIds: readonly string[];
}

export interface CorrectionRecurrenceMetrics {
  readonly baselineCorrectionRepeated: number;
  readonly baselineRcr: number;
  readonly caseCount: number;
  readonly contextCorrectionRepeated: number;
  readonly contextRcr: number;
  readonly counterevidenceCases: number;
  readonly counterevidenceStopped: number;
  readonly degradedRetrievals: number;
  readonly evidenceTierAccuracy: number;
  readonly evidenceTierCaseCount: number;
  readonly evidenceTierCorrect: number;
  readonly matchedCases: number;
  readonly negativeCaseCount: number;
  readonly opportunityCount: number;
  readonly provenanceComplete: number;
  readonly provenanceCompleteness: number;
  readonly rcrImprovement: number;
  readonly wrongInjectionRate: number;
  readonly wrongInjections: number;
}

export interface CorrectionRecurrenceEvaluationReport {
  readonly evidenceKind: "synthetic";
  readonly evaluationPurpose: "regression";
  readonly fieldEffect: "not_established";
  readonly datasetId: string;
  readonly datasetVersion: number;
  readonly metrics: CorrectionRecurrenceMetrics;
  readonly negativeCases: readonly CorrectionNegativeCaseResult[];
  readonly opportunities: readonly CorrectionOpportunityCaseResult[];
  readonly status: "fail" | "pass";
  readonly thresholds: {
    readonly evidenceTierAccuracy: number;
    readonly minimumOpportunities: number;
    readonly provenanceCompleteness: number;
    readonly rcrImprovement: number;
    readonly wrongInjectionRate: number;
  };
}

export interface CorrectionRecurrenceEvaluationOptions {
  readonly databasePath: string;
  readonly evidenceTierAccuracyThreshold?: number;
  readonly knowledgeDatabasePath: string;
  readonly minimumOpportunities?: number;
  readonly provenanceCompletenessThreshold?: number;
  readonly rcrImprovementThreshold?: number;
  readonly wrongInjectionThreshold?: number;
}

interface CaseMaterial {
  readonly caseId: string;
  readonly correctionEventIds: readonly string[];
  readonly operationEventIds: readonly string[];
  readonly episodeIds: readonly string[];
  readonly repoId: string;
  readonly trigger: string;
  readonly verificationEventIds: readonly string[];
}

interface HeldoutTraceMaterial {
  readonly allEnvelopes: readonly CaptureEnvelope[];
  readonly finalEpisode: WorkEpisode;
  readonly initialEpisode: WorkEpisode;
  readonly sessionId: string;
}

const builtInDatasetPath = fileURLToPath(
  new URL(
    "../fixtures/correction-recurrence-v1.json",
    import.meta.url,
  ),
);

const evaluationNow = new Date("2026-12-31T00:00:00.000Z");

const validatedDataset = (
  input: unknown,
): CorrectionRecurrenceDataset => {
  const parsed = correctionRecurrenceDatasetSchema.parse(input);
  if (
    [
      parsed.datasetId,
      ...parsed.opportunities.map((testCase) => testCase.caseId),
      ...parsed.negativeCases.map((testCase) => testCase.caseId),
      ...parsed.negativeCases.flatMap((testCase) =>
        testCase.queryCaseId === undefined
          ? []
          : [
              testCase.queryCaseId,
            ],
      ),
    ].some(containsPotentialSecret)
  ) {
    throw new Error(
      "Correction Recurrence dataset contains a potential secret.",
    );
  }
  return parsed;
};

const safeRatio = (
  numerator: number,
  denominator: number,
): number => denominator === 0 ? 0 : numerator / denominator;

const ratioThreshold = (
  value: number | undefined,
  fallback: number,
  name: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new RangeError(`${name} must be between 0 and 1.`);
  }
  return resolved;
};

const positiveThreshold = (
  value: number | undefined,
  fallback: number,
  name: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return resolved;
};

const timestamp = (
  caseIndex: number,
  occurrence: number,
  minute: number,
): string =>
  new Date(
    Date.UTC(2026, 0, 1 + caseIndex) +
      occurrence * 60 * 60 * 1_000 +
      minute * 60 * 1_000,
  ).toISOString();

const correctionMessage = (
  caseId: string,
  trigger: string,
): string => [
  `Violated Constraint: Inspect the repository validation contract for ${caseId}`,
  `Expected Behavior: Run the targeted repository validation for ${caseId}`,
  `Trigger: ${trigger}`,
  "Task Family: testing",
  `Subsystem: runner-${caseId}`,
  "Scope: repository",
].join("\n");

const envelope = (input: {
  readonly caseId: string;
  readonly completionStatus?: "failed" | "succeeded";
  readonly content?: string;
  readonly eventType: string;
  readonly occurrence: number;
  readonly operationId?: string;
  readonly parentEventId?: string;
  readonly command?: string;
  readonly verificationBinding?: NonNullable<CaptureEnvelope["event"]["verificationBinding"]>;
  readonly repoId: string;
  readonly sessionId?: string;
  readonly sourceEventId?: string;
  readonly timestamp: string;
  readonly trust: "tool" | "user";
}): CaptureEnvelope =>
  createCaptureEnvelope({
    adapter: "copilot-cli",
    adapterVersion: "1.0.82-0",
    branch: `feat/${input.caseId}`,
    worktree: `C:\\fixtures\\${input.caseId}`,
    ...(input.completionStatus === undefined
      ? {}
      : {
          completionStatus: input.completionStatus,
          exitCode: input.completionStatus === "succeeded" ? 0 : 1,
        }),
    ...(input.content === undefined && input.command === undefined
      ? {}
      : {
          content: {
            ...(input.content === undefined ? {} : { message: input.content }),
            ...(input.command === undefined ? {} : {
              toolArguments: { command: input.command },
            }),
          },
        }),
    eventType: input.eventType,
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.command === undefined ? {} : {
      toolName: "powershell",
    }),
    ...(input.verificationBinding === undefined ? {} : { verificationBinding: input.verificationBinding }),
    ...(input.parentEventId === undefined
      ? {}
      : {
          parentEventId: input.parentEventId,
        }),
    repoId: input.repoId,
    sessionId:
      input.sessionId ??
      `session-${input.caseId}-${input.occurrence}`,
    sourceEventId:
      input.sourceEventId ??
      `${input.caseId}-${input.occurrence}-${input.eventType}-${input.timestamp}`,
    timestamp: input.timestamp,
    trust: input.trust,
  });

const workEpisode = (input: {
  readonly caseId: string;
  readonly correctionEventId: string;
  readonly eventIds: readonly string[];
  readonly finishedAt: string;
  readonly occurrence: number;
  readonly outcome: "failure" | "success" | "unknown";
  readonly repoId: string;
  readonly startedAt: string;
  readonly verificationEventIds: readonly string[];
}): WorkEpisode => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  associationConfidence: 1,
  associationEvidenceIds: [],
  branches: [
    `feat/${input.caseId}`,
  ],
  commitIds: [],
  correctionEventIds: [
    input.correctionEventId,
  ],
  episodeId: `episode-${input.caseId}-${input.occurrence}`,
  finishedAt: input.finishedAt,
  goal: `Complete ${input.caseId} repository validation`,
  issueIds: [],
  outcome: input.outcome,
  outcomeEvidenceIds: [
    ...input.verificationEventIds,
  ],
  outcomeQualification:
    input.outcome === "unknown" ? "open" : "qualified",
  ...(input.outcome === "unknown"
    ? {}
    : {
        outcomeQualifiedAt: input.finishedAt,
      }),
  pullRequestIds: [],
  repoId: input.repoId,
  sessionIds: [
    `session-${input.caseId}-${input.occurrence}`,
  ],
  sourceEventIds: [
    ...input.eventIds,
  ],
  startedAt: input.startedAt,
});

const materialFor = (
  caseId: string,
  caseIndex: number,
  trainingOccurrences: number,
  scenario?: CorrectionRecurrenceNegativeScenario,
): {
  readonly envelopes: readonly CaptureEnvelope[];
  readonly material: CaseMaterial;
  readonly workEpisodes: readonly WorkEpisode[];
} => {
  const repoId = `repo-${caseId}`;
  const trigger = `package validation ${caseId}`;
  const envelopes: CaptureEnvelope[] = [];
  const episodes: WorkEpisode[] = [];
  const correctionEventIds: string[] = [];
  const operationEventIds: string[] = [];
  const verificationEventIds: string[] = [];
  for (
    let occurrence = 0;
    occurrence < trainingOccurrences;
    occurrence += 1
  ) {
    const correction = envelope({
      caseId,
      content: correctionMessage(caseId, trigger),
      eventType: "user.corrected",
      occurrence,
      repoId,
      timestamp: timestamp(caseIndex, occurrence, 10),
      trust: "user",
    });
    const occurrenceEnvelopes: CaptureEnvelope[] = [
      correction,
    ];
    const occurrenceVerificationIds: string[] = [];
    if (scenario !== "unverified") {
      const operationId = `operation-${caseId}-${occurrence}`;
      const operation = envelope({
        caseId,
        command: `npx vitest run ${caseId}`,
        eventType: "tool.started",
        occurrence,
        operationId,
        parentEventId: correction.event.eventId,
        repoId,
        timestamp: timestamp(caseIndex, occurrence, 15),
        trust: "tool",
      });
      const verification = envelope({
        caseId,
        completionStatus: "succeeded",
        eventType: "test.completed",
        occurrence,
        operationId,
        parentEventId: operation.event.eventId,
        verificationBinding: {
          correctionEventId: correction.event.eventId,
          operationEventId: operation.event.eventId,
        },
        repoId,
        timestamp: timestamp(caseIndex, occurrence, 20),
        trust: "tool",
      });
      occurrenceEnvelopes.push(operation, verification);
      operationEventIds.push(operation.event.eventId);
      occurrenceVerificationIds.push(verification.event.eventId);
      verificationEventIds.push(verification.event.eventId);
      if (
        scenario === "counterevidence" &&
        occurrence === trainingOccurrences - 1
      ) {
        const failedOperationId = `operation-${caseId}-${occurrence}-counterevidence`;
        const failedOperation = envelope({
          caseId,
          command: `npx vitest run ${caseId}`,
          eventType: "tool.started",
          occurrence,
          operationId: failedOperationId,
          parentEventId: verification.event.eventId,
          repoId,
          timestamp: timestamp(caseIndex, occurrence, 24),
          trust: "tool",
        });
        occurrenceEnvelopes.push(
          failedOperation,
          envelope({
            caseId,
            completionStatus: "failed",
            eventType: "test.completed",
            occurrence,
            operationId: failedOperationId,
            parentEventId: verification.event.eventId,
            verificationBinding: {
              correctionEventId: correction.event.eventId,
              operationEventId: failedOperation.event.eventId,
            },
            repoId,
            timestamp: timestamp(caseIndex, occurrence, 25),
            trust: "tool",
          }),
        );
      }
    }
    correctionEventIds.push(correction.event.eventId);
    envelopes.push(...occurrenceEnvelopes);
    episodes.push(
      workEpisode({
        caseId,
        correctionEventId: correction.event.eventId,
        eventIds: occurrenceEnvelopes.map(
          (item) => item.event.eventId,
        ),
        finishedAt: timestamp(caseIndex, occurrence, 30),
        occurrence,
        outcome:
          scenario === "unverified"
            ? "unknown"
            : scenario === "counterevidence"
              ? "failure"
              : "success",
        repoId,
        startedAt: timestamp(caseIndex, occurrence, 0),
        verificationEventIds: occurrenceVerificationIds,
      }),
    );
  }
  return {
    envelopes,
    material: {
      caseId,
      correctionEventIds,
      operationEventIds,
      episodeIds: episodes.map((episode) => episode.episodeId),
      repoId,
      trigger,
      verificationEventIds,
    },
    workEpisodes: episodes,
  };
};

const heldoutTraceMaterialFor = (
  material: CaseMaterial,
  caseIndex: number,
  condition: "baseline" | "context",
  trace: CorrectionRecurrenceTrace,
): HeldoutTraceMaterial => {
  const occurrence = condition === "baseline" ? 10 : 12;
  const sessionId = `heldout-${condition}-${material.caseId}`;
  const episodeId = `episode-${condition}-${material.caseId}`;
  const startedAt = timestamp(caseIndex, occurrence, 0);
  const prompt = envelope({
    caseId: material.caseId,
    content: [
      material.trigger,
      "Task Family: testing",
      `Subsystem: runner-${material.caseId}`,
    ].join("\n"),
    eventType: "prompt.submitted",
    occurrence,
    repoId: material.repoId,
    sessionId,
    sourceEventId: `${episodeId}-prompt`,
    timestamp: timestamp(caseIndex, occurrence, 1),
    trust: "user",
  });
  const correction =
    trace === "correction_repeated"
      ? envelope({
          caseId: material.caseId,
          content: correctionMessage(
            material.caseId,
            material.trigger,
          ),
          eventType: "user.corrected",
          occurrence,
          repoId: material.repoId,
          sessionId,
          sourceEventId: `${episodeId}-correction`,
          timestamp: timestamp(caseIndex, occurrence, 10),
          trust: "user",
        })
      : undefined;
  const operationId = `${episodeId}-operation`;
  const operation = envelope({
    caseId: material.caseId,
    command: `npx vitest run ${material.caseId}`,
    eventType: "tool.started",
    occurrence,
    operationId,
    parentEventId: correction?.event.eventId ?? prompt.event.eventId,
    repoId: material.repoId,
    sessionId,
    sourceEventId: `${episodeId}-operation-started`,
    timestamp: timestamp(caseIndex, occurrence, 15),
    trust: "tool",
  });
  const verification = envelope({
    caseId: material.caseId,
    completionStatus: "succeeded",
    eventType: "test.completed",
    occurrence,
    operationId,
    parentEventId: operation.event.eventId,
    ...(correction === undefined ? {} : {
      verificationBinding: {
        correctionEventId: correction.event.eventId,
        operationEventId: operation.event.eventId,
      },
    }),
    repoId: material.repoId,
    sessionId,
    sourceEventId: `${episodeId}-verification`,
    timestamp: timestamp(caseIndex, occurrence, 20),
    trust: "tool",
  });
  const allEnvelopes = [
    prompt,
    ...(correction === undefined ? [] : [correction]),
    operation,
    verification,
  ];
  const initialEpisode: WorkEpisode = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    associationConfidence: 1,
    associationEvidenceIds: [],
    branches: [
      `feat/${material.caseId}`,
    ],
    commitIds: [],
    correctionEventIds: [],
    episodeId,
    goal: `Evaluate ${material.trigger}`,
    issueIds: [],
    outcome: "unknown",
    outcomeEvidenceIds: [],
    outcomeQualification: "open",
    pullRequestIds: [],
    repoId: material.repoId,
    sessionIds: [
      sessionId,
    ],
    sourceEventIds: [
      prompt.event.eventId,
    ],
    startedAt,
  };
  const finalEpisode: WorkEpisode = {
    ...initialEpisode,
    correctionEventIds:
      correction === undefined
        ? []
        : [
            correction.event.eventId,
          ],
    finishedAt: timestamp(caseIndex, occurrence, 30),
    outcome: "success",
    outcomeEvidenceIds: [
      verification.event.eventId,
    ],
    outcomeQualification: "qualified",
    outcomeQualifiedAt: timestamp(caseIndex, occurrence, 30),
    sourceEventIds: allEnvelopes.map(
      (item) => item.event.eventId,
    ),
  };
  return {
    allEnvelopes,
    finalEpisode,
    initialEpisode,
    sessionId,
  };
};

const ingestEnvelopes = (
  store: CanonicalSqliteStore,
  envelopes: readonly CaptureEnvelope[],
): void => {
  envelopes.forEach((item) => {
    const queueItem = captureQueueItemSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      attemptCount: 0,
      createdAt: item.capturedAt,
      envelope: item,
      failureCount: 0,
      queueItemId: `evaluation-${item.event.eventId}`,
      state: "pending",
      updatedAt: item.capturedAt,
    });
    const result = store.ingestQueueItem(queueItem);
    if (result.status !== "stored" && result.status !== "duplicate") {
      throw new Error(
        `Correction Recurrence event ${item.event.eventId} was not stored.`,
      );
    }
  });
};

const rebuildCorrectionProjection = (
  store: CanonicalSqliteStore,
): ReturnType<CorrectionCaptureBuilder["build"]> => {
  const result = new CorrectionCaptureBuilder().build({
    contextUseRecords: store.contextUseRecords(),
    envelopes: store.episodeSourceEnvelopes(),
    knowledgeCandidates: store.knowledgeCandidates(),
    workEpisodes: store.workEpisodes(),
  });
  store.replaceCorrectionProjection({
    correctionKeys: result.correctionKeys,
    opportunities: result.opportunities,
  });
  return result;
};

const candidateFor = (
  material: CaseMaterial,
  candidates: readonly KnowledgeCandidate[],
): KnowledgeCandidate | undefined =>
  candidates.find((candidate) =>
    material.correctionEventIds.some((eventId) =>
      candidate.sourceEvidenceIds.includes(eventId),
    ),
  );

const returnedKnowledgeIds = (
  response: Awaited<
    ReturnType<ContextRetrievalService["context"]>
  >,
): readonly string[] =>
  response.items
    .filter((item) => item.kind === "knowledge")
    .map((item) => item.id);

const provenanceComplete = (
  candidate: KnowledgeCandidate | undefined,
  material: CaseMaterial,
  store: CanonicalSqliteStore,
  admission: {
    readonly admitted: boolean;
    readonly proofChain: {
      readonly sourceEpisodeIds: readonly string[];
      readonly sourceEvidenceIds: readonly string[];
    };
  } | undefined,
): boolean => {
  if (candidate === undefined || admission === undefined) {
    return false;
  }
  const expectedEvidenceIds = [
    ...material.correctionEventIds,
    ...material.operationEventIds,
    ...material.verificationEventIds,
  ];
  const evidence = store.knowledgeAdmissionEvidence([
    candidate,
  ]);
  const persistedEvidenceIds = new Set(
    evidence.envelopes.map((item) => item.event.eventId),
  );
  const persistedEpisodeIds = new Set(
    evidence.workEpisodes.map((episode) => episode.episodeId),
  );
  return (
    admission.admitted &&
    expectedEvidenceIds.every(
      (eventId) =>
        candidate.sourceEvidenceIds.includes(eventId) &&
        admission.proofChain.sourceEvidenceIds.includes(eventId) &&
        persistedEvidenceIds.has(eventId),
    ) &&
    material.episodeIds.every(
      (episodeId) =>
        candidate.sourceEpisodeIds.includes(episodeId) &&
        admission.proofChain.sourceEpisodeIds.includes(episodeId) &&
        persistedEpisodeIds.has(episodeId),
    )
  );
};

export const loadCorrectionRecurrenceDataset = async (
  path = builtInDatasetPath,
): Promise<CorrectionRecurrenceDataset> =>
  validatedDataset(
    JSON.parse(await readFile(path, "utf8")) as unknown,
  );

export const evaluateCorrectionRecurrenceDataset = async (
  dataset: CorrectionRecurrenceDataset,
  options: CorrectionRecurrenceEvaluationOptions,
): Promise<CorrectionRecurrenceEvaluationReport> => {
  const parsed = validatedDataset(dataset);
  const thresholds = {
    evidenceTierAccuracy: ratioThreshold(
      options.evidenceTierAccuracyThreshold,
      0.95,
      "evidenceTierAccuracyThreshold",
    ),
    minimumOpportunities: positiveThreshold(
      options.minimumOpportunities,
      20,
      "minimumOpportunities",
    ),
    provenanceCompleteness: ratioThreshold(
      options.provenanceCompletenessThreshold,
      1,
      "provenanceCompletenessThreshold",
    ),
    rcrImprovement: ratioThreshold(
      options.rcrImprovementThreshold,
      0.2,
      "rcrImprovementThreshold",
    ),
    wrongInjectionRate: ratioThreshold(
      options.wrongInjectionThreshold,
      0.02,
      "wrongInjectionThreshold",
    ),
  };
  const trainingEnvelopes: CaptureEnvelope[] = [];
  const trainingEpisodes: WorkEpisode[] = [];
  const materials = new Map<string, CaseMaterial>();
  parsed.opportunities.forEach((testCase, index) => {
    const built = materialFor(
      testCase.caseId,
      index,
      testCase.trainingOccurrences,
    );
    trainingEnvelopes.push(...built.envelopes);
    trainingEpisodes.push(...built.workEpisodes);
    materials.set(testCase.caseId, built.material);
  });
  parsed.negativeCases.forEach((testCase, index) => {
    const built = materialFor(
      testCase.caseId,
      parsed.opportunities.length + index,
      1,
      testCase.scenario,
    );
    trainingEnvelopes.push(...built.envelopes);
    trainingEpisodes.push(...built.workEpisodes);
    materials.set(testCase.caseId, built.material);
  });

  const store = new CanonicalSqliteStore(options.databasePath, {
    now: () => evaluationNow,
  });
  const backend = new SqliteFtsKnowledgeBackend(
    options.knowledgeDatabasePath,
  );
  try {
    ingestEnvelopes(store, trainingEnvelopes);
    const canonicalTraining = new Map(
      store.episodeSourceEnvelopes().map((item) => [item.event.eventId, item]),
    );
    for (const original of trainingEnvelopes) {
      const binding = original.event.verificationBinding;
      if (binding === undefined) {
        continue;
      }
      const correction = canonicalTraining.get(binding.correctionEventId);
      const verification = canonicalTraining.get(original.event.eventId);
      if (
        correction === undefined || verification === undefined ||
        boundVerificationOperation(correction, verification, canonicalTraining) === undefined
      ) {
        throw new Error("Synthetic correction proof did not survive canonical storage with its operation and workspace binding.");
      }
    }
    store.replaceWorkEpisodeProjection({
      associations: [],
      corrections: [],
      episodes: trainingEpisodes,
    });
    const trainingCorrection =
      rebuildCorrectionProjection(store);
    const lifecycle = new KnowledgeLifecycleBuilder().build({
      contextUseRecords: [],
      correctionKeys: trainingCorrection.correctionKeys,
      correctionOpportunities: trainingCorrection.opportunities,
      envelopes: trainingEnvelopes,
      feedbackEvents: [],
      workEpisodes: trainingEpisodes,
    });
    store.replaceCorrectionKnowledgeCandidates({
      candidates: lifecycle.candidates,
    });
    await new KnowledgeProjectionManager({
      backend,
      store,
    }).rebuild();
    const admissionById = new Map(
      lifecycle.admissionDecisions.map((admission) => [
        admission.knowledgeId,
        admission,
      ]),
    );
    const heldoutByCase = new Map<
      string,
      {
        readonly baseline: HeldoutTraceMaterial;
        readonly context: HeldoutTraceMaterial;
      }
    >();
    parsed.opportunities.forEach((testCase, index) => {
      const material = materials.get(testCase.caseId);
      if (material === undefined) {
        throw new Error(
          `Missing Correction Recurrence material for ${testCase.caseId}.`,
        );
      }
      heldoutByCase.set(testCase.caseId, {
        baseline: heldoutTraceMaterialFor(
          material,
          index,
          "baseline",
          testCase.baselineTrace,
        ),
        context: heldoutTraceMaterialFor(
          material,
          index,
          "context",
          testCase.contextTrace,
        ),
      });
    });
    const heldout = [...heldoutByCase.values()];
    const contextPromptEnvelopes = heldout
      .map((item) => item.context.allEnvelopes[0])
      .filter(
      (item): item is CaptureEnvelope => item !== undefined,
    );
    const baselineEnvelopes = heldout.flatMap(
      (item) => item.baseline.allEnvelopes,
    );
    const baselineEpisodes = heldout.map(
      (item) => item.baseline.finalEpisode,
    );
    const initialContextEpisodes = heldout.map(
      (item) => item.context.initialEpisode,
    );
    const baselineStore = new CanonicalSqliteStore(":memory:", {
      now: () => evaluationNow,
    });
    let baselineOpportunityByEpisode:
      Map<string, CorrectionOpportunity>;
    try {
      ingestEnvelopes(baselineStore, trainingEnvelopes);
      baselineStore.replaceWorkEpisodeProjection({
        associations: [],
        corrections: [],
        episodes: trainingEpisodes,
      });
      rebuildCorrectionProjection(baselineStore);
      baselineStore.replaceCorrectionKnowledgeCandidates({
        candidates: lifecycle.candidates,
      });
      ingestEnvelopes(baselineStore, baselineEnvelopes);
      baselineStore.replaceWorkEpisodeProjection({
        associations: [],
        corrections: [],
        episodes: [
          ...trainingEpisodes,
          ...baselineEpisodes,
        ],
      });
      const baselineCorrection =
        rebuildCorrectionProjection(baselineStore);
      const baselineEpisodeIds = new Set(
        baselineEpisodes.map((episode) => episode.episodeId),
      );
      baselineOpportunityByEpisode = new Map(
        baselineCorrection.opportunities
          .filter((opportunity) =>
            baselineEpisodeIds.has(opportunity.episodeId),
          )
          .map((opportunity) => [
            opportunity.episodeId,
            opportunity,
          ]),
      );
    } finally {
      baselineStore.close();
    }
    ingestEnvelopes(store, contextPromptEnvelopes);
    store.replaceWorkEpisodeProjection({
      associations: [],
      corrections: [],
      episodes: [
        ...trainingEpisodes,
        ...initialContextEpisodes,
      ],
    });
    let requestSequence = 0;
    const retrieve = async (
      material: CaseMaterial,
      candidate: KnowledgeCandidate | undefined,
      repositoryScopeId: string,
      sessionId: string,
      now: Date,
      applicationFeedback?: "helpful" | "wrong",
    ) => {
      const service = new ContextRetrievalService({
        backend,
        clockMs: () => performance.now(),
        idGenerator: () =>
          `m2-request-${requestSequence += 1}`,
        now: () => now,
        store,
        syncKnowledge: async (candidate) => {
          const current = store.knowledgeCandidates([
            candidate.knowledgeId,
          ])[0];
          if (current === undefined) {
            throw new Error(
              "Knowledge projection target no longer exists.",
            );
          }
          await backend.index([
            knowledgeProjectionFromCandidate(current),
          ]);
        },
        timeoutMs: 5_000,
      });
      const response = await service.context({
        cwd: `C:\\fixtures\\${material.caseId}`,
        prompt: material.trigger,
        repoId: repositoryScopeId,
        sessionId,
        tokenBudget: 1_200,
      });
      const knowledgeIds = returnedKnowledgeIds(response);
      if (
        applicationFeedback !== undefined &&
        candidate !== undefined &&
        knowledgeIds.includes(candidate.knowledgeId)
      ) {
        const feedback = await service.feedback({
          action: applicationFeedback,
          reason: "Synthetic M2 user-reported adoption and feedback.",
          requestId: response.requestId,
          sessionId,
          source: "user",
          targetId: candidate.knowledgeId,
          targetKind: "knowledge",
          userReportedApplied: true,
        });
        const contextUse = store.contextUseRecords().find(
          (record) => record.requestId === response.requestId,
        );
        if (
          feedback.status !== "recorded" ||
          contextUse?.feedback !== applicationFeedback ||
          !contextUse.appliedKnowledgeIds.includes(`knowledge:${candidate.knowledgeId}`)
        ) {
          throw new Error(
            `Synthetic user-reported application was not recorded for ${material.caseId}.`,
          );
        }
      }
      return {
        knowledgeIds,
        response,
        returned:
          candidate !== undefined &&
          knowledgeIds.includes(candidate.knowledgeId),
      };
    };

    const contextRetrievals = new Map<
      string,
      Awaited<ReturnType<typeof retrieve>>
    >();
    for (const [index, testCase] of parsed.opportunities.entries()) {
      const material = materials.get(testCase.caseId);
      const traces = heldoutByCase.get(testCase.caseId);
      if (material === undefined || traces === undefined) {
        throw new Error(
          `Missing held-out replay material for ${testCase.caseId}.`,
        );
      }
      const candidate = candidateFor(
        material,
        lifecycle.candidates,
      );
      contextRetrievals.set(
        testCase.caseId,
        await retrieve(
          material,
          candidate,
          material.repoId,
          traces.context.sessionId,
          new Date(timestamp(index, 12, 5)),
          testCase.contextTrace === "correction_repeated"
            ? "wrong"
            : "helpful",
        ),
      );
    }
    const contextEnvelopes = heldout.flatMap(
      (item) => item.context.allEnvelopes.slice(1),
    );
    const contextEpisodes = heldout.map(
      (item) => item.context.finalEpisode,
    );
    ingestEnvelopes(store, contextEnvelopes);
    store.replaceWorkEpisodeProjection({
      associations: [],
      corrections: [],
      episodes: [
        ...trainingEpisodes,
        ...contextEpisodes,
      ],
    });
    const replayCorrection =
      rebuildCorrectionProjection(store);
    const contextEpisodeIds = new Set(
      contextEpisodes.map((episode) => episode.episodeId),
    );
    const contextOpportunityByEpisode = new Map(
      replayCorrection.opportunities
        .filter((opportunity) =>
          contextEpisodeIds.has(opportunity.episodeId),
        )
        .map((opportunity) => [
          opportunity.episodeId,
          opportunity,
        ]),
    );

    const opportunityResults: CorrectionOpportunityCaseResult[] = [];
    for (const testCase of parsed.opportunities) {
      const material = materials.get(testCase.caseId);
      if (material === undefined) {
        throw new Error(
          `Missing Correction Recurrence material for ${testCase.caseId}.`,
        );
      }
      const candidate = candidateFor(
        material,
        lifecycle.candidates,
      );
      const traces = heldoutByCase.get(testCase.caseId);
      const retrieval = contextRetrievals.get(testCase.caseId);
      if (traces === undefined || retrieval === undefined) {
        throw new Error(
          `Missing held-out result for ${testCase.caseId}.`,
        );
      }
      const admission =
        candidate === undefined
          ? undefined
          : admissionById.get(candidate.knowledgeId);
      const complete = provenanceComplete(
        candidate,
        material,
        store,
        admission,
      );
      const baselineOpportunity =
        baselineOpportunityByEpisode.get(
          traces.baseline.finalEpisode.episodeId,
        );
      const contextOpportunity =
        contextOpportunityByEpisode.get(
          traces.context.finalEpisode.episodeId,
        );
      if (
        baselineOpportunity === undefined ||
        contextOpportunity === undefined
      ) {
        throw new Error(
          `Missing generated held-out Opportunity for ${testCase.caseId}.`,
        );
      }
      const unexpectedKnowledgeIds = retrieval.knowledgeIds.filter(
        (knowledgeId) => knowledgeId !== candidate?.knowledgeId,
      );
      const expectedBaselineRepeated =
        testCase.baselineTrace === "correction_repeated";
      const expectedContextRepeated =
        testCase.contextTrace === "correction_repeated";
      const matched =
        retrieval.response.status === "ok" &&
        retrieval.returned &&
        unexpectedKnowledgeIds.length === 0 &&
        candidate?.state === "active" &&
        admission?.admitted === true &&
        candidate.evidenceTier ===
          testCase.expectedEvidenceTier &&
        baselineOpportunity.applicable &&
        baselineOpportunity.knowledgeAvailableBeforeCorrection &&
        !baselineOpportunity.knowledgeAppliedBeforeCorrection &&
        baselineOpportunity.outcomeKnown &&
        baselineOpportunity.correctionRepeated ===
          expectedBaselineRepeated &&
        contextOpportunity.applicable &&
        contextOpportunity.knowledgeAvailableBeforeCorrection &&
        contextOpportunity.knowledgeAppliedBeforeCorrection &&
        contextOpportunity.outcomeKnown &&
        contextOpportunity.correctionRepeated ===
          expectedContextRepeated &&
        complete;
      opportunityResults.push({
        ...(candidate === undefined
          ? {}
          : {
              actualEvidenceTier: candidate.evidenceTier,
              knowledgeId: candidate.knowledgeId,
            }),
        admitted: admission?.admitted ?? false,
        baselineCorrectionRepeated:
          baselineOpportunity.correctionRepeated,
        baselineKnowledgeAppliedBeforeCorrection:
          baselineOpportunity.knowledgeAppliedBeforeCorrection,
        caseId: testCase.caseId,
        contextCorrectionRepeated:
          contextOpportunity.correctionRepeated,
        contextKnowledgeAppliedBeforeCorrection:
          contextOpportunity.knowledgeAppliedBeforeCorrection,
        expectedEvidenceTier: testCase.expectedEvidenceTier,
        knowledgeReturned: retrieval.returned,
        matched,
        provenanceComplete: complete,
        returnedKnowledgeIds: retrieval.knowledgeIds,
        retrievalStatus: retrieval.response.status,
        ...(retrieval.response.statusDetail === undefined
          ? {}
          : {
              statusDetail: retrieval.response.statusDetail,
            }),
        unexpectedKnowledgeIds,
      });
    }

    const negativeResults: CorrectionNegativeCaseResult[] = [];
    for (const testCase of parsed.negativeCases) {
      const material = materials.get(testCase.caseId);
      if (material === undefined) {
        throw new Error(
          `Missing Correction Recurrence material for ${testCase.caseId}.`,
        );
      }
      const candidate = candidateFor(
        material,
        lifecycle.candidates,
      );
      const queryMaterial =
        testCase.queryCaseId === undefined
          ? material
          : materials.get(testCase.queryCaseId);
      if (queryMaterial === undefined) {
        throw new Error(
          `Missing negative query material for ${testCase.caseId}.`,
        );
      }
      const repositoryScopeId =
        testCase.scenario === "scope_mismatch"
          ? testCase.queryCaseId === undefined
            ? `${material.repoId}-other`
            : queryMaterial.repoId
          : material.repoId;
      const retrieval = await retrieve(
        queryMaterial,
        candidate,
        repositoryScopeId,
        `evaluation-${material.caseId}`,
        evaluationNow,
      );
      const unexpectedKnowledgeIds = [
        ...retrieval.knowledgeIds,
      ];
      const anyKnowledgeReturned =
        unexpectedKnowledgeIds.length > 0;
      const counterevidenceStopped =
        testCase.scenario === "counterevidence" &&
        candidate?.state === "disputed" &&
        !anyKnowledgeReturned;
      const expectedState =
        testCase.scenario === "counterevidence"
          ? "disputed"
          : testCase.scenario === "unverified"
            ? "candidate"
            : "active";
      const expectedEvidenceTier: EvidenceTier =
        testCase.scenario === "counterevidence"
          ? "disputed"
          : testCase.scenario === "unverified"
            ? "inferred"
            : "externally_verified";
      negativeResults.push({
        ...(candidate === undefined
          ? {}
          : {
              actualEvidenceTier: candidate.evidenceTier,
              candidateState: candidate.state,
              knowledgeId: candidate.knowledgeId,
            }),
        caseId: testCase.caseId,
        counterevidenceStopped,
        expectedEvidenceTier,
        knowledgeReturned: anyKnowledgeReturned,
        matched:
          retrieval.response.status === "ok" &&
          !anyKnowledgeReturned &&
          candidate?.state === expectedState &&
          candidate.evidenceTier === expectedEvidenceTier,
        returnedKnowledgeIds: retrieval.knowledgeIds,
        retrievalStatus: retrieval.response.status,
        scenario: testCase.scenario,
        ...(retrieval.response.statusDetail === undefined
          ? {}
          : {
              statusDetail: retrieval.response.statusDetail,
            }),
        unexpectedKnowledgeIds,
      });
    }

    const baselineCorrectionRepeated =
      opportunityResults.filter(
        (result) => result.baselineCorrectionRepeated,
      ).length;
    const contextCorrectionRepeated =
      opportunityResults.filter(
        (result) => result.contextCorrectionRepeated,
      ).length;
    const baselineRcr = safeRatio(
      baselineCorrectionRepeated,
      opportunityResults.length,
    );
    const contextRcr = safeRatio(
      contextCorrectionRepeated,
      opportunityResults.length,
    );
    const counterevidenceCases = negativeResults.filter(
      (result) => result.scenario === "counterevidence",
    );
    const tierResults = [
      ...opportunityResults,
      ...negativeResults,
    ];
    const evidenceTierCorrect = tierResults.filter(
      (result) =>
        result.actualEvidenceTier === result.expectedEvidenceTier,
    ).length;
    const provenanceCompleteCount = opportunityResults.filter(
      (result) => result.provenanceComplete,
    ).length;
    const allResults = [
      ...opportunityResults,
      ...negativeResults,
    ];
    const wrongInjections = allResults.filter(
      (result) => result.unexpectedKnowledgeIds.length > 0,
    ).length;
    const metrics: CorrectionRecurrenceMetrics = {
      baselineCorrectionRepeated,
      baselineRcr,
      caseCount: allResults.length,
      contextCorrectionRepeated,
      contextRcr,
      counterevidenceCases: counterevidenceCases.length,
      counterevidenceStopped: counterevidenceCases.filter(
        (result) => result.counterevidenceStopped,
      ).length,
      degradedRetrievals: allResults.filter(
        (result) => result.retrievalStatus !== "ok",
      ).length,
      evidenceTierAccuracy: safeRatio(
        evidenceTierCorrect,
        tierResults.length,
      ),
      evidenceTierCaseCount: tierResults.length,
      evidenceTierCorrect,
      matchedCases: allResults.filter(
        (result) => result.matched,
      ).length,
      negativeCaseCount: negativeResults.length,
      opportunityCount: opportunityResults.length,
      provenanceComplete: provenanceCompleteCount,
      provenanceCompleteness: safeRatio(
        provenanceCompleteCount,
        opportunityResults.length,
      ),
      rcrImprovement:
        baselineRcr === 0
          ? 0
          : (baselineRcr - contextRcr) / baselineRcr,
      wrongInjectionRate: safeRatio(
        wrongInjections,
        allResults.length,
      ),
      wrongInjections,
    };
    return {
      evidenceKind: "synthetic",
      evaluationPurpose: "regression",
      fieldEffect: "not_established",
      datasetId: parsed.datasetId,
      datasetVersion: parsed.datasetVersion,
      metrics,
      negativeCases: negativeResults,
      opportunities: opportunityResults,
      status:
        metrics.opportunityCount >= thresholds.minimumOpportunities &&
        metrics.rcrImprovement >= thresholds.rcrImprovement &&
        metrics.provenanceCompleteness >=
          thresholds.provenanceCompleteness &&
        metrics.evidenceTierAccuracy >=
          thresholds.evidenceTierAccuracy &&
        metrics.counterevidenceCases > 0 &&
        metrics.counterevidenceStopped ===
          metrics.counterevidenceCases &&
        metrics.wrongInjectionRate <=
          thresholds.wrongInjectionRate &&
        metrics.degradedRetrievals === 0 &&
        metrics.matchedCases === metrics.caseCount
          ? "pass"
          : "fail",
      thresholds,
    };
  } finally {
    await backend.closeAsync();
    store.close();
  }
};

const percent = (value: number): string =>
  `${(value * 100).toFixed(2)}%`;

const markdownTableCell = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/gu, " ");

export const renderCorrectionRecurrenceReport = (
  report: CorrectionRecurrenceEvaluationReport,
): string => [
  "# Correction Recurrence Evaluation",
  "",
  "Synthetic regression only. Frozen traces and qualified outcomes are not evidence of real-world learning or causal benefit.",
  "",
  `- Dataset: \`${report.datasetId}\` v${report.datasetVersion}`,
  `- Status: **${report.status.toUpperCase()}**`,
  `- Independent Opportunities: ${report.metrics.opportunityCount}`,
  `- Baseline RCR: ${percent(report.metrics.baselineRcr)}`,
  `- Context RCR: ${percent(report.metrics.contextRcr)}`,
  `- RCR improvement: ${percent(report.metrics.rcrImprovement)}`,
  `- Knowledge provenance completeness: ${percent(report.metrics.provenanceCompleteness)}`,
  `- Evidence Tier accuracy: ${percent(report.metrics.evidenceTierAccuracy)}`,
  `- Direct counterevidence stopped: ${report.metrics.counterevidenceStopped}/${report.metrics.counterevidenceCases}`,
  `- Wrong Injection: ${report.metrics.wrongInjections} (${percent(report.metrics.wrongInjectionRate)})`,
  "",
  "| Case | Expected Tier | Actual Tier | Returned | Unexpected | Provenance | Match |",
  "|---|---|---|---:|---:|---:|---:|",
  ...report.opportunities.map(
    (result) =>
      `| ${markdownTableCell(result.caseId)} | ${markdownTableCell(result.expectedEvidenceTier)} | ${markdownTableCell(result.actualEvidenceTier ?? "missing")} | ${result.returnedKnowledgeIds.length} | ${result.unexpectedKnowledgeIds.length} | ${result.provenanceComplete ? "complete" : "incomplete"} | ${result.matched ? "yes" : "no"} |`,
  ),
  "",
  "| Negative Case | Scenario | State | Tier | Returned | Unexpected | Counter stopped | Match |",
  "|---|---|---|---|---:|---:|---:|---:|",
  ...report.negativeCases.map(
    (result) =>
      `| ${markdownTableCell(result.caseId)} | ${markdownTableCell(result.scenario)} | ${markdownTableCell(result.candidateState ?? "missing")} | ${markdownTableCell(result.actualEvidenceTier ?? "missing")} | ${result.returnedKnowledgeIds.length} | ${result.unexpectedKnowledgeIds.length} | ${result.counterevidenceStopped ? "yes" : "n/a"} | ${result.matched ? "yes" : "no"} |`,
  ),
  "",
].join("\n");
