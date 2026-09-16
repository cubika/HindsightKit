import {
  createHash,
  randomUUID,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import {
  join,
  resolve,
} from "node:path";

import { z } from "zod";

import {
  evaluateBranchContinuationDataset,
  loadBranchContinuationDataset,
  renderBranchContinuationReport,
  type BranchContinuationEvaluationReport,
} from "./branch-continuation-evaluation.js";
import {
  containsKnownSecret,
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

export type M1ReleaseTarget = "research" | "stable";
export type M1ReleaseGateStatus = "fail" | "pass";

export interface M1ReleaseGateCheck {
  readonly checkId: string;
  readonly message: string;
  readonly status: M1ReleaseGateStatus;
}

export interface M1ReleaseReport {
  readonly evidenceKind: "synthetic";
  readonly evaluationPurpose: "regression";
  readonly observationEvidence?: ObservationManifest;
  readonly branchContinuation?: BranchContinuationEvaluationReport;
  readonly checks: readonly M1ReleaseGateCheck[];
  readonly codeVersion: string;
  readonly completedAt: string;
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly limitations: readonly string[];
  readonly releaseTarget: M1ReleaseTarget;
  readonly reportVersion: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly status: M1ReleaseGateStatus;
}

export interface RunM1ReleaseGateOptions {
  readonly observationManifestPath?: string;
  readonly codeVersion?: string;
  readonly cwd?: string;
  readonly datasetPath?: string;
  readonly now?: () => Date;
  readonly outputRoot: string;
  readonly releaseTarget?: M1ReleaseTarget;
  readonly runId?: string;
}

export interface RunM1ReleaseGateResult {
  readonly report: M1ReleaseReport;
  readonly runDirectory: string;
}

const m1ReleaseReportSchema = z
  .object({
    evidenceKind: z.literal("synthetic"),
    evaluationPurpose: z.literal("regression"),
    observationEvidence: observationManifestSchema.optional(),
    branchContinuation: z.unknown().optional(),
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

const validateRunId = (runId: string): string => {
  if (
    !safeRunIdPattern.test(runId) ||
    containsKnownSecret(runId)
  ) {
    throw new Error("M1 runId must be a safe non-secret path segment.");
  }
  return runId;
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

const resolveCodeVersion = async (
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
  digest.update(status);
  digest.update(
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
    digest.update(path);
    digest.update(await readFile(resolve(cwd, path)));
  }
  return `${head}+dirty.${digest.digest("hex").slice(0, 16)}`;
};

const percent = (value: number): string =>
  `${(value * 100).toFixed(2)}%`;

const checksFor = (
  report: BranchContinuationEvaluationReport,
): readonly M1ReleaseGateCheck[] => [
  {
    checkId: "branch-continuation-pairs",
    message:
      `${report.metrics.caseCount} frozen Branch Continuation pairs were evaluated.`,
    status:
      report.metrics.caseCount >= report.thresholds.minimumPairs
        ? "pass"
        : "fail",
  },
  {
    checkId: "repeated-context-token-reduction",
    message:
      `Median reduction ${percent(report.metrics.repeatedContextTokenMedianReduction)}.`,
    status:
      report.metrics.repeatedContextTokenMedianReduction >=
        report.thresholds.repeatedContextTokenMedianReduction
        ? "pass"
        : "fail",
  },
  {
    checkId: "ttv-reduction",
    message:
      `Median reduction ${percent(report.metrics.ttvMedianReduction)} across ${report.metrics.ttvComparableCases} outcome-qualified pairs.`,
    status:
      report.metrics.ttvComparableCases > 0 &&
      report.metrics.ttvMedianReduction >=
        report.thresholds.ttvMedianReduction
        ? "pass"
        : "fail",
  },
  {
    checkId: "retrieval-precision-at-3",
    message:
      `Precision@3 ${percent(report.metrics.precisionAt3)}.`,
    status:
      report.metrics.precisionAt3 >= report.thresholds.precisionAt3
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
    checkId: "outcome-success",
    message:
      `Outcome Success delta ${percent(report.metrics.outcomeSuccessDelta)}.`,
    status:
      report.metrics.outcomeSuccessDelta >=
        report.thresholds.outcomeSuccessDelta
        ? "pass"
        : "fail",
  },
  {
    checkId: "retrieval-latency",
    message:
      `P95 ${report.metrics.latencyP95Ms.toFixed(2)} ms.`,
    status:
      report.metrics.latencyP95Ms <= report.thresholds.latencyP95Ms
        ? "pass"
        : "fail",
  },
  {
    checkId: "retrieval-fidelity",
    message:
      `${report.metrics.matchedCases}/${report.metrics.caseCount} cases matched; ` +
      `${report.metrics.missedUsefulContexts} useful misses, ` +
      `${report.metrics.tokenBudgetViolations} budget violations, ` +
      `${report.metrics.degradedRetrievals} degraded retrievals.`,
    status:
      report.metrics.matchedCases === report.metrics.caseCount &&
      report.metrics.missedUsefulContexts === 0 &&
      report.metrics.tokenBudgetViolations === 0 &&
      report.metrics.degradedRetrievals === 0
        ? "pass"
        : "fail",
  },
];

const sanitizeM1Report = (
  report: M1ReleaseReport,
): M1ReleaseReport => {
  const branchContinuation =
    report.branchContinuation === undefined
      ? undefined
      : {
          ...report.branchContinuation,
          cases: report.branchContinuation.cases.map((testCase) => ({
            ...testCase,
            caseId: redactKnownSecrets(testCase.caseId),
            expectedContextIds:
              testCase.expectedContextIds.map(redactKnownSecrets),
            returnedContextIds:
              testCase.returnedContextIds.map(redactKnownSecrets),
          })),
          datasetId: redactKnownSecrets(
            report.branchContinuation.datasetId,
          ),
        };
  return {
    ...report,
    checks: report.checks.map((check) => ({
      checkId: redactKnownSecrets(check.checkId),
      message: redactPotentialSecrets(check.message),
      status: check.status,
    })),
    codeVersion: redactKnownSecrets(report.codeVersion),
    limitations: report.limitations.map(redactPotentialSecrets),
    runId: redactKnownSecrets(report.runId),
    ...(branchContinuation === undefined
      ? {}
      : {
          branchContinuation,
        }),
  };
};

const renderM1ReleaseReport = (
  report: M1ReleaseReport,
): string => {
  const checks = report.checks.map(
    (check) =>
      `| ${check.checkId} | ${check.status} | ${check.message.replaceAll("|", "\\|")} |`,
  );
  const branchContinuation =
    report.branchContinuation === undefined
      ? "- Unavailable"
      : renderBranchContinuationReport(report.branchContinuation);
  return `# ProvenLoop M1 release gate

Synthetic regression only; this report does not establish real user benefits.

## Result

| Field | Value |
|---|---|
| Run ID | \`${report.runId}\` |
| Code version | \`${report.codeVersion}\` |
| Release target | ${report.releaseTarget} |
| Status | **${report.status.toUpperCase()}** |
| Exit code | ${report.exitCode} |
| Started | ${report.startedAt} |
| Completed | ${report.completedAt} |

## Checks

| Check | Status | Message |
|---|---|---|
${checks.join("\n")}

## Branch Continuation

${branchContinuation}

## Known failures and limitations

${
  report.limitations.length === 0
    ? "- None"
    : report.limitations.map((item) => `- ${item}`).join("\n")
}
`;
};

const writeM1Reports = async (
  runDirectory: string,
  report: M1ReleaseReport,
): Promise<M1ReleaseReport> => {
  const sanitized = m1ReleaseReportSchema.parse(
    sanitizeM1Report(report),
  ) as M1ReleaseReport;
  const json = `${JSON.stringify(sanitized, null, 2)}\n`;
  const markdown = renderM1ReleaseReport(sanitized);
  if (
    containsKnownSecret(json) ||
    containsKnownSecret(markdown)
  ) {
    throw new Error("M1 release report contains an unredacted secret.");
  }
  await writeFile(
    join(runDirectory, "m1-report.json"),
    json,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  await writeFile(
    join(runDirectory, "m1-report.md"),
    markdown,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  return sanitized;
};

export const runM1ReleaseGate = async (
  options: RunM1ReleaseGateOptions,
): Promise<RunM1ReleaseGateResult> => {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = validateRunId(
    options.runId ??
      `m1-${startedAt.toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID()}`,
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
    throw new Error("M1 run directory escaped the output root.");
  }
  await mkdir(runDirectory);
  const releaseTarget = options.releaseTarget ?? "research";
  let codeVersion = options.codeVersion ?? "unavailable";
  try {
    codeVersion =
      options.codeVersion ?? await resolveCodeVersion(cwd);
    if (containsKnownSecret(codeVersion)) {
      throw new Error("M1 codeVersion cannot contain a known secret.");
    }
    const observationEvidence = await loadObservationManifest(options.observationManifestPath, codeVersion);
    const branchContinuation =
      await evaluateBranchContinuationDataset(
        await loadBranchContinuationDataset(options.datasetPath),
        {
          databasePath: join(
            runDirectory,
            "branch-continuation.db",
          ),
          wrongInjectionThreshold:
            releaseTarget === "stable" ? 0.01 : 0.02,
        },
      );
    const checks = checksFor(branchContinuation);
    const status: M1ReleaseGateStatus =
      checks.every((check) => check.status === "pass") &&
      branchContinuation.status === "pass"
        ? "pass"
        : "fail";
    const report: M1ReleaseReport = {
      evidenceKind: "synthetic",
      evaluationPurpose: "regression",
      ...(observationEvidence === undefined ? {} : { observationEvidence }),
      branchContinuation,
      checks,
      codeVersion,
      completedAt: now().toISOString(),
      exitCode: status === "pass" ? 0 : 1,
      limitations: [SYNTHETIC_REGRESSION_LIMITATION, ...checks
        .filter((check) => check.status === "fail")
        .map((check) => check.message)],
      releaseTarget,
      reportVersion: 1,
      runId,
      startedAt: startedAt.toISOString(),
      status,
    };
    return {
      report: await writeM1Reports(runDirectory, report),
      runDirectory,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report: M1ReleaseReport = {
      evidenceKind: "synthetic",
      evaluationPurpose: "regression",
      checks: [
        {
          checkId: "m1-infrastructure",
          message,
          status: "fail",
        },
      ],
      codeVersion,
      completedAt: now().toISOString(),
      exitCode: error instanceof ObservationManifestInputError ? 2 : 3,
      limitations: [
        "The M1 aggregate gate could not complete.",
      ],
      releaseTarget,
      reportVersion: 1,
      runId,
      startedAt: startedAt.toISOString(),
      status: "fail",
    };
    return {
      report: await writeM1Reports(runDirectory, report),
      runDirectory,
    };
  }
};
