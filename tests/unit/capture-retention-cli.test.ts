import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureQueueItemSchema } from "@provenloop/contracts";
import { runCli } from "@provenloop/cli";
import { createCaptureEnvelope, type CaptureEventInput } from "@provenloop/domain";
import type { CaptureRetentionPlan } from "@provenloop/host";
import { resolveWindowsProvenLoopPaths, WindowsCaptureQueue } from "@provenloop/platform-windows";
import { CanonicalSqliteStore, DatabaseSync } from "@provenloop/storage-sqlite";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const workspace = resolve(process.cwd()); const absolute = resolve(root);
    assert(absolute.startsWith(workspace + "/") || absolute.startsWith(workspace + "\\"));
    await rm(absolute, { recursive: true, force: true });
  }
});
const old = new Date("2020-01-01T00:00:00.000Z");
const cutoff = "2020-02-01T00:00:00.000Z";
const eventInput = (sessionId: string, eventType: string, index: number): CaptureEventInput => ({
  adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: `${sessionId}-${index}`, sessionId,
  repoId: "retention-repo", worktree: "C:/retention-repo", repositoryState: "known_repo", eventType,
  timestamp: new Date(old.getTime() + index * 1000).toISOString(), trust: eventType === "prompt.submitted" ? "user" : "system",
  ...(eventType === "prompt.submitted" ? { content: { message: "Inspect a temporary build failure. SOURCE_TEXT_NOT_FOR_PLAN" } } : {}),
});
const snapshot = (databasePath: string) => {
  const store = new CanonicalSqliteStore(databasePath);
  try { return { events: store.rawEvents(), episodes: store.workEpisodes(), knowledge: store.knowledgeCandidates(), deletionActive: store.hasActiveDeletion() }; }
  finally { store.close(); }
};
const execute = async (args: string[]) => {
  const logs: string[] = []; const errors: string[] = [];
  const code = await runCli(args, { log: (value) => { logs.push(value); }, error: (value) => { errors.push(value); } });
  return { code, logs, errors };
};
const fixture = async () => {
  const root = await mkdtemp(join(process.cwd(), ".retention-cli-test-")); roots.push(root);
  const paths = resolveWindowsProvenLoopPaths(root); await mkdir(paths.data, { recursive: true }); await writeFile(paths.rootMarker, "{}");
  const store = new CanonicalSqliteStore(paths.database, { now: () => old });
  try {
    for (const [session, events] of [["eligible-old", ["prompt.submitted", "session.ended"]], ["keep-open", ["prompt.submitted"]]] as const) {
      for (const [index, type] of events.entries()) {
        const envelope = createCaptureEnvelope(eventInput(session, type, index));
        store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `${session}-${index}`, state: "pending", attemptCount: 0, failureCount: 0, createdAt: old.toISOString(), updatedAt: old.toISOString(), envelope }));
      }
    }
  } finally { store.close(); }
  const queue = new WindowsCaptureQueue(paths.queue); await queue.initialize();
  return { root, paths, queue };
};
const plan = async (root: string, olderThan?: string): Promise<CaptureRetentionPlan> => {
  const result = await execute(["capture", "retention", "plan", "--data-root", root, ...(olderThan ? ["--older-than", olderThan] : [])]);
  expect(result.code, result.errors.join("\n")).toBe(0);
  return JSON.parse(result.logs.at(-1) ?? "{}") as CaptureRetentionPlan;
};
const applyArgs = (root: string, reviewed: CaptureRetentionPlan): string[] => ["capture", "retention", "apply", "--data-root", root, "--older-than", reviewed.olderThan, "--expect", reviewed.expectedDigest, "--sessions", "eligible-old", "--confirm"];

describe("capture retention CLI", () => {
  it("plans a default 90-day window without changing records or exposing captured prose", async () => {
    const { root, paths } = await fixture(); const before = snapshot(paths.database); const start = Date.now();
    const reviewed = await plan(root); const end = Date.now();
    expect(Date.parse(reviewed.olderThan)).toBeGreaterThanOrEqual(start - 90 * 86_400_000);
    expect(Date.parse(reviewed.olderThan)).toBeLessThanOrEqual(end - 90 * 86_400_000);
    expect(reviewed.candidates.map((item) => item.sessionId)).toEqual(["eligible-old"]);
    expect(reviewed.protected.find((item) => item.sessionId === "keep-open")?.reasons).toContain("session_not_closed");
    expect(reviewed.candidateEventCount).toBe(2); expect(reviewed.expectedDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(reviewed)).not.toContain("SOURCE_TEXT_NOT_FOR_PLAN");
    expect(snapshot(paths.database)).toEqual(before);
  });

  it("requires explicit cutoff, current digest, selected sessions and confirmation before applying", async () => {
    const { root, paths } = await fixture(); const reviewed = await plan(root, cutoff); const before = snapshot(paths.database);
    for (const field of ["--older-than", "--expect", "--sessions", "--confirm"]) {
      const args = applyArgs(root, reviewed); const index = args.indexOf(field); args.splice(index, field === "--confirm" ? 1 : 2);
      const result = await execute(args); expect(result.code, field).not.toBe(0); expect(result.errors.length).toBeGreaterThan(0);
      expect(snapshot(paths.database), field).toEqual(before);
    }
    const stale = applyArgs(root, reviewed); stale[stale.indexOf("--expect") + 1] = "0".repeat(64);
    expect((await execute(stale)).code).not.toBe(0); expect(snapshot(paths.database)).toEqual(before);
  });

  it("deletes the selected closed old session through DeletionService and preserves the open session", async () => {
    const { root, paths, queue } = await fixture(); const reviewed = await plan(root, cutoff);
    const result = await execute(applyArgs(root, reviewed)); expect(result.code, result.errors.join("\n")).toBe(0);
    expect(JSON.parse(result.logs.at(-1) ?? "{}")).toEqual({ deletedSessionIds: ["eligible-old"] });
    const remaining = snapshot(paths.database); expect(remaining.events.map((record) => record.sessionId)).toEqual(["keep-open"]);
    expect(remaining.deletionActive).toBe(false); expect(await queue.activeDeletionBarrier()).toBeUndefined();
    const database = new DatabaseSync(paths.database, { readOnly: true });
    try { const operations = database.prepare("SELECT body_json FROM deletion_operations").all().map((entry) => JSON.parse(String(entry.body_json)) as Record<string, unknown>); expect(operations).toHaveLength(1); expect(operations[0]).toMatchObject({ targetType: "session", status: "completed" }); }
    finally { database.close(); }
  });

  it("rejects cleanup when a reviewed session resumes into the queue and releases the preflight barrier", async () => {
    const { root, paths, queue } = await fixture(); const reviewed = await plan(root, cutoff); const before = snapshot(paths.database);
    const pending = await queue.enqueue({ ...eventInput("eligible-old", "prompt.submitted", 2), timestamp: new Date().toISOString(), content: { message: "The session has resumed." } });
    const result = await execute(applyArgs(root, reviewed)); expect(result.code).not.toBe(0);
    expect(result.errors.join("\n")).toContain("pending or failed capture work");
    expect(snapshot(paths.database)).toEqual(before); expect(await queue.activeDeletionBarrier()).toBeUndefined();
    expect((await queue.get(pending.queueItemId)).state).toBe("pending");
    const database = new DatabaseSync(paths.database, { readOnly: true });
    try { expect(database.prepare("SELECT count(*) AS count FROM deletion_operations").get()?.count).toBe(0); }
    finally { database.close(); }
  });
});
