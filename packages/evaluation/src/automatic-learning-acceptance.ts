import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { verifyExternalReportArtifacts } from "./external-report-binding.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const observation = z.enum(["pass", "fail", "unknown"]);

// A retained observation needs a content digest; a boolean assertion is not evidence.
export const automaticLearningObservationIds = [
  "open_session_trigger_zh", "open_session_trigger_en",
  "bounded_redacted_real_model", "original_source_spans",
  "native_recovery", "mcp_recovery", "unsupported_proof_rejected",
  "native_later_compliance", "mcp_later_compliance",
  "no_tools_or_plugins", "internal_session_exclusion", "consent",
  "disabled_learning", "quota_pause", "signed_out", "rate_limited",
  "timeout", "foreground_isolation",
  "retry_deduplication", "counterevidence", "revocation",
  "source_deletion", "session_deletion", "inflight_invalidation",
  "rebuild_non_resurrection", "temporary_requests", "quotations",
  "generic_advice", "synonym_merge", "conflicts", "candidate_expiry",
  "prompt_replay_no_expiry_refresh", "instruction_duplicate_suppression",
  "candidate_context_isolation", "activation_notice_visible",
  "delivery_notice_visible", "notice_source_and_controls",
  "notice_task_bounds", "activation_notice_cross_task_deduplication",
  "candidate_notice_suppression", "notification_mute_is_independent",
  "pending_notice_invalidation",
] as const;

const windowSchema = z.object({
  id: identifier,
  independentSourceId: identifier,
  language: z.enum(["zh", "en"]),
  reusable: z.boolean().nullable(),
  qualified: z.boolean().nullable(),
  activationProhibited: z.boolean(),
  candidate: z.enum(["correct", "incorrect", "none", "unknown"]),
  proposedRules: z.number().int().nonnegative(),
  correctRules: z.number().int().nonnegative(),
  provenanceComplete: z.boolean().nullable(),
  active: z.boolean().nullable(),
  disposition: z.enum(["completed", "not_scheduled", "queued", "paused", "timeout", "failed", "unknown"]),
  persistenceLatencyMs: z.number().nonnegative().nullable(),
  evidenceDigests: z.array(digest).min(1),
}).strict().superRefine((value, context) => {
  if (value.correctRules > value.proposedRules || (value.qualified === true && value.reusable !== true) ||
      (value.candidate === "none" && value.proposedRules !== 0) ||
      (value.candidate === "correct" && value.correctRules === 0) ||
      (value.candidate === "incorrect" && value.proposedRules === 0)) {
    context.addIssue({ code: "custom", message: "Inconsistent independent window labels or rule counts." });
  }
});

const taskSchema = z.object({
  id: identifier,
  scenario: z.enum(["native", "mcp"]).optional(),
  applicable: z.boolean().nullable(),
  deliveredBeforeOperationWithoutReminder: z.boolean().nullable(),
  providedItems: z.number().int().nonnegative(),
  incorrectItems: z.number().int().nonnegative(),
  hostObserved: z.boolean(),
  compliance: z.enum(["compliant", "noncompliant", "unknown"]),
  evidenceDigests: z.array(digest).min(1),
}).strict().superRefine((value, context) => {
  if (value.incorrectItems > value.providedItems ||
      (value.deliveredBeforeOperationWithoutReminder === true && value.providedItems === 0)) {
    context.addIssue({ code: "custom", message: "Inconsistent task delivery counts." });
  }
});

export const automaticLearningEvidenceSchema = z.object({
  evidenceVersion: z.literal(1),
  evidenceKind: z.enum(["installed_controlled", "synthetic"]),
  codeVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/u),
  installedArtifactDigest: digest,
  providerId: identifier,
  modelId: identifier,
  hostVersion: identifier,
  signInObserved: z.boolean(),
  realModelCalls: z.number().int().nonnegative(),
  conditionsFrozenAt: z.string().datetime({ offset: true }),
  labelsFrozenAt: z.string().datetime({ offset: true }),
  runStartedAt: z.string().datetime({ offset: true }),
  independentHumanAnnotators: z.array(identifier).min(2),
  allAttemptsRetained: z.boolean(),
  infrastructureFailureCount: z.number().int().nonnegative(),
  secretLeakageCount: z.number().int().nonnegative(),
  crossRepositoryMisuseCount: z.number().int().nonnegative(),
  fabricatedConfirmationCount: z.number().int().nonnegative(),
  windows: z.array(windowSchema),
  tasks: z.array(taskSchema),
  observations: z.array(z.object({
    id: z.enum(automaticLearningObservationIds),
    status: observation,
    evidenceDigests: z.array(digest),
  }).strict()),
}).strict().superRefine((value, context) => {
  const groups = [value.windows.map((item) => item.id),
    value.windows.map((item) => item.independentSourceId), value.tasks.map((item) => item.id),
    value.observations.map((item) => item.id), value.independentHumanAnnotators];
  if (groups.some((group) => new Set(group).size !== group.length)) {
    context.addIssue({ code: "custom", message: "Duplicate case, causal source, observation or annotator identity." });
  }
});

export type AutomaticLearningEvidence = z.infer<typeof automaticLearningEvidenceSchema>;
export interface AutomaticLearningCheck {
  readonly checkId: string;
  readonly status: "pass" | "fail" | "blocked";
  readonly message: string;
}
export interface AutomaticLearningAcceptanceReport {
  readonly status: "pass" | "fail" | "insufficient_evidence";
  readonly checks: readonly AutomaticLearningCheck[];
  readonly metrics: Readonly<Record<string, number | null>>;
  readonly evidenceDigest?: string;
}

export const installedLearningArtifactManifestSchema = z.object({
  version: z.literal(1), producer: z.literal("provenloop-installed-observer"),
  codeVersion: z.string(), executableDigest: digest,
  artifacts: z.array(z.object({ path: z.string(), sha256: digest }).strict()).min(1),
}).strict();

const importedEvidenceBindingSchema = z.object({
  version: z.literal(1), evidenceDigest: digest, artifactRoot: z.string().min(1),
  manifest: installedLearningArtifactManifestSchema,
}).strict();

const readBoundedJson = async (path: string): Promise<unknown> => {
  const file = await open(path, "r");
  try {
    const details = await file.stat();
    if (!details.isFile() || details.size > 16 * 1024 * 1024) {
      throw new Error("Automatic-learning evidence must be a bounded file.");
    }
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } finally { await file.close(); }
};

export const loadAutomaticLearningEvidence = async (path?: string, expected?: {
  readonly codeVersion: string; readonly executableDigest: string;
}): Promise<AutomaticLearningEvidence | undefined> => {
  if (path === undefined) return undefined;
  const evidence = automaticLearningEvidenceSchema.parse(await readBoundedJson(path));
  const binding = importedEvidenceBindingSchema.parse(await readBoundedJson(path + ".artifacts.json"));
  if (evidence.evidenceKind !== "installed_controlled" ||
      binding.evidenceDigest !== createHash("sha256").update(JSON.stringify(evidence)).digest("hex") ||
      binding.manifest.codeVersion !== evidence.codeVersion ||
      binding.manifest.executableDigest !== evidence.installedArtifactDigest ||
      (expected !== undefined && (evidence.codeVersion !== expected.codeVersion ||
        evidence.installedArtifactDigest !== expected.executableDigest))) {
    throw new Error("Installed evidence, import binding and evaluated executable do not match.");
  }
  await verifyExternalReportArtifacts(binding.manifest.artifacts, [
    ...evidence.windows.flatMap((item) => item.evidenceDigests),
    ...evidence.tasks.flatMap((item) => item.evidenceDigests),
    ...evidence.observations.flatMap((item) => item.evidenceDigests),
  ], resolve(dirname(path), binding.artifactRoot));
  return evidence;
};

export const evaluateAutomaticLearningAcceptance = (
  input: unknown,
  releaseTarget: "research" | "stable" = "research",
  expectedCodeVersion?: string,
): AutomaticLearningAcceptanceReport => {
  const parsed = automaticLearningEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: input === undefined ? "insufficient_evidence" : "fail",
      checks: Array.from({ length: 8 }, (_, index) => ({
        checkId: `M2-AUTO-00${index + 1}`,
        status: input === undefined ? "blocked" : "fail",
        message: input === undefined
          ? "Insufficient evidence: no frozen installed automatic-learning observations supplied."
          : "Invalid automatic-learning evidence; unknown fields, inconsistent counts and duplicate identities are rejected.",
      })),
      metrics: {},
    };
  }
  const evidence = parsed.data;
  const checks: AutomaticLearningCheck[] = [];
  const metrics: Record<string, number | null> = {};
  const add = (checkId: string, passed: boolean, message: string, complete = true): void => {
    checks.push({ checkId, message, status: !complete ? "blocked" : passed ? "pass" : "fail" });
  };
  const observed = (checkId: string, ids: readonly typeof automaticLearningObservationIds[number][]): void => {
    const values = ids.map((id) => evidence.observations.find((item) => item.id === id));
    add(checkId, values.every((item) => item?.status === "pass"),
      `Required retained host observations: ${ids.join(", ")}.`,
      values.every((item) => item !== undefined && item.status !== "unknown" && item.evidenceDigests.length > 0));
  };
  const ratio = (id: string, numerator: number, denominator: number, threshold: number, minimum: number, upper = false): void => {
    metrics[id] = denominator === 0 ? null : numerator / denominator;
    add(id, denominator > 0 && (upper ? numerator / denominator <= threshold : numerator / denominator >= threshold),
      `${numerator}/${denominator}; required ${upper ? "at most" : "at least"} ${threshold}, denominator at least ${minimum}.`,
      denominator >= minimum);
  };
  add("M2-AUTO-002-runtime-binding", expectedCodeVersion === undefined || evidence.codeVersion === expectedCodeVersion,
    "Installed evidence must match the evaluated code version.");
  add("M2-AUTO-002-real-provider", true, "Synthetic fixtures and unavailable provider runs do not establish installed acceptance.",
    evidence.evidenceKind === "installed_controlled" && evidence.signInObserved && evidence.realModelCalls > 0);
  add("M2-AUTO-007-frozen-labels", Date.parse(evidence.labelsFrozenAt) < Date.parse(evidence.runStartedAt) &&
    Date.parse(evidence.conditionsFrozenAt) < Date.parse(evidence.runStartedAt), "Labels and resource/provider conditions must be frozen before execution.");
  const windows = evidence.windows;
  const tasks = evidence.tasks;
  const positives = windows.filter((item) => item.reusable === true);
  const qualified = windows.filter((item) => item.qualified === true);
  const applicable = tasks.filter((item) => item.applicable === true);
  const inapplicable = tasks.filter((item) => item.applicable === false);
  add("M2-AUTO-007-sample", true, "Require 40 windows, 20 independent positive and 20 negative windows, Chinese and English.",
    windows.length >= 40 && positives.length >= 20 && windows.filter((item) => item.reusable === false).length >= 20 &&
    new Set(windows.map((item) => item.language)).size === 2);
  add("M2-AUTO-007-label-completeness", true, "Every frozen window/task needs independent labels and observed results; missing values remain unknown.",
    windows.every((item) => item.reusable !== null && item.qualified !== null && item.provenanceComplete !== null && item.active !== null && item.candidate !== "unknown") &&
    tasks.every((item) => item.applicable !== null && item.hostObserved && item.deliveredBeforeOperationWithoutReminder !== null &&
      (item.applicable !== true || (item.scenario !== undefined && item.compliance !== "unknown"))));
  add("M2-AUTO-004-observed-compliance", ["native", "mcp"].every((scenario) => applicable.some((item) =>
    item.scenario === scenario && item.hostObserved && item.deliveredBeforeOperationWithoutReminder === true &&
    item.providedItems > item.incorrectItems && item.compliance === "compliant")),
    "Both native test-command and MCP-parameter later tasks must show observed compliance after timely, applicable delivery; delivery alone is not adoption.",
    applicable.length > 0 && applicable.every((item) => item.scenario !== undefined && item.hostObserved && item.compliance !== "unknown"));
  add("M2-AUTO-005-complete-run", true, "All attempts must be retained; provider/host failures and queued, paused or timeout windows make controlled acceptance incomplete.",
    evidence.allAttemptsRetained && evidence.infrastructureFailureCount === 0 && windows.every((item) => item.disposition === "completed" || item.disposition === "not_scheduled"));
  ratio("M2-AUTO-007-discovery-recall", positives.filter((item) => item.candidate === "correct" && item.provenanceComplete).length, positives.length, 0.9, 20);
  ratio("M2-AUTO-007-activation-rate", qualified.filter((item) => item.active === true).length, qualified.length, 0.9, 20);
  ratio("M2-AUTO-007-delivery-rate", applicable.filter((item) => item.hostObserved && item.deliveredBeforeOperationWithoutReminder === true).length, applicable.length, 0.95, 20);
  ratio("M2-AUTO-007-negative-abstention", inapplicable.filter((item) => item.hostObserved && item.providedItems === 0).length, inapplicable.length, 0.98, 20);
  ratio("M2-AUTO-002-rule-precision", windows.reduce((sum, item) => sum + item.correctRules, 0), windows.reduce((sum, item) => sum + item.proposedRules, 0), 0.95, 1);
  const wrongThreshold = releaseTarget === "stable" ? 0.01 : 0.02;
  ratio("M2-AUTO-007-wrong-items", tasks.reduce((sum, item) => sum + item.incorrectItems, 0), tasks.reduce((sum, item) => sum + item.providedItems, 0), wrongThreshold, 1, true);
  ratio("M2-AUTO-007-wrong-tasks", tasks.filter((item) => item.incorrectItems > 0).length, tasks.filter((item) => item.providedItems > 0).length, wrongThreshold, 1, true);
  add("M2-AUTO-002-provenance", windows.every((item) => item.proposedRules === 0 || item.provenanceComplete === true), "Every proposed rule needs complete original-source provenance.");
  add("M2-AUTO-003-prohibited-activation", windows.every((item) => !item.activationProhibited || item.active === false), "All prohibited automatic activations must be blocked.");
  add("M2-AUTO-006-zero-safety-errors", evidence.secretLeakageCount === 0 && evidence.crossRepositoryMisuseCount === 0 && evidence.fabricatedConfirmationCount === 0,
    "Secret leakage, cross-repository misuse and fabricated confirmation must be zero.");
  const latencies = qualified.filter((item) => item.active === true).flatMap((item) => item.persistenceLatencyMs === null ? [] : [item.persistenceLatencyMs]).sort((a, b) => a - b);
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1] ?? null;
  metrics.persistenceLatencyP95Ms = p95;
  for (const disposition of ["queued", "paused", "timeout", "failed", "not_scheduled", "unknown"] as const) {
    metrics[`${disposition}Windows`] = windows.filter((item) => item.disposition === disposition).length;
  }
  for (const compliance of ["compliant", "noncompliant", "unknown"] as const) {
    metrics[`${compliance}Tasks`] = tasks.filter((item) => item.compliance === compliance).length;
    metrics[`${compliance}ApplicableTasks`] = applicable.filter((item) => item.compliance === compliance).length;
  }
  for (const scenario of ["native", "mcp"] as const) {
    for (const compliance of ["compliant", "noncompliant", "unknown"] as const) {
      metrics[`${scenario}${compliance}Tasks`] = applicable.filter((item) => item.scenario === scenario && item.compliance === compliance).length;
    }
  }
  metrics.causalBenefit = null;
  add("M2-AUTO-007-persistence-latency", p95 !== null && p95 <= 120_000,
    "Observed persistence latency p95 must be at most 120000 ms; missing, paused and queued observations cannot disappear.",
    latencies.length > 0 && qualified.filter((item) => item.active === true).every((item) => item.persistenceLatencyMs !== null));
  observed("M2-AUTO-001", automaticLearningObservationIds.slice(0, 2));
  observed("M2-AUTO-002", automaticLearningObservationIds.slice(2, 4));
  observed("M2-AUTO-003", automaticLearningObservationIds.slice(4, 7));
  observed("M2-AUTO-004", automaticLearningObservationIds.slice(7, 9));
  observed("M2-AUTO-005", automaticLearningObservationIds.slice(9, 18));
  observed("M2-AUTO-006", automaticLearningObservationIds.slice(18, 25));
  observed("M2-AUTO-007", automaticLearningObservationIds.slice(25, 34));
  observed("M2-AUTO-008", automaticLearningObservationIds.slice(34));
  return {
    status: checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "blocked") ? "insufficient_evidence" : "pass",
    checks, metrics, evidenceDigest: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
  };
};
