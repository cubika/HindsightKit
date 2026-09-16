import {
  createHash,
  randomUUID,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  join,
  resolve,
} from "node:path";

import { z } from "zod";
import {
  evaluateAutomaticLearningAcceptance,
  loadAutomaticLearningEvidence,
  type AutomaticLearningAcceptanceReport,
} from "./automatic-learning-acceptance.js";

import { sanitizeDiagnostic } from "@provenloop/domain";

import {
  evaluateCorrectionRecurrenceDataset,
  loadCorrectionRecurrenceDataset,
  renderCorrectionRecurrenceReport,
  type CorrectionRecurrenceDataset,
  type CorrectionRecurrenceEvaluationReport,
} from "./correction-recurrence-evaluation.js";
import {
  containsKnownSecret,
  containsPotentialSecret,
  redactKnownSecrets,
  redactPotentialSecrets,
} from "./secret-detection.js";

import {
  loadObservationManifest,
  observationManifestSchema,
  ObservationManifestInputError,
  SYNTHETIC_REGRESSION_LIMITATION,
  type ObservationManifest,
} from "./observation-manifest.js";

export type M2ReleaseTarget = "research" | "stable";
export type M2ReleaseGateStatus = "fail" | "pass";

export interface M2ReleaseGateCheck {
  readonly checkId: string;
  readonly message: string;
  readonly status: M2ReleaseGateStatus;
}

export interface M2ReleaseReport {
  readonly automaticLearning?: AutomaticLearningAcceptanceReport;
  readonly evidenceKind: "synthetic";
  readonly evaluationPurpose: "regression";
  readonly observationEvidence?: ObservationManifest;
  readonly checks: readonly M2ReleaseGateCheck[];
  readonly codeVersion: string;
  readonly completedAt: string;
  readonly correctionRecurrence?: CorrectionRecurrenceEvaluationReport;
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly limitations: readonly string[];
  readonly releaseTarget: M2ReleaseTarget;
  readonly reportVersion: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly status: M2ReleaseGateStatus;
}

export interface RunM2ReleaseGateOptions {
  readonly automaticLearningEvidencePath?: string;
  readonly observationManifestPath?: string;
  readonly codeVersion?: string;
  readonly cwd?: string;
  readonly datasetPath?: string;
  readonly now?: () => Date;
  readonly outputRoot: string;
  readonly releaseTarget?: M2ReleaseTarget;
  readonly runId?: string;
}

export interface RunM2ReleaseGateResult {
  readonly report: M2ReleaseReport;
  readonly runDirectory: string;
}

const m2ReleaseReportSchema = z
  .object({
    automaticLearning: z.unknown().optional(),
    evidenceKind: z.literal("synthetic"),
    evaluationPurpose: z.literal("regression"),
    observationEvidence: observationManifestSchema.optional(),
    checks: z.array(
      z
        .object({
          checkId: z.string().min(1),
          message: z.string().min(1),
          status: z.enum([
            "fail",
            "pass",
          ]),
        })
        .strict(),
    ),
    codeVersion: z.string().min(1),
    completedAt: z.string().datetime({
      offset: true,
    }),
    correctionRecurrence: z.unknown().optional(),
    exitCode: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(3),
    ]),
    limitations: z.array(z.string()),
    releaseTarget: z.enum([
      "research",
      "stable",
    ]),
    reportVersion: z.literal(1),
    runId: z.string().min(1),
    startedAt: z.string().datetime({
      offset: true,
    }),
    status: z.enum([
      "fail",
      "pass",
    ]),
  })
  .strict();

const safeRunIdPattern =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const generatedRunIdPattern =
  /^m2-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const safeCodeVersionPattern =
  /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/u;
const gitCodeVersionPattern =
  /^(?:[a-f0-9]{7,40}|[a-f0-9]{64})(?:-dirty|\+dirty\.[a-f0-9]{16})?$/iu;

class M2InputError extends Error {
  public override readonly name = "M2InputError";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

class M2RunAlreadyExistsError extends Error {
  public readonly code = "EEXIST";
  public override readonly name = "M2RunAlreadyExistsError";
  public readonly path: string;

  public constructor(path: string) {
    super(`M2 run directory already exists: ${path}`);
    this.path = path;
  }
}

const datasetInputErrorMessage = (error: unknown): string => {
  if (error instanceof SyntaxError) {
    return "M2 dataset JSON is invalid.";
  }
  if (error instanceof z.ZodError) {
    return "M2 dataset schema is invalid.";
  }
  if (
    error instanceof Error &&
    "code" in error &&
    (
      error.code === "EACCES" ||
      error.code === "ENOENT" ||
      error.code === "EPERM"
    )
  ) {
    return "M2 dataset file could not be read.";
  }
  return "M2 dataset is invalid.";
};

const sanitizePublishedDiagnostic = (
  value: unknown,
): string =>
  redactPotentialSecrets(
    sanitizeDiagnostic(value),
  )
    .replaceAll(
      /file:\/\/\/[A-Za-z]:\/[^\s"'<>)]*/giu,
      "[path]",
    )
    .replaceAll(
      /(?:[A-Za-z]:\\|\\\\)[^\r\n"'<>]*/gu,
      "[path]",
    )
    .replaceAll(/\r?\n/gu, " ")
    .trim();

const escapeMarkdownText = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(
      /([`*_{}[\]()+#.!|])/gu,
      "\\$1",
    )
    .replaceAll(/\r?\n/gu, " ");

const assertRunDirectoryAvailable = async (
  runDirectory: string,
): Promise<void> => {
  try {
    await stat(runDirectory);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  throw new M2RunAlreadyExistsError(runDirectory);
};

const validateRunId = (runId: string): string => {
  if (
    !safeRunIdPattern.test(runId) ||
    containsKnownSecret(runId) ||
    (
      !generatedRunIdPattern.test(runId) &&
      containsPotentialSecret(runId)
    )
  ) {
    throw new Error("M2 runId must be a safe non-secret path segment.");
  }
  return runId;
};

const validateCodeVersion = (codeVersion: string): string => {
  if (
    !safeCodeVersionPattern.test(codeVersion) ||
    containsKnownSecret(codeVersion) ||
    (
      !gitCodeVersionPattern.test(codeVersion) &&
      containsPotentialSecret(codeVersion)
    )
  ) {
    throw new M2InputError(
      "M2 codeVersion must be a safe non-secret Git version.",
    );
  }
  return codeVersion;
};

const gitOutput = (
  args: readonly string[],
  cwd: string,
): Buffer => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail =
      result.error?.message ??
      result.stderr.toString("utf8").trim() ??
      `exit ${result.status ?? "unknown"}`;
    throw new Error(
      `Git provenance command failed (${args.join(" ")}): ${detail}`,
    );
  }
  return result.stdout;
};

const updateFramedDigest = (
  digest: ReturnType<typeof createHash>,
  label: string,
  value: Buffer | string,
): void => {
  const bytes =
    typeof value === "string"
      ? Buffer.from(value, "utf8")
      : value;
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  digest.update(label, "utf8");
  digest.update("\u0000", "utf8");
  digest.update(length);
  digest.update(bytes);
};

export const resolveLearningEvaluationCodeVersion = async (
  cwd: string,
): Promise<string> => {
  const head = gitOutput([
    "rev-parse",
    "HEAD",
  ], cwd).toString("utf8").trim();
  if (!head) {
    return "unknown";
  }
  const status = gitOutput([
    "status",
    "--porcelain=v1",
    "-z",
  ], cwd);
  if (status.length === 0) {
    return head;
  }
  const digest = createHash("sha256");
  updateFramedDigest(digest, "status", status);
  updateFramedDigest(
    digest,
    "tracked-diff",
    gitOutput([
      "diff",
      "--binary",
      "HEAD",
    ], cwd),
  );
  const untracked = gitOutput([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ], cwd);
  for (
    const path of untracked
      .toString("utf8")
      .split("\u0000")
      .filter((value) => value.length > 0)
      .sort()
  ) {
    updateFramedDigest(digest, "untracked-path", path);
    updateFramedDigest(
      digest,
      "untracked-content",
      await readFile(resolve(cwd, path)),
    );
  }
  return `${head}+dirty.${digest.digest("hex").slice(0, 16)}`;
};

const percent = (value: number): string =>
  `${(value * 100).toFixed(2)}%`;

const checksFor = (
  report: CorrectionRecurrenceEvaluationReport,
): readonly M2ReleaseGateCheck[] => [
  {
    checkId: "correction-opportunities",
    message:
      `${report.metrics.opportunityCount} independent Correction Opportunities were evaluated.`,
    status:
      report.metrics.opportunityCount >=
        report.thresholds.minimumOpportunities
        ? "pass"
        : "fail",
  },
  {
    checkId: "correction-recurrence",
    message:
      `RCR improved ${percent(report.metrics.rcrImprovement)} from ${percent(report.metrics.baselineRcr)} to ${percent(report.metrics.contextRcr)}.`,
    status:
      report.metrics.rcrImprovement >=
        report.thresholds.rcrImprovement
        ? "pass"
        : "fail",
  },
  {
    checkId: "knowledge-provenance",
    message:
      `${report.metrics.provenanceComplete}/${report.metrics.opportunityCount} Knowledge proof chains were complete (${percent(report.metrics.provenanceCompleteness)}).`,
    status:
      report.metrics.provenanceCompleteness >=
        report.thresholds.provenanceCompleteness
        ? "pass"
        : "fail",
  },
  {
    checkId: "evidence-tier-accuracy",
    message:
      `${report.metrics.evidenceTierCorrect}/${report.metrics.evidenceTierCaseCount} Evidence Tier labels were correct (${percent(report.metrics.evidenceTierAccuracy)}).`,
    status:
      report.metrics.evidenceTierAccuracy >=
        report.thresholds.evidenceTierAccuracy
        ? "pass"
        : "fail",
  },
  {
    checkId: "negative-scenario-coverage",
    message:
      `${new Set(report.negativeCases.map((testCase) => testCase.scenario)).size}/3 required negative scenarios were replayed.`,
    status:
      [
        "counterevidence",
        "scope_mismatch",
        "unverified",
      ].every((scenario) =>
        report.negativeCases.some(
          (testCase) => testCase.scenario === scenario,
        ),
      )
        ? "pass"
        : "fail",
  },
  {
    checkId: "direct-counterevidence",
    message:
      `${report.metrics.counterevidenceStopped}/${report.metrics.counterevidenceCases} direct counterevidence cases stopped automatic injection.`,
    status:
      report.metrics.counterevidenceCases > 0 &&
      report.metrics.counterevidenceStopped ===
        report.metrics.counterevidenceCases
        ? "pass"
        : "fail",
  },
  {
    checkId: "wrong-injection",
    message:
      `${report.metrics.wrongInjections} wrong injections (${percent(report.metrics.wrongInjectionRate)}).`,
    status:
      report.metrics.wrongInjectionRate <=
        report.thresholds.wrongInjectionRate
        ? "pass"
        : "fail",
  },
  {
    checkId: "replay-fidelity",
    message:
      `${report.metrics.matchedCases}/${report.metrics.caseCount} cases matched with ${report.metrics.degradedRetrievals} degraded retrievals.`,
    status:
      report.metrics.matchedCases === report.metrics.caseCount &&
      report.metrics.degradedRetrievals === 0
        ? "pass"
        : "fail",
  },
];

const sanitizeM2Report = (
  report: M2ReleaseReport,
): M2ReleaseReport => {
  const correctionRecurrence =
    report.correctionRecurrence === undefined
      ? undefined
      : {
          ...report.correctionRecurrence,
          datasetId: redactKnownSecrets(
            report.correctionRecurrence.datasetId,
          ),
          negativeCases:
            report.correctionRecurrence.negativeCases.map(
              (testCase) => ({
                ...testCase,
                caseId: redactKnownSecrets(testCase.caseId),
                returnedKnowledgeIds:
                  testCase.returnedKnowledgeIds.map(
                    redactKnownSecrets,
                  ),
                unexpectedKnowledgeIds:
                  testCase.unexpectedKnowledgeIds.map(
                    redactKnownSecrets,
                  ),
                ...(testCase.statusDetail === undefined
                  ? {}
                  : {
                      statusDetail: sanitizePublishedDiagnostic(
                        testCase.statusDetail,
                      ),
                    }),
                ...(testCase.knowledgeId === undefined
                  ? {}
                  : {
                      knowledgeId: redactKnownSecrets(
                        testCase.knowledgeId,
                      ),
                    }),
              }),
            ),
          opportunities:
            report.correctionRecurrence.opportunities.map(
              (testCase) => ({
                ...testCase,
                caseId: redactKnownSecrets(testCase.caseId),
                returnedKnowledgeIds:
                  testCase.returnedKnowledgeIds.map(
                    redactKnownSecrets,
                  ),
                unexpectedKnowledgeIds:
                  testCase.unexpectedKnowledgeIds.map(
                    redactKnownSecrets,
                  ),
                ...(testCase.statusDetail === undefined
                  ? {}
                  : {
                      statusDetail: sanitizePublishedDiagnostic(
                        testCase.statusDetail,
                      ),
                    }),
                ...(testCase.knowledgeId === undefined
                  ? {}
                  : {
                      knowledgeId: redactKnownSecrets(
                        testCase.knowledgeId,
                      ),
                    }),
              }),
            ),
        };
  return {
    ...report,
    checks: report.checks.map((check) => ({
      checkId: redactKnownSecrets(check.checkId),
      message: sanitizePublishedDiagnostic(check.message),
      status: check.status,
    })),
    codeVersion: redactKnownSecrets(report.codeVersion),
    limitations: report.limitations.map(
      sanitizePublishedDiagnostic,
    ),
    runId: redactKnownSecrets(report.runId),
    ...(correctionRecurrence === undefined
      ? {}
      : {
          correctionRecurrence,
        }),
  };
};

const renderM2ReleaseReport = (
  report: M2ReleaseReport,
): string => {
  const checks = report.checks.map(
    (check) =>
      `| ${escapeMarkdownText(check.checkId)} | ${check.status} | ${escapeMarkdownText(check.message)} |`,
  );
  const correctionRecurrence =
    report.correctionRecurrence === undefined
      ? "- Unavailable"
      : renderCorrectionRecurrenceReport(
          report.correctionRecurrence,
        );
  return `# ProvenLoop M2 release gate

## Result

| Field | Value |
|---|---|
| Run ID | \`${report.runId}\` |
| Code version | \`${report.codeVersion}\` |
| Release target | ${report.releaseTarget} |
| Evaluation purpose | ${report.evaluationPurpose} |
| Evidence kind | ${report.evidenceKind} |
| Status | **${report.status.toUpperCase()}** |
| Automatic learning acceptance | ${report.automaticLearning?.status ?? "insufficient_evidence"} |
| Exit code | ${report.exitCode} |
| Started | ${report.startedAt} |
| Completed | ${report.completedAt} |

## Checks

| Check | Status | Message |
|---|---|---|
${checks.join("\n")}

## Automatic learning acceptance

| Check | Status | Message |
|---|---|---|
${(report.automaticLearning ?? evaluateAutomaticLearningAcceptance(undefined)).checks.map((check) => `| ${escapeMarkdownText(check.checkId)} | ${check.status} | ${escapeMarkdownText(check.message)} |`).join("\n")}

## Correction Recurrence

${correctionRecurrence}

## Known failures and limitations

${
  report.limitations.length === 0
    ? "- None"
    : report.limitations
        .map((item) => `- ${escapeMarkdownText(item)}`)
        .join("\n")
}
`;
};

const writeM2Reports = async (
  runDirectory: string,
  report: M2ReleaseReport,
): Promise<M2ReleaseReport> => {
  const sanitized = m2ReleaseReportSchema.parse(
    sanitizeM2Report(report),
  ) as M2ReleaseReport;
  const json = `${JSON.stringify(sanitized, null, 2)}\n`;
  const markdown = renderM2ReleaseReport(sanitized);
  if (
    containsKnownSecret(json) ||
    containsKnownSecret(markdown)
  ) {
    throw new Error("M2 release report contains an unredacted secret.");
  }
  const jsonPath = join(runDirectory, "m2-report.json");
  const markdownPath = join(runDirectory, "m2-report.md");
  const suffix = randomUUID();
  const temporaryJsonPath =
    join(runDirectory, `.m2-report-${suffix}.json.tmp`);
  const temporaryMarkdownPath =
    join(runDirectory, `.m2-report-${suffix}.md.tmp`);
  try {
    await writeFile(
      temporaryMarkdownPath,
      markdown,
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    await writeFile(
      temporaryJsonPath,
      json,
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    await rename(temporaryMarkdownPath, markdownPath);
    await rename(temporaryJsonPath, jsonPath);
    return sanitized;
  } catch (error) {
    await Promise.all([
      rm(temporaryJsonPath, {
        force: true,
        recursive: true,
      }),
      rm(temporaryMarkdownPath, {
        force: true,
        recursive: true,
      }),
      rm(jsonPath, {
        force: true,
        recursive: true,
      }),
      rm(markdownPath, {
        force: true,
        recursive: true,
      }),
    ]);
    throw error;
  }
};

export const runM2ReleaseGate = async (
  options: RunM2ReleaseGateOptions,
): Promise<RunM2ReleaseGateResult> => {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = validateRunId(
    options.runId ??
      `m2-${startedAt.toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID()}`,
  );
  const cwd = resolve(options.cwd ?? process.cwd());
  const outputRoot = resolve(options.outputRoot);
  await mkdir(outputRoot, {
    recursive: true,
  });
  const runDirectory = resolve(outputRoot, runId);
  if (
    !runDirectory.startsWith(`${outputRoot}\\`) &&
    runDirectory !== outputRoot
  ) {
    throw new Error("M2 run directory escaped the output root.");
  }
  const stagingDirectory = resolve(
    outputRoot,
    `.${runId}.staging`,
  );
  await assertRunDirectoryAvailable(runDirectory);
  await mkdir(stagingDirectory);
  let published = false;
  try {
    const releaseTarget = options.releaseTarget ?? "research";
    let codeVersion = "unavailable";
    let publishedReport: M2ReleaseReport;
    try {
      const resolvedCodeVersion =
        options.codeVersion ?? await resolveLearningEvaluationCodeVersion(cwd);
      codeVersion = validateCodeVersion(resolvedCodeVersion);
      const observationEvidence = await loadObservationManifest(options.observationManifestPath, codeVersion);
      let automaticLearning: AutomaticLearningAcceptanceReport;
      try {
        const expected = options.automaticLearningEvidencePath === undefined ? undefined : {
          codeVersion, executableDigest: await (await import("./mvp-release-gate.js")).resolveLearningEvaluationExecutableDigest(cwd),
        };
        automaticLearning = evaluateAutomaticLearningAcceptance(
          await loadAutomaticLearningEvidence(options.automaticLearningEvidencePath, expected), releaseTarget, codeVersion,
        );
      } catch (error) {
        throw new M2InputError("Automatic-learning evidence is invalid or its retained artifact binding could not be verified.", { cause: error });
      }
      let dataset: CorrectionRecurrenceDataset;
      try {
        dataset = await loadCorrectionRecurrenceDataset(
          options.datasetPath,
        );
      } catch (error) {
        if (options.datasetPath !== undefined) {
          throw new M2InputError(
            datasetInputErrorMessage(error),
            {
              cause: error,
            },
          );
        }
        throw error;
      }
      const correctionRecurrence =
        await evaluateCorrectionRecurrenceDataset(
          dataset,
          {
            databasePath: join(
              stagingDirectory,
              "correction-recurrence.db",
            ),
            knowledgeDatabasePath: join(
              stagingDirectory,
              "correction-recurrence-knowledge.db",
            ),
            wrongInjectionThreshold:
              releaseTarget === "stable" ? 0.01 : 0.02,
          },
        );
      const checks = checksFor(correctionRecurrence);
      const status: M2ReleaseGateStatus =
        checks.every((check) => check.status === "pass") &&
        correctionRecurrence.status === "pass"
          ? "pass"
          : "fail";
      const report: M2ReleaseReport = {
        automaticLearning,
        evidenceKind: "synthetic",
        evaluationPurpose: "regression",
        ...(observationEvidence === undefined ? {} : { observationEvidence }),
        checks,
        codeVersion,
        completedAt: now().toISOString(),
        correctionRecurrence,
        exitCode: status === "pass" ? 0 : 1,
        limitations: [SYNTHETIC_REGRESSION_LIMITATION,
          "The M2 status and exit code describe synthetic correction-recurrence regression only; automatic-learning acceptance is reported separately.",
          ...automaticLearning.checks.filter((check) => check.status !== "pass").map((check) => check.message), ...checks
          .filter((check) => check.status === "fail")
          .map((check) => check.message)],
        releaseTarget,
        reportVersion: 1,
        runId,
        startedAt: startedAt.toISOString(),
        status,
      };
      publishedReport = await writeM2Reports(
        stagingDirectory,
        report,
      );
    } catch (error) {
      const message = sanitizePublishedDiagnostic(error);
      const invalidInput = error instanceof M2InputError || error instanceof ObservationManifestInputError;
      const report: M2ReleaseReport = {
        evidenceKind: "synthetic",
        evaluationPurpose: "regression",
        checks: [
          {
            checkId:
              invalidInput ? "m2-input" : "m2-infrastructure",
            message,
            status: "fail",
          },
        ],
        codeVersion,
        completedAt: now().toISOString(),
        exitCode: invalidInput ? 2 : 3,
        limitations: [
          invalidInput
            ? "The M2 input was invalid."
            : "The M2 aggregate gate could not complete.",
        ],
        releaseTarget,
        reportVersion: 1,
        runId,
        startedAt: startedAt.toISOString(),
        status: "fail",
      };
      publishedReport = await writeM2Reports(
        stagingDirectory,
        report,
      );
    }
    await rename(stagingDirectory, runDirectory);
    published = true;
    return {
      report: publishedReport,
      runDirectory,
    };
  } finally {
    if (!published) {
      await rm(stagingDirectory, {
        force: true,
        recursive: true,
      });
    }
  }
};
