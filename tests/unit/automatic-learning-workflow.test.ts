import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createFrozenLearningCorpus, prepareFrozenLearningEvaluation, runFrozenLearningEvaluation,
  reviewFrozenLearningEvaluation } from "@provenloop/evaluation";
import { learningSourceDigest, verifyLearningRecovery } from "@provenloop/domain";
import type { LearningWindow, RuleProposal } from "@provenloop/contracts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const fixture = async () => { const root = await mkdtemp(join(tmpdir(), "pl-frozen-eval-")); roots.push(root);
  const preparedDirectory = join(root, "prepared"); await prepareFrozenLearningEvaluation({ outputDirectory: preparedDirectory });
  return { root, preparedDirectory, outputDirectory: join(root, "run") }; };
const provider = { identity: { provider: "test-provider", model: "test-model", version: "1" }, infer: async () => ({ schemaVersion: 1, proposals: [] }) };
const defaults = { provider, providerMode: "test_substitute" as const, codeVersion: "fixture-code", executableDigest: "a".repeat(64) };
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const reviewedFixture = async () => {
  const f = await fixture();
  const inputLabelPaths = ["a", "b"].map((suffix) => join(f.preparedDirectory, "input-review-" + suffix + ".json"));
  const corpus = createFrozenLearningCorpus();
  for (const [index, path] of inputLabelPaths.entries()) {
    await writeFile(path, JSON.stringify({ version: 1, corpusDigest: digest(await readFile(join(f.preparedDirectory, "corpus.json"), "utf8")),
      reviewerId: "synthetic-input-reviewer-" + index, reviewedAt: "2026-09-01T00:00:00Z", role: "independent_human",
      windows: corpus.cases.map((item) => ({ id: item.id, reusable: true, qualified: false, activationProhibited: true,
        expectedRule: "Synthetic expected meaning.", applicability: "Synthetic task scope.", notes: "Synthetic reviewer fixture only." })),
      tasks: corpus.tasks.map((item) => ({ id: item.id, applicable: true, notes: "Synthetic reviewer fixture only." })) }));
  }
  return { ...f, inputLabelPaths };
};
const completeOutputReviews = async (runDirectory: string) => {
  const paths = ["a", "b"].map((suffix) => join(runDirectory, "output-review-" + suffix + ".json"));
  for (const [index, path] of paths.entries()) {
    const review = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...review, reviewerId: "synthetic-output-reviewer-" + index, reviewedAt: "2026-09-03T00:00:00Z",
      windows: review.windows.map((item: { id: string }) => ({ id: item.id, candidate: "none", correctRules: 0, provenanceComplete: true, notes: "Synthetic reviewer fixture only." })) }));
  }
  return paths;
};

describe("frozen automatic-learning evaluation workflow", () => {
  it("counts a quality-review request against the same run budget and retains its count", async () => {
    const f = await fixture(); let reserved = 0;
    const run = await runFrozenLearningEvaluation({ ...defaults, ...f, maxRequests: 2,
      reserveAttempt: () => { reserved += 1; return true; },
      provider: { ...provider, timeoutMs: 100_000, infer: async (_window, options) => {
        expect(await options.reserveReviewAttempt?.()).toBe(true);
        expect(await options.reserveReviewAttempt?.()).toBe(false);
        return { schemaVersion: 1, proposals: [], distillation: { proposed: 1, accepted: 0, rejected: 1, reasons: ["Quality review: reusable"] } };
      } },
    });
    expect(reserved).toBe(2);
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0]).toMatchObject({ status: "no_rule", reviewRequests: 1 });
    expect(run.attempts[0]?.distillation).toMatchObject({ proposed: 1, accepted: 0, rejected: 1 });
    expect(run.pendingCaseIds).toHaveLength(39);
    expect(await readFile(join(f.outputDirectory, "attempts.jsonl"), "utf8")).toContain('"reviewRequests":1');
  });
  it("keeps source hashes and typed positive proof valid after corpus JSON persistence", () => {
    const corpus = createFrozenLearningCorpus();
    const persisted: ReturnType<typeof createFrozenLearningCorpus> = JSON.parse(JSON.stringify(corpus));
    for (const item of persisted.cases.filter((entry) => entry.designStratum === "correction")) {
      const [failed, , user, retry, completion] = item.window.events;
      const contract = item.contracts[0];
      if (!failed || !user || !retry || !completion || !contract || !user.content?.message) throw new Error("Missing fixture proof.");
      expect(item.window.sources.every((source, index) => {
        const event = item.window.events[index]; return event !== undefined && learningSourceDigest(event) === source.digest;
      })).toBe(true);
      const proposal: RuleProposal = { schemaVersion: 1, proposalId: "fixture-proposal", jobId: "fixture-job", knowledgeId: "learning-knowledge-fixture",
        createdAt: user.event.timestamp, expiresAt: "2026-10-01T00:00:00Z", rule: "Supply the required argument.", trigger: "This tool",
        exclusions: ["Other tools"], userSource: { eventId: user.event.eventId, quote: user.content.message },
        failedOperationEventId: failed.event.eventId, retryOperationEventId: retry.event.eventId, completionEventId: completion.event.eventId,
        predicate: { kind: "required_argument", serverName: contract.serverName, toolName: contract.toolName,
          argument: contract.requiredArguments[0] ?? "missing", contractDigest: contract.digest }, sourceDigests: item.window.sources };
      expect(verifyLearningRecovery(proposal, item.window.events, item.contracts, new Date("2026-09-01T00:00:10Z"))?.proves).toBe("invocation_contract");
    }
  });
  it("freezes 40 bilingual windows and 40 later tasks without assigning human labels", async () => {
    const first = createFrozenLearningCorpus(); expect(JSON.stringify(createFrozenLearningCorpus()) === JSON.stringify(first)).toBe(true);
    expect(first.cases).toHaveLength(40); expect(first.tasks).toHaveLength(40);
    expect(first.cases.filter((item) => item.designStratum === "correction")).toHaveLength(20);
    expect(first.cases.filter((item) => item.language === "zh")).toHaveLength(20);
    expect(first.tasks.filter((item) => item.designStratum === "related")).toHaveLength(20);
    const f = await fixture(); const review = JSON.parse(await readFile(join(f.preparedDirectory, "input-review-a.json"), "utf8"));
    expect(review.reviewerId).toBeNull(); expect(review.windows.every((item: { reusable: unknown }) => item.reusable === null)).toBe(true);
    await expect(prepareFrozenLearningEvaluation({ outputDirectory: f.preparedDirectory })).rejects.toThrow();
  });
  it("retains every retry and visible pending windows without treating model calls as acceptance", async () => {
    const f = await fixture(); let calls = 0;
    const run = await runFrozenLearningEvaluation({ ...defaults, ...f, maxRequests: 3, maxAttempts: 2,
      provider: { ...provider, infer: async () => { calls += 1; if (calls === 1) throw new Error("PRIVATE_SNIPPET"); return { schemaVersion: 1, proposals: [] }; } } });
    expect(run.attempts.map((item) => item.status)).toEqual(["provider_failed", "no_rule", "no_rule"]);
    expect(run.pendingCaseIds).toHaveLength(38); expect(run.complete).toBe(false); expect(run.inputLabelsFrozen).toBe(false);
    const ledger = await readFile(join(f.outputDirectory, "attempts.jsonl"), "utf8");
    expect(ledger).not.toContain("PRIVATE_SNIPPET"); expect(ledger.split("\n").filter(Boolean)).toHaveLength(7);
    expect(JSON.parse(await readFile(join(f.outputDirectory, "acceptance-summary.json"), "utf8")).status).toBe("insufficient_evidence");
  });
  it("rejects changed corpora and refuses retroactive input labels", async () => {
    const f = await fixture(); await runFrozenLearningEvaluation({ ...defaults, ...f, maxRequests: 1 });
    await expect(reviewFrozenLearningEvaluation({ runDirectory: f.outputDirectory, outputReviewPaths: [], outputPath: join(f.root, "review.json") })).rejects.toThrow("not frozen");
    await writeFile(join(f.preparedDirectory, "corpus.json"), JSON.stringify(createFrozenLearningCorpus()) + " ");
    await expect(runFrozenLearningEvaluation({ ...defaults, ...f, outputDirectory: join(f.root, "changed"), maxRequests: 1 })).rejects.toThrow("digest changed");
  });
  it("preserves quota-blocked windows as pending without dispatch", async () => {
    const f = await fixture(); let calls = 0;
    const run = await runFrozenLearningEvaluation({ ...defaults, ...f, reserveAttempt: () => false,
      provider: { ...provider, infer: async () => { calls += 1; return { schemaVersion: 1, proposals: [] }; } } });
    expect(calls).toBe(0); expect(run.attempts).toEqual([]); expect(run.pendingCaseIds).toHaveLength(40);
  });
  it("retains timeout and schema-validation failures as failures, never no-rule", async () => {
    const f = await fixture();
    const run = await runFrozenLearningEvaluation({ ...defaults, ...f, maxRequests: 1, deadlineMs: 5,
      provider: { ...provider, infer: () => new Promise(() => undefined) } });
    expect(run.attempts[0]?.status).toBe("timeout");
    expect(run.attempts[0]?.rejectionReason).toBeUndefined();
    const invalid = await runFrozenLearningEvaluation({ ...defaults, ...f, outputDirectory: join(f.root, "invalid"), maxRequests: 1,
      provider: { ...provider, infer: async () => ({ schemaVersion: 1, proposals: [{ rule: "unsupported" }] }) } });
    expect(invalid.attempts[0]?.status).toBe("validation_failed");
    expect(invalid.attempts[0]?.rejectionReason).toBe("schema_invalid");
  });
  it("retains safe validation rejection categories without raw payloads or diagnostic text", async () => {
    const f = await fixture();
    const baseline = (window: LearningWindow) => {
      const [failed, , user, retry, completion] = window.events;
      if (!failed || !user?.content?.message || !retry || !completion) throw new Error("Missing fixture chain.");
      return { rule: "Always provide the required argument.", trigger: "When calling this tool.", exclusions: ["Other tools."],
        userSource: { eventId: user.event.eventId, quote: user.content.message },
        failedOperationEventId: failed.event.eventId, retryOperationEventId: retry.event.eventId, completionEventId: completion.event.eventId };
    };
    const variants: { reason: string; output: (window: LearningWindow) => unknown; forbidden: string }[] = [
      { reason: "response_budget", output: () => ({ payload: "PRIVATE_RESPONSE_PAYLOAD".repeat(1000) }), forbidden: "PRIVATE_RESPONSE_PAYLOAD" },
      { reason: "sensitive_content", output: (window) => ({ schemaVersion: 1, proposals: [{ ...baseline(window), rule: "Use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 now." }] }), forbidden: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890" },
      { reason: "source_quote", output: (window) => ({ schemaVersion: 1, proposals: [{ ...baseline(window), userSource: { eventId: baseline(window).userSource.eventId, quote: "PRIVATE_QUOTE_NOT_PRESENT" } }] }), forbidden: "PRIVATE_QUOTE_NOT_PRESENT" },
      { reason: "source_unknown", output: (window) => ({ schemaVersion: 1, proposals: [{ ...baseline(window), failedOperationEventId: "private-unknown-operation" }] }), forbidden: "private-unknown-operation" },
      { reason: "operation_kind", output: (window) => ({ schemaVersion: 1, proposals: [{ ...baseline(window), failedOperationEventId: baseline(window).userSource.eventId }] }), forbidden: "Proposal operation references must identify" },
      { reason: "predicate_conflict", output: (window) => ({ schemaVersion: 1, proposals: [{ ...baseline(window),
        predicate: { kind: "required_argument", serverName: "test-server", toolName: "test-tool", argument: "id", contractDigest: "a".repeat(64) },
        shellPredicate: { kind: "repository_test_command", toolName: "powershell", failedCommand: "npm test", command: "npm run test" } }] }), forbidden: "A proposal cannot mix" },
      { reason: "validation_unknown", output: () => ({ toJSON: () => { throw new Error("PRIVATE_UNEXPECTED_DIAGNOSTIC"); } }), forbidden: "PRIVATE_UNEXPECTED_DIAGNOSTIC" },
    ];
    for (const variant of variants) {
      const outputDirectory = join(f.root, variant.reason);
      const run = await runFrozenLearningEvaluation({ ...defaults, ...f, outputDirectory, maxRequests: 1,
        provider: { ...provider, infer: async (window) => variant.output(window) } });
      expect(run.attempts[0]).toMatchObject({ status: "validation_failed", rejectionReason: variant.reason, proposals: [], proposalCount: 0 });
      for (const path of ["attempts.jsonl", "machine-report.json"]) {
        const text = await readFile(join(outputDirectory, path), "utf8");
        expect(text).toContain(variant.reason); expect(text).not.toContain(variant.forbidden);
      }
    }
  });
  it("UX-06/08 retains semantic label disagreements and every unobserved later task", async () => {
    const f = await reviewedFixture();
    const secondPath = f.inputLabelPaths[1];
    if (!secondPath) throw new Error("Missing synthetic reviewer.");
    const second = JSON.parse(await readFile(secondPath, "utf8"));
    second.windows[0].expectedRule = "A different expected meaning.";
    second.windows[1].applicability = "A different scope.";
    second.tasks[0].applicable = false;
    await writeFile(secondPath, JSON.stringify(second));
    await runFrozenLearningEvaluation({ ...defaults, ...f, maxRequests: 1, now: () => new Date("2026-09-02T00:00:00Z") });
    const outputReviewPaths = await completeOutputReviews(f.outputDirectory);
    const outputPath = join(f.root, "review.json");
    await reviewFrozenLearningEvaluation({ runDirectory: f.outputDirectory, outputReviewPaths, outputPath });
    const result = JSON.parse(await readFile(outputPath, "utf8"));
    expect(result.status).toBe("insufficient_evidence");
    expect(result.cases.slice(0, 2)).toEqual(expect.arrayContaining([expect.objectContaining({ reusable: null, disagreement: true })]));
    expect(result.tasks).toHaveLength(40);
    expect(result.tasks[0]).toMatchObject({ applicable: null, disagreement: true, hostObserved: false, compliance: "unknown" });
    expect(result.metrics).toMatchObject({ unresolvedReviews: 2, unresolvedTaskLabels: 1, pendingTasks: 40, pendingWindows: 39, causalBenefit: null });
  });
  it("UX-07 rejects replaced machine reports even when the ledger digest is unchanged", async () => {
    const f = await fixture();
    await runFrozenLearningEvaluation({ ...defaults, ...f, maxRequests: 1 });
    const reportPath = join(f.outputDirectory, "machine-report.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    report.attempts[0].status = "extracted";
    await writeFile(reportPath, JSON.stringify(report));
    await expect(reviewFrozenLearningEvaluation({ runDirectory: f.outputDirectory, outputReviewPaths: [], outputPath: join(f.root, "review.json") })).rejects.toThrow("attempt ledger");
  });
  it("UX-07 accepts equivalent machine-report serialization before source-bound output review", async () => {
    const f = await reviewedFixture();
    await runFrozenLearningEvaluation({ ...defaults, ...f, maxRequests: 1, now: () => new Date("2026-09-02T00:00:00Z") });
    const reportPath = join(f.outputDirectory, "machine-report.json");
    const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder) :
      value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)])) : value;
    const serialized = JSON.stringify(reorder(JSON.parse(await readFile(reportPath, "utf8"))));
    await writeFile(reportPath, serialized);
    const outputReviewPaths = await completeOutputReviews(f.outputDirectory);
    for (const path of outputReviewPaths) {
      const review = JSON.parse(await readFile(path, "utf8")); review.runDigest = digest(serialized);
      await writeFile(path, JSON.stringify(review));
    }
    await expect(reviewFrozenLearningEvaluation({ runDirectory: f.outputDirectory, outputReviewPaths, outputPath: join(f.root, "review.json") })).resolves.toMatchObject({ status: "insufficient_evidence" });
  });
  it("UX-07 rejects a correct candidate claim when the provider produced no proposal", async () => {
    const f = await reviewedFixture();
    await runFrozenLearningEvaluation({ ...defaults, ...f, maxRequests: 1, now: () => new Date("2026-09-02T00:00:00Z") });
    const outputReviewPaths = await completeOutputReviews(f.outputDirectory);
    for (const path of outputReviewPaths) {
      const review = JSON.parse(await readFile(path, "utf8")); review.windows[0].candidate = "correct";
      await writeFile(path, JSON.stringify(review));
    }
    await expect(reviewFrozenLearningEvaluation({ runDirectory: f.outputDirectory, outputReviewPaths, outputPath: join(f.root, "review.json") })).rejects.toThrow("contradicts produced proposals");
  });
  it("UX-07 rejects omitted pending windows and retroactive edits to frozen reviews", async () => {
    const f = await reviewedFixture();
    await runFrozenLearningEvaluation({ ...defaults, ...f, maxRequests: 1, now: () => new Date("2026-09-02T00:00:00Z") });
    const reportPath = join(f.outputDirectory, "machine-report.json");
    const original = await readFile(reportPath, "utf8");
    const report = JSON.parse(original); report.pendingCaseIds = []; report.complete = true;
    await writeFile(reportPath, JSON.stringify(report));
    await expect(reviewFrozenLearningEvaluation({ runDirectory: f.outputDirectory, outputReviewPaths: [], outputPath: join(f.root, "review.json") })).rejects.toThrow("coverage");
    await writeFile(reportPath, original);
    const labelPath = join(f.outputDirectory, "frozen-input-review-0.json");
    const label = JSON.parse(await readFile(labelPath, "utf8")); label.windows[0].expectedRule = "Changed after execution.";
    await writeFile(labelPath, JSON.stringify(label));
    await expect(reviewFrozenLearningEvaluation({ runDirectory: f.outputDirectory, outputReviewPaths: [], outputPath: join(f.root, "review.json") })).rejects.toThrow("Frozen human labels changed");
  });
});
