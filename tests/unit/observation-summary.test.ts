import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCaptureEnvelope } from "@provenloop/domain";
import {
  readLocalObservationSummary,
  recordLocalObservationBatch,
  exportLocalObservationManifest,
  type ObservationContextUse,
} from "../../packages/cli/src/observation-summary.js";
import { PROVENLOOP_CODE_VERSION } from "../../packages/cli/src/release-metadata.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, unlink: vi.fn(original.unlink), rename: vi.fn(original.rename) };
});

const directories: string[] = [];
const root = async () => {
  const base = join(process.cwd(), "evaluation-output", "observation-tests");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "run-"));
  directories.push(directory);
  return directory;
};
const at = "2026-09-05T01:00:00.000Z";
const event = (id: string, type = "prompt.submitted") => createCaptureEnvelope({
  adapter: "copilot-cli", adapterVersion: "1.0.82-0", eventType: type,
  sourceEventId: id, sessionId: "private-session", repoId: "private-repository",
  timestamp: at, trust: "user", content: { message: "PRIVATE_PROMPT_AND_CODE" },
});
const context = (changes: Partial<ObservationContextUse> = {}): ObservationContextUse => ({
  schemaVersion: 1, sessionId: "private-session", repoId: "private-repository",
  requestId: "private-request", createdAt: at,
  codeVersion: PROVENLOOP_CODE_VERSION,
  candidateKnowledgeIds: ["private-knowledge"], returnedKnowledgeIds: ["knowledge:private-knowledge"],
  appliedKnowledgeIds: [], latencyMs: 12, renderedTokens: 15, retrievalStatus: "provided", ...changes,
});

afterEach(async () => {
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(unlink).mockReset().mockImplementation(original.unlink);
  vi.mocked(rename).mockReset().mockImplementation(original.rename);
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("incremental local observations", () => {
  it.skipIf(process.platform !== "win32")("retries a transient Windows archive replacement denial", async () => {
    const dataRoot = await root();
    await recordLocalObservationBatch({ dataRoot, contextUseRecords: [context()] });
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("busy reader"), { code: "EPERM" }));
    await expect(recordLocalObservationBatch({ dataRoot, contextUseRecords: [context({ feedback: "helpful" })] }))
      .resolves.toHaveLength(1);
    expect((await readLocalObservationSummary({ dataRoot, date: "2026-09-05" }))[0]?.retrieval.feedbackCount).toBe(1);
  });
  it("counts deliberate search separately from automatic context and adoption", async () => {
    const dataRoot = await root();
    await recordLocalObservationBatch({ dataRoot, contextUseRecords: [
      context(), context({ requestId: "deliberate-search", retrievalMode: "search" }),
    ] });
    const summary = (await readLocalObservationSummary({ dataRoot, date: "2026-09-05" }))[0];
    expect(summary?.retrieval).toMatchObject({ invocationCount: 1, providedCount: 1, explicitlyAdoptedCount: 0,
      search: { invocationCount: 1, providedCount: 1, explicitlyAdoptedCount: 0 } });
  });
  it.each(["identity", "archive"] as const)(
    "surfaces %s staging cleanup errors and supports an idempotent retry",
    async (stage) => {
      const dataRoot = await root();
      if (stage === "archive") {
        await recordLocalObservationBatch({ dataRoot });
      }
      const failure = Object.assign(new Error("Observation cleanup denied."), { code: "EACCES" });
      vi.mocked(unlink).mockRejectedValueOnce(failure);
      const batch = { dataRoot, events: [event("cleanup-retry")] };
      await expect(recordLocalObservationBatch(batch)).rejects.toBe(failure);
      await expect(recordLocalObservationBatch(batch)).resolves.toMatchObject([
        { observedEventCount: 1 },
      ]);
    },
  );

  it("archives real batches without a daily acceptance window or raw content", async () => {
    const dataRoot = await root();
    const batch = { dataRoot, events: [event("one")], contextUseRecords: [context()] };
    await recordLocalObservationBatch(batch);
    await recordLocalObservationBatch(batch);
    const summaries = await readLocalObservationSummary({ dataRoot, date: "2026-09-05" });
    expect(summaries).toHaveLength(1);
    expect(await exportLocalObservationManifest({ dataRoot, date: "2026-09-05" })).toMatchObject({
      evidenceKind: "observational",
      controlledEffect: "not_established",
      observations: [{ invocationCount: 1, providedCount: 1, outcome: "unknown" }],
    });
    expect(summaries[0]).toMatchObject({
      evidenceKind: "observational", controlledEffect: "not_established",
      observedEventCount: 1, subsequentCorrectionCount: null,
      outcome: "unknown", baselineAssignment: "unknown", taskDurationMs: null,
      verification: { succeeded: null, failed: null },
      retrieval: { state: "provided", invocationCount: 1, explicitlyAdoptedCount: 0 },
    });
    const directory = join(dataRoot, "evaluation", "observations", "2026-09-05");
    for (const name of await readdir(directory)) {
      const serialized = await readFile(join(directory, name), "utf8");
      expect(serialized).not.toMatch(/PRIVATE_PROMPT|private-session|private-repository|private-knowledge|private-request/u);
    }
  });

  it("updates explicit feedback idempotently without calling it successful task completion", async () => {
    const dataRoot = await root();
    const initial = context();
    const feedback = context({
      appliedKnowledgeIds: ["knowledge:private-knowledge"], feedback: "helpful",
      updatedAt: "2026-09-05T02:00:00.000Z",
    });
    await recordLocalObservationBatch({ dataRoot, contextUseRecords: [initial, feedback] });
    await recordLocalObservationBatch({ dataRoot, contextUseRecords: [initial, feedback] });
    expect((await readLocalObservationSummary({ dataRoot, date: "2026-09-05" }))[0]).toMatchObject({
      outcome: "unknown",
      retrieval: { state: "explicitly_adopted", invocationCount: 1, feedbackCount: 1, explicitlyAdoptedCount: 1 },
    });
  });

  it("distinguishes unknown, disabled, no match and confirmed absence of an invocation", async () => {
    const dataRoot = await root();
    const first = await recordLocalObservationBatch({ dataRoot, events: [event("one")] });
    expect(first[0]?.retrieval).toMatchObject({ state: "not_observed", invocationCount: null });
    const disabled = await recordLocalObservationBatch({
      dataRoot, events: [event("one")], capabilityState: { retrieval: false },
    });
    expect(disabled[0]?.retrieval.state).toBe("disabled");
    const closed = await recordLocalObservationBatch({
      dataRoot, events: [event("closed", "session.ended")],
      capabilityState: { retrieval: true }, contextCoverage: "complete",
    });
    expect(closed[0]?.retrieval).toMatchObject({ state: "not_invoked", invocationCount: 0 });
    const unmatched = await recordLocalObservationBatch({
      dataRoot, contextUseRecords: [context({ returnedKnowledgeIds: [], retrievalStatus: "no_match" })],
    });
    expect(unmatched[0]?.retrieval.state).toBe("no_match");
  });

  it("does not infer absence from an open session or an unresolved scope", async () => {
    const dataRoot = await root();
    const open = await recordLocalObservationBatch({
      dataRoot, events: [event("open")], contextCoverage: "complete",
    });
    expect(open[0]?.retrieval).toMatchObject({ state: "not_observed", invocationCount: null });
    const closed = event("unresolved-closed", "session.ended");
    const unresolved = await recordLocalObservationBatch({
      dataRoot, events: [{ ...closed, event: { ...closed.event, repoId: undefined } }],
      contextCoverage: "complete",
    });
    expect(unresolved[0]?.retrieval).toMatchObject({ state: "not_observed", invocationCount: null });
  });

  it("partitions dates, repositories and versions and serializes concurrent batches", async () => {
    const dataRoot = await root();
    await recordLocalObservationBatch({ dataRoot, events: [event("seed")] });
    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      recordLocalObservationBatch({ dataRoot, events: [event(`concurrent-${index}`)] })));
    expect((await readLocalObservationSummary({ dataRoot, date: "2026-09-05" }))[0]?.observedEventCount).toBe(11);
    await recordLocalObservationBatch({
      dataRoot, contextUseRecords: [
        context({ requestId: "next", createdAt: "2026-09-06T01:00:00Z" }),
        context({ repoId: "another-repository", codeVersion: "another-version" }),
      ],
    });
    expect(await readLocalObservationSummary({ dataRoot, date: "2026-09-05" })).toHaveLength(2);
    expect(await readLocalObservationSummary({ dataRoot, date: "2026-09-06" })).toHaveLength(1);
    expect(await readLocalObservationSummary({ dataRoot, date: "2026-09-05", sessionId: "different" })).toEqual([]);
    await expect(readLocalObservationSummary({ dataRoot, date: "..\\outside" })).rejects.toThrow();
  });

  it("keeps process health separate from latency and does not persist error payloads", async () => {
    const dataRoot = await root();
    const summaries = await recordLocalObservationBatch({
      dataRoot, captureHealth: [{
        sessionId: "private-session", timestamp: at, callbackCount: 2,
        droppedEvents: 1, writeFailures: 1,
      }],
    });

    expect(summaries[0]).toMatchObject({
      captureHealth: { callbackCount: 2, droppedEvents: 1, writeFailures: 1 },
      taskDurationMs: null, outcome: "unknown",
    });
    expect(JSON.stringify(summaries)).not.toContain("private-session");
  });

  it("keeps unknown identity and generic tool completion separate from semantic verification", async () => {
    const dataRoot = await root();
    const captured = event("tool-one", "tool.completed");
    const result = await recordLocalObservationBatch({
      dataRoot,
      events: [{
        ...captured,
        event: { ...captured.event, sessionId: undefined, repoId: undefined, completionStatus: "succeeded" },
      }],
    });

    expect(result[0]).toMatchObject({
      sessionDigest: null, repoDigest: null,
      verification: { succeeded: null, failed: null }, outcome: "unknown",
    });
  });

  it("uses trusted completion evidence and gives nonzero exit codes precedence", async () => {
    const success = event("verified-success", "test.completed");
    const failed = event("verified-failure", "build.completed");
    const userClaim = event("claimed-success", "verification.completed");
    const result = await recordLocalObservationBatch({
      dataRoot: await root(),
      events: [
        { ...success, event: { ...success.event, trust: "tool", exitCode: 0 } },
        { ...failed, event: { ...failed.event, trust: "tool", exitCode: 1, completionStatus: "succeeded" } },
        { ...userClaim, event: { ...userClaim.event, completionStatus: "succeeded" } },
      ],
    });
    expect(result[0]).toMatchObject({
      observedEventCount: 3, verification: { succeeded: 1, failed: 1 }, outcome: "unknown",
    });
  });

  it("preserves missing legacy retrieval status and counts branch feedback without promoting knowledge", async () => {
    const dataRoot = await root();
    const legacy = await recordLocalObservationBatch({
      dataRoot, contextUseRecords: [context({
        returnedKnowledgeIds: [], retrievalStatus: undefined, codeVersion: undefined,
      })],
    });
    expect(legacy[0]?.codeVersion).toBeNull();
    expect(legacy[0]?.retrieval).toMatchObject({ state: "unknown", noMatchCount: 0, unknownStatusRecordCount: 1 });
    const inferred = await recordLocalObservationBatch({
      dataRoot, contextUseRecords: [context({
        requestId: "legacy-inferred", retrievalStatus: undefined, codeVersion: undefined,
        appliedKnowledgeIds: ["knowledge:private-knowledge"], feedback: "helpful",
      })],
    });
    expect(inferred[0]?.retrieval).toMatchObject({
      explicitlyAdoptedCount: 0, unknownStatusRecordCount: 2,
    });
    const adopted = await recordLocalObservationBatch({
      dataRoot, contextUseRecords: [context({
        requestId: "branch-request", returnedKnowledgeIds: ["branch-context:one"],
        appliedKnowledgeIds: ["branch-context:one"], feedback: "helpful",
      })],
    });
    expect(adopted[0]).toMatchObject({
      outcome: "unknown", controlledEffect: "not_established",
      retrieval: { explicitlyAdoptedCount: 1, unknownStatusRecordCount: 0 },
    });
  });

  it("does not propagate unrecognized cached payloads into rewritten archives", async () => {
    const dataRoot = await root();
    await recordLocalObservationBatch({ dataRoot, contextUseRecords: [context()] });
    const directory = join(dataRoot, "evaluation", "observations", "2026-09-05");
    const [name] = await readdir(directory);
    if (name === undefined) {
      throw new Error("Missing observation archive.");
    }
    const path = join(directory, name);
    const cached = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    cached.prompt = "RAW_PRIVATE_PAYLOAD";
    await writeFile(path, JSON.stringify(cached));
    await recordLocalObservationBatch({ dataRoot, contextUseRecords: [context()] });
    expect(await readFile(path, "utf8")).not.toContain("RAW_PRIVATE_PAYLOAD");
  });

  it("caps retained identities and marks incomplete coverage instead of double-counting overflow", async () => {
    const dataRoot = await root();
    const events = Array.from({ length: 5_001 }, (_, index) => event(`bounded-${index}`));
    const batch = await recordLocalObservationBatch({ dataRoot, events });
    expect(batch[0]).toMatchObject({ observedEventCount: 5_000, coverage: "bounded_sample" });
    expect((await recordLocalObservationBatch({ dataRoot, events: events.slice(-1) }))[0])
      .toMatchObject({ observedEventCount: 5_000, coverage: "bounded_sample" });
  });
});
