import {
  createHash,
  randomUUID,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
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
  sanitizeDiagnostic,
  sha256,
} from "@provenloop/domain";

import {
  runM0ReleaseGate,
  type M0ReleaseReport,
} from "./m0-release-gate.js";
import {
  m0AcceptanceEvidenceSchema,
  type M0AcceptanceEvidence,
} from "./m0-acceptance-evidence.js";
import {
  runM1ReleaseGate,
  type M1ReleaseReport,
  type M1ReleaseTarget,
} from "./m1-release-gate.js";
import {
  runM2ReleaseGate,
  type M2ReleaseReport,
} from "./m2-release-gate.js";
import {
  evaluateAutomaticLearningAcceptance,
  type AutomaticLearningAcceptanceReport,
} from "./automatic-learning-acceptance.js";
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

export type MvpReleaseDecision =
  | "conditional_go"
  | "go"
  | "no_go";
export type MvpReleaseTarget = M1ReleaseTarget;
export type MvpReleaseCheckStatus =
  | "blocked"
  | "fail"
  | "pass";

export interface MvpReleaseCheck {
  readonly checkId: string;
  readonly message: string;
  readonly status: MvpReleaseCheckStatus;
}

export interface MvpGuardrailEvidence {
  readonly crossRepositoryLeakageCount: number;
  readonly deletionPropagationFailureCount: number;
  readonly secretLeakageCount: number;
  readonly severeHarmCount: number;
  readonly unsupportedCompletionClaimCount: number;
}

export interface MvpDatasetBinding {
  readonly datasetId: string;
  readonly datasetVersion: number;
}

export interface MvpEvaluationBinding {
  readonly codeVersion: string;
  readonly datasets: {
    readonly branchContinuation: MvpDatasetBinding;
    readonly correctionRecurrence: MvpDatasetBinding;
    readonly workEpisodeAssociation: MvpDatasetBinding;
  };
  readonly executableDigest: string;
  readonly subgateDigests: {
    readonly m0: string;
    readonly m1: string;
    readonly m2: string;
  };
}

export interface MvpReleaseEvidence {
  readonly conditionalCanary?: {
    readonly expiresAt: string;
    readonly targetIds: readonly string[];
    readonly targetType: "design_partner" | "repository";
  };
  readonly evidenceVersion: 1;
  readonly m0Acceptance?: M0AcceptanceEvidence;
  readonly evaluation: MvpEvaluationBinding;
  readonly guardrails: MvpGuardrailEvidence;
  readonly observationWindow: {
    readonly endsAt: string;
    readonly observedThrough: string;
  };
  readonly owner: string;
  readonly reviewId: string;
  readonly reviewedAt: string;
  readonly rollback: {
    readonly resolvedCommitSha: string;
    readonly target: string;
    readonly verified: boolean;
  };
  readonly shadow: {
    readonly completedAt?: string;
    readonly runId?: string;
    readonly status: "fail" | "not_run" | "pass";
  };
  readonly worstCaseReview: {
    readonly allHarmReviewed: boolean;
    readonly allWrongInjectionsReviewed: boolean;
    readonly completed: boolean;
    readonly reviewedCaseIds: readonly string[];
  };
}

export interface MvpAutomatedReadiness {
  readonly automaticLearning?: AutomaticLearningAcceptanceReport;
  readonly codeVersions: readonly string[];
  readonly evaluationBinding: MvpEvaluationBinding;
  readonly eventProcessIntegrityPassed: boolean;
  readonly m0Status: M0ReleaseReport["status"];
  readonly m1Status: M1ReleaseReport["status"];
  readonly m2Status: M2ReleaseReport["status"];
  readonly negativeTriggerCaseCount: number;
  readonly outcomeSuccessDelta?: number;
  readonly outcomeSuccessThreshold?: number;
  readonly rollbackTargetValid: boolean;
  readonly safetyRecoveryPassed: boolean;
}

export interface MvpReleaseReadiness {
  readonly checks: readonly MvpReleaseCheck[];
  readonly decision: MvpReleaseDecision;
  readonly limitations: readonly string[];
}

export interface MvpSubgateSummary {
  readonly evidenceDigest: string;
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly reportPath: string;
  readonly runId: string;
  readonly status: string;
  readonly subgate: "m0" | "m1" | "m2";
}

export interface MvpReleaseReport {
  readonly automatedEvidenceKind?: "synthetic_regression";
  readonly fieldEffect?: "not_established";
  readonly reviewEvidenceKind?: "maintainer_attestation";
  readonly observationEvidence?: ObservationManifest;
  readonly checks: readonly MvpReleaseCheck[];
  readonly codeVersion: string;
  readonly completedAt: string;
  readonly decision: MvpReleaseDecision;
  readonly evidence?: MvpReleaseEvidence;
  readonly evaluationBinding?: MvpEvaluationBinding;
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly limitations: readonly string[];
  readonly releaseTarget: MvpReleaseTarget;
  readonly reportVersion: 1;
  readonly rollbackTarget: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly subgates: readonly MvpSubgateSummary[];
}

export interface RunMvpReleaseGateOptions {
  readonly automaticLearningEvidencePath?: string;
  readonly observationManifestPath?: string;
  readonly codeVersion?: string;
  readonly cwd?: string;
  readonly evidencePath?: string;
  readonly now?: () => Date;
  readonly outputRoot: string;
  readonly releaseTarget?: MvpReleaseTarget;
  readonly runId?: string;
}

export interface RunMvpReleaseGateResult {
  readonly report: MvpReleaseReport;
  readonly runDirectory: string;
}

export const mvpReleaseExitCode = (
  subgateExitCodes: readonly (0 | 1 | 2 | 3)[],
  decision: MvpReleaseDecision,
): 0 | 1 | 2 | 3 =>
  subgateExitCodes.includes(3)
    ? 3
    : subgateExitCodes.includes(2)
      ? 2
      : decision === "no_go"
        ? 1
        : 0;

const safeIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const safeOwnerSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9@][A-Za-z0-9 @._-]*$/u);
const repositoryCanaryTargetSchema = z
  .string()
  .min(6)
  .max(128)
  .regex(/^repo-[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const designPartnerCanaryTargetSchema = z
  .string()
  .min(9)
  .max(128)
  .regex(/^partner-[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const safeCodeVersionPattern =
  /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/u;
const gitCodeVersionPattern =
  /^(?:[a-f0-9]{7,40}|[a-f0-9]{64})(?:-dirty|\+dirty\.[a-f0-9]{16})?$/iu;
const generatedRunIdPattern =
  /^mvp-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const commitShaSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu);
const evidenceDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u);
const nonNegativeCountSchema = z.number().int().nonnegative();
const datasetBindingSchema = z
  .object({
    datasetId: safeIdentifierSchema,
    datasetVersion: z.number().int().positive(),
  })
  .strict();
const evaluationBindingSchema = z
  .object({
    codeVersion: z
      .string()
      .min(1)
      .max(256)
      .regex(safeCodeVersionPattern),
    datasets: z
      .object({
        branchContinuation: datasetBindingSchema,
        correctionRecurrence: datasetBindingSchema,
        workEpisodeAssociation: datasetBindingSchema,
      })
      .strict(),
    executableDigest: evidenceDigestSchema,
    subgateDigests: z
      .object({
        m0: evidenceDigestSchema,
        m1: evidenceDigestSchema,
        m2: evidenceDigestSchema,
      })
      .strict(),
  })
  .strict();

export const mvpReleaseEvidenceSchema = z
  .object({
    conditionalCanary: z
      .discriminatedUnion("targetType", [
        z
          .object({
            expiresAt: z.string().datetime({
              offset: true,
            }),
            targetIds: z
              .array(designPartnerCanaryTargetSchema)
              .min(1)
              .max(20),
            targetType: z.literal("design_partner"),
          })
          .strict(),
        z
          .object({
            expiresAt: z.string().datetime({
              offset: true,
            }),
            targetIds: z
              .array(repositoryCanaryTargetSchema)
              .min(1)
              .max(20),
            targetType: z.literal("repository"),
          })
          .strict(),
      ])
      .optional(),
    evidenceVersion: z.literal(1),
    m0Acceptance: m0AcceptanceEvidenceSchema.optional(),
    evaluation: evaluationBindingSchema,
    guardrails: z
      .object({
        crossRepositoryLeakageCount: nonNegativeCountSchema,
        deletionPropagationFailureCount: nonNegativeCountSchema,
        secretLeakageCount: nonNegativeCountSchema,
        severeHarmCount: nonNegativeCountSchema,
        unsupportedCompletionClaimCount: nonNegativeCountSchema,
      })
      .strict(),
    observationWindow: z
      .object({
        endsAt: z.string().datetime({
          offset: true,
        }),
        observedThrough: z.string().datetime({
          offset: true,
        }),
      })
      .strict(),
    owner: safeOwnerSchema,
    reviewId: safeIdentifierSchema,
    reviewedAt: z.string().datetime({
      offset: true,
    }),
    rollback: z
      .object({
        resolvedCommitSha: commitShaSchema,
        target: z
          .string()
          .min(1)
          .max(256)
          .regex(safeCodeVersionPattern),
        verified: z.boolean(),
      })
      .strict(),
    shadow: z
      .object({
        completedAt: z
          .string()
          .datetime({
            offset: true,
          })
          .optional(),
        runId: safeIdentifierSchema.optional(),
        status: z.enum([
          "fail",
          "not_run",
          "pass",
        ]),
      })
      .strict(),
    worstCaseReview: z
      .object({
        allHarmReviewed: z.boolean(),
        allWrongInjectionsReviewed: z.boolean(),
        completed: z.boolean(),
        reviewedCaseIds: z
          .array(safeIdentifierSchema)
          .max(100),
      })
      .strict(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (
      evidence.shadow.status === "pass" &&
      (
        evidence.shadow.completedAt === undefined ||
        evidence.shadow.runId === undefined
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Passing Shadow evidence requires runId and completedAt.",
        path: [
          "shadow",
        ],
      });
    }
    if (
      new Set(
        evidence.worstCaseReview.reviewedCaseIds,
      ).size !==
        evidence.worstCaseReview.reviewedCaseIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Reviewed case IDs must be unique.",
        path: [
          "worstCaseReview",
          "reviewedCaseIds",
        ],
      });
    }
    if (
      evidence.conditionalCanary !== undefined &&
      new Set(evidence.conditionalCanary.targetIds).size !==
        evidence.conditionalCanary.targetIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Conditional Canary target IDs must be unique.",
        path: [
          "conditionalCanary",
          "targetIds",
        ],
      });
    }
  });

const mvpReleaseReportSchema = z
  .object({
    automatedEvidenceKind: z.literal("synthetic_regression").default("synthetic_regression"),
    fieldEffect: z.literal("not_established").default("not_established"),
    reviewEvidenceKind: z.literal("maintainer_attestation").default("maintainer_attestation"),
    observationEvidence: observationManifestSchema.optional(),
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
    decision: z.enum([
      "conditional_go",
      "go",
      "no_go",
    ]),
    evidence: z.unknown().optional(),
    evaluationBinding: z.unknown().optional(),
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
    rollbackTarget: z.string(),
    runId: z.string().min(1),
    startedAt: z.string().datetime({
      offset: true,
    }),
    subgates: z.array(
      z
        .object({
          evidenceDigest: evidenceDigestSchema,
          exitCode: z.union([
            z.literal(0),
            z.literal(1),
            z.literal(2),
            z.literal(3),
          ]),
          reportPath: z.string(),
          runId: z.string().min(1),
          status: z.string().min(1),
          subgate: z.enum([
            "m0",
            "m1",
            "m2",
          ]),
        })
        .strict(),
    ),
  })
  .strict();

export class MvpReleaseInputError extends Error {
  public override readonly name = "MvpReleaseInputError";
}

class MvpRunAlreadyExistsError extends Error {
  public readonly code = "EEXIST";
  public override readonly name = "MvpRunAlreadyExistsError";
  public readonly path: string;

  public constructor(path: string) {
    super(`MVP release run directory already exists: ${path}`);
    this.path = path;
  }
}

const validateRunId = (runId: string): string => {
  if (
    !safeIdentifierSchema.safeParse(runId).success ||
    containsKnownSecret(runId) ||
    (
      !generatedRunIdPattern.test(runId) &&
      containsPotentialSecret(runId)
    )
  ) {
    throw new MvpReleaseInputError(
      "MVP runId must be a safe non-secret path segment.",
    );
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
    throw new MvpReleaseInputError(
      "MVP codeVersion must be a safe non-secret Git version.",
    );
  }
  return codeVersion;
};

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
  throw new MvpRunAlreadyExistsError(runDirectory);
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
    throw new Error(
      `Git provenance command failed: ${
        result.error?.message ??
        (
          result.stderr.toString("utf8").trim() ||
          `exit ${result.status ?? "unknown"}`
        )
      }`,
    );
  }
  return result.stdout;
};

const resolveCodeVersion = async (
  cwd: string,
): Promise<string> => {
  const repositoryRoot = gitOutput([
    "rev-parse",
    "--show-toplevel",
  ], cwd).toString("utf8").trim();
  const head = gitOutput([
    "rev-parse",
    "HEAD",
  ], repositoryRoot).toString("utf8").trim();
  if (!head) {
    return "unknown";
  }
  const status = gitOutput([
    "status",
    "--porcelain=v1",
    "-z",
  ], repositoryRoot);
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
    ], repositoryRoot),
  );
  const untracked = gitOutput([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--full-name",
    "-z",
  ], repositoryRoot);
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
      await readFile(resolve(repositoryRoot, path)),
    );
  }
  return `${head}+dirty.${digest.digest("hex").slice(0, 16)}`;
};

const runtimeModulePath = fileURLToPath(import.meta.url);

const runtimeFiles = async (
  directory: string,
): Promise<readonly string[]> => {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return runtimeFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".js")
        ? [
            path,
          ]
        : [];
    }),
  );
  return nested.flat();
};

export const resolveLearningEvaluationExecutableDigest = async (
  cwd: string,
): Promise<string> => {
  if (!runtimeModulePath.includes(`${sep}dist${sep}`)) {
    return sha256({
      runtime: "source-typescript",
    });
  }
  const repositoryRoot = gitOutput([
    "rev-parse",
    "--show-toplevel",
  ], cwd).toString("utf8").trim();
  const packageEntries = await readdir(
    join(repositoryRoot, "packages"),
    {
      withFileTypes: true,
    },
  );
  const files = (
    await Promise.all(
      packageEntries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const dist = join(
            repositoryRoot,
            "packages",
            entry.name,
            "dist",
          );
          try {
            return await runtimeFiles(dist);
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            ) {
              return [];
            }
            throw error;
          }
        }),
    )
  ).flat().sort();
  if (files.length === 0) {
    throw new Error(
      "No built JavaScript artifacts were found for MVP evaluation.",
    );
  }
  const digest = createHash("sha256");
  for (const path of files) {
    updateFramedDigest(
      digest,
      "runtime-path",
      relative(repositoryRoot, path),
    );
    updateFramedDigest(
      digest,
      "runtime-content",
      await readFile(path),
    );
  }
  return digest.digest("hex");
};

const validateArtifactLocation = (
  path: string | undefined,
  cwd: string,
  label: string,
): void => {
  if (path === undefined) {
    return;
  }
  const repositoryRoot = gitOutput([
    "rev-parse",
    "--show-toplevel",
  ], cwd).toString("utf8").trim();
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
    throw new MvpReleaseInputError(
      `${label} must be outside the repository or ignored by Git.`,
    );
  }
};

const assertCodeVersionUnchanged = async (
  cwd: string,
  expected: string,
  expectedExecutableDigest: string,
): Promise<void> => {
  const current = validateCodeVersion(
    await resolveCodeVersion(cwd),
  );
  if (current !== expected) {
    throw new Error(
      "The Git worktree changed during MVP evaluation.",
    );
  }
  const executableDigest =
    await resolveLearningEvaluationExecutableDigest(cwd);
  if (executableDigest !== expectedExecutableDigest) {
    throw new Error(
      "The executable runtime changed during MVP evaluation.",
    );
  }
};

const loadedEvidence = async (
  path: string | undefined,
): Promise<MvpReleaseEvidence | undefined> => {
  if (path === undefined) {
    return undefined;
  }
  let parsed: MvpReleaseEvidence;
  try {
    const content = await readFile(path, "utf8");
    parsed = mvpReleaseEvidenceSchema.parse(
      JSON.parse(content.replace(/^\uFEFF/u, "")) as unknown,
    ) as MvpReleaseEvidence;
  } catch (error) {
    throw new MvpReleaseInputError(
      error instanceof SyntaxError
        ? "MVP release evidence JSON is invalid."
        : error instanceof z.ZodError
          ? "MVP release evidence schema is invalid."
          : "MVP release evidence could not be read.",
      {
        cause: error,
      },
    );
  }
  if (containsKnownSecret(JSON.stringify(parsed))) {
    throw new MvpReleaseInputError(
      "MVP release evidence contains a secret.",
    );
  }
  validateCodeVersion(parsed.evaluation.codeVersion);
  validateCodeVersion(parsed.rollback.target);
  return parsed;
};

const statusForSubgate = (
  status: string,
): MvpReleaseCheckStatus =>
  status === "pass"
    ? "pass"
    : status === "blocked"
      ? "blocked"
      : "fail";

const evidenceCheck = (
  evidence: MvpReleaseEvidence | undefined,
  checkId: string,
  passed: (value: MvpReleaseEvidence) => boolean,
  passMessage: string,
  failMessage: string,
): MvpReleaseCheck => {
  if (evidence === undefined) {
    return {
      checkId,
      message: "Required release evidence was not supplied.",
      status: "blocked",
    };
  }
  return {
    checkId,
    message: passed(evidence) ? passMessage : failMessage,
    status: passed(evidence) ? "pass" : "fail",
  };
};

export const evaluateMvpReleaseReadiness = (input: {
  readonly automated: MvpAutomatedReadiness;
  readonly evidence?: MvpReleaseEvidence;
  readonly now: Date;
  readonly releaseTarget: MvpReleaseTarget;
}): MvpReleaseReadiness => {
  const evidence = input.evidence;
  const versions = new Set(input.automated.codeVersions);
  const checks: MvpReleaseCheck[] = [
    {
      checkId: "automatic-learning-acceptance",
      status: input.automated.automaticLearning?.status === "pass" &&
        Array.from({ length: 8 }, (_, index) => `M2-AUTO-00${index + 1}`).every((id) =>
          input.automated.automaticLearning?.checks.some((check) => check.checkId === id && check.status === "pass"))
        ? "pass" : "blocked",
      message: "All eight automatic-learning requirements need retained installed acceptance; missing evidence cannot inherit synthetic regression approval.",
    },
    ...(input.automated.automaticLearning ?? evaluateAutomaticLearningAcceptance(undefined, input.releaseTarget)).checks,
    {
      checkId: "field-effect-evidence",
      status: "blocked",
      message: "Controlled field effects have not been evaluated. Synthetic regression and observational manifests cannot establish user benefit.",
    },
    {
      checkId: "m0-observation-foundation",
      message:
        `M0 aggregate gate status is ${input.automated.m0Status}.`,
      status: statusForSubgate(input.automated.m0Status),
    },
    {
      checkId: "event-process-integrity",
      message: input.automated.eventProcessIntegrityPassed
        ? "Event and Process Integrity suites matched their frozen expectations."
        : "Event and Process Integrity suites are missing or unverified.",
      status:
        input.automated.eventProcessIntegrityPassed
          ? "pass"
          : "fail",
    },
    {
      checkId: "safety-recovery",
      message: input.automated.safetyRecoveryPassed
        ? "Secret, scope, deletion, and recovery suites matched their frozen expectations."
        : "Safety and Recovery suites are missing or unverified.",
      status:
        input.automated.safetyRecoveryPassed
          ? "pass"
          : "fail",
    },
    {
      checkId: "m1-branch-continuation",
      message:
        `M1 aggregate gate status is ${input.automated.m1Status}.`,
      status: statusForSubgate(input.automated.m1Status),
    },
    {
      checkId: "negative-trigger",
      message:
        `${input.automated.negativeTriggerCaseCount} Negative Trigger cases were evaluated.`,
      status:
        input.automated.m1Status === "pass" &&
        input.automated.negativeTriggerCaseCount > 0
          ? "pass"
          : "fail",
    },
    {
      checkId: "outcome-success",
      message:
        input.automated.outcomeSuccessDelta === undefined ||
        input.automated.outcomeSuccessThreshold === undefined
          ? "Outcome Success evidence is unavailable."
          : `Synthetic Outcome Success delta is ${(input.automated.outcomeSuccessDelta * 100).toFixed(2)}%; this is not a measured field effect.`,
      status:
        input.automated.outcomeSuccessDelta !== undefined &&
        input.automated.outcomeSuccessThreshold !== undefined &&
        input.automated.outcomeSuccessDelta >=
          input.automated.outcomeSuccessThreshold
          ? "pass"
          : "fail",
    },
    {
      checkId: "m2-correction-recurrence",
      message:
        `M2 aggregate gate status is ${input.automated.m2Status}.`,
      status: statusForSubgate(input.automated.m2Status),
    },
    {
      checkId: "code-version-consistency",
      message:
        versions.size === 1
          ? "M0, M1, and M2 used the same code version."
          : "Subgate code versions do not match.",
      status: versions.size === 1 ? "pass" : "fail",
    },
    evidenceCheck(
      evidence,
      "evaluation-evidence-binding",
      (value) =>
        sha256(value.evaluation) ===
          sha256(input.automated.evaluationBinding),
      "Review evidence matches the evaluated code, datasets, and subgate digests.",
      "Review evidence does not match the current evaluation.",
    ),
    evidenceCheck(
      evidence,
      "worst-case-review",
      (value) =>
        value.worstCaseReview.completed &&
        value.worstCaseReview.reviewedCaseIds.length >= 10 &&
        value.worstCaseReview.allHarmReviewed &&
        value.worstCaseReview.allWrongInjectionsReviewed &&
        Date.parse(value.reviewedAt) <= input.now.getTime(),
      "The worst 10 cases and all Harm/Wrong Injection cases were reviewed.",
      "Worst-case review evidence is incomplete.",
    ),
    evidenceCheck(
      evidence,
      "zero-severe-harm",
      (value) => value.guardrails.severeHarmCount === 0,
      "Severe Harm count is zero.",
      "Severe Harm must be zero.",
    ),
    evidenceCheck(
      evidence,
      "zero-secret-leakage",
      (value) => value.guardrails.secretLeakageCount === 0,
      "Secret leakage count is zero.",
      "Secret leakage must be zero.",
    ),
    evidenceCheck(
      evidence,
      "zero-cross-repository-leakage",
      (value) =>
        value.guardrails.crossRepositoryLeakageCount === 0,
      "Cross-repository leakage count is zero.",
      "Cross-repository leakage must be zero.",
    ),
    evidenceCheck(
      evidence,
      "zero-deletion-propagation-failure",
      (value) =>
        value.guardrails.deletionPropagationFailureCount === 0,
      "Deletion propagation failure count is zero.",
      "Deletion propagation failures must be zero.",
    ),
    evidenceCheck(
      evidence,
      "zero-unsupported-completion-claims",
      (value) =>
        value.guardrails.unsupportedCompletionClaimCount === 0,
      "Unsupported Completion Claim count is zero.",
      "Unsupported Completion Claims must be zero.",
    ),
    evidenceCheck(
      evidence,
      "shadow",
      (value) =>
        value.shadow.status === "pass" &&
        value.shadow.completedAt !== undefined &&
        Date.parse(value.shadow.completedAt) <=
          input.now.getTime(),
      "Shadow evaluation passed.",
      "Shadow evaluation has not passed.",
    ),
    evidenceCheck(
      evidence,
      "observation-window",
      (value) =>
        Date.parse(value.observationWindow.observedThrough) >=
          Date.parse(value.observationWindow.endsAt) &&
        Date.parse(value.observationWindow.observedThrough) <=
          input.now.getTime() &&
        input.now.getTime() >=
          Date.parse(value.observationWindow.endsAt),
      "The configured outcome observation window completed.",
      "The outcome observation window is incomplete.",
    ),
    evidenceCheck(
      evidence,
      "rollback",
      (value) =>
        value.rollback.verified &&
        value.rollback.target.length > 0 &&
        value.rollback.target !==
          value.evaluation.codeVersion &&
        input.automated.rollbackTargetValid,
      "A rollback target was verified.",
      "Rollback target is missing, unverified, nonexistent, or matches the evaluated version.",
    ),
  ];
  if (input.releaseTarget === "research") {
    checks.push(
      evidenceCheck(
        evidence,
        "conditional-canary",
        (value) =>
          value.conditionalCanary !== undefined &&
          value.conditionalCanary.targetIds.length > 0 &&
          Date.parse(value.conditionalCanary.expiresAt) >
            input.now.getTime(),
        "A restricted, unexpired Canary scope is recorded.",
        "Research thresholds require a restricted, unexpired Canary scope.",
      ),
    );
  }
  const allPassed = checks.every(
    (check) => check.status === "pass",
  );
  const decision: MvpReleaseDecision =
    allPassed
      ? input.releaseTarget === "stable"
        ? "go"
        : "conditional_go"
      : "no_go";
  return {
    checks,
    decision,
    limitations: [
      ...new Set([
        ...checks
          .filter((check) => check.status !== "pass")
          .map((check) => check.message),
        SYNTHETIC_REGRESSION_LIMITATION,
        ...(decision === "conditional_go"
          ? [
              "Research thresholds permit only the recorded limited Canary until its expiry.",
            ]
          : []),
      ]),
    ],
  };
};

const requiredSuitesVerified = (
  report: M0ReleaseReport,
  suiteIds: readonly string[],
): boolean =>
  suiteIds.every((suiteId) =>
    report.suites.some(
      (suite) => suite.suiteId === suiteId && suite.verified,
    ),
  );

const normalizedSubgateReport = (
  report: M0ReleaseReport | M1ReleaseReport | M2ReleaseReport,
): unknown => {
  const normalized = {
    ...report,
    checks: report.checks.map((check) => ({
      checkId: check.checkId,
      status: check.status,
    })),
    completedAt: "[completed]",
    limitations: [],
    runId: "[run]",
    startedAt: "[started]",
  };
  if ("suites" in report) {
    return {
      ...normalized,
      suites: report.suites.map((suite) => ({
        ...suite,
        reportPath: `[suite:${suite.suiteId}]`,
      })),
    };
  }
  if (
    "branchContinuation" in report &&
    report.branchContinuation !== undefined
  ) {
    return {
      ...normalized,
      branchContinuation: {
        ...report.branchContinuation,
        cases: report.branchContinuation.cases.map(
          (testCase) => ({
            ...testCase,
            latencyMs: 0,
          }),
        ),
        metrics: {
          ...report.branchContinuation.metrics,
          latencyP95Ms: 0,
        },
      },
    };
  }
  return {
    ...normalized,
  };
};

const subgateEvidenceDigest = (
  report: M0ReleaseReport | M1ReleaseReport | M2ReleaseReport,
): string => sha256(normalizedSubgateReport(report));

const datasetBinding = (
  input:
    | {
        readonly datasetId: string;
        readonly datasetVersion: number;
      }
    | undefined,
): MvpDatasetBinding => input === undefined
  ? {
      datasetId: "unavailable",
      datasetVersion: 1,
    }
  : {
      datasetId: input.datasetId,
      datasetVersion: input.datasetVersion,
    };

const evaluationBinding = (
  codeVersion: string,
  executableDigest: string,
  m0: M0ReleaseReport,
  m1: M1ReleaseReport,
  m2: M2ReleaseReport,
): MvpEvaluationBinding => ({
  codeVersion,
  datasets: {
    branchContinuation: datasetBinding(
      m1.branchContinuation,
    ),
    correctionRecurrence: datasetBinding(
      m2.correctionRecurrence,
    ),
    workEpisodeAssociation: datasetBinding(
      m0.episodeAssociation,
    ),
  },
  executableDigest,
  subgateDigests: {
    m0: subgateEvidenceDigest(m0),
    m1: subgateEvidenceDigest(m1),
    m2: subgateEvidenceDigest(m2),
  },
});

const rollbackTargetValid = (
  evidence: MvpReleaseEvidence | undefined,
  cwd: string,
): boolean => {
  if (
    evidence === undefined ||
    !evidence.rollback.verified
  ) {
    return false;
  }
  try {
    const resolved = gitOutput([
      "rev-parse",
      "--verify",
      `${evidence.rollback.target}^{commit}`,
    ], cwd).toString("utf8").trim();
    const head = gitOutput([
      "rev-parse",
      "HEAD",
    ], cwd).toString("utf8").trim();
    return (
      resolved === evidence.rollback.resolvedCommitSha &&
      resolved !== head
    );
  } catch {
    return false;
  }
};

const automatedReadiness = (
  m0: M0ReleaseReport,
  m1: M1ReleaseReport,
  m2: M2ReleaseReport,
  binding: MvpEvaluationBinding,
  rollbackValid: boolean,
): MvpAutomatedReadiness => {
  const outcomeSuccessDelta =
    m1.branchContinuation?.metrics.outcomeSuccessDelta;
  const outcomeSuccessThreshold =
    m1.branchContinuation?.thresholds.outcomeSuccessDelta;
  return {
    codeVersions: [
      m0.codeVersion,
      m1.codeVersion,
      m2.codeVersion,
    ],
    automaticLearning: m2.automaticLearning ?? evaluateAutomaticLearningAcceptance(undefined),
    evaluationBinding: binding,
    eventProcessIntegrityPassed: requiredSuitesVerified(
      m0,
      [
        "false-completion",
        "malformed-event",
        "participant-not-invoked",
        "resolved-model-mismatch",
        "unknown-adapter-version",
        "valid-supported-event",
      ],
    ),
    m0Status: m0.status,
    m1Status: m1.status,
    m2Status: m2.status,
    negativeTriggerCaseCount:
      m1.branchContinuation?.metrics.negativeCases ?? 0,
    ...(outcomeSuccessDelta === undefined
      ? {}
      : {
          outcomeSuccessDelta,
        }),
    ...(outcomeSuccessThreshold === undefined
      ? {}
      : {
          outcomeSuccessThreshold,
        }),
    rollbackTargetValid: rollbackValid,
    safetyRecoveryPassed: requiredSuitesVerified(
      m0,
      [
        "deletion-propagation",
        "duplicate-event",
        "queue-interruption-recovery",
        "repository-scope-leakage",
        "seeded-secret",
      ],
    ),
  };
};

const sanitizePublishedDiagnostic = (
  value: unknown,
): string =>
  redactPotentialSecrets(sanitizeDiagnostic(value))
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

const sanitizeReport = (
  report: MvpReleaseReport,
): MvpReleaseReport => ({
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
  rollbackTarget: redactKnownSecrets(report.rollbackTarget),
  runId: redactKnownSecrets(report.runId),
  subgates: report.subgates.map((subgate) => ({
    ...subgate,
    reportPath: redactKnownSecrets(subgate.reportPath),
    runId: redactKnownSecrets(subgate.runId),
  })),
});

const renderMvpReleaseReport = (
  report: MvpReleaseReport,
): string => {
  const checks = report.checks.map(
    (check) =>
      `| ${escapeMarkdownText(check.checkId)} | ${check.status} | ${escapeMarkdownText(check.message)} |`,
  );
  const subgates = report.subgates.map(
    (subgate) =>
      `| ${subgate.subgate.toUpperCase()} | ${escapeMarkdownText(subgate.status)} | ${subgate.exitCode} | \`${subgate.evidenceDigest}\` | \`${subgate.reportPath}\` |`,
  );
  return `# ProvenLoop M1 + M2 MVP Go/No-Go

## Decision

| Field | Value |
|---|---|
| Run ID | \`${report.runId}\` |
| Code version | \`${report.codeVersion}\` |
| Release target | ${report.releaseTarget} |
| Decision | **${report.decision.toUpperCase().replaceAll("_", " ")}** |
| Exit code | ${report.exitCode} |
| Rollback target | \`${report.rollbackTarget}\` |
| Started | ${report.startedAt} |
| Completed | ${report.completedAt} |

## Subgates

| Gate | Status | Exit code | Evidence digest | Report |
|---|---|---:|---|---|
${subgates.join("\n")}

## Checks

| Check | Status | Message |
|---|---|---|
${checks.join("\n")}

## Known limitations

${
  report.limitations.length === 0
    ? "- None"
    : report.limitations
        .map((item) => `- ${escapeMarkdownText(item)}`)
        .join("\n")
}
`;
};

const writeReports = async (
  directory: string,
  report: MvpReleaseReport,
): Promise<MvpReleaseReport> => {
  const sanitized = mvpReleaseReportSchema.parse(
    sanitizeReport(report),
  ) as MvpReleaseReport;
  const json = `${JSON.stringify(sanitized, null, 2)}\n`;
  const markdown = renderMvpReleaseReport(sanitized);
  if (
    containsKnownSecret(json) ||
    containsKnownSecret(markdown)
  ) {
    throw new Error(
      "MVP release report contains an unredacted secret.",
    );
  }
  await writeFile(
    join(directory, "mvp-report.json"),
    json,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  await writeFile(
    join(directory, "mvp-report.md"),
    markdown,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  return sanitized;
};

const subgateSummaries = (
  reports: {
    readonly m0: M0ReleaseReport;
    readonly m1: M1ReleaseReport;
    readonly m2: M2ReleaseReport;
  },
  binding: MvpEvaluationBinding,
): readonly MvpSubgateSummary[] => [
  {
    evidenceDigest: binding.subgateDigests.m0,
    exitCode: reports.m0.exitCode,
    reportPath: join(
      "subgates",
      "m0",
      "m0-report.json",
    ),
    runId: reports.m0.runId,
    status: reports.m0.status,
    subgate: "m0",
  },
  {
    evidenceDigest: binding.subgateDigests.m1,
    exitCode: reports.m1.exitCode,
    reportPath: join(
      "subgates",
      "m1",
      "m1-report.json",
    ),
    runId: reports.m1.runId,
    status: reports.m1.status,
    subgate: "m1",
  },
  {
    evidenceDigest: binding.subgateDigests.m2,
    exitCode: reports.m2.exitCode,
    reportPath: join(
      "subgates",
      "m2",
      "m2-report.json",
    ),
    runId: reports.m2.runId,
    status: reports.m2.status,
    subgate: "m2",
  },
];

export const runMvpReleaseGate = async (
  options: RunMvpReleaseGateOptions,
): Promise<RunMvpReleaseGateResult> => {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = validateRunId(
    options.runId ??
      `mvp-${startedAt.toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID()}`,
  );
  const cwd = resolve(options.cwd ?? process.cwd());
  const outputRoot = resolve(options.outputRoot);
  const verifyWorktree = options.codeVersion === undefined;
  const evidencePath =
    options.evidencePath === undefined
      ? undefined
      : resolve(options.evidencePath);
  let codeVersion = "unavailable";
  let executableDigest = sha256({
    runtime: "unavailable",
  });
  let provenanceError: unknown;
  validateArtifactLocation(
    outputRoot,
    cwd,
    "MVP output directory",
  );
  try {
    validateArtifactLocation(
      evidencePath,
      cwd,
      "MVP release evidence",
    );
    codeVersion = validateCodeVersion(
      options.codeVersion ?? await resolveCodeVersion(cwd),
    );
    executableDigest =
      await resolveLearningEvaluationExecutableDigest(cwd);
  } catch (error) {
    provenanceError = error;
  }
  await mkdir(outputRoot, {
    recursive: true,
  });
  const runDirectory = resolve(outputRoot, runId);
  if (
    !runDirectory.startsWith(`${outputRoot}\\`) &&
    runDirectory !== outputRoot
  ) {
    throw new MvpReleaseInputError(
      "MVP run directory escaped the output root.",
    );
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
    let report: MvpReleaseReport;
    try {
      if (provenanceError !== undefined) {
        throw provenanceError;
      }
      const evidence = await loadedEvidence(
        evidencePath,
      );
      const observationEvidence = await loadObservationManifest(options.observationManifestPath, codeVersion);
      const subgateRoot = join(
        stagingDirectory,
        "subgates",
      );
      const [
        m0,
        m1,
        m2,
      ] = await Promise.all([
        runM0ReleaseGate({
          ...(evidencePath === undefined ? {} : { evidenceRoot: resolve(evidencePath, "..") }),
          ...(evidence?.m0Acceptance === undefined
            ? {}
            : {
                acceptanceEvidence: evidence.m0Acceptance,
              }),
          codeVersion,
          cwd,
          outputRoot: subgateRoot,
          runId: "m0",
        }),
        runM1ReleaseGate({
          ...(options.observationManifestPath === undefined ? {} : { observationManifestPath: options.observationManifestPath }),
          codeVersion,
          cwd,
          outputRoot: subgateRoot,
          releaseTarget,
          runId: "m1",
        }),
        runM2ReleaseGate({
          ...(options.automaticLearningEvidencePath === undefined ? {} : { automaticLearningEvidencePath: options.automaticLearningEvidencePath }),
          ...(options.observationManifestPath === undefined ? {} : { observationManifestPath: options.observationManifestPath }),
          codeVersion,
          cwd,
          outputRoot: subgateRoot,
          releaseTarget,
          runId: "m2",
        }),
      ]);
      if (verifyWorktree) {
        await assertCodeVersionUnchanged(
          cwd,
          codeVersion,
          executableDigest,
        );
      }
      const binding = evaluationBinding(
        codeVersion,
        executableDigest,
        m0.report,
        m1.report,
        m2.report,
      );
      const readiness = evaluateMvpReleaseReadiness({
        automated: automatedReadiness(
          m0.report,
          m1.report,
          m2.report,
          binding,
          rollbackTargetValid(evidence, cwd),
        ),
        ...(evidence === undefined
          ? {}
          : {
              evidence,
            }),
        now: now(),
        releaseTarget,
      });
      report = {
        ...(observationEvidence === undefined ? {} : { observationEvidence }),
        checks: readiness.checks,
        codeVersion,
        completedAt: now().toISOString(),
        decision: readiness.decision,
        ...(evidence === undefined
          ? {}
          : {
              evidence,
            }),
        evaluationBinding: binding,
        exitCode: mvpReleaseExitCode(
          [
            m0.report.exitCode,
            m1.report.exitCode,
            m2.report.exitCode,
          ],
          readiness.decision,
        ),
        limitations: readiness.limitations,
        releaseTarget,
        reportVersion: 1,
        rollbackTarget:
          evidence?.rollback.target ?? "unavailable",
        runId,
        startedAt: startedAt.toISOString(),
        subgates: subgateSummaries({
          m0: m0.report,
          m1: m1.report,
          m2: m2.report,
        }, binding),
      };
    } catch (error) {
      const invalidInput =
        error instanceof MvpReleaseInputError || error instanceof ObservationManifestInputError;
      report = {
        checks: [
          {
            checkId:
              invalidInput
                ? "mvp-input"
                : "mvp-infrastructure",
            message: sanitizePublishedDiagnostic(error),
            status: "fail",
          },
        ],
        codeVersion,
        completedAt: now().toISOString(),
        decision: "no_go",
        exitCode: invalidInput ? 2 : 3,
        limitations: [
          invalidInput
            ? "The MVP release input was invalid."
            : "The MVP aggregate gate could not complete.",
        ],
        releaseTarget,
        reportVersion: 1,
        rollbackTarget: "unavailable",
        runId,
        startedAt: startedAt.toISOString(),
        subgates: [],
      };
    }
    let publishedReport = await writeReports(
      stagingDirectory,
      report,
    );
    if (verifyWorktree && report.subgates.length > 0) {
      try {
        await assertCodeVersionUnchanged(
          cwd,
          codeVersion,
          executableDigest,
        );
      } catch (error) {
        await Promise.all([
          rm(join(stagingDirectory, "mvp-report.json"), {
            force: true,
          }),
          rm(join(stagingDirectory, "mvp-report.md"), {
            force: true,
          }),
        ]);
        publishedReport = await writeReports(
          stagingDirectory,
          {
            checks: [
              {
                checkId: "mvp-provenance",
                message: sanitizePublishedDiagnostic(error),
                status: "fail",
              },
            ],
            codeVersion,
            completedAt: now().toISOString(),
            decision: "no_go",
            exitCode: 3,
            limitations: [
              "The worktree changed before the MVP decision could be published.",
            ],
            releaseTarget,
            reportVersion: 1,
            rollbackTarget: "unavailable",
            runId,
            startedAt: startedAt.toISOString(),
            subgates: [],
          },
        );
      }
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
