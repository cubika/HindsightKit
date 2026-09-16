import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { learningDistillationSummarySchema, type LearningDistillationSummary, type LearningWindow, type RuleProposal } from "@provenloop/contracts";
import { validateLearningResponse, verifyLearningRecovery, sha256 } from "@provenloop/domain";
import { frozenLearningCorpusSchema, createFrozenLearningCorpus, type FrozenLearningCorpus } from "./automatic-learning-corpus.js";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { buildLearningWindows } from "@provenloop/domain";
import { evaluateAutomaticLearningAcceptance, automaticLearningEvidenceSchema, installedLearningArtifactManifestSchema } from "./automatic-learning-acceptance.js";
import { verifyExternalReportArtifacts } from "./external-report-binding.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timeSchema = z.string().datetime({ offset: true });
const digestText = (value: string): string => createHash("sha256").update(value).digest("hex");
const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const writeNew = async (path: string, value: unknown): Promise<string> => {
  const text = json(value); await writeFile(path, text, { encoding: "utf8", flag: "wx" }); return digestText(text);
};
const readJson = async (path: string): Promise<unknown> => {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > 16 * 1024 * 1024) throw new Error("Evaluation input exceeds 16 MiB.");
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } finally { await file.close(); }
};
export const learningInputLabelsSchema = z.object({
  version: z.literal(1), corpusDigest: digestSchema, reviewerId: z.string().min(1).nullable(), reviewedAt: timeSchema.nullable(),
  role: z.literal("independent_human"),
  windows: z.array(z.object({ id: z.string(), reusable: z.boolean().nullable(), qualified: z.boolean().nullable(),
    activationProhibited: z.boolean().nullable(), expectedRule: z.string().max(2048).nullable(),
    applicability: z.string().max(2048).nullable(), notes: z.string().max(2048) }).strict()),
  tasks: z.array(z.object({ id: z.string(), applicable: z.boolean().nullable(), notes: z.string().max(2048) }).strict()),
}).strict();
export const learningOutputReviewSchema = z.object({
  version: z.literal(1), corpusDigest: digestSchema, runDigest: digestSchema,
  reviewerId: z.string().min(1).nullable(), reviewedAt: timeSchema.nullable(), role: z.literal("independent_human"),
  windows: z.array(z.object({ id: z.string(), candidate: z.enum(["correct", "incorrect", "none"]).nullable(),
    correctRules: z.number().int().nonnegative().nullable(), provenanceComplete: z.boolean().nullable(),
    notes: z.string().max(2048) }).strict()),
}).strict();
type InputLabels = z.infer<typeof learningInputLabelsSchema>;
const exactIds = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && new Set(actual).size === actual.length && actual.every((id) => expected.includes(id));

export const prepareFrozenLearningEvaluation = async (options: {
  readonly outputDirectory: string; readonly corpus?: FrozenLearningCorpus; readonly now?: () => Date;
}): Promise<{ corpusDigest: string; directory: string }> => {
  const corpus = frozenLearningCorpusSchema.parse(options.corpus ?? createFrozenLearningCorpus());
  await mkdir(options.outputDirectory, { recursive: true });
  const corpusDigest = await writeNew(join(options.outputDirectory, "corpus.json"), corpus);
  await writeNew(join(options.outputDirectory, "frozen-manifest.json"), { version: 1, corpusDigest,
    frozenAt: (options.now ?? (() => new Date()))().toISOString(), sourceKind: corpus.sourceKind,
    windows: corpus.cases.length, tasks: corpus.tasks.length,
    instruction: "Design strata are author coverage categories, not human labels. Complete input reviews before running the model." });
  const blank: InputLabels = { version: 1, corpusDigest, reviewerId: null, reviewedAt: null, role: "independent_human",
    windows: corpus.cases.map((item) => ({ id: item.id, reusable: null, qualified: null, activationProhibited: null,
      expectedRule: null, applicability: null, notes: "" })),
    tasks: corpus.tasks.map((item) => ({ id: item.id, applicable: null, notes: "" })) };
  await writeNew(join(options.outputDirectory, "input-review-a.json"), blank);
  await writeNew(join(options.outputDirectory, "input-review-b.json"), blank);
  return { corpusDigest, directory: options.outputDirectory };
};

const loadLabels = async (paths: readonly string[], corpus: FrozenLearningCorpus, corpusDigest: string, before: string): Promise<InputLabels[]> => {
  const labels: InputLabels[] = [];
  for (const path of paths) {
    const label = learningInputLabelsSchema.parse(await readJson(path));
    if (label.corpusDigest !== corpusDigest || !label.reviewerId || !label.reviewedAt || Date.parse(label.reviewedAt) >= Date.parse(before) ||
        !exactIds(label.windows.map((item) => item.id), corpus.cases.map((item) => item.id)) ||
        !exactIds(label.tasks.map((item) => item.id), corpus.tasks.map((item) => item.id)) ||
        label.windows.some((item) => item.reusable === null || item.qualified === null || item.activationProhibited === null ||
          (item.reusable && (!item.expectedRule || !item.applicability))) || label.tasks.some((item) => item.applicable === null)) {
      throw new Error("Independent input labels are incomplete, stale, or do not cover the frozen corpus.");
    }
    labels.push(label);
  }
  if (labels.length > 0 && (labels.length !== 2 || labels[0]?.reviewerId === labels[1]?.reviewerId)) throw new Error("Two distinct input reviewers are required.");
  return labels;
};
export interface FrozenLearningProvider {
  readonly timeoutMs?: number;
  readonly identity: { readonly provider: string; readonly model: string; readonly version: string };
  infer(window: LearningWindow, options: { readonly signal: AbortSignal; readonly reserveReviewAttempt?: () => boolean | Promise<boolean> }): Promise<unknown>;
}
const rejectionReasonSchema = z.enum(["schema_invalid", "response_budget", "sensitive_content", "predicate_conflict",
  "source_quote", "source_unknown", "operation_kind", "validation_unknown"]);
const classifyValidationRejection = (error: unknown): z.infer<typeof rejectionReasonSchema> => {
  if (error instanceof z.ZodError) return "schema_invalid";
  if (!(error instanceof Error)) return "validation_unknown";
  switch (error.message) {
    case "Learning response exceeds byte budget.": return "response_budget";
    case "Learning proposal contains sensitive content.": return "sensitive_content";
    case "A proposal cannot mix shell and MCP predicates.": return "predicate_conflict";
    case "Invalid user source quotation.": return "source_quote";
    case "Invalid agent source or tool quotation.": return "source_quote";
    case "Proposal references an unknown source.": return "source_unknown";
    case "Proposal operation references must identify failed/retry tool.started events and the retry tool.completed event.": return "operation_kind";
    default: return "validation_unknown";
  }
};
const attemptSchema = z.object({
  id: z.string(), caseId: z.string(), attempt: z.number().int().positive(), startedAt: timeSchema, completedAt: timeSchema,
  durationMs: z.number().nonnegative(), status: z.enum(["extracted", "no_rule", "provider_failed", "validation_failed", "timeout", "cancelled"]),
  proposalCount: z.number().int().nonnegative(), receiptCount: z.number().int().nonnegative(), inputDigest: digestSchema,
  outputDigest: digestSchema.nullable(), proposals: z.array(z.unknown()).max(3), receiptDigests: z.array(digestSchema),
  rejectionReason: rejectionReasonSchema.optional(),
  reviewRequests: z.number().int().min(0).max(1).optional(),
  distillation: learningDistillationSummarySchema.optional(),
}).strict();
export const frozenLearningRunSchema = z.object({
  version: z.literal(1), evidenceKind: z.enum(["synthetic_provider_replay", "captured_provider_replay"]),
  corpusDigest: digestSchema, codeVersion: z.string().min(1), executableDigest: digestSchema,
  provider: z.object({ provider: z.string(), model: z.string(), version: z.string() }).strict(),
  providerMode: z.enum(["actual_copilot", "test_substitute"]), startedAt: timeSchema, completedAt: timeSchema,
  maxRequests: z.number().int(), maxAttempts: z.number().int(), attempts: z.array(attemptSchema), pendingCaseIds: z.array(z.string()),
  inputLabelDigests: z.array(digestSchema), inputLabelsFrozen: z.boolean(), ledgerDigest: digestSchema, complete: z.boolean(),
}).strict();
export type FrozenLearningRun = z.infer<typeof frozenLearningRunSchema>;

const verifyRetainedRun = (run: FrozenLearningRun, corpus: FrozenLearningCorpus, ledger: string): void => {
  if (digestText(ledger) !== run.ledgerDigest) throw new Error("Retained evidence changed.");
  const entries = ledger.split("\n").filter(Boolean).map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
  const header = entries[0];
  const binding = { kind: "run_started", version: 1, corpusDigest: run.corpusDigest, startedAt: run.startedAt,
    provider: run.provider, providerMode: run.providerMode, codeVersion: run.codeVersion, executableDigest: run.executableDigest,
    maxRequests: run.maxRequests, maxAttempts: run.maxAttempts, inputLabelDigests: run.inputLabelDigests };
  if (!header || Object.entries(binding).some(([key, value]) => sha256(header[key]) !== sha256(value)) ||
      entries.length !== 1 + run.attempts.length * 2 || run.attempts.reduce((sum, entry) => sum + 1 + (entry.reviewRequests ?? 0), 0) > run.maxRequests ||
      new Set(run.attempts.map((item) => item.id)).size !== run.attempts.length) {
    throw new Error("Machine report does not match the retained attempt ledger.");
  }
  for (const [index, attempt] of run.attempts.entries()) {
    const started = entries[1 + index * 2];
    const completed = entries[2 + index * 2];
    const source = corpus.cases.find((item) => item.id === attempt.caseId);
    const expectedStarted = { kind: "attempt_started", id: attempt.id, caseId: attempt.caseId, attempt: attempt.attempt,
      startedAt: attempt.startedAt, inputDigest: attempt.inputDigest };
    if (sha256(started) !== sha256(expectedStarted) || !completed || completed.kind !== "attempt_completed" ||
        !source || attempt.inputDigest !== sha256(source.window) || attempt.attempt > run.maxAttempts ||
        attempt.proposalCount !== attempt.proposals.length || attempt.receiptCount !== attempt.receiptDigests.length ||
        attempt.receiptCount > attempt.proposalCount || Date.parse(attempt.startedAt) < Date.parse(run.startedAt) ||
        Date.parse(attempt.completedAt) < Date.parse(attempt.startedAt) || Date.parse(run.completedAt) < Date.parse(attempt.completedAt)) {
      throw new Error("Machine report does not match the retained attempt ledger.");
    }
    const retained = { ...completed };
    delete retained.kind;
    if (sha256(attemptSchema.parse(retained)) !== sha256(attempt)) {
      throw new Error("Machine report does not match the retained attempt ledger.");
    }
  }
  const pending = corpus.cases.filter((item) => !run.attempts.some((attempt) => attempt.caseId === item.id)).map((item) => item.id);
  const complete = pending.length === 0 && run.attempts.every((attempt) => attempt.status === "extracted" || attempt.status === "no_rule");
  if (!exactIds(run.pendingCaseIds, pending) || run.complete !== complete ||
      run.inputLabelsFrozen !== (run.inputLabelDigests.length === 2) ||
      run.evidenceKind !== (corpus.sourceKind === "authored_replay" ? "synthetic_provider_replay" : "captured_provider_replay")) {
    throw new Error("Machine report coverage does not match retained evidence.");
  }
};

export const runFrozenLearningEvaluation = async (options: {
  readonly preparedDirectory: string; readonly outputDirectory: string; readonly provider: FrozenLearningProvider;
  readonly providerMode: "actual_copilot" | "test_substitute"; readonly codeVersion: string; readonly executableDigest: string;
  readonly inputLabelPaths?: readonly string[]; readonly maxRequests?: number; readonly maxAttempts?: number;
  readonly reserveAttempt?: () => boolean | Promise<boolean>;
  readonly deadlineMs?: number; readonly signal?: AbortSignal; readonly now?: () => Date;
}): Promise<FrozenLearningRun> => {
  const now = options.now ?? (() => new Date()); const startedAt = now().toISOString();
  const corpusBytes = await readFile(join(options.preparedDirectory, "corpus.json"), "utf8");
  const corpusDigest = digestText(corpusBytes);
  const corpus = frozenLearningCorpusSchema.parse(JSON.parse(corpusBytes));
  const manifest = z.object({ corpusDigest: digestSchema }).passthrough().parse(await readJson(join(options.preparedDirectory, "frozen-manifest.json")));
  if (manifest.corpusDigest !== corpusDigest) throw new Error("Frozen corpus digest changed.");
  const maxRequests = options.maxRequests ?? 40; const maxAttempts = options.maxAttempts ?? 1; const deadlineMs = options.deadlineMs ?? options.provider.timeoutMs ?? 60_000;
  if (![maxRequests, maxAttempts, deadlineMs].every(Number.isInteger) || maxRequests < 1 || maxRequests > 200 ||
      maxAttempts < 1 || maxAttempts > 3 || deadlineMs < 1 || deadlineMs > 120_000) throw new Error("Invalid evaluation budgets.");
  digestSchema.parse(options.executableDigest);
  const labels = await loadLabels(options.inputLabelPaths ?? [], corpus, corpusDigest, startedAt);
  await mkdir(options.outputDirectory, { recursive: true });
  const ledger = await open(join(options.outputDirectory, "attempts.jsonl"), "wx");
  const attempts: FrozenLearningRun["attempts"] = []; const labelDigests: string[] = [];
  const requestsUsed = () => attempts.reduce((sum, entry) => sum + 1 + (entry.reviewRequests ?? 0), 0);
  const ledgerWrite = async (value: unknown): Promise<void> => { await ledger.write(JSON.stringify(value) + "\n"); await ledger.sync(); };
  try {
    for (const [index, label] of labels.entries()) labelDigests.push(await writeNew(join(options.outputDirectory, "frozen-input-review-" + index + ".json"), label));
    await writeNew(join(options.outputDirectory, "corpus.json"), corpus);
    await ledgerWrite({ kind: "run_started", version: 1, corpusDigest, startedAt, provider: options.provider.identity,
      providerMode: options.providerMode, codeVersion: options.codeVersion, executableDigest: options.executableDigest,
      maxRequests, maxAttempts, deadlineMs, inputLabelDigests: labelDigests });
    for (const item of corpus.cases) {
      if (requestsUsed() >= maxRequests || options.signal?.aborted) break;
      for (let attempt = 1; attempt <= maxAttempts && requestsUsed() < maxRequests; attempt += 1) {
        if (options.signal?.aborted) break;
        if (options.reserveAttempt && !await options.reserveAttempt()) break;
        const attemptStarted = now(); const id = item.id + "-attempt-" + attempt;
        await ledgerWrite({ kind: "attempt_started", id, caseId: item.id, attempt, startedAt: attemptStarted.toISOString(), inputDigest: sha256(item.window) });
        const controller = new AbortController(); const abort = (): void => controller.abort();
        options.signal?.addEventListener("abort", abort, { once: true });
        let timer: NodeJS.Timeout | undefined;
        let status: z.infer<typeof attemptSchema>["status"] = "provider_failed";
        let rejectionReason: z.infer<typeof rejectionReasonSchema> | undefined;
        let proposals: RuleProposal[] = []; let receiptDigests: string[] = []; let outputDigest: string | null = null; let outputReceived = false;
        let reviewRequests = 0;
        let distillation: LearningDistillationSummary | undefined;
        try {
          const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("deadline")); }, deadlineMs); });
          const output = await Promise.race([options.provider.infer(item.window, { signal: controller.signal,
            reserveReviewAttempt: async () => {
              const used = requestsUsed() + 1 + reviewRequests;
              if (reviewRequests > 0 || used >= maxRequests || controller.signal.aborted || options.signal?.aborted || (options.reserveAttempt && !await options.reserveAttempt())) return false;
              reviewRequests += 1;
              return true;
            },
          }), deadline]);
          outputReceived = true; outputDigest = sha256(output);
          const parsed = validateLearningResponse(item.window, output);
          distillation = parsed.distillation;
          proposals = parsed.proposals.map((proposal, index) => ({ ...proposal, schemaVersion: 1, proposalId: id + "-proposal-" + index,
            jobId: id, knowledgeId: "learning-knowledge-" + sha256([item.window.repoId,
              proposal.shellPredicate ? [proposal.shellPredicate, item.window.events.find((entry) => entry.event.eventId === proposal.retryOperationEventId)?.event.commitSha] : proposal.predicate ?? proposal.rule]).slice(0, 24),
            createdAt: item.window.createdAt, expiresAt: new Date(Date.parse(item.window.createdAt) + 30 * 86_400_000).toISOString(), sourceDigests: item.window.sources }));
          receiptDigests = proposals.flatMap((proposal) => { const receipt = verifyLearningRecovery(proposal, item.window.events, item.contracts, now()); return receipt ? [sha256(receipt)] : []; });
          status = proposals.length === 0 ? "no_rule" : "extracted";
        } catch (error) {
          status = options.signal?.aborted ? "cancelled" : controller.signal.aborted ? "timeout" : outputReceived ? "validation_failed" : "provider_failed";
          if (status === "validation_failed") rejectionReason = classifyValidationRejection(error);
        } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
        const completedAt = now();
        const result = attemptSchema.parse({ id, caseId: item.id, attempt, startedAt: attemptStarted.toISOString(), completedAt: completedAt.toISOString(),
          durationMs: Math.max(0, completedAt.getTime() - attemptStarted.getTime()), status, proposalCount: proposals.length,
          receiptCount: receiptDigests.length, inputDigest: sha256(item.window), outputDigest, proposals, receiptDigests,
          ...(reviewRequests ? { reviewRequests } : {}),
          ...(distillation ? { distillation } : {}),
          ...(rejectionReason === undefined ? {} : { rejectionReason }) });
        attempts.push(result); await ledgerWrite({ kind: "attempt_completed", ...result });
        if (status === "extracted" || status === "no_rule" || status === "cancelled") break;
      }
    }
  } finally { await ledger.close(); }
  const pendingCaseIds = corpus.cases.filter((item) => !attempts.some((attempt) => attempt.caseId === item.id)).map((item) => item.id);
  const report = frozenLearningRunSchema.parse({ version: 1, evidenceKind: corpus.sourceKind === "authored_replay" ? "synthetic_provider_replay" : "captured_provider_replay",
    corpusDigest, codeVersion: options.codeVersion, executableDigest: options.executableDigest, provider: options.provider.identity,
    providerMode: options.providerMode, startedAt, completedAt: now().toISOString(), maxRequests, maxAttempts, attempts, pendingCaseIds,
    inputLabelDigests: labelDigests, inputLabelsFrozen: labels.length === 2,
    ledgerDigest: digestText(await readFile(join(options.outputDirectory, "attempts.jsonl"), "utf8")),
    complete: pendingCaseIds.length === 0 && attempts.every((attempt) => attempt.status === "extracted" || attempt.status === "no_rule") });
  const runDigest = await writeNew(join(options.outputDirectory, "machine-report.json"), report);
  const review = { version: 1, corpusDigest, runDigest, reviewerId: null, reviewedAt: null, role: "independent_human",
    windows: corpus.cases.map((item) => ({ id: item.id, candidate: null, correctRules: null, provenanceComplete: null, notes: "" })) };
  await writeNew(join(options.outputDirectory, "output-review-a.json"), review);
  await writeNew(join(options.outputDirectory, "output-review-b.json"), review);
  await writeNew(join(options.outputDirectory, "acceptance-summary.json"), { status: "insufficient_evidence",
    reason: "Provider replay measures extraction only. Independent human adjudication, installed activation, later host delivery, compliance and visible notices remain separate evidence.",
    attemptedRequests: requestsUsed(), failedAttempts: attempts.filter((attempt) => !["extracted", "no_rule"].includes(attempt.status)).length,
    pendingWindows: pendingCaseIds.length, tasksObserved: 0, humanLabelsFrozen: labels.length === 2 });
  return report;
};

export const reviewFrozenLearningEvaluation = async (options: {
  readonly runDirectory: string; readonly outputReviewPaths: readonly string[]; readonly outputPath: string;
}): Promise<unknown> => {
  const bytes = await readFile(join(options.runDirectory, "machine-report.json"), "utf8");
  const run = frozenLearningRunSchema.parse(JSON.parse(bytes));
  const corpus = frozenLearningCorpusSchema.parse(await readJson(join(options.runDirectory, "corpus.json")));
  if (digestText(json(corpus)) !== run.corpusDigest) throw new Error("Retained evidence changed.");
  verifyRetainedRun(run, corpus, await readFile(join(options.runDirectory, "attempts.jsonl"), "utf8"));
  if (!run.inputLabelsFrozen) throw new Error("Input labels were not frozen before this run. Complete the independent input reviews and rerun.");
  const inputPaths = [0, 1].map((index) => join(options.runDirectory, "frozen-input-review-" + index + ".json"));
  const labels = await loadLabels(inputPaths, corpus, run.corpusDigest, run.startedAt);
  if (labels.some((label, index) => digestText(json(label)) !== run.inputLabelDigests[index])) throw new Error("Frozen human labels changed.");
  const reviews = await Promise.all(options.outputReviewPaths.map(async (path) => learningOutputReviewSchema.parse(await readJson(path))));
  if (reviews.length !== 2 || !reviews[0]?.reviewerId || !reviews[1]?.reviewerId || reviews[0].reviewerId === reviews[1].reviewerId ||
      reviews.some((review) => review.runDigest !== digestText(bytes) || review.corpusDigest !== run.corpusDigest ||
        !review.reviewedAt || Date.parse(review.reviewedAt) < Date.parse(run.completedAt) ||
        !exactIds(review.windows.map((item) => item.id), corpus.cases.map((item) => item.id)))) throw new Error("Two distinct, complete, source-bound post-run reviews are required.");
  const cases = corpus.cases.map((item) => {
    const a = labels[0]?.windows.find((entry) => entry.id === item.id);
    const b = labels[1]?.windows.find((entry) => entry.id === item.id);
    const x = reviews[0]?.windows.find((entry) => entry.id === item.id);
    const y = reviews[1]?.windows.find((entry) => entry.id === item.id);
    const attempt = run.attempts.findLast((entry) => entry.caseId === item.id);
    const labelAgreed = a && b && a.reusable === b.reusable && a.qualified === b.qualified &&
      a.activationProhibited === b.activationProhibited && a.expectedRule === b.expectedRule && a.applicability === b.applicability;
    const resultAgreed = x && y && x.candidate !== null && x.candidate === y.candidate && x.correctRules !== null &&
      x.correctRules === y.correctRules && x.provenanceComplete !== null && x.provenanceComplete === y.provenanceComplete;
    if (resultAgreed && x.correctRules !== null && x.correctRules > (attempt?.proposalCount ?? 0)) throw new Error("Review correctness exceeds produced proposals.");
    if (resultAgreed && ((x.candidate === "none" && (attempt?.proposalCount ?? 0) !== 0) ||
        (x.candidate === "correct" && x.correctRules === 0) ||
        (x.candidate === "incorrect" && (attempt?.proposalCount ?? 0) === 0))) {
      throw new Error("Review candidate classification contradicts produced proposals.");
    }
    return { id: item.id, reusable: labelAgreed ? a.reusable : null, qualified: labelAgreed ? a.qualified : null,
      candidate: resultAgreed ? x.candidate : "unknown", correctRules: resultAgreed ? x.correctRules : null,
      provenanceComplete: resultAgreed ? x.provenanceComplete : null, proposedRules: attempt?.proposalCount ?? 0,
      disagreement: !labelAgreed || !resultAgreed, disposition: attempt?.status ?? "pending" };
  });
  const positives = cases.filter((item) => item.reusable === true);
  const discovered = positives.filter((item) => item.candidate === "correct" && item.provenanceComplete === true).length;
  const proposed = cases.reduce((sum, item) => sum + item.proposedRules, 0);
  const correct = cases.reduce((sum, item) => sum + (item.correctRules ?? 0), 0);
  const tasks = corpus.tasks.map((item) => {
    const a = labels[0]?.tasks.find((entry) => entry.id === item.id);
    const b = labels[1]?.tasks.find((entry) => entry.id === item.id);
    const agreed = a !== undefined && b !== undefined && a.applicable === b.applicable;
    return { id: item.id, applicable: agreed ? a.applicable : null, disagreement: !agreed,
      hostObserved: false, delivery: "unknown", compliance: "unknown" };
  });
  const report = { version: 1, evidenceKind: run.evidenceKind, status: "insufficient_evidence", corpusDigest: run.corpusDigest,
    runDigest: digestText(bytes), reviewDigests: reviews.map((review) => digestText(json(review))),
    inputReviewDigests: run.inputLabelDigests, cases, tasks, metrics: {
      reusableOpportunities: positives.length, discoveryRecall: positives.length === 0 ? null : discovered / positives.length,
      proposedRules: proposed, precision: proposed === 0 ? null : correct / proposed,
      unresolvedReviews: cases.filter((item) => item.disagreement).length,
      unresolvedTaskLabels: tasks.filter((item) => item.disagreement).length,
      pendingTasks: tasks.length,
      pendingWindows: run.pendingCaseIds.length,
      failedAttempts: run.attempts.filter((item) => !["extracted", "no_rule"].includes(item.status)).length,
      nativeActivationRate: null, nativeDeliveryRate: null, nativeCompliance: null, nativeVisibleNotices: null, causalBenefit: null },
    acceptance: evaluateAutomaticLearningAcceptance(undefined),
    reason: "Adjudicated replay is an extraction measurement. It cannot establish installed activation, unprompted delivery, adoption, or visible feedback." };
  await writeNew(options.outputPath, report); return report;
};

export const exportInstalledLearningCorpus = async (options: {
  readonly databasePath: string; readonly outputDirectory: string; readonly maximumWindows?: number; readonly now?: () => Date;
}): Promise<{ corpusDigest: string; directory: string }> => {
  const maximumWindows = options.maximumWindows ?? 40;
  if (!Number.isInteger(maximumWindows) || maximumWindows < 1 || maximumWindows > 100) throw new Error("Captured window export must be bounded to 1-100 windows.");
  const store = new CanonicalSqliteStore(options.databasePath);
  let corpus: FrozenLearningCorpus;
  try {
    if (store.hasActiveDeletion()) throw new Error("Installed export is blocked during deletion.");
    const windows = buildLearningWindows(store.episodeSourceEnvelopes(), (options.now ?? (() => new Date()))()).slice(-maximumWindows);
    if (windows.length === 0) throw new Error("No captured eligible windows are available.");
    const receipts = store.learningReceipts();
    corpus = frozenLearningCorpusSchema.parse({ version: 1, corpusId: "installed-capture-review-v1", sourceKind: "captured_installed",
      cases: windows.map((window, index) => ({ id: "captured-" + index, language: /[\u3400-\u9fff]/u.test(window.events.map((event) => event.content?.message ?? "").join(" ")) ? "zh" : "en",
        scenario: window.origin === "agent" ? "captured-agent-experience" : "captured-ordinary-window", designStratum: "unlabeled_capture", window,
        contracts: receipts.flatMap((receipt) => receipt.proves === "invocation_contract" &&
          window.sources.some((source) => source.eventId === (receipt.userEventId ?? receipt.agentEventId)) ? [receipt.contract] : []) })), tasks: [] });
  } finally { store.close(); }
  return prepareFrozenLearningEvaluation({ outputDirectory: options.outputDirectory, corpus, ...(options.now ? { now: options.now } : {}) });
};

// Imported host evidence remains distinct from replay and must resolve its complete artifact ledger.
export const importInstalledLearningAcceptance = async (options: {
  readonly evidencePath: string; readonly artifactManifestPath: string; readonly artifactRoot: string;
  readonly expectedCodeVersion: string; readonly expectedExecutableDigest: string; readonly outputPath: string;
}): Promise<unknown> => {
  const evidence = automaticLearningEvidenceSchema.parse(await readJson(options.evidencePath));
  const manifest = installedLearningArtifactManifestSchema.parse(await readJson(options.artifactManifestPath));
  if (evidence.evidenceKind !== "installed_controlled" || evidence.codeVersion !== options.expectedCodeVersion ||
      manifest.codeVersion !== options.expectedCodeVersion || manifest.executableDigest !== options.expectedExecutableDigest ||
      evidence.installedArtifactDigest !== options.expectedExecutableDigest) throw new Error("Installed observer evidence does not match the evaluated executable.");
  const required = [...evidence.windows.flatMap((item) => item.evidenceDigests), ...evidence.tasks.flatMap((item) => item.evidenceDigests),
    ...evidence.observations.flatMap((item) => item.evidenceDigests)];
  await verifyExternalReportArtifacts(manifest.artifacts, required, options.artifactRoot);
  const report = { version: 1, evidence, manifestDigest: digestText(json(manifest)),
    acceptance: evaluateAutomaticLearningAcceptance(evidence, "research", options.expectedCodeVersion),
    authority: "Artifact integrity verified; independent human claims and native-observer authenticity still require review. An edited manifest is not a signature." };
  await writeNew(options.outputPath, report);
  const evidencePath = options.outputPath + ".evidence.json";
  await writeNew(evidencePath, evidence);
  await writeNew(evidencePath + ".artifacts.json", { version: 1, evidenceDigest: digestText(JSON.stringify(evidence)),
    artifactRoot: relative(dirname(resolve(evidencePath)), resolve(options.artifactRoot)) || ".", manifest });
  return report;
};
