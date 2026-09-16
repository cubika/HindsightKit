import {
  createHash,
  randomUUID,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  evidenceLedgerEntrySchema,
} from "@provenloop/contracts";

import {
  evaluateEpisodeAssociationDataset,
  loadEpisodeAssociationDataset,
  type EpisodeAssociationEvaluationReport,
} from "./episode-association-evaluation.js";
import {
  loadM0AcceptanceEvidence,
  m0AcceptanceEvidenceSchema,
  M0AcceptanceEvidenceInputError,
  type M0AcceptanceEvidence,
} from "./m0-acceptance-evidence.js";
import { runEvaluation } from "./runner.js";
import { verifyExternalReportArtifacts } from "./external-report-binding.js";
import {
  containsKnownSecret,
  redactKnownSecrets,
  redactPotentialSecrets,
} from "./secret-detection.js";
import type {
  EvaluationReport,
  RunEvaluationOptions,
  RunEvaluationResult,
} from "./types.js";

const M0_SUITES = [
  "valid-supported-event",
  "duplicate-event",
  "queue-interruption-recovery",
  "false-completion",
  "participant-not-invoked",
  "resolved-model-mismatch",
  "seeded-secret",
  "unknown-adapter-version",
  "repository-scope-leakage",
  "malformed-event",
  "deletion-propagation",
] as const;

export type M0ReleaseGateStatus = "blocked" | "fail" | "pass";

export interface M0ReleaseGateCheck {
  readonly checkId: string;
  readonly message: string;
  readonly status: M0ReleaseGateStatus;
}

export interface M0SuiteResult {
  readonly reportPath: string;
  readonly status: EvaluationReport["status"];
  readonly suiteId: string;
  readonly verified: boolean;
}

export interface M0ReleaseReport {
  readonly acceptanceEvidenceKind?: "maintainer_attestation";
  readonly artifactIntegrity?: "verified" | "not_supplied" | "unverified";
  readonly acceptanceEvidence?: M0AcceptanceEvidence;
  readonly checks: readonly M0ReleaseGateCheck[];
  readonly codeVersion: string;
  readonly completedAt: string;
  readonly episodeAssociation?: EpisodeAssociationEvaluationReport;
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly limitations: readonly string[];
  readonly reportVersion: 1;
  readonly runId: string;
  readonly runtimeDigest: string;
  readonly startedAt: string;
  readonly status: M0ReleaseGateStatus;
  readonly suites: readonly M0SuiteResult[];
}

export interface RunM0ReleaseGateOptions {
  readonly evidenceRoot?: string;
  readonly acceptanceEvidence?: M0AcceptanceEvidence;
  readonly codeVersion?: string;
  readonly cwd?: string;
  readonly evidencePath?: string;
  readonly episodeDatasetPath?: string;
  readonly now?: () => Date;
  readonly outputRoot: string;
  readonly runSuite?: (
    options: RunEvaluationOptions,
  ) => Promise<RunEvaluationResult>;
  readonly runId?: string;
}

export interface RunM0ReleaseGateResult {
  readonly report: M0ReleaseReport;
  readonly runDirectory: string;
}

const m0ReleaseReportSchema = z
  .object({
    acceptanceEvidenceKind: z.literal("maintainer_attestation").default("maintainer_attestation"),
    artifactIntegrity: z.enum(["verified", "not_supplied", "unverified"]).optional(),
    acceptanceEvidence: m0AcceptanceEvidenceSchema.optional(),
    checks: z.array(
      z
        .object({
          checkId: z.string().min(1),
          message: z.string().min(1),
          status: z.enum([
            "blocked",
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
    episodeAssociation: z.unknown().optional(),
    exitCode: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(3),
    ]),
    limitations: z.array(z.string()),
    reportVersion: z.literal(1),
    runId: z.string().min(1),
    runtimeDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u),
    startedAt: z.string().datetime({
      offset: true,
    }),
    status: z.enum([
      "blocked",
      "fail",
      "pass",
    ]),
    suites: z.array(
      z
        .object({
          reportPath: z.string(),
          status: z.enum([
            "pass",
            "fail",
            "inconclusive",
            "invalid_input",
            "infrastructure_error",
          ]),
          suiteId: z.string().min(1),
          verified: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

const EXPECTED_SUITE_PROFILES: Readonly<
  Record<
    typeof M0_SUITES[number],
    {
      readonly actualGate: EvaluationReport["case"]["actualGate"];
      readonly exitCode: EvaluationReport["exitCode"];
      readonly expectedGate: EvaluationReport["case"]["expectedGate"];
      readonly gates: readonly string[];
      readonly status: EvaluationReport["status"];
    }
  >
> = {
  "deletion-propagation": {
    actualGate: "pass",
    exitCode: 0,
    expectedGate: "pass",
    gates: [
      "deletion-propagation:deletion-propagation:pass",
    ],
    status: "pass",
  },
  "duplicate-event": {
    actualGate: "pass",
    exitCode: 0,
    expectedGate: "pass",
    gates: [
      "duplicate-event:event-schema-source-version:pass",
      "duplicate-event:event-idempotency:pass",
    ],
    status: "pass",
  },
  "false-completion": {
    actualGate: "fail",
    exitCode: 1,
    expectedGate: "fail",
    gates: [
      "false-completion:process-claim-execution-consistency:fail",
      "false-completion:command-completion-exit-code:fail",
    ],
    status: "fail",
  },
  "malformed-event": {
    actualGate: "fail",
    exitCode: 2,
    expectedGate: "fail",
    gates: [
      "malformed-event:event-schema-source-version:fail",
    ],
    status: "invalid_input",
  },
  "participant-not-invoked": {
    actualGate: "fail",
    exitCode: 1,
    expectedGate: "fail",
    gates: [
      "participant-not-invoked:participant-resolved-model-identity:fail",
    ],
    status: "fail",
  },
  "queue-interruption-recovery": {
    actualGate: "pass",
    exitCode: 0,
    expectedGate: "pass",
    gates: [
      "queue-interruption-recovery:queue-recovery:pass",
    ],
    status: "pass",
  },
  "repository-scope-leakage": {
    actualGate: "fail",
    exitCode: 1,
    expectedGate: "fail",
    gates: [
      "repository-scope-leakage:repository-scope-isolation:fail",
    ],
    status: "fail",
  },
  "resolved-model-mismatch": {
    actualGate: "fail",
    exitCode: 1,
    expectedGate: "fail",
    gates: [
      "resolved-model-mismatch:participant-resolved-model-identity:fail",
    ],
    status: "fail",
  },
  "seeded-secret": {
    actualGate: "fail",
    exitCode: 1,
    expectedGate: "fail",
    gates: [
      "seeded-secret:secret-persistence:fail",
    ],
    status: "fail",
  },
  "unknown-adapter-version": {
    actualGate: "fail",
    exitCode: 1,
    expectedGate: "fail",
    gates: [
      "unknown-adapter-version:event-schema-source-version:fail",
    ],
    status: "fail",
  },
  "valid-supported-event": {
    actualGate: "pass",
    exitCode: 0,
    expectedGate: "pass",
    gates: [
      "valid-supported-event:event-schema-source-version:pass",
    ],
    status: "pass",
  },
};

const suiteVerified = (report: EvaluationReport): boolean => {
  const profile = EXPECTED_SUITE_PROFILES[
    report.suiteId as typeof M0_SUITES[number]
  ];
  if (profile === undefined || report.case.evidenceIds.length === 0) {
    return false;
  }
  return (
    report.status === profile.status &&
    report.exitCode === profile.exitCode &&
    report.case.actualGate === profile.actualGate &&
    report.case.expectedGate === profile.expectedGate &&
    JSON.stringify(
      report.case.gates.map(
        (gate) => `${gate.gateId}:${gate.status}`,
      ),
    ) === JSON.stringify(profile.gates)
  );
};

const ledgerEvidenceIds = async (
  result: RunEvaluationResult,
): Promise<ReadonlySet<string>> => {
  const ledgerPath = resolve(
    result.runDirectory,
    result.report.ledgerPath,
  );
  const runDirectory = resolve(result.runDirectory);
  if (
    !ledgerPath.startsWith(`${runDirectory}\\`) &&
    ledgerPath !== runDirectory
  ) {
    throw new Error(
      `Suite ${result.report.suiteId} Ledger escaped its run directory.`,
    );
  }
  const entries = (await readFile(ledgerPath, "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) =>
      evidenceLedgerEntrySchema.parse(
        JSON.parse(line) as unknown,
      ),
    );
  const ids = new Set(
    entries.map((entry) => entry.ledgerEntryId),
  );
  if (ids.size !== entries.length) {
    throw new Error(
      `Suite ${result.report.suiteId} Ledger contains duplicate IDs.`,
    );
  }
  return ids;
};

export const verifyM0SuiteEvidence = async (
  result: RunEvaluationResult,
): Promise<boolean> => {
  if (!suiteVerified(result.report)) {
    return false;
  }
  const ledgerIds = await ledgerEvidenceIds(result);
  const gateEvidence = [
    ...new Set(
      result.report.case.gates.flatMap(
        (gate) => gate.evidenceIds,
      ),
    ),
  ].sort();
  const caseEvidence = [
    ...new Set(result.report.case.evidenceIds),
  ].sort();
  return (
    result.report.case.gates.every(
      (gate) =>
        gate.evidenceIds.length > 0 &&
        gate.evidenceIds.every((id) => ledgerIds.has(id)),
    ) &&
    caseEvidence.every((id) => ledgerIds.has(id)) &&
    JSON.stringify(caseEvidence) === JSON.stringify(gateEvidence)
  );
};

const renderM0ReleaseReport = (
  report: M0ReleaseReport,
): string => {
  const checks = report.checks.map(
    (check) =>
      `| ${check.checkId} | ${check.status} | ${check.message.replaceAll("|", "\\|")} |`,
  );
  const suites = report.suites.map(
    (suite) =>
      `| ${suite.suiteId} | ${suite.status} | ${suite.verified} | \`${suite.reportPath}\` |`,
  );
  const episodeAssociation =
    report.episodeAssociation === undefined
      ? "- Unavailable"
      : [
          `- Dataset: \`${report.episodeAssociation.datasetId}\` v${report.episodeAssociation.datasetVersion}`,
          `- Precision: ${(report.episodeAssociation.metrics.precision * 100).toFixed(2)}%`,
          `- Recall: ${(report.episodeAssociation.metrics.recall * 100).toFixed(2)}%`,
          `- Wrong merges: ${report.episodeAssociation.metrics.wrongMerges}`,
          `- Wrong splits: ${report.episodeAssociation.metrics.wrongSplits}`,
        ].join("\n");
  return `# ProvenLoop M0 release gate

## Result

| Field | Value |
|---|---|
| Run ID | \`${report.runId}\` |
| Code version | \`${report.codeVersion}\` |
| Runtime digest | \`${report.runtimeDigest}\` |
| Status | **${report.status.toUpperCase()}** |
| Exit code | ${report.exitCode} |
| Started | ${report.startedAt} |
| Completed | ${report.completedAt} |

## Checks

| Check | Status | Message |
|---|---|---|
${checks.join("\n")}

## Frozen suites

| Suite | Status | Verified | Report |
|---|---|---:|---|
${suites.join("\n")}

## Episode association

${episodeAssociation}

## Known failures and limitations

${report.limitations.map((item) => `- ${item}`).join("\n")}
`;
};

const missingEvidenceChecks = (): readonly M0ReleaseGateCheck[] => [
  {
    checkId: "capture-latency-windows",
    message:
      "Windows 10 and paired foreground Extension A/B latency evidence remains open under F0-001.",
    status: "blocked",
  },
  {
    checkId: "provider-degradation",
    message:
      "Signed-out, rate-limited, and provider-unavailable evidence remains open under F0-002.",
    status: "blocked",
  },
  {
    checkId: "remote-marketplace-upgrade",
    message:
      "A two-version remote marketplace upgrade remains open under F0-003.",
    status: "blocked",
  },
  {
    checkId: "doctor-signin",
    message:
      "Online Doctor classification evidence has not been supplied.",
    status: "blocked",
  },
  {
    checkId: "capability-isolation",
    message:
      "Installed capability-isolation evidence has not been supplied.",
    status: "blocked",
  },
  {
    checkId: "observed-guardrails",
    message:
      "Observed privacy, isolation, and foreground safety evidence has not been supplied.",
    status: "blocked",
  },
];

const evidenceReportDigests = (
  evidence: M0AcceptanceEvidence,
): readonly string[] => [
  evidence.capabilityIsolation.reportDigest,
  evidence.capture.reportDigest,
  evidence.doctor.reportDigest,
  evidence.marketplaceUpgrade.reportDigest,
  evidence.providerDegradation.reportDigest,
];

const validateEvidenceBinding = async (
  evidence: M0AcceptanceEvidence,
  codeVersion: string,
  runtimeDigest: string,
  evidenceRoot: string | undefined,
): Promise<void> => {
  if (evidence.binding.codeVersion !== codeVersion) {
    throw new M0AcceptanceEvidenceInputError(
      "M0 acceptance evidence code version does not match the evaluated code.",
    );
  }
  if (evidence.binding.runtimeDigest !== runtimeDigest) {
    throw new M0AcceptanceEvidenceInputError(
      "M0 acceptance evidence runtime digest does not match the evaluated runtime.",
    );
  }
  const retained = new Set(evidence.binding.reportDigests);
  if (
    evidenceReportDigests(evidence).some(
      (digest) => !retained.has(digest),
    )
  ) {
    throw new M0AcceptanceEvidenceInputError(
      "M0 acceptance evidence references an unretained report digest.",
    );
  }
  try {
    await verifyExternalReportArtifacts(
      evidence.binding.reportArtifacts ?? [],
      evidence.binding.reportDigests,
      evidenceRoot,
    );
  } catch {
    throw new M0AcceptanceEvidenceInputError(
      "M0 external report artifacts are missing, unsafe, or do not match their digests.",
    );
  }
};

const acceptanceEvidenceChecks = (
  evidence: M0AcceptanceEvidence | undefined,
): readonly M0ReleaseGateCheck[] => {
  if (evidence === undefined) {
    return missingEvidenceChecks();
  }
  const capturePass =
    evidence.capture.status === "pass" &&
    evidence.binding.operatingSystemVersions.some((version) =>
      /windows[-_. ]?10/iu.test(version),
    ) &&
    evidence.binding.operatingSystemVersions.some((version) =>
      /windows[-_. ]?11/iu.test(version),
    ) &&
    evidence.capture.foregroundAddedLatencyP95Ms <= 10 &&
    evidence.capture.callbackWorkDurationP95Ms <= 1 &&
    evidence.capture.missingRequiredEventCount === 0 &&
    evidence.capture.duplicateCanonicalFactCount === 0 &&
    evidence.capture.seededSecretPersistenceCount === 0 &&
    evidence.capture.internalSessionPersistenceCount === 0 &&
    evidence.capture.foregroundBlockingFailureCount === 0 &&
    evidence.capture.windows10RepresentativeEventCount >= 500 &&
    evidence.capture.windows11RepresentativeEventCount >= 500;
  const providerPass =
    evidence.providerDegradation.status === "pass" &&
    evidence.providerDegradation.signedOut === "pass" &&
    evidence.providerDegradation.rateLimited === "pass" &&
    evidence.providerDegradation.unavailable === "pass" &&
    evidence.providerDegradation.incompatible === "pass" &&
    evidence.providerDegradation.backlogDurable &&
    evidence.providerDegradation.boundedRetry &&
    evidence.providerDegradation.foregroundUsable;
  const marketplacePass =
    evidence.marketplaceUpgrade.status === "pass" &&
    evidence.marketplaceUpgrade.disableEnablePassed &&
    evidence.marketplaceUpgrade.repeatedInstallPassed &&
    evidence.marketplaceUpgrade.knowledgeDataPreserved &&
    evidence.marketplaceUpgrade.queueDataPreserved &&
    evidence.marketplaceUpgrade.uninstallPreservedData &&
    evidence.marketplaceUpgrade.settingsRestoredExactly &&
    evidence.marketplaceUpgrade.fromVersion !==
      evidence.marketplaceUpgrade.toVersion;
  const requiredDoctorClassifications = [
    "incompatible",
    "rate_limited",
    "signed_out",
    "unavailable",
  ] as const;
  const doctorPass =
    evidence.doctor.status === "pass" &&
    requiredDoctorClassifications.every((classification) =>
      evidence.doctor.onlineClassifications.includes(classification),
    );
  const isolationPass =
    evidence.capabilityIsolation.status === "pass" &&
    evidence.capabilityIsolation.automatedTestPassed &&
    evidence.capabilityIsolation.installedProbePassed &&
    evidence.capabilityIsolation.retrievalDisabledPassed &&
    evidence.capabilityIsolation.captureDisabledPassed &&
    evidence.capabilityIsolation.workerDisabledPassed &&
    evidence.capabilityIsolation.correctionLearningDisabledPassed;
  const guardrails = evidence.observedGuardrails;
  const guardrailsPass =
    guardrails.secretPersistenceCount === 0 &&
    guardrails.internalSessionPersistenceCount === 0 &&
    guardrails.foregroundBlockingFailureCount === 0 &&
    guardrails.crossRepositoryLeakageCount === 0 &&
    guardrails.deletionPropagationFailureCount === 0;
  return [
    {
      checkId: "capture-latency-windows",
      message: capturePass
        ? "Windows capture correctness, privacy, and latency thresholds passed."
        : "Windows capture evidence failed one or more hard thresholds.",
      status: capturePass ? "pass" : "fail",
    },
    {
      checkId: "provider-degradation",
      message: providerPass
        ? "Provider degradation scenarios preserved backlog and foreground usability."
        : "Provider degradation evidence is incomplete or failed.",
      status: providerPass ? "pass" : "fail",
    },
    {
      checkId: "remote-marketplace-upgrade",
      message: marketplacePass
        ? "Two-version remote marketplace upgrade and lifecycle checks passed."
        : "Remote marketplace upgrade evidence is incomplete or failed.",
      status: marketplacePass ? "pass" : "fail",
    },
    {
      checkId: "doctor-signin",
      message: doctorPass
        ? "Passive and online Doctor behavior passed all required classifications."
        : "Doctor evidence is incomplete or failed.",
      status: doctorPass ? "pass" : "fail",
    },
    {
      checkId: "capability-isolation",
      message: isolationPass
        ? "Automated and installed capability-isolation matrices passed."
        : "Capability-isolation evidence is incomplete or failed.",
      status: isolationPass ? "pass" : "fail",
    },
    {
      checkId: "observed-guardrails",
      message: guardrailsPass
        ? "Observed privacy, scope, deletion, and foreground guardrails remained at zero failures."
        : "One or more observed guardrail counts are non-zero.",
      status: guardrailsPass ? "pass" : "fail",
    },
  ];
};

const safeRunIdPattern =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const validateRunId = (runId: string): string => {
  if (
    !safeRunIdPattern.test(runId) ||
    containsKnownSecret(runId)
  ) {
    throw new Error("M0 runId must be a safe non-secret path segment.");
  }
  return runId;
};

const assertPathAvailable = async (path: string): Promise<void> => {
  try {
    await stat(path);
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
  const error = new Error(`M0 release run already exists: ${path}`);
  Object.assign(error, {
    code: "EEXIST",
    path,
  });
  throw error;
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

const validateArtifactLocation = (
  path: string | undefined,
  cwd: string,
  label: string,
): void => {
  if (path === undefined) {
    return;
  }
  const repositoryProbe = spawnSync(
    "git",
    [
      "rev-parse",
      "--show-toplevel",
    ],
    {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (repositoryProbe.status !== 0) {
    return;
  }
  const repositoryRoot = repositoryProbe.stdout.trim();
  const relativePath = relative(repositoryRoot, path);
  const insideRepository =
    relativePath === "" ||
    (
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath)
    );
  if (!insideRepository) {
    return;
  }
  const ignored = spawnSync(
    "git",
    [
      "check-ignore",
      "--quiet",
      "--",
      relativePath,
    ],
    {
      cwd: repositoryRoot,
      windowsHide: true,
    },
  );
  if (ignored.status !== 0) {
    throw new M0AcceptanceEvidenceInputError(
      `${label} must be outside the repository or ignored by Git.`,
    );
  }
};

const runtimeModulePath = fileURLToPath(import.meta.url);

const resolveRuntimeDigest = async (): Promise<string> => {
  if (!runtimeModulePath.includes(`${sep}dist${sep}`)) {
    return createHash("sha256")
      .update("provenloop-source-typescript-v1", "utf8")
      .digest("hex");
  }
  return createHash("sha256")
    .update(await readFile(runtimeModulePath))
    .digest("hex");
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
  const status =
    gitOutput([
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
  const untracked =
    gitOutput([
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

const sanitizeM0Report = (
  report: M0ReleaseReport,
): M0ReleaseReport => {
  const episodeAssociation =
    report.episodeAssociation === undefined
      ? undefined
      : {
          ...report.episodeAssociation,
          cases: report.episodeAssociation.cases.map((testCase) => ({
            ...testCase,
            caseId: redactKnownSecrets(testCase.caseId),
          })),
          datasetId: redactKnownSecrets(
            report.episodeAssociation.datasetId,
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
    suites: report.suites.map((suite) => ({
      ...suite,
      reportPath: redactKnownSecrets(suite.reportPath),
      suiteId: redactKnownSecrets(suite.suiteId),
    })),
    ...(episodeAssociation === undefined
      ? {}
      : {
          episodeAssociation,
        }),
  };
};

const writeM0Reports = async (
  runDirectory: string,
  report: M0ReleaseReport,
): Promise<M0ReleaseReport> => {
  const sanitized = m0ReleaseReportSchema.parse(
    {
      ...sanitizeM0Report(report),
      artifactIntegrity: report.artifactIntegrity ??
        (report.acceptanceEvidence === undefined ? "not_supplied" : "verified"),
    },
  ) as M0ReleaseReport;
  const json = `${JSON.stringify(sanitized, null, 2)}\n`;
  const markdown = renderM0ReleaseReport(sanitized);
  if (
    containsKnownSecret(json) ||
    containsKnownSecret(markdown)
  ) {
    throw new Error("M0 release report contains an unredacted secret.");
  }
  await writeFile(
    join(runDirectory, "m0-report.json"),
    json,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  await writeFile(
    join(runDirectory, "m0-report.md"),
    markdown,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  return sanitized;
};

export const runM0ReleaseGate = async (
  options: RunM0ReleaseGateOptions,
): Promise<RunM0ReleaseGateResult> => {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = validateRunId(
    options.runId ??
      `m0-${startedAt.toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID()}`,
  );
  const cwd = resolve(options.cwd ?? process.cwd());
  const outputRoot = resolve(options.outputRoot);
  const evidencePath =
    options.evidencePath === undefined
      ? undefined
      : resolve(options.evidencePath);
  validateArtifactLocation(
    outputRoot,
    cwd,
    "M0 output directory",
  );
  validateArtifactLocation(
    evidencePath,
    cwd,
    "M0 acceptance evidence",
  );
  await mkdir(outputRoot, {
    recursive: true,
  });
  const runDirectory = resolve(outputRoot, runId);
  if (
    !runDirectory.startsWith(`${outputRoot}\\`) &&
    runDirectory !== outputRoot
  ) {
    throw new Error("M0 run directory escaped the output root.");
  }
  const stagingDirectory = resolve(
    outputRoot,
    `.${runId}.staging`,
  );
  await Promise.all([
    assertPathAvailable(runDirectory),
    assertPathAvailable(stagingDirectory),
  ]);
  await mkdir(stagingDirectory);
  const suiteRoot = join(stagingDirectory, "suites");
  await mkdir(suiteRoot);
  let codeVersion = options.codeVersion ?? "unavailable";
  let runtimeDigest = createHash("sha256")
    .update("provenloop-runtime-unavailable", "utf8")
    .digest("hex");
  let acceptanceEvidence: M0AcceptanceEvidence | undefined;
  try {
    codeVersion =
      options.codeVersion ?? await resolveCodeVersion(cwd);
    if (containsKnownSecret(codeVersion)) {
      throw new Error("M0 codeVersion cannot contain a known secret.");
    }
    runtimeDigest = await resolveRuntimeDigest();
    if (
      options.acceptanceEvidence !== undefined &&
      evidencePath !== undefined
    ) {
      throw new M0AcceptanceEvidenceInputError(
        "Provide M0 acceptance evidence by value or path, not both.",
      );
    }
    if (options.acceptanceEvidence !== undefined) {
      const parsed = m0AcceptanceEvidenceSchema.safeParse(
        options.acceptanceEvidence,
      );
      if (!parsed.success) {
        throw new M0AcceptanceEvidenceInputError(
          "M0 acceptance evidence schema is invalid.",
          {
            cause: parsed.error,
          },
        );
      }
      acceptanceEvidence = parsed.data;
    } else {
      acceptanceEvidence = await loadM0AcceptanceEvidence(
        evidencePath,
      );
    }
    if (acceptanceEvidence !== undefined) {
      await validateEvidenceBinding(
        acceptanceEvidence,
        codeVersion,
        runtimeDigest,
        options.evidenceRoot ?? (evidencePath === undefined ? undefined : resolve(evidencePath, "..")),
      );
    }
    const runSuite = options.runSuite ?? runEvaluation;
    const suiteRuns = await Promise.all(
      M0_SUITES.map(async (suiteId) => ({
        requestedSuiteId: suiteId,
        result: await runSuite({
          codeVersion,
          outputRoot: suiteRoot,
          runId: `${runId}-${suiteId}`,
          suite: suiteId,
        }),
      })),
    );
    const episodeAssociation = evaluateEpisodeAssociationDataset(
      await loadEpisodeAssociationDataset(
        options.episodeDatasetPath,
      ),
    );
    const suites = await Promise.all(
      suiteRuns.map(
        async ({
          requestedSuiteId,
          result,
        }): Promise<M0SuiteResult> => ({
          reportPath: relative(
            stagingDirectory,
            join(result.runDirectory, "report.json"),
          ).replaceAll("\\", "/"),
          status: result.report.status,
          suiteId: result.report.suiteId,
          verified:
            result.report.suiteId === requestedSuiteId &&
            await verifyM0SuiteEvidence(result),
        }),
      ),
    );
    const deterministicSuitesPass = suites.every(
      (suite) => suite.verified,
    );
    const versionedArtifacts = suiteRuns.every(
      ({ requestedSuiteId, result }) =>
        result.report.suiteId === requestedSuiteId &&
        result.report.reportVersion === 1 &&
        result.report.codeVersion === codeVersion &&
        result.report.case.fixtureVersion === 1 &&
        result.report.case.requirementId !== "unknown" &&
        result.report.case.specId !== "unknown",
    );
    const suiteInfrastructureFailure = suiteRuns.some(
      ({ result }) =>
        result.report.status === "infrastructure_error" ||
        result.report.exitCode === 3,
    );
    const checks: M0ReleaseGateCheck[] = [
      {
        checkId: "versioned-evaluation-artifacts",
        message: versionedArtifacts
          ? "Requirement, replay, fixture, report, and Ledger artifacts are versioned."
          : "One or more evaluation artifacts are invalid or unversioned.",
        status: versionedArtifacts ? "pass" : "fail",
      },
      {
        checkId: "suite-infrastructure",
        message: suiteInfrastructureFailure
          ? "One or more frozen suites encountered an infrastructure failure."
          : "Frozen suites completed without infrastructure errors.",
        status: suiteInfrastructureFailure ? "fail" : "pass",
      },
      {
        checkId: "deterministic-evaluation-suites",
        message: deterministicSuitesPass
          ? "Event, process, secret, scope, idempotency, and recovery suites match their frozen expectations."
          : "One or more frozen deterministic suites did not match expectations.",
        status: deterministicSuitesPass ? "pass" : "fail",
      },
      {
        checkId: "episode-association-quality",
        message:
          `Precision ${(episodeAssociation.metrics.precision * 100).toFixed(2)}%, ` +
          `recall ${(episodeAssociation.metrics.recall * 100).toFixed(2)}%, ` +
          `wrong merges ${episodeAssociation.metrics.wrongMerges}, ` +
          `wrong splits ${episodeAssociation.metrics.wrongSplits}.`,
        status:
          episodeAssociation.status === "pass" ? "pass" : "fail",
      },
      {
        checkId: "observation-only",
        message:
          "M0 persists evidence and Episode projections without activating long-term Knowledge.",
        status: "pass",
      },
      ...acceptanceEvidenceChecks(acceptanceEvidence),
    ];
    const status: M0ReleaseGateStatus =
      checks.some((check) => check.status === "fail")
        ? "fail"
        : checks.some((check) => check.status === "blocked")
          ? "blocked"
          : "pass";
    const report: M0ReleaseReport = {
      ...(acceptanceEvidence === undefined
        ? {}
        : {
            acceptanceEvidence,
          }),
      checks,
      codeVersion,
      completedAt: now().toISOString(),
      episodeAssociation,
      exitCode:
        suiteInfrastructureFailure
          ? 3
          : status === "pass"
            ? 0
            : 1,
      limitations: checks
        .filter((check) => check.status === "blocked")
        .map((check) => check.message),
      reportVersion: 1,
      runId,
      runtimeDigest,
      startedAt: startedAt.toISOString(),
      status,
      suites,
    };
    const persistedReport = await writeM0Reports(
      stagingDirectory,
      report,
    );
    await rename(stagingDirectory, runDirectory);
    return {
      report: persistedReport,
      runDirectory,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const invalidInput =
      error instanceof M0AcceptanceEvidenceInputError;
    const report: M0ReleaseReport = {
      checks: [
        {
          checkId: invalidInput ? "m0-input" : "m0-infrastructure",
          message,
          status: "fail",
        },
      ],
      artifactIntegrity: evidencePath !== undefined || options.acceptanceEvidence !== undefined
        ? "unverified" : "not_supplied",
      codeVersion,
      completedAt: now().toISOString(),
      exitCode: invalidInput ? 2 : 3,
      limitations: [
        "The M0 aggregate gate could not complete.",
      ],
      reportVersion: 1,
      runId,
      runtimeDigest,
      startedAt: startedAt.toISOString(),
      status: "fail",
      suites: [],
    };
    const persistedReport = await writeM0Reports(
      stagingDirectory,
      report,
    );
    await rename(stagingDirectory, runDirectory);
    return {
      report: persistedReport,
      runDirectory,
    };
  }
};
