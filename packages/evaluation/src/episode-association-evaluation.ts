import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  CURRENT_SCHEMA_VERSION,
  type CaptureEnvelope,
  type EpisodeAssociationStatus,
  type EpisodeGroupingCorrection,
} from "@provenloop/contracts";
import {
  CommitAncestryIndex,
  createCaptureEnvelope,
  WorkEpisodeBuilder,
} from "@provenloop/domain";
import { z } from "zod";

const episodeLabelSchema = z.enum([
  "ambiguous",
  "different",
  "same",
]);

const sessionFixtureSchema = z
  .object({
    ambientCommitSha: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    changedFile: z.string().min(1).optional(),
    commitSha: z.string().min(1).optional(),
    goal: z.string().min(1).optional(),
    issueId: z.string().min(1).optional(),
    pullRequestId: z.string().min(1).optional(),
    readFile: z.string().min(1).optional(),
    repoId: z.string().min(1),
    sessionId: z.string().min(1),
    startedAt: z.string().datetime({
      offset: true,
    }),
    testOrError: z.string().min(1).optional(),
  })
  .strict();

const ancestryEdgeSchema = z
  .object({
    childCommit: z.string().min(1),
    parentCommit: z.string().min(1),
    repoId: z.string().min(1),
  })
  .strict();

const episodeAssociationCaseSchema = z
  .object({
    ancestry: z.array(ancestryEdgeSchema).default([]),
    caseId: z.string().min(1),
    correction: z.enum([
      "merge",
      "split",
    ]).optional(),
    label: episodeLabelSchema,
    left: sessionFixtureSchema,
    right: sessionFixtureSchema,
  })
  .strict();

export const episodeAssociationDatasetSchema = z
  .object({
    evidenceKind: z.literal("synthetic").default("synthetic"),
    evaluationPurpose: z.literal("regression").default("regression"),
    cases: z.array(episodeAssociationCaseSchema).min(20).max(50),
    datasetId: z.string().min(1),
    datasetVersion: z.number().int().positive(),
  })
  .strict();

export type EpisodeAssociationDataset = z.infer<
  typeof episodeAssociationDatasetSchema
>;
export type EpisodeAssociationLabel = z.infer<
  typeof episodeLabelSchema
>;

export interface EpisodeAssociationCaseResult {
  readonly caseId: string;
  readonly confidence: number;
  readonly expected: EpisodeAssociationLabel;
  readonly matched: boolean | null;
  readonly predicted: EpisodeAssociationLabel;
  readonly status: EpisodeAssociationStatus;
}

export interface EpisodeAssociationMetrics {
  readonly ambiguousCases: number;
  readonly ambiguousForced: number;
  readonly candidates: number;
  readonly falseNegatives: number;
  readonly falsePositives: number;
  readonly negativeCases: number;
  readonly positiveCases: number;
  readonly precision: number;
  readonly recall: number;
  readonly scoredCases: number;
  readonly trueNegatives: number;
  readonly truePositives: number;
  readonly wrongMergeRate: number;
  readonly wrongMerges: number;
  readonly wrongSplitRate: number;
  readonly wrongSplits: number;
}

export interface EpisodeAssociationEvaluationReport {
  readonly cases: readonly EpisodeAssociationCaseResult[];
  readonly datasetId: string;
  readonly datasetVersion: number;
  readonly metrics: EpisodeAssociationMetrics;
  readonly status: "fail" | "pass";
  readonly thresholds: {
    readonly precision: number;
    readonly recall: number;
  };
}

export interface EpisodeAssociationEvaluationOptions {
  readonly precisionThreshold?: number;
  readonly recallThreshold?: number;
}

const builtInDatasetPath = fileURLToPath(
  new URL(
    "../fixtures/work-episode-association-v1.json",
    import.meta.url,
  ),
);

const offsetTimestamp = (
  timestamp: string,
  seconds: number,
): string =>
  new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();

const sessionEvents = (
  caseId: string,
  side: "left" | "right",
  fixture: z.infer<typeof sessionFixtureSchema>,
): readonly CaptureEnvelope[] => {
  let sequence = 0;
  const next = (
    eventType: string,
    options: {
      readonly commitSha?: string;
      readonly message?: string;
      readonly toolArguments?: Readonly<Record<string, string>>;
      readonly trust?: "system" | "tool" | "user" | "model";
    } = {},
  ): CaptureEnvelope => {
    const sourceEventId = `${caseId}-${side}-${sequence += 1}`;
    return createCaptureEnvelope({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      ...(fixture.branch === undefined
        ? {}
        : {
            branch: fixture.branch,
          }),
      ...(options.commitSha === undefined
        ? {}
        : {
            commitSha: options.commitSha,
          }),
      ...(options.message === undefined &&
      options.toolArguments === undefined
        ? {}
        : {
            content: {
              ...(options.message === undefined
                ? {}
                : {
                    message: options.message,
                  }),
              ...(options.toolArguments === undefined
                ? {}
                : {
                    toolArguments: options.toolArguments,
                  }),
            },
          }),
      eventType,
      repoId: fixture.repoId,
      sessionId: fixture.sessionId,
      sourceEventId,
      timestamp: offsetTimestamp(fixture.startedAt, sequence),
      trust: options.trust ?? "system",
    });
  };
  const events: CaptureEnvelope[] = [];
  if (fixture.goal !== undefined) {
    events.push(
      next("prompt.submitted", {
        ...(fixture.ambientCommitSha === undefined
          ? {}
          : {
              commitSha: fixture.ambientCommitSha,
            }),
        message: fixture.goal,
        trust: "user",
      }),
    );
  }
  if (fixture.commitSha !== undefined) {
    events.push(
      next("git.commit", {
        commitSha: fixture.commitSha,
      }),
    );
  }
  if (fixture.changedFile !== undefined) {
    events.push(
      next("file.changed", {
        message: fixture.changedFile,
      }),
    );
  }
  if (fixture.readFile !== undefined) {
    events.push(
      next("tool.started", {
        toolArguments: {
          path: fixture.readFile,
        },
        trust: "tool",
      }),
    );
  }
  if (fixture.issueId !== undefined) {
    events.push(
      next("issue.linked", {
        message: `Issue #${fixture.issueId}`,
      }),
    );
  }
  if (fixture.pullRequestId !== undefined) {
    events.push(
      next("pull_request.updated", {
        message: `PR #${fixture.pullRequestId}`,
      }),
    );
  }
  if (fixture.testOrError !== undefined) {
    events.push(
      next("session.error", {
        message: fixture.testOrError,
      }),
    );
  }
  if (fixture.goal === undefined) {
    // This fixture isolates association signals. Synthetic assistant activity
    // satisfies the work gate without adding user-goal tokens or real evidence.
    events.push(next("agent.message", {
      message: "Synthetic work activity for the association-only fixture.",
      trust: "model",
    }));
  }
  return events;
};

const prediction = (
  status: EpisodeAssociationStatus,
): EpisodeAssociationLabel =>
  status === "associated"
    ? "same"
    : status === "candidate"
      ? "ambiguous"
      : "different";

const safeRatio = (
  numerator: number,
  denominator: number,
): number => denominator === 0 ? 0 : numerator / denominator;

const threshold = (
  value: number | undefined,
  fallback: number,
  name: string,
): number => {
  const resolved = value ?? fallback;
  if (
    !Number.isFinite(resolved) ||
    resolved < 0 ||
    resolved > 1
  ) {
    throw new RangeError(`${name} must be between 0 and 1.`);
  }
  return resolved;
};

export const loadEpisodeAssociationDataset = async (
  path = builtInDatasetPath,
): Promise<EpisodeAssociationDataset> =>
  episodeAssociationDatasetSchema.parse(
    JSON.parse(await readFile(path, "utf8")) as unknown,
  );

export const evaluateEpisodeAssociationDataset = (
  dataset: EpisodeAssociationDataset,
  options: EpisodeAssociationEvaluationOptions = {},
): EpisodeAssociationEvaluationReport => {
  const parsed = episodeAssociationDatasetSchema.parse(dataset);
  const precisionThreshold = threshold(
    options.precisionThreshold,
    0.95,
    "precisionThreshold",
  );
  const recallThreshold = threshold(
    options.recallThreshold,
    0.9,
    "recallThreshold",
  );
  const results = parsed.cases.map(
    (testCase): EpisodeAssociationCaseResult => {
      const correction:
        readonly EpisodeGroupingCorrection[] =
        testCase.correction === undefined
          ? []
          : [
              {
                schemaVersion: CURRENT_SCHEMA_VERSION,
                action: testCase.correction,
                correctionId: `${testCase.caseId}-correction`,
                sessionIds: [
                  testCase.left.sessionId,
                  testCase.right.sessionId,
                ],
                timestamp: offsetTimestamp(
                  testCase.right.startedAt,
                  60,
                ),
              },
            ];
      const result = new WorkEpisodeBuilder({
        commitAncestry: new CommitAncestryIndex(
          testCase.ancestry,
        ),
      }).build(
        [
          ...sessionEvents(testCase.caseId, "left", testCase.left),
          ...sessionEvents(testCase.caseId, "right", testCase.right),
        ],
        correction,
      );
      const association = result.associations[0];
      if (association === undefined) {
        throw new Error(
          `Evaluation case ${testCase.caseId} did not produce an association.`,
        );
      }
      const predicted = prediction(association.status);
      return {
        caseId: testCase.caseId,
        confidence: association.confidence,
        expected: testCase.label,
        matched:
          testCase.label === "ambiguous"
            ? null
            : testCase.label === "same"
              ? predicted === "same"
              : predicted !== "same",
        predicted,
        status: association.status,
      };
    },
  );
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;
  let ambiguousCases = 0;
  let ambiguousForced = 0;
  let candidates = 0;
  for (const result of results) {
    if (result.predicted === "ambiguous") {
      candidates += 1;
    }
    if (result.expected === "ambiguous") {
      ambiguousCases += 1;
      if (result.predicted !== "ambiguous") {
        ambiguousForced += 1;
      }
      continue;
    }
    if (result.expected === "same") {
      if (result.predicted === "same") {
        truePositives += 1;
      } else {
        falseNegatives += 1;
      }
      continue;
    }
    if (result.predicted === "same") {
      falsePositives += 1;
    } else {
      trueNegatives += 1;
    }
  }
  const precision = safeRatio(
    truePositives,
    truePositives + falsePositives,
  );
  const recall = safeRatio(
    truePositives,
    truePositives + falseNegatives,
  );
  const metrics: EpisodeAssociationMetrics = {
    ambiguousCases,
    ambiguousForced,
    candidates,
    falseNegatives,
    falsePositives,
    negativeCases: trueNegatives + falsePositives,
    positiveCases: truePositives + falseNegatives,
    precision,
    recall,
    scoredCases:
      truePositives +
      falsePositives +
      trueNegatives +
      falseNegatives,
    trueNegatives,
    truePositives,
    wrongMergeRate: safeRatio(
      falsePositives,
      trueNegatives + falsePositives,
    ),
    wrongMerges: falsePositives,
    wrongSplitRate: safeRatio(
      falseNegatives,
      truePositives + falseNegatives,
    ),
    wrongSplits: falseNegatives,
  };
  return {
    cases: results,
    datasetId: parsed.datasetId,
    datasetVersion: parsed.datasetVersion,
    metrics,
    status:
      precision >= precisionThreshold &&
      recall >= recallThreshold &&
      falsePositives === 0 &&
      truePositives + falseNegatives > 0 &&
      trueNegatives + falsePositives > 0 &&
      ambiguousForced === 0
        ? "pass"
        : "fail",
    thresholds: {
      precision: precisionThreshold,
      recall: recallThreshold,
    },
  };
};

export const renderEpisodeAssociationReport = (
  report: EpisodeAssociationEvaluationReport,
): string => [
  `# Work Episode Association Evaluation`,
  "",
  `- Dataset: \`${report.datasetId}\` v${report.datasetVersion}`,
  `- Status: **${report.status.toUpperCase()}**`,
  `- Precision: ${(report.metrics.precision * 100).toFixed(2)}%`,
  `- Recall: ${(report.metrics.recall * 100).toFixed(2)}%`,
  `- Wrong merges: ${report.metrics.wrongMerges}`,
  `- Wrong splits: ${report.metrics.wrongSplits}`,
  `- Ambiguous cases: ${report.metrics.ambiguousCases}`,
  `- Ambiguous cases forced to a decision: ${report.metrics.ambiguousForced}`,
  `- Candidate predictions: ${report.metrics.candidates}`,
  `- Scored cases: ${report.metrics.scoredCases}`,
  "",
  "| Case | Expected | Predicted | Confidence |",
  "|---|---|---|---:|",
  ...report.cases.map(
    (result) =>
      `| ${result.caseId} | ${result.expected} | ${result.predicted} | ${result.confidence.toFixed(3)} |`,
  ),
  "",
].join("\n");
