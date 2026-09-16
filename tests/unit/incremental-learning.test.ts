import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureQueueItemSchema } from "@provenloop/contracts";
import { buildLearningWindows, createCaptureEnvelope, sha256 } from "@provenloop/domain";
import { LearningCoordinator } from "@provenloop/host";
import { CanonicalSqliteStore, DEFAULT_SQLITE_MIGRATIONS, DatabaseSync } from "@provenloop/storage-sqlite";

const base = Date.parse("2026-09-08T00:00:00Z");
const now = new Date(base + 60_000);
const roots: string[] = [];
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Missing fixture entry.");
  return value;
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const item = (id: string, type = "prompt.submitted", at = base, message?: string, session = "session") => {
  const timestamp = new Date(at).toISOString();
  return captureQueueItemSchema.parse({
    schemaVersion: 1, queueItemId: `queue-${id}`, state: "pending", attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp,
    envelope: createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: id,
      eventType: type, trust: type === "prompt.submitted" ? "user" : "tool", sessionId: session,
      repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo", timestamp,
      ...(message === undefined ? {} : { content: { message } }),
    }),
  });
};
const seedTurn = (store: CanonicalSqliteStore, id: string, at = base, session = "session") => {
  store.ingestQueueItem(item(`${id}-prompt`, "prompt.submitted", at, "Please check this repository.", session));
  store.ingestQueueItem(item(`${id}-done`, "tool.completed", at + 1000, undefined, session));
};
const finishWork = (store: CanonicalSqliteStore) => {
  for (let round = 0; round < 100; round++) {
    const work = store.learningPromptWork(now, 128);
    if (!work.length) return;
    for (const entry of work) store.completeLearningPromptWork(entry);
  }
  throw new Error("Work queue did not drain.");
};

describe("incremental automatic learning", () => {
  it("retains pending work across reopen and drains unchanged history once", async () => {
    const root = await mkdtemp(join(tmpdir(), "learning-work-")); roots.push(root);
    const path = join(root, "canonical.db");
    let store = new CanonicalSqliteStore(path);
    try {
      seedTurn(store, "one");
      const initial = store.learningPromptWork(now);
      expect(initial).toHaveLength(1);
      store.close(); store = new CanonicalSqliteStore(path);
      const resumed = store.learningPromptWork(now);
      expect(resumed.map((entry) => entry.eventId)).toEqual(initial.map((entry) => entry.eventId));
      store.completeLearningPromptWork(required(resumed[0]));
      expect(store.learningPromptWork(now)).toEqual([]);
      store.ingestQueueItem(item("one-prompt", "prompt.submitted", base, "Please check this repository."));
      expect(store.learningPromptWork(now)).toEqual([]);
    } finally { store.close(); }
  });

  it("revisits a turn for late completion and enrichment without relying on observation timestamps", () => {
    const store = new CanonicalSqliteStore(":memory:", { now: () => now });
    try {
      const prompt = item("late-prompt"); store.ingestQueueItem(prompt);
      const initial = required(store.learningPromptWork(now)[0]);
      expect(buildLearningWindows(initial.events, now)).toEqual([]);
      store.completeLearningPromptWork(initial);
      store.ingestQueueItem(item("late-completion", "tool.completed", base + 1000));
      const completed = required(store.learningPromptWork(now)[0]);
      store.completeLearningPromptWork(completed);
      const enriched = item("late-prompt", "prompt.submitted", base, "Use the repository test command.");
      expect(store.enrichRawEvent({ envelope: enriched.envelope, sourceDigest: "a".repeat(64) }).status).toBe("enriched");
      const revised = required(store.learningPromptWork(now)[0]);
      expect(revised.events.find((entry) => entry.event.eventId === prompt.envelope.event.eventId)?.content?.message).toBe("Use the repository test command.");
      expect(buildLearningWindows(revised.events, now)).toHaveLength(1);
    } finally { store.close(); }
  });

  it("does not acknowledge concurrent changes with an old generation", () => {
    const store = new CanonicalSqliteStore(":memory:");
    try {
      seedTurn(store, "one"); const first = required(store.learningPromptWork(now)[0]);
      store.ingestQueueItem(item("later-done", "tool.completed", base + 2000));
      const second = required(store.learningPromptWork(now)[0]);
      expect(second.generation).toBeGreaterThan(first.generation);
      store.completeLearningPromptWork(first);
      expect(store.learningPromptWork(now)).toHaveLength(1);
      store.completeLearningPromptWork(second);
      expect(store.learningPromptWork(now)).toEqual([]);
    } finally { store.close(); }
  });

  it("orders mixed timestamp offsets without changing source evidence", () => {
    const store = new CanonicalSqliteStore(":memory:");
    try {
      const prompt = item("offset-prompt", "prompt.submitted", base, "Check this repository.");
      prompt.envelope.event.timestamp = "2026-09-08T08:00:00+08:00";
      const done = item("offset-done", "tool.completed", base + 1000);
      done.envelope.event.timestamp = "2026-09-08T00:00:01Z";
      store.ingestQueueItem(done); store.ingestQueueItem(prompt);
      const work = store.learningPromptWork(now);
      expect(work).toHaveLength(1);
      expect(required(work[0]).events.map((entry) => entry.sourceEventId)).toEqual(["offset-prompt", "offset-done"]);
      expect(required(required(work[0]).events[0]).event.timestamp).toBe("2026-09-08T08:00:00+08:00");
      expect(buildLearningWindows(required(work[0]).events, now)).toHaveLength(1);
    } finally { store.close(); }
  });

  it("excludes internal events before the context read budget", () => {
    const store = new CanonicalSqliteStore(":memory:");
    try {
      store.ingestQueueItem(item("visible-prompt", "prompt.submitted", base, "Check the repository."));
      for (let i = 0; i < 70; i++) {
        const internal = item(`internal-${i}`, "tool.completed", base + i + 1);
        internal.envelope.event.actorId = "provenloop-internal";
        store.ingestQueueItem(internal);
      }
      store.ingestQueueItem(item("visible-result", "tool.completed", base + 1000));
      const work = required(store.learningPromptWork(now)[0]);
      expect(work.events).toHaveLength(2);
      expect(buildLearningWindows(work.events, now)).toHaveLength(1);
    } finally { store.close(); }
  });

  it("revisits all adjacent turns that can depend on an enriched earlier operation", () => {
    const store = new CanonicalSqliteStore(":memory:");
    try {
      const operation = item("shared-operation", "tool.started", base); store.ingestQueueItem(operation);
      store.ingestQueueItem(item("first-turn", "prompt.submitted", base + 1000, "Check the command."));
      store.ingestQueueItem(item("second-turn", "prompt.submitted", base + 2000, "Use the package command."));
      finishWork(store);
      const enriched = item("shared-operation", "tool.started", base, "Recovered operation content");
      expect(store.enrichRawEvent({ envelope: enriched.envelope, sourceDigest: "b".repeat(64) }).status).toBe("enriched");
      expect(store.learningPromptWork(now).map((entry) => entry.events.find((source) => source.event.eventId === entry.eventId)?.sourceEventId).sort())
        .toEqual(["first-turn", "second-turn"]);
    } finally { store.close(); }
  });

  it("reschedules the latest superseded window when enriched evidence is beyond adjacent turns", () => {
    const store = new CanonicalSqliteStore(":memory:");
    try {
      seedTurn(store, "original");
      const prompt = required(store.episodeSourceEnvelopes().find((entry) => entry.sourceEventId === "original-prompt"));
      const distant = item("distant-proof", "tool.completed", base + 200_000); store.ingestQueueItem(distant);
      for (let index = 0; index < 80; index += 1) seedTurn(store, `between-${index}`, base + 2000 + index * 2000);
      const capturedDistant = required(store.episodeSourceEnvelopes().find((entry) => entry.sourceEventId === "distant-proof"));
      const sources = [prompt, capturedDistant].map((event) => ({ eventId: event.event.eventId, digest: sha256(event) }));
      const job = required(store.scheduleLearningWindow({ schemaVersion: 1, windowId: `learning-window-${sha256(prompt.event.eventId).slice(0, 24)}`,
        revision: sha256(sources), sessionId: "session", repoId: "repo", worktree: "C:/repo", createdAt: prompt.event.timestamp, sources, events: [prompt, capturedDistant] },
      new Date(base + 86_400_000).toISOString()));
      const time = new Date(base + 300_000);
      for (let round = 0; round < 10; round += 1) for (const work of store.learningPromptWork(time, 128)) store.completeLearningPromptWork(work);
      expect(store.enrichRawEvent({ envelope: { ...distant.envelope, content: { message: "Recovered exact result." } }, sourceDigest: "d".repeat(64) }).status).toBe("enriched");
      store.transitionLearningJob({ ...job, state: "superseded" }, "pending");
      expect(store.learningPromptWork(time, 128).some((work) => work.eventId === prompt.event.eventId)).toBe(true);
    } finally { store.close(); }
  });

  it("honors debounce and batch limits, and removes work when its source is deleted", () => {
    const store = new CanonicalSqliteStore(":memory:");
    try {
      for (let i = 0; i < 12; i++) seedTurn(store, `turn-${i}`, base + i * 2000, `s-${i}`);
      expect(store.learningPromptWork(new Date(base + 1000))).toEqual([]);
      const page = store.learningPromptWork(now, 3); expect(page).toHaveLength(3);
      const target = { targetType: "source" as const, targetId: required(page[0]).eventId };
      const deletion = store.beginDeletion(target); store.deleteCanonicalTarget(deletion.deletionId, target);
      expect(store.learningPromptWork(now)).toEqual([]); // Active deletion blocks all learning.
    } finally { store.close(); }
  });

  it("uses bounded context for a new turn after a long history and avoids all-history coordinator reads", async () => {
    const store = new CanonicalSqliteStore(":memory:");
    try {
      for (let i = 0; i < 300; i++) seedTurn(store, `old-${i}`, base - (301 - i) * 2000);
      finishWork(store);
      const envelopes = vi.spyOn(store, "episodeSourceEnvelopes").mockImplementation(() => { throw new Error("Unbounded event read"); });
      const jobs = vi.spyOn(store, "learningJobs").mockImplementation(() => { throw new Error("Unbounded job read"); });
      const proposals = vi.spyOn(store, "learningProposals").mockImplementation(() => { throw new Error("Unbounded proposal read"); });
      seedTurn(store, "new");
      const work = store.learningPromptWork(now);
      expect(work).toHaveLength(1);
      expect(required(work[0]).events.length).toBeLessThanOrEqual(128);
      const infer = vi.fn(async () => ({ schemaVersion: 1, proposals: [] }));
      const coordinator = new LearningCoordinator({ store, now: () => now, enabled: async () => true,
        lease: { tryAcquire: async () => ({ release: async () => undefined }) }, provider: { identity: { provider: "fixture", model: "fixture", version: "1" }, infer } });
      expect(await coordinator.run()).toMatchObject({ status: "evaluated", proposals: 0 });
      expect(await coordinator.run()).toMatchObject({ status: "idle" });
      expect(infer).toHaveBeenCalledTimes(1);
      expect(envelopes).not.toHaveBeenCalled(); expect(jobs).not.toHaveBeenCalled(); expect(proposals).not.toHaveBeenCalled();
    } finally { store.close(); }
  });

  it("backfills version 11 prompts once and uses indexed context lookup", async () => {
    const root = await mkdtemp(join(tmpdir(), "learning-migration-")); roots.push(root);
    const path = join(root, "canonical.db");
    const old = new CanonicalSqliteStore(path, { migrations: DEFAULT_SQLITE_MIGRATIONS.filter((migration) => migration.version < 12) });
    seedTurn(old, "legacy"); old.close();
    const legacy = new DatabaseSync(path);
    legacy.prepare("UPDATE raw_events SET event_timestamp=? WHERE event_type='prompt.submitted'").run("2026-09-08T08:00:00.0009+08:00");
    legacy.close();
    expect(() => new CanonicalSqliteStore(path)).toThrow();
    const migrated = new CanonicalSqliteStore(path, { allowSchemaMigration: true });
    try {
      expect(migrated.health().userVersion).toBe(DEFAULT_SQLITE_MIGRATIONS.length);
      const work = migrated.learningPromptWork(now); expect(work).toHaveLength(1);
      migrated.completeLearningPromptWork(required(work[0]));
    } finally { migrated.close(); }
    const reopened = new CanonicalSqliteStore(path);
    try { expect(reopened.learningPromptWork(now)).toEqual([]); } finally { reopened.close(); }
    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare("SELECT event_timestamp FROM raw_events WHERE event_type='prompt.submitted'").get()?.event_timestamp)
        .toBe("2026-09-08T00:00:00.000Z");
      const plan = raw.prepare(`EXPLAIN QUERY PLAN SELECT safe_envelope_json FROM raw_events WHERE parse_status='supported'
        AND coalesce(json_extract(safe_envelope_json, '$.event.actorId'),'') != 'provenloop-internal'
        AND session_id=? AND repo_id=? AND worktree=? AND (event_timestamp,event_id)>=(?,?) ORDER BY event_timestamp,event_id LIMIT 64`)
        .all("session", "repo", "C:/repo", new Date(base).toISOString(), "event");
      expect(plan.map((row) => row.detail).join(" ")).toContain("raw_events_learning_context");
      const target = raw.prepare("SELECT deduplication_key FROM raw_events WHERE event_type='prompt.submitted'").get();
      if (!target) throw new Error("Missing prompt row");
      raw.exec("PRAGMA foreign_keys=ON");
      raw.prepare("INSERT INTO learning_event_changes VALUES (?)").run(String(target.deduplication_key));
      raw.prepare("INSERT INTO learning_prompt_work VALUES (?,1,0)").run(String(target.deduplication_key));
      raw.prepare("DELETE FROM raw_events WHERE deduplication_key=?").run(String(target.deduplication_key));
      expect(raw.prepare("SELECT count(*) AS n FROM learning_prompt_work").get()?.n).toBe(0);
      expect(raw.prepare("SELECT count(*) AS n FROM learning_event_changes").get()?.n).toBe(0);
    } finally { raw.close(); }
  });

  it("requires an explicit schema 13 upgrade and rejects older learning readers afterwards", async () => {
    const root = await mkdtemp(join(tmpdir(), "learning-schema-13-")); roots.push(root);
    const path = join(root, "canonical.db");
    const oldMigrations = DEFAULT_SQLITE_MIGRATIONS.filter((migration) => migration.version < 13);
    const prior = new CanonicalSqliteStore(path, { migrations: oldMigrations });
    seedTurn(prior, "upgrade"); prior.close();
    expect(() => new CanonicalSqliteStore(path)).toThrow("maintenance upgrade");
    const upgraded = new CanonicalSqliteStore(path, { allowSchemaMigration: true });
    try {
      expect(upgraded.health().userVersion).toBe(DEFAULT_SQLITE_MIGRATIONS.length);
      expect(upgraded.learningPromptWork(now)).toHaveLength(1);
    } finally { upgraded.close(); }
    expect(() => new CanonicalSqliteStore(path, { migrations: oldMigrations })).toThrow("newer than supported");
  });

  it("rotates bounded evidence and inference pages fairly when the clock does not advance", async () => {
    const store = new CanonicalSqliteStore(":memory:");
    try {
      for (let index = 0; index < 35; index += 1) {
        seedTurn(store, `fair-${index}`, base, `fair-session-${index}`);
      }
      const windows = buildLearningWindows(store.episodeSourceEnvelopes(), now);
      expect(windows).toHaveLength(35);
      for (const window of windows) store.scheduleLearningWindow(window, new Date(base + 86_400_000).toISOString(), now);
      const first = store.learningJobsDue(now, "inference", 1)[0];
      expect(first).toBeDefined();
      if (!first) throw new Error("Missing pending job.");
      store.transitionLearningJob({ ...first, state: "failed", attempts: 1, updatedAt: now.toISOString() }, "pending");
      expect(store.learningJobsDue(now, "inference", 1)[0]?.jobId).not.toBe(first.jobId);
      for (const job of store.learningJobs()) store.transitionLearningJob({ ...job, state: "waiting_evidence" }, job.state);
      const firstPage = store.learningJobsDue(now, "evidence");
      expect(firstPage).toHaveLength(32);
      for (const job of firstPage) store.transitionLearningJob({ ...job, updatedAt: now.toISOString() }, "waiting_evidence");
      const nextPage = store.learningJobsDue(now, "evidence");
      expect(nextPage.slice(0, 3).every((job) => !firstPage.some((prior) => prior.jobId === job.jobId))).toBe(true);
      expect(store.learningJobsDue(new Date(base + 86_400_000), "evidence")).toEqual([]);
    } finally { store.close(); }
  });
});
