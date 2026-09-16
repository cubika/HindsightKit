import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

import {
  CURRENT_SCHEMA_VERSION,
  EVALUATION_EXIT_CODES,
  evidenceLedgerEntrySchema,
  type EvidenceLedgerEntry,
  type EvaluationExitCode,
  type GateResult,
} from "@provenloop/contracts";
import { ZodError } from "zod";

import { sha256 } from "./digest.js";
import {
  DuplicateLedgerEntryError,
  EvidenceLedgerWriter,
  UnsafeLedgerIdentifierError,
} from "./ledger.js";
import {
  EvaluationInputError,
  loadEvaluationSuite,
} from "./load-suite.js";
import { writeEvaluationReport } from "./report.js";
import type {
  EvaluationReport,
  RunEvaluationOptions,
  RunEvaluationResult,
} from "./types.js";
import { runVerifier } from "./verifiers.js";

const createRunId = (now: Date): string =>
  `${now.toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;

const resolveCodeVersion = (): string => {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA;
  }
  const result = spawnSync(
    "git",
    [
      "--no-pager",
      "rev-parse",
      "HEAD",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return result.status === 0 ? result.stdout.trim() : "unknown";
};

const aggregateGateStatus = (
  gates: readonly GateResult[],
): "pass" | "fail" | "inconclusive" | "infrastructure_error" => {
  if (gates.some((gate) => gate.status === "infrastructure_error")) {
    return "infrastructure_error";
  }
  if (gates.some((gate) => gate.status === "fail")) {
    return "fail";
  }
  if (gates.some((gate) => gate.status === "inconclusive")) {
    return "inconclusive";
  }
  return "pass";
};

const statusToExitCode = (
  status: EvaluationReport["status"],
  releaseGate: "hard" | "conditional",
): EvaluationExitCode => {
  switch (status) {
    case "pass":
      return EVALUATION_EXIT_CODES.gatesPassed;
    case "inconclusive":
      return releaseGate === "conditional"
        ? EVALUATION_EXIT_CODES.gatesPassed
        : EVALUATION_EXIT_CODES.gateFailed;
    case "fail":
      return EVALUATION_EXIT_CODES.gateFailed;
    case "invalid_input":
      return EVALUATION_EXIT_CODES.invalidInput;
    case "infrastructure_error":
      return EVALUATION_EXIT_CODES.infrastructureError;
  }
};

const createErrorLedgerEntry = (
  runId: string,
  timestamp: string,
  status: string,
  error: unknown,
): EvidenceLedgerEntry =>
  evidenceLedgerEntrySchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ledgerEntryId: `${runId}:${status}`,
    runId,
    status,
    inputDigest: sha256(
      error instanceof Error ? error.message : String(error),
    ),
    timestamp,
  });

export const runEvaluation = async (
  options: RunEvaluationOptions,
): Promise<RunEvaluationResult> => {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = options.runId ?? createRunId(startedAt);
  const runDirectory = join(options.outputRoot, runId);
  await mkdir(options.outputRoot, {
    recursive: true,
  });
  await mkdir(runDirectory, {
    recursive: false,
  });

  const ledger = new EvidenceLedgerWriter(
    join(runDirectory, "evidence-ledger.jsonl"),
  );
  await ledger.initialize();

  try {
    const suite = await loadEvaluationSuite(options.suite);
    const generatedAt = now().toISOString();
    const normalizedFixtureEvidence = suite.fixture.evidence.map((entry) => ({
      ...entry,
      runId,
    }));
    const ledgerEntries = [
      ...(await ledger.append(normalizedFixtureEvidence)),
    ];

    const gates: GateResult[] = [];
    let invalidInput = false;
    for (const verifierId of suite.manifest.verifierIds) {
      const outcome = runVerifier(verifierId, {
        fixture: suite.fixture,
        generatedAt,
        ledgerEntries,
        manifest: suite.manifest,
        replaySpec: suite.replaySpec,
        runId,
      });
      gates.push(outcome.gate);
      if (outcome.invalidInput) {
        invalidInput = true;
      }
      if (outcome.ledgerEntries) {
        const persistedEntries = await ledger.append(
          outcome.ledgerEntries,
        );
        ledgerEntries.push(...persistedEntries);
      }
    }

    const secretRedactionEntries = ledgerEntries.filter(
      (entry) => entry.status === "secret.redacted_before_ledger",
    );
    if (secretRedactionEntries.length > 0) {
      gates.push({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        gateId: `${suite.replaySpec.specId}:ledger-secret-preflight`,
        status: "fail",
        evidenceIds: secretRedactionEntries.map(
          (entry) => entry.ledgerEntryId,
        ),
        message: "Secret-like Ledger fields were redacted before persistence.",
      });
    }
    const evidenceStatuses = new Set(
      ledgerEntries.map((entry) => entry.status),
    );
    const missingRequiredEvidence =
      suite.manifest.requiredEvidence.filter(
        (status) => !evidenceStatuses.has(status),
      );
    if (missingRequiredEvidence.length > 0) {
      gates.push({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        gateId: `${suite.replaySpec.specId}:required-evidence`,
        status: "fail",
        evidenceIds: [],
        message: `Missing required evidence status: ${missingRequiredEvidence.join(", ")}.`,
      });
    }
    const missingExpectedEvidence =
      suite.replaySpec.expectedEvidence.filter(
        (status) => !evidenceStatuses.has(status),
      );
    if (missingExpectedEvidence.length > 0) {
      invalidInput = true;
      gates.push({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        gateId: `${suite.replaySpec.specId}:expected-evidence`,
        status: "fail",
        evidenceIds: [],
        message: `Replay expected evidence was not observed: ${missingExpectedEvidence.join(", ")}.`,
      });
    }

    const observedGate = aggregateGateStatus(gates);
    const actualGate =
      observedGate === "infrastructure_error" ? "fail" : observedGate;
    const expectationMatched =
      !invalidInput &&
      actualGate === suite.replaySpec.expectedGate &&
      missingExpectedEvidence.length === 0;
    if (!invalidInput && !expectationMatched) {
      gates.push({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        gateId: `${suite.replaySpec.specId}:expected-gate`,
        status: "fail",
        evidenceIds: [],
        message: `Replay expected gate ${suite.replaySpec.expectedGate}, observed ${actualGate}.`,
      });
    }

    const aggregated = aggregateGateStatus(gates);
    const reportStatus: EvaluationReport["status"] = invalidInput
      ? "invalid_input"
      : aggregated;
    const exitCode = statusToExitCode(
      reportStatus,
      suite.manifest.releaseGate,
    );
    const failureMessages = gates
      .filter((gate) => gate.status !== "pass")
      .map((gate) => gate.message);
    const evidenceIds = [
      ...new Set(gates.flatMap((gate) => gate.evidenceIds)),
    ].sort();
    const completedAt = now().toISOString();
    const report: EvaluationReport = {
      schemaVersion: 1,
      case: {
        actualGate,
        evidenceIds,
        expectationMatched,
        expectedGate: suite.replaySpec.expectedGate,
        failureMessages,
        fixtureId: suite.fixture.fixtureId,
        fixtureVersion: suite.fixture.fixtureVersion,
        gates,
        requirementId: suite.manifest.requirementId,
        specId: suite.replaySpec.specId,
      },
      codeVersion: options.codeVersion ?? resolveCodeVersion(),
      completedAt,
      exitCode,
      ledgerPath: relative(
        runDirectory,
        ledger.path,
      ).replaceAll("\\", "/"),
      limitations:
        gates.some((gate) => gate.status === "inconclusive")
          ? [
              "One or more deterministic gates were inconclusive.",
            ]
          : [],
      reportVersion: 1,
      runId,
      startedAt: startedAt.toISOString(),
      status: reportStatus,
      suiteId: suite.suiteId,
    };
    const persistedReport = await writeEvaluationReport(
      runDirectory,
      report,
    );
    return {
      report: persistedReport,
      runDirectory,
    };
  } catch (error) {
    const timestamp = now().toISOString();
    const invalidInput =
      error instanceof ZodError ||
      error instanceof DuplicateLedgerEntryError ||
      error instanceof EvaluationInputError ||
      error instanceof UnsafeLedgerIdentifierError ||
      error instanceof SyntaxError;
    const status: EvaluationReport["status"] = invalidInput
      ? "invalid_input"
      : "infrastructure_error";
    const exitCode = statusToExitCode(status, "hard");
    const message =
      error instanceof Error ? error.message : String(error);
    const errorEntry = createErrorLedgerEntry(
      runId,
      timestamp,
      invalidInput
        ? "evaluation.invalid_input"
        : "evaluation.infrastructure_error",
      error,
    );
    await ledger.append([
      errorEntry,
    ]);
    const report: EvaluationReport = {
      schemaVersion: 1,
      case: {
        actualGate: "fail",
        evidenceIds: [
          errorEntry.ledgerEntryId,
        ],
        expectationMatched: false,
        expectedGate: "pass",
        failureMessages: [
          message,
        ],
        fixtureId: options.suite,
        fixtureVersion: 0,
        gates: [],
        requirementId: "unknown",
        specId: "unknown",
      },
      codeVersion: options.codeVersion ?? resolveCodeVersion(),
      completedAt: timestamp,
      exitCode,
      ledgerPath: relative(
        runDirectory,
        ledger.path,
      ).replaceAll("\\", "/"),
      limitations: [
        "The suite could not be evaluated.",
      ],
      reportVersion: 1,
      runId,
      startedAt: startedAt.toISOString(),
      status,
      suiteId: options.suite,
    };
    const persistedReport = await writeEvaluationReport(
      runDirectory,
      report,
    );
    return {
      report: persistedReport,
      runDirectory,
    };
  }
};
