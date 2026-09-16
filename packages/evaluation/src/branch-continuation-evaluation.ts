import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  CURRENT_SCHEMA_VERSION,
  type BranchContext,
} from "@provenloop/contracts";
import {
  containsPotentialSecret,
} from "@provenloop/domain";
import {
  ContextRetrievalService,
  type KnowledgeBackend,
} from "@provenloop/retrieval";
import {
  CanonicalSqliteStore,
} from "@provenloop/storage-sqlite";
import { z } from "zod";

const branchContinuationScenarioSchema = z.enum([
  "branch_mismatch",
  "exact",
  "expired",
  "head_mismatch",
  "missing_branch",
  "missing_head",
  "missing_repo",
  "new_task",
  "no_context",
  "repository_mismatch",
  "token_budget_exceeded",
]);

const observationSchema = z
  .object({
    outcomeSucceeded: z.boolean(),
    repeatedContextTokens: z.number().int().nonnegative(),
    ttvMs: z.number().finite().positive(),
  })
  .strict();

const observationOverrideSchema = observationSchema.partial().strict();

const branchContinuationCaseSchema = z
  .object({
    caseId: z.string().min(1),
    expectedRelevant: z.boolean(),
    goal: z.string().min(1),
    observation: observationOverrideSchema.optional(),
    prompt: z.string().min(1),
    scenario: branchContinuationScenarioSchema,
    tokenBudget: z.number().int().positive().optional(),
  })
  .strict();

export const branchContinuationDatasetSchema = z
  .object({
    evidenceKind: z.literal("synthetic").default("synthetic"),
    evaluationPurpose: z.literal("regression").default("regression"),
    cases: z.array(branchContinuationCaseSchema).min(30).max(100),
    datasetId: z.string().min(1),
    datasetVersion: z.number().int().positive(),
    observations: z
      .object({
        applicableContext: observationSchema,
        baseline: observationSchema,
        abstainedContext: observationSchema,
      })
      .strict(),
    tokenBudget: z.number().int().positive(),
  })
  .strict();

export type BranchContinuationDataset = z.infer<
  typeof branchContinuationDatasetSchema
>;
export type BranchContinuationScenario = z.infer<
  typeof branchContinuationScenarioSchema
>;

export interface BranchContinuationCaseResult {
  readonly baselineOutcomeSucceeded: boolean;
  readonly baselineRepeatedContextTokens: number;
  readonly baselineTtvMs: number;
  readonly caseId: string;
  readonly contextOutcomeSucceeded: boolean;
  readonly contextRepeatedContextTokens: number;
  readonly contextTtvMs: number;
  readonly expectedContextIds: readonly string[];
  readonly expectedRelevant: boolean;
  readonly irrelevantReturned: number;
  readonly latencyMs: number;
  readonly matched: boolean;
  readonly relevantReturned: number;
  readonly renderedTokens: number;
  readonly repeatedContextTokenReduction: number;
  readonly retrievalStatus: "degraded" | "muted" | "ok";
  readonly returnedContextIds: readonly string[];
  readonly scenario: BranchContinuationScenario;
  readonly tokenBudget: number;
  readonly ttvReduction?: number;
}

export interface BranchContinuationMetrics {
  readonly baselineOutcomeSuccessRate: number;
  readonly caseCount: number;
  readonly contextOutcomeSuccessRate: number;
  readonly degradedRetrievals: number;
  readonly irrelevantReturned: number;
  readonly latencyP95Ms: number;
  readonly matchedCases: number;
  readonly missedUsefulContexts: number;
  readonly negativeAbstention: number;
  readonly negativeCases: number;
  readonly outcomeSuccessDelta: number;
  readonly positiveCases: number;
  readonly precisionAt3: number;
  readonly relevantReturned: number;
  readonly repeatedContextTokenMedianReduction: number;
  readonly tokenBudgetViolations: number;
  readonly ttvComparableCases: number;
  readonly ttvMedianReduction: number;
  readonly usefulContextMissRate: number;
  readonly wrongInjectionRate: number;
  readonly wrongInjections: number;
}

export interface BranchContinuationEvaluationReport {
  readonly evidenceKind: "synthetic";
  readonly evaluationPurpose: "regression";
  readonly fieldEffect: "not_established";
  readonly cases: readonly BranchContinuationCaseResult[];
  readonly datasetId: string;
  readonly datasetVersion: number;
  readonly metrics: BranchContinuationMetrics;
  readonly status: "fail" | "pass";
  readonly thresholds: {
    readonly latencyP95Ms: number;
    readonly minimumPairs: number;
    readonly outcomeSuccessDelta: number;
    readonly precisionAt3: number;
    readonly repeatedContextTokenMedianReduction: number;
    readonly ttvMedianReduction: number;
    readonly wrongInjectionRate: number;
  };
}

export interface BranchContinuationEvaluationOptions {
  readonly databasePath: string;
  readonly latencyP95ThresholdMs?: number;
  readonly minimumPairs?: number;
  readonly outcomeSuccessDeltaThreshold?: number;
  readonly precisionAt3Threshold?: number;
  readonly repeatedContextTokenReductionThreshold?: number;
  readonly ttvReductionThreshold?: number;
  readonly wrongInjectionThreshold?: number;
}

const builtInDatasetPath = fileURLToPath(
  new URL(
    "../fixtures/branch-continuation-v1.json",
    import.meta.url,
  ),
);

const evaluationNow = new Date("2026-09-01T00:00:00.000Z");

const emptyKnowledgeBackend: KnowledgeBackend = {
  get: async () => undefined,
  health: async () => ({
    fts5Available: true,
    quickCheck: "ok",
    recordCount: 0,
    status: "healthy",
  }),
  index: async () => undefined,
  rebuild: async () => undefined,
  remove: async () => undefined,
  search: async () => [],
};

const safeRatio = (
  numerator: number,
  denominator: number,
): number => denominator === 0 ? 0 : numerator / denominator;

const median = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
};

const percentile = (
  values: readonly number[],
  quantile: number,
): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.ceil(quantile * sorted.length) - 1,
  );
  return sorted[index] ?? 0;
};

const thresholdRatio = (
  value: number | undefined,
  fallback: number,
  name: string,
  minimum = 0,
): number => {
  const resolved = value ?? fallback;
  if (
    !Number.isFinite(resolved) ||
    resolved < minimum ||
    resolved > 1
  ) {
    throw new RangeError(
      `${name} must be between ${minimum} and 1.`,
    );
  }
  return resolved;
};

const thresholdPositive = (
  value: number | undefined,
  fallback: number,
  name: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be positive.`);
  }
  return resolved;
};

const contextIdentity = (
  testCase: z.infer<typeof branchContinuationCaseSchema>,
): {
  readonly branch: string;
  readonly contextId: string;
  readonly headSha: string;
  readonly repoId: string;
} => ({
  branch: `feat/${testCase.caseId}`,
  contextId: `branch-context-${testCase.caseId}`,
  headSha: `head-${testCase.caseId}`,
  repoId: `repo-${testCase.caseId}`,
});

const contextForCase = (
  testCase: z.infer<typeof branchContinuationCaseSchema>,
): BranchContext | undefined => {
  if (testCase.scenario === "no_context") {
    return undefined;
  }
  const identity = contextIdentity(testCase);
  const oversizedGoal =
    testCase.scenario === "token_budget_exceeded"
      ? Array.from({
          length: 80,
        }, () => testCase.goal).join(" ")
      : testCase.goal;
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    acceptedDecisions: [
      `Continue ${testCase.goal} from verified state.`,
    ],
    branch:
      testCase.scenario === "branch_mismatch"
        ? `${identity.branch}-other`
        : identity.branch,
    branchContextId: identity.contextId,
    expiresAt:
      testCase.scenario === "expired"
        ? "2026-08-31T23:59:59.000Z"
        : "2026-09-30T00:00:00.000Z",
    explicitConstraints: [
      "Preserve repository and branch scope.",
    ],
    goal: oversizedGoal,
    headSha:
      testCase.scenario === "head_mismatch"
        ? `${identity.headSha}-other`
        : identity.headSha,
    implementationState: [
      "The previous session completed its declared verification.",
    ],
    recentVerificationEvidenceIds: [],
    repoId:
      testCase.scenario === "repository_mismatch"
        ? `${identity.repoId}-other`
        : identity.repoId,
    sourceEpisodeIds: ["episode-" + testCase.caseId],
    sourceEventIds: [],
    sourceSessionIds: ["previous-session-" + testCase.caseId],
    unfinishedItems: [
      `Finish ${testCase.goal}.`,
    ],
    updatedAt: "2026-08-31T23:00:00.000Z",
  };
};

const observationForCase = (
  dataset: BranchContinuationDataset,
  testCase: z.infer<typeof branchContinuationCaseSchema>,
): {
  readonly baseline: z.infer<typeof observationSchema>;
  readonly context: z.infer<typeof observationSchema>;
} => {
  const defaultContext =
    testCase.expectedRelevant
      ? dataset.observations.applicableContext
      : dataset.observations.abstainedContext;
  return {
    baseline: dataset.observations.baseline,
    context: {
      outcomeSucceeded:
        testCase.observation?.outcomeSucceeded ??
        defaultContext.outcomeSucceeded,
      repeatedContextTokens:
        testCase.observation?.repeatedContextTokens ??
        defaultContext.repeatedContextTokens,
      ttvMs:
        testCase.observation?.ttvMs ??
        defaultContext.ttvMs,
    },
  };
};

export const loadBranchContinuationDataset = async (
  path = builtInDatasetPath,
): Promise<BranchContinuationDataset> =>
  branchContinuationDatasetSchema.parse(
    JSON.parse(await readFile(path, "utf8")) as unknown,
  );

export const evaluateBranchContinuationDataset = async (
  dataset: BranchContinuationDataset,
  options: BranchContinuationEvaluationOptions,
): Promise<BranchContinuationEvaluationReport> => {
  const parsed = branchContinuationDatasetSchema.parse(dataset);
  if (
    parsed.cases.some((testCase) =>
      [
        testCase.caseId,
        testCase.goal,
        testCase.prompt,
      ].some(containsPotentialSecret),
    )
  ) {
    throw new Error(
      "Branch Continuation dataset contains a potential secret.",
    );
  }
  const thresholds = {
    latencyP95Ms: thresholdPositive(
      options.latencyP95ThresholdMs,
      150,
      "latencyP95ThresholdMs",
    ),
    minimumPairs: thresholdPositive(
      options.minimumPairs,
      30,
      "minimumPairs",
    ),
    outcomeSuccessDelta: thresholdRatio(
      options.outcomeSuccessDeltaThreshold,
      -0.02,
      "outcomeSuccessDeltaThreshold",
      -1,
    ),
    precisionAt3: thresholdRatio(
      options.precisionAt3Threshold,
      0.9,
      "precisionAt3Threshold",
    ),
    repeatedContextTokenMedianReduction: thresholdRatio(
      options.repeatedContextTokenReductionThreshold,
      0.3,
      "repeatedContextTokenReductionThreshold",
    ),
    ttvMedianReduction: thresholdRatio(
      options.ttvReductionThreshold,
      0.15,
      "ttvReductionThreshold",
    ),
    wrongInjectionRate: thresholdRatio(
      options.wrongInjectionThreshold,
      0.02,
      "wrongInjectionThreshold",
    ),
  };
  const store = new CanonicalSqliteStore(options.databasePath, {
    now: () => evaluationNow,
  });
  try {
    store.replaceBranchContextProjection({
      contexts: parsed.cases.flatMap((testCase) => {
        const context = contextForCase(testCase);
        return context === undefined ? [] : [context];
      }),
    });
    const results: BranchContinuationCaseResult[] = [];
    for (const testCase of parsed.cases) {
      const identity = contextIdentity(testCase);
      const expectedContextIds = testCase.expectedRelevant
        ? [identity.contextId]
        : [];
      const service = new ContextRetrievalService({
        backend: emptyKnowledgeBackend,
        clockMs: () => performance.now(),
        idGenerator: () => `request-${testCase.caseId}`,
        now: () => evaluationNow,
        store,
      });
      const tokenBudget =
        testCase.scenario === "token_budget_exceeded"
          ? 20
          : testCase.tokenBudget ?? parsed.tokenBudget;
      const response = await service.context({
        // These synthetic pairs model an explicit resume from a previous
        // session. Authorization is independent of the relevance label so a
        // mislabeled positive still exposes a wrong injection in evaluation.
        ...(testCase.scenario === "new_task" ? {} : { continuationEpisodeId: "episode-" + testCase.caseId }),
        ...(testCase.scenario === "missing_branch"
          ? {}
          : {
              branch: identity.branch,
            }),
        cwd: `C:\\fixtures\\${testCase.caseId}`,
        ...(testCase.scenario === "missing_head"
          ? {}
          : {
              headSha: identity.headSha,
            }),
        prompt: testCase.prompt,
        ...(testCase.scenario === "missing_repo"
          ? {}
          : {
              repoId: identity.repoId,
            }),
        sessionId: `session-${testCase.caseId}`,
        tokenBudget,
      });
      const returnedContextIds = response.items.map((item) => item.id);
      const expectedSet = new Set(expectedContextIds);
      const relevantReturned = returnedContextIds.filter((id) =>
        expectedSet.has(id),
      ).length;
      const irrelevantReturned =
        returnedContextIds.length - relevantReturned;
      const observation = observationForCase(parsed, testCase);
      const repeatedContextTokenReduction =
        (
          observation.baseline.repeatedContextTokens -
          observation.context.repeatedContextTokens
        ) / observation.baseline.repeatedContextTokens;
      const ttvReduction =
        observation.baseline.outcomeSucceeded &&
        observation.context.outcomeSucceeded
          ? (
              observation.baseline.ttvMs -
              observation.context.ttvMs
            ) / observation.baseline.ttvMs
          : undefined;
      results.push({
        baselineOutcomeSucceeded:
          observation.baseline.outcomeSucceeded,
        baselineRepeatedContextTokens:
          observation.baseline.repeatedContextTokens,
        baselineTtvMs: observation.baseline.ttvMs,
        caseId: testCase.caseId,
        contextOutcomeSucceeded:
          observation.context.outcomeSucceeded,
        contextRepeatedContextTokens:
          observation.context.repeatedContextTokens,
        contextTtvMs: observation.context.ttvMs,
        expectedContextIds,
        expectedRelevant: testCase.expectedRelevant,
        irrelevantReturned,
        latencyMs: response.latencyMs,
        matched:
          response.status === "ok" &&
          irrelevantReturned === 0 &&
          expectedContextIds.every((id) =>
            returnedContextIds.includes(id),
          ) &&
          (
            testCase.expectedRelevant ||
            returnedContextIds.length === 0
          ),
        relevantReturned,
        renderedTokens: response.renderedTokens,
        repeatedContextTokenReduction,
        retrievalStatus: response.status,
        returnedContextIds,
        scenario: testCase.scenario,
        tokenBudget,
        ...(ttvReduction === undefined
          ? {}
          : {
              ttvReduction,
            }),
      });
    }
    const positiveCases = results.filter(
      (result) => result.expectedRelevant,
    );
    const negativeCases = results.filter(
      (result) => !result.expectedRelevant,
    );
    const relevantReturned = results.reduce(
      (total, result) => total + result.relevantReturned,
      0,
    );
    const irrelevantReturned = results.reduce(
      (total, result) => total + result.irrelevantReturned,
      0,
    );
    const wrongInjections = results.filter(
      (result) => result.irrelevantReturned > 0,
    ).length;
    const missedUsefulContexts = positiveCases.filter(
      (result) => result.relevantReturned === 0,
    ).length;
    const ttvReductions = results.flatMap((result) =>
      result.ttvReduction === undefined
        ? []
        : [result.ttvReduction],
    );
    const baselineOutcomeSuccessRate = safeRatio(
      results.filter((result) => result.baselineOutcomeSucceeded).length,
      results.length,
    );
    const contextOutcomeSuccessRate = safeRatio(
      results.filter((result) => result.contextOutcomeSucceeded).length,
      results.length,
    );
    const metrics: BranchContinuationMetrics = {
      baselineOutcomeSuccessRate,
      caseCount: results.length,
      contextOutcomeSuccessRate,
      degradedRetrievals: results.filter(
        (result) => result.retrievalStatus !== "ok",
      ).length,
      irrelevantReturned,
      latencyP95Ms: percentile(
        results.map((result) => result.latencyMs),
        0.95,
      ),
      matchedCases: results.filter((result) => result.matched).length,
      missedUsefulContexts,
      negativeAbstention: safeRatio(
        negativeCases.filter(
          (result) => result.returnedContextIds.length === 0,
        ).length,
        negativeCases.length,
      ),
      negativeCases: negativeCases.length,
      outcomeSuccessDelta:
        contextOutcomeSuccessRate - baselineOutcomeSuccessRate,
      positiveCases: positiveCases.length,
      precisionAt3: safeRatio(
        relevantReturned,
        relevantReturned + irrelevantReturned,
      ),
      relevantReturned,
      repeatedContextTokenMedianReduction: median(
        results.map(
          (result) => result.repeatedContextTokenReduction,
        ),
      ),
      tokenBudgetViolations: results.filter(
        (result) => result.renderedTokens > result.tokenBudget,
      ).length,
      ttvComparableCases: ttvReductions.length,
      ttvMedianReduction: median(ttvReductions),
      usefulContextMissRate: safeRatio(
        missedUsefulContexts,
        positiveCases.length,
      ),
      wrongInjectionRate: safeRatio(
        wrongInjections,
        results.length,
      ),
      wrongInjections,
    };
    return {
      evidenceKind: "synthetic",
      evaluationPurpose: "regression",
      fieldEffect: "not_established",
      cases: results,
      datasetId: parsed.datasetId,
      datasetVersion: parsed.datasetVersion,
      metrics,
      status:
        metrics.caseCount >= thresholds.minimumPairs &&
        metrics.repeatedContextTokenMedianReduction >=
          thresholds.repeatedContextTokenMedianReduction &&
        metrics.ttvComparableCases > 0 &&
        metrics.ttvMedianReduction >= thresholds.ttvMedianReduction &&
        metrics.precisionAt3 >= thresholds.precisionAt3 &&
        metrics.wrongInjectionRate <= thresholds.wrongInjectionRate &&
        metrics.outcomeSuccessDelta >= thresholds.outcomeSuccessDelta &&
        metrics.latencyP95Ms <= thresholds.latencyP95Ms &&
        metrics.missedUsefulContexts === 0 &&
        metrics.tokenBudgetViolations === 0 &&
        metrics.degradedRetrievals === 0 &&
        metrics.matchedCases === metrics.caseCount
          ? "pass"
          : "fail",
      thresholds,
    };
  } finally {
    store.close();
  }
};

const percent = (value: number): string =>
  `${(value * 100).toFixed(2)}%`;

export const renderBranchContinuationReport = (
  report: BranchContinuationEvaluationReport,
): string => [
  "# Branch Continuation Evaluation",
  "",
  "Synthetic regression only. Token, TTV and success observations are fixture inputs, not measured user benefits.",
  "",
  `- Dataset: \`${report.datasetId}\` v${report.datasetVersion}`,
  `- Status: **${report.status.toUpperCase()}**`,
  `- Paired tasks: ${report.metrics.caseCount}`,
  `- Repeated Context Token median reduction: ${percent(report.metrics.repeatedContextTokenMedianReduction)}`,
  `- TTV median reduction: ${percent(report.metrics.ttvMedianReduction)}`,
  `- Retrieval Precision@3: ${percent(report.metrics.precisionAt3)}`,
  `- Wrong Injection: ${percent(report.metrics.wrongInjectionRate)}`,
  `- Outcome Success delta: ${percent(report.metrics.outcomeSuccessDelta)}`,
  `- Retrieval latency P95: ${report.metrics.latencyP95Ms.toFixed(2)} ms`,
  `- Useful Context misses: ${report.metrics.missedUsefulContexts}`,
  `- Negative Abstention: ${percent(report.metrics.negativeAbstention)}`,
  `- Token budget violations: ${report.metrics.tokenBudgetViolations}`,
  "",
  "| Case | Scenario | Expected | Returned | Tokens | Latency | Match |",
  "|---|---|---:|---|---:|---:|---:|",
  ...report.cases.map(
    (result) =>
      `| ${result.caseId} | ${result.scenario} | ${result.expectedRelevant} | ${result.returnedContextIds.join(", ") || "none"} | ${result.renderedTokens} | ${result.latencyMs.toFixed(2)} ms | ${result.matched} |`,
  ),
  "",
].join("\n");
