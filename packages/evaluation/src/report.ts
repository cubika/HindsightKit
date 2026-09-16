import {
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import {
  ARTIFACT_FORMAT_VERSIONS,
  gateResultSchema,
} from "@provenloop/contracts";

import type { EvaluationReport } from "./types.js";
import {
  containsKnownSecret,
  redactKnownSecrets,
  redactPotentialSecrets,
} from "./secret-detection.js";

const evaluationCaseReportSchema = z
  .object({
    actualGate: z.enum([
      "pass",
      "fail",
      "inconclusive",
    ]),
    evidenceIds: z.array(z.string()),
    expectationMatched: z.boolean(),
    expectedGate: z.enum([
      "pass",
      "fail",
      "inconclusive",
    ]),
    failureMessages: z.array(z.string()),
    fixtureId: z.string(),
    fixtureVersion: z.number().int().nonnegative(),
    gates: z.array(gateResultSchema),
    requirementId: z.string(),
    specId: z.string(),
  })
  .strict();

export const evaluationReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    case: evaluationCaseReportSchema,
    codeVersion: z.string(),
    completedAt: z.string().datetime({
      offset: true,
    }),
    exitCode: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(3),
    ]),
    ledgerPath: z.string(),
    limitations: z.array(z.string()),
    reportVersion: z.literal(ARTIFACT_FORMAT_VERSIONS.report),
    runId: z.string(),
    startedAt: z.string().datetime({
      offset: true,
    }),
    status: z.enum([
      "pass",
      "fail",
      "inconclusive",
      "invalid_input",
      "infrastructure_error",
    ]),
    suiteId: z.string(),
  })
  .strict();

export class EvaluationReportInputError extends Error {
  public override readonly name = "EvaluationReportInputError";
}

const escapeTableCell = (value: string): string =>
  value.replaceAll("|", "\\|").replaceAll("\n", " ");

export const renderEvaluationReport = (
  report: EvaluationReport,
): string => {
  const gateRows = report.case.gates
    .map(
      (gate) =>
        `| ${escapeTableCell(gate.gateId)} | ${gate.status} | ${escapeTableCell(gate.message)} |`,
    )
    .join("\n");
  const failures =
    report.case.failureMessages.length === 0
      ? "- None"
      : report.case.failureMessages
          .map((message) => `- ${message}`)
          .join("\n");
  const evidence =
    report.case.evidenceIds.length === 0
      ? "- None"
      : report.case.evidenceIds.map((id) => `- \`${id}\``).join("\n");
  const limitations =
    report.limitations.length === 0
      ? "- None"
      : report.limitations.map((item) => `- ${item}`).join("\n");

  return `# ProvenLoop evaluation report

## Run

| Field | Value |
|---|---|
| Run ID | \`${report.runId}\` |
| Suite | \`${report.suiteId}\` |
| Requirement | \`${report.case.requirementId}\` |
| Replay Spec | \`${report.case.specId}\` |
| Fixture | \`${report.case.fixtureId}\` v${report.case.fixtureVersion} |
| Code version | \`${report.codeVersion}\` |
| Status | ${report.status} |
| Exit code | ${report.exitCode} |
| Expected gate | ${report.case.expectedGate} |
| Actual gate | ${report.case.actualGate} |
| Expectation matched | ${report.case.expectationMatched} |
| Started | ${report.startedAt} |
| Completed | ${report.completedAt} |
| Evidence Ledger | \`${report.ledgerPath}\` |

## Gates

| Gate | Status | Message |
|---|---|---|
${gateRows || "| None | inconclusive | No verifier ran. |"}

## Failure messages

${failures}

## Evidence IDs

${evidence}

## Limitations

${limitations}
`;
};

export const writeEvaluationReport = async (
  runDirectory: string,
  report: EvaluationReport,
): Promise<EvaluationReport> => {
  const sanitized = {
    ...report,
    case: {
      ...report.case,
      evidenceIds: report.case.evidenceIds.map(redactKnownSecrets),
      failureMessages: report.case.failureMessages.map(
        redactPotentialSecrets,
      ),
      fixtureId: redactKnownSecrets(report.case.fixtureId),
      gates: report.case.gates.map((gate) => ({
        ...gate,
        evidenceIds: gate.evidenceIds.map(redactKnownSecrets),
        gateId: redactKnownSecrets(gate.gateId),
        message: redactPotentialSecrets(gate.message),
      })),
      requirementId: redactKnownSecrets(report.case.requirementId),
      specId: redactKnownSecrets(report.case.specId),
    },
    limitations: report.limitations.map(redactPotentialSecrets),
    runId: redactKnownSecrets(report.runId),
    suiteId: redactKnownSecrets(report.suiteId),
  };
  const parsed = evaluationReportSchema.parse(sanitized);
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  if (containsKnownSecret(serialized)) {
    throw new Error("Evaluation report contains an unredacted secret.");
  }
  await writeFile(
    join(runDirectory, "report.json"),
    serialized,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  await writeFile(
    join(runDirectory, "report.md"),
    renderEvaluationReport(parsed),
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  return parsed;
};

const resolveRunDirectory = async (run: string): Promise<string> => {
  const candidate = isAbsolute(run) ? run : resolve(run);
  try {
    const metadata = await stat(candidate);
    if (metadata.isDirectory()) {
      return candidate;
    }
    if (metadata.isFile() && candidate.endsWith("report.json")) {
      return resolve(candidate, "..");
    }
  } catch {
    // Fall through to the default run root.
  }
  return resolve(".provenloop", "eval", run);
};

export const loadEvaluationReport = async (
  run: string,
): Promise<{
  readonly report: EvaluationReport;
  readonly runDirectory: string;
}> => {
  const runDirectory = await resolveRunDirectory(run);
  let report;
  try {
    report = evaluationReportSchema.parse(
      JSON.parse(
        await readFile(join(runDirectory, "report.json"), "utf8"),
      ) as unknown,
    );
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      error instanceof z.ZodError ||
      (error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT")
    ) {
      throw new EvaluationReportInputError(
        "Evaluation report input is missing or invalid.",
      );
    }
    throw error;
  }
  return {
    report,
    runDirectory,
  };
};

export const regenerateMarkdownReport = async (
  run: string,
): Promise<{
  readonly markdown: string;
  readonly report: EvaluationReport;
  readonly runDirectory: string;
}> => {
  const loaded = await loadEvaluationReport(run);
  const markdown = renderEvaluationReport(loaded.report);
  await writeFile(join(loaded.runDirectory, "report.md"), markdown, "utf8");
  return {
    markdown,
    ...loaded,
  };
};
