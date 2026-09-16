import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  automaticLearningObservationIds,
  evaluateAutomaticLearningAcceptance,
  evaluateMvpReleaseReadiness,
  importInstalledLearningAcceptance,
  loadAutomaticLearningEvidence,
  resolveLearningEvaluationExecutableDigest,
  runM2ReleaseGate,
  type AutomaticLearningEvidence,
} from "@provenloop/evaluation";

// Synthetic arithmetic fixture only: never retained as installed/human acceptance.
const at = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error("Missing fixture item.");
  return item;
};
const fixture = (): AutomaticLearningEvidence => ({
  evidenceVersion: 1, evidenceKind: "installed_controlled", codeVersion: "test-version",
  installedArtifactDigest: "a".repeat(64), providerId: "test-provider", modelId: "test-model", hostVersion: "test-host",
  signInObserved: true, realModelCalls: 40, conditionsFrozenAt: "2026-09-01T00:00:00Z",
  labelsFrozenAt: "2026-09-01T00:00:00Z", runStartedAt: "2026-09-02T00:00:00Z",
  independentHumanAnnotators: ["fixture-reviewer-1", "fixture-reviewer-2"],
  allAttemptsRetained: true, infrastructureFailureCount: 0, secretLeakageCount: 0,
  crossRepositoryMisuseCount: 0, fabricatedConfirmationCount: 0,
  windows: Array.from({ length: 40 }, (_, i) => ({
    id: `window-${i}`, independentSourceId: `source-${i}`, language: i % 2 === 0 ? "en" : "zh",
    reusable: i < 20, qualified: i < 20, activationProhibited: i >= 20,
    candidate: i < 20 ? "correct" : "none", proposedRules: i < 20 ? 1 : 0,
    correctRules: i < 20 ? 1 : 0, provenanceComplete: true, active: i < 20,
    disposition: "completed", persistenceLatencyMs: i < 20 ? 120_000 : null, evidenceDigests: ["b".repeat(64)],
  })),
  tasks: Array.from({ length: 40 }, (_, i) => ({
    id: `task-${i}`, scenario: i % 2 === 0 ? "native" : "mcp", applicable: i < 20, deliveredBeforeOperationWithoutReminder: i < 20,
    providedItems: i < 20 ? 1 : 0, incorrectItems: 0, hostObserved: true,
    compliance: i < 20 ? "compliant" : "unknown", evidenceDigests: ["c".repeat(64)],
  })),
  observations: automaticLearningObservationIds.map((id) => ({ id, status: "pass", evidenceDigests: ["d".repeat(64)] })),
});
const check = (evidence: unknown, id: string, target: "research" | "stable" = "research"): string | undefined =>
  evaluateAutomaticLearningAcceptance(evidence, target, "test-version").checks.find((item) => item.checkId === id)?.status;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const artifactFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "pl-acceptance-evidence-")); roots.push(root);
  const evidence = fixture();
  evidence.installedArtifactDigest = await resolveLearningEvaluationExecutableDigest(process.cwd());
  const bytes = "Synthetic test observation, not independent human or native acceptance.";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  for (const item of [...evidence.windows, ...evidence.tasks, ...evidence.observations]) item.evidenceDigests = [sha256];
  const evidencePath = join(root, "evidence.json");
  const artifactManifestPath = join(root, "artifacts.json");
  await writeFile(join(root, "observation.txt"), bytes);
  await writeFile(evidencePath, JSON.stringify(evidence));
  await writeFile(artifactManifestPath, JSON.stringify({ version: 1, producer: "provenloop-installed-observer",
    codeVersion: evidence.codeVersion, executableDigest: evidence.installedArtifactDigest, artifacts: [{ path: "observation.txt", sha256 }] }));
  return { root, evidence, evidencePath, artifactManifestPath, artifactRoot: root,
    expectedCodeVersion: evidence.codeVersion, expectedExecutableDigest: evidence.installedArtifactDigest, outputPath: join(root, "import.json") };
};

describe("automatic-learning acceptance arithmetic and evidence boundaries", () => {
  it("UX-07 rejects plausible raw installed evidence at the M2 entry point", async () => {
    const f = await artifactFixture();
    expect(evaluateAutomaticLearningAcceptance(f.evidence).status).toBe("pass");
    const result = await runM2ReleaseGate({ codeVersion: f.evidence.codeVersion, outputRoot: f.root, runId: "raw-evidence",
      automaticLearningEvidencePath: f.evidencePath });
    expect(result.report).toMatchObject({ status: "fail", exitCode: 2, checks: [{ checkId: "m2-input" }] });
  });
  it("UX-07 revalidates imported artifacts and executable binding when M2 consumes evidence", async () => {
    const f = await artifactFixture();
    await importInstalledLearningAcceptance(f);
    const automaticLearningEvidencePath = f.outputPath + ".evidence.json";
    const first = await runM2ReleaseGate({ codeVersion: f.evidence.codeVersion, outputRoot: f.root, runId: "valid-evidence", automaticLearningEvidencePath });
    expect(first.report).toMatchObject({ status: "pass", automaticLearning: { status: "pass" }, evaluationPurpose: "regression" });
    expect(await readFile(join(first.runDirectory, "m2-report.md"), "utf8")).toContain("Evaluation purpose | regression");
    await expect(loadAutomaticLearningEvidence(automaticLearningEvidencePath, { codeVersion: f.evidence.codeVersion, executableDigest: "0".repeat(64) })).rejects.toThrow("do not match");
    await writeFile(join(f.root, "observation.txt"), "Replaced after import.");
    const changed = await runM2ReleaseGate({ codeVersion: f.evidence.codeVersion, outputRoot: f.root, runId: "changed-evidence", automaticLearningEvidencePath });
    expect(changed.report).toMatchObject({ status: "fail", exitCode: 2 });
  });
  it("UX-07 rejects replacement evidence even when its artifact references stay unchanged", async () => {
    const f = await artifactFixture();
    await importInstalledLearningAcceptance(f);
    at(f.evidence.tasks, 0).compliance = "noncompliant";
    await writeFile(f.outputPath + ".evidence.json", JSON.stringify(f.evidence));
    await expect(loadAutomaticLearningEvidence(f.outputPath + ".evidence.json")).rejects.toThrow("do not match");
  });
  it("accepts the actual dirty-worktree code version and still rejects mismatched evidence", () => {
    const evidence = fixture();
    evidence.codeVersion = `${"a".repeat(40)}+dirty.${"b".repeat(16)}`;
    expect(evaluateAutomaticLearningAcceptance(evidence, "research", evidence.codeVersion).status).toBe("pass");
    expect(evaluateAutomaticLearningAcceptance(evidence, "research", `${"a".repeat(40)}+dirty.${"c".repeat(16)}`).status).toBe("fail");
  });
  it("always blocks legacy MVP readiness when automatic-learning evidence is omitted", () => {
    const result = evaluateMvpReleaseReadiness({
      automated: {
        codeVersions: ["test-version"],
        evaluationBinding: { codeVersion: "test-version", executableDigest: "a".repeat(64),
          datasets: { branchContinuation: { datasetId: "branch", datasetVersion: 1 },
            correctionRecurrence: { datasetId: "correction", datasetVersion: 1 },
            workEpisodeAssociation: { datasetId: "episode", datasetVersion: 1 } },
          subgateDigests: { m0: "a".repeat(64), m1: "b".repeat(64), m2: "c".repeat(64) } },
        eventProcessIntegrityPassed: true, m0Status: "pass", m1Status: "pass", m2Status: "pass",
        negativeTriggerCaseCount: 20, rollbackTargetValid: true, safetyRecoveryPassed: true,
      },
      now: new Date("2026-09-07T00:00:00Z"), releaseTarget: "research",
    });
    expect(result.decision).toBe("no_go");
    expect(result.checks.find((item) => item.checkId === "automatic-learning-acceptance")?.status).toBe("blocked");
    expect(result.checks.filter((item) => item.checkId.startsWith("M2-AUTO-"))).toHaveLength(8);
  });
  it("blocks missing evidence and rejects malformed or repeated causal windows", () => {
    expect(evaluateAutomaticLearningAcceptance(undefined).status).toBe("insufficient_evidence");
    expect(evaluateAutomaticLearningAcceptance({}).status).toBe("fail");
    const evidence = fixture();
    at(evidence.windows, 1).independentSourceId = at(evidence.windows, 0).independentSourceId;
    expect(evaluateAutomaticLearningAcceptance(evidence).status).toBe("fail");
  });
  it("UX-07 rejects discovery labels that contradict produced rule counts", () => {
    const evidence = fixture();
    at(evidence.windows, 0).candidate = "none";
    expect(evaluateAutomaticLearningAcceptance(evidence).status).toBe("fail");
    at(evidence.windows, 0).candidate = "correct";
    at(evidence.windows, 0).proposedRules = 0;
    at(evidence.windows, 0).correctRules = 0;
    expect(evaluateAutomaticLearningAcceptance(evidence).status).toBe("fail");
  });
  it("accepts the arithmetic fixture but cannot treat synthetic provider evidence as installed acceptance", () => {
    const evidence = fixture();
    expect(evaluateAutomaticLearningAcceptance(evidence).status).toBe("pass");
    evidence.evidenceKind = "synthetic";
    expect(evaluateAutomaticLearningAcceptance(evidence).status).toBe("insufficient_evidence");
  });
  it("UX-06/08 requires observed compliance in both supported scenarios without inventing a rate threshold", () => {
    const evidence = fixture();
    for (const task of evidence.tasks.filter((item) => item.applicable)) task.compliance = "noncompliant";
    const failed = evaluateAutomaticLearningAcceptance(evidence);
    expect(failed.status).toBe("fail");
    expect(check(evidence, "M2-AUTO-004-observed-compliance")).toBe("fail");
    expect(failed.metrics).toMatchObject({ noncompliantApplicableTasks: 20, compliantApplicableTasks: 0, causalBenefit: null });
    at(evidence.tasks, 0).compliance = "compliant";
    expect(check(evidence, "M2-AUTO-004-observed-compliance")).toBe("fail");
    at(evidence.tasks, 1).compliance = "compliant";
    expect(evaluateAutomaticLearningAcceptance(evidence).status).toBe("pass");
    at(evidence.tasks, 1).deliveredBeforeOperationWithoutReminder = false;
    expect(check(evidence, "M2-AUTO-004-observed-compliance")).toBe("fail");
  });
  it("UX-06 keeps missing later outcomes and scenario labels incomplete", () => {
    const evidence = fixture();
    at(evidence.tasks, 0).compliance = "unknown";
    expect(evaluateAutomaticLearningAcceptance(evidence).status).toBe("insufficient_evidence");
    expect(check(evidence, "M2-AUTO-007-label-completeness")).toBe("blocked");
    expect(check(evidence, "M2-AUTO-004-observed-compliance")).toBe("blocked");
    at(evidence.tasks, 0).compliance = "compliant";
    delete at(evidence.tasks, 0).scenario;
    expect(evaluateAutomaticLearningAcceptance(evidence).status).toBe("insufficient_evidence");
  });
  it("keeps extraction misses in activation and applicable-task denominators", () => {
    const evidence = fixture();
    for (let i = 0; i < 2; i++) {
      at(evidence.windows, i).candidate = "none";
      at(evidence.windows, i).proposedRules = 0;
      at(evidence.windows, i).correctRules = 0;
      at(evidence.windows, i).active = false;
    }
    expect(check(evidence, "M2-AUTO-007-discovery-recall")).toBe("pass");
    expect(check(evidence, "M2-AUTO-007-activation-rate")).toBe("pass");
    at(evidence.windows, 2).candidate = "none";
    at(evidence.windows, 2).proposedRules = 0;
    at(evidence.windows, 2).correctRules = 0;
    at(evidence.windows, 2).active = false;
    expect(check(evidence, "M2-AUTO-007-discovery-recall")).toBe("fail");
    expect(check(evidence, "M2-AUTO-007-activation-rate")).toBe("fail");
    at(evidence.tasks, 0).deliveredBeforeOperationWithoutReminder = false;
    expect(check(evidence, "M2-AUTO-007-delivery-rate")).toBe("pass");
    at(evidence.tasks, 1).deliveredBeforeOperationWithoutReminder = false;
    expect(check(evidence, "M2-AUTO-007-delivery-rate")).toBe("fail");
  });
  it("checks both wrong-delivery denominators and stable thresholds", () => {
    const evidence = fixture();
    evidence.tasks = Array.from({ length: 100 }, (_, i) => ({
      ...at(evidence.tasks, 0), id: `delivered-${i}`, providedItems: 10, incorrectItems: i < 2 ? 1 : 0,
    })).concat(evidence.tasks.slice(20));
    expect(check(evidence, "M2-AUTO-007-wrong-items")).toBe("pass");
    expect(check(evidence, "M2-AUTO-007-wrong-tasks")).toBe("pass");
    for (const task of evidence.tasks.filter((item) => item.providedItems > 0)) task.providedItems = 1;
    expect(check(evidence, "M2-AUTO-007-wrong-items")).toBe("pass");
    expect(check(evidence, "M2-AUTO-007-wrong-items", "stable")).toBe("fail");
    for (const task of evidence.tasks.filter((item) => item.providedItems > 0)) task.providedItems = 10;
    expect(check(evidence, "M2-AUTO-007-wrong-tasks", "stable")).toBe("fail");
    at(evidence.tasks, 2).incorrectItems = 1;
    expect(check(evidence, "M2-AUTO-007-wrong-tasks")).toBe("fail");
    expect(check(evidence, "M2-AUTO-007-wrong-items")).toBe("pass");
  });
  it("checks the exact precision and negative-abstention boundaries", () => {
    const evidence = fixture();
    at(evidence.windows, 0).correctRules = 0;
    at(evidence.windows, 0).candidate = "incorrect";
    expect(check(evidence, "M2-AUTO-002-rule-precision")).toBe("pass");
    at(evidence.windows, 1).correctRules = 0;
    at(evidence.windows, 1).candidate = "incorrect";
    expect(check(evidence, "M2-AUTO-002-rule-precision")).toBe("fail");
    evidence.tasks = evidence.tasks.slice(0, 20).concat(Array.from({ length: 100 }, (_, i) => ({
      ...at(evidence.tasks, 20), id: `negative-${i}`, providedItems: i < 2 ? 1 : 0,
    })));
    expect(check(evidence, "M2-AUTO-007-negative-abstention")).toBe("pass");
    at(evidence.tasks, 22).providedItems = 1;
    expect(check(evidence, "M2-AUTO-007-negative-abstention")).toBe("fail");
  });
  it("preserves unknowns, paused attempts, absent host notices and stale binding", () => {
    const evidence = fixture();
    at(evidence.windows, 0).disposition = "paused";
    at(evidence.tasks, 0).hostObserved = false;
    evidence.observations = evidence.observations.filter((item) => item.id !== "activation_notice_visible");
    expect(check(evidence, "M2-AUTO-005-complete-run")).toBe("blocked");
    expect(check(evidence, "M2-AUTO-007-label-completeness")).toBe("blocked");
    expect(check(evidence, "M2-AUTO-008")).toBe("blocked");
    evidence.codeVersion = "stale";
    expect(check(evidence, "M2-AUTO-002-runtime-binding")).toBe("fail");
  });
  it("requires sample sizes, complete provenance, prohibited-activation blocking and p95 latency", () => {
    const evidence = fixture();
    at(evidence.windows, 0).provenanceComplete = false;
    at(evidence.windows, 20).active = true;
    at(evidence.windows, 0).persistenceLatencyMs = 120_001;
    at(evidence.windows, 1).persistenceLatencyMs = 120_001;
    expect(check(evidence, "M2-AUTO-002-provenance")).toBe("fail");
    expect(check(evidence, "M2-AUTO-003-prohibited-activation")).toBe("fail");
    expect(check(evidence, "M2-AUTO-007-persistence-latency")).toBe("fail");
    evidence.windows.pop();
    expect(check(evidence, "M2-AUTO-007-sample")).toBe("blocked");
  });
});
