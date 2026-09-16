import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureEnvelope, KnowledgeCandidate, RuleProposal } from "@provenloop/contracts";
import { buildLearningWindows, createCaptureEnvelope, directKnowledgeCounterevidence, learningKnowledgeCandidate, sha256, verifyMcpRecovery } from "@provenloop/domain";
import { CanonicalSqliteStore, DatabaseSync, DEFAULT_SQLITE_MIGRATIONS } from "@provenloop/storage-sqlite";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
const at = (second: number) => new Date(Date.UTC(2026, 8, 1) + second * 1000).toISOString();
const add = (store: CanonicalSqliteStore, envelope: CaptureEnvelope) => store.ingestQueueItem({
  schemaVersion: 1, queueItemId: "queue-" + envelope.event.eventId, state: "pending", attemptCount: 0, failureCount: 0,
  createdAt: envelope.event.timestamp, updatedAt: envelope.event.timestamp, envelope,
});
const candidate = (sourceEvidenceIds: string[]): KnowledgeCandidate => ({
  schemaVersion: 1, knowledgeId: "learning-knowledge-scale", topicKey: "testing", content: "Run the repository checks.",
  appliesWhen: ["Testing this repository"], nonApplicability: [], conflictsWith: [], scope: "repository", scopeId: "repo",
  state: "active", kind: "procedural", evidenceTier: "user_confirmed", evidenceMarks: ["user_confirmed"], importance: 1,
  coverage: { applicableOpportunities: 0, observedOutcomes: 0 }, utility: { applied: 0, helpful: 0, harmful: 0 },
  createdAt: at(0), sourceEpisodeIds: [], sourceEvidenceIds,
});

describe("canonical scale boundaries", () => {
  it("opens a current store while a separate writer holds an uncommitted transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonical-scale-")); roots.push(root);
    const path = join(root, "canonical.db"); new CanonicalSqliteStore(path).close();
    const writer = new DatabaseSync(path); writer.exec("BEGIN IMMEDIATE;");
    try {
      const reader = new CanonicalSqliteStore(path, { busyTimeoutMs: 25 });
      try { expect(reader.knowledgeCandidates()).toEqual([]); }
      finally { reader.close(); }
    } finally { writer.exec("ROLLBACK;"); writer.close(); }
  });

  it("migrates evidence indexes only through the explicit maintenance option", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonical-scale-upgrade-")); roots.push(root);
    const path = join(root, "canonical.db");
    new CanonicalSqliteStore(path, { migrations: DEFAULT_SQLITE_MIGRATIONS.slice(0, 20) }).close();
    expect(() => new CanonicalSqliteStore(path)).toThrow("requires a verified maintenance upgrade");
    new CanonicalSqliteStore(path, { allowSchemaMigration: true }).close();
    const sql = new DatabaseSync(path, { readOnly: true });
    try {
      const plan = sql.prepare("EXPLAIN QUERY PLAN SELECT safe_envelope_json FROM raw_events WHERE parse_status='supported' AND session_id=? AND event_type='tool.started' AND event_timestamp>=? AND event_timestamp<=?").all("session", at(0), at(9));
      expect(JSON.stringify(plan)).toContain("raw_events_session_type");
    } finally { sql.close(); }
  });

  it("does not materialize unrelated results but retains later counterevidence and its ancestors", () => {
    const store = new CanonicalSqliteStore(":memory:");
    const source = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "source", sessionId: "session",
      repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo", timestamp: at(0), eventType: "prompt.submitted", trust: "user",
      content: { message: "Run the repository checks." } });
    try {
      add(store, source);
      for (let i = 1; i <= 1000; i++) add(store, createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1",
        sourceEventId: "noise-" + i, sessionId: "session", repoId: "repo", worktree: "C:/repo", timestamp: at(i), eventType: "tool.completed", trust: "tool" }));
      expect(store.knowledgeAdmissionEvidence([candidate([source.event.eventId])]).envelopes.map(item => item.event.eventId))
        .toEqual([source.event.eventId]);
      const parent = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "late-parent", sessionId: "session",
        repoId: "repo", worktree: "C:/repo", timestamp: at(1001), eventType: "test.completed", completionStatus: "failed", trust: "tool", parentEventId: source.event.eventId });
      const failure = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "late-failure", sessionId: "session",
        repoId: "repo", worktree: "C:/repo", timestamp: at(1002), eventType: "test.completed", completionStatus: "failed", trust: "tool", parentEventId: parent.event.eventId });
      add(store, parent); add(store, failure);
      expect(store.knowledgeAdmissionEvidence([candidate([source.event.eventId])]).envelopes.map(item => item.event.eventId))
        .toEqual([source.event.eventId, parent.event.eventId, failure.event.eventId]);
    } finally { store.close(); }
  });

  it.each(["utc", "offset", "fraction"])("keeps competing retries and late failure checks with %s source timestamps", (timeFormat) => {
    const store = new CanonicalSqliteStore(":memory:");
    const body = { schemaVersion: 1 as const, serverName: "files", toolName: "read", version: "1", sourceSchemaDigest: sha256({ type: "object" }), requiredArguments: ["path"], absolutePathArguments: [] };
    const contract = { ...body, digest: sha256(body) };
    const event = (id: string, second: number, patch: Partial<Parameters<typeof createCaptureEnvelope>[0]>) => createCaptureEnvelope({
      adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: id, timestamp: at(second), sessionId: "session", repoId: "repo",
      repositoryState: "known_repo", worktree: "C:/repo", eventType: "tool.started", trust: "tool", toolName: "files-read",
      mcp: { serverName: "files", toolName: "read", contractDigest: contract.digest }, ...patch,
    });
    const failed = event("start", 0, { operationId: "first", content: { toolArguments: {} } });
    const failure = event("failure", 1, { eventType: "tool.failed", operationId: "first", parentEventId: failed.event.eventId, completionStatus: "failed",
      mcp: { serverName: "files", toolName: "read", contractDigest: contract.digest, isError: true, failureArgument: "path" } });
    const user = event("user", 2, { eventType: "prompt.submitted", trust: "user", parentEventId: failure.event.eventId, content: { message: "Always supply path." } });
    const retry = event("retry", 4, { operationId: "second", parentEventId: user.event.eventId, content: { toolArguments: { path: "README.md" } } });
    const complete = event("complete", 5, { eventType: "tool.completed", operationId: "second", parentEventId: retry.event.eventId, completionStatus: "succeeded",
      mcp: { serverName: "files", toolName: "read", contractDigest: contract.digest, isError: false } });
    const events: CaptureEnvelope[] = JSON.parse(JSON.stringify([failed, failure, user, retry, complete].map((entry, index) => ({
      ...entry, event: { ...entry.event, timestamp: timeFormat === "offset"
        ? entry.event.timestamp.replace("T00:", "T08:").replace("Z", "+08:00")
        : timeFormat === "fraction" && index % 2 === 0 ? entry.event.timestamp.replace(".000Z", "Z") : entry.event.timestamp },
    }))));
    const proposal: RuleProposal = { schemaVersion: 1, proposalId: "proposal", jobId: "job", knowledgeId: "learning-knowledge-proof", createdAt: at(2), expiresAt: at(10000),
      rule: "Always supply path.", trigger: "Reading files", exclusions: [], userSource: { eventId: user.event.eventId, quote: "Always supply path." },
      predicate: { kind: "required_argument", serverName: "files", toolName: "read", argument: "path", contractDigest: contract.digest },
      failedOperationEventId: failed.event.eventId, retryOperationEventId: retry.event.eventId, completionEventId: complete.event.eventId,
      sourceDigests: events.map(entry => ({ eventId: entry.event.eventId, digest: sha256(entry) })),
    };
    try {
      for (const entry of events) add(store, entry);
      const receipt = verifyMcpRecovery(proposal, events, [contract], new Date(at(9)));
      expect(receipt).toBeDefined();
      const window = buildLearningWindows(events, new Date(at(9)))[0];
      if (!window) throw new Error("Expected learning window.");
      const knowledge = learningKnowledgeCandidate(window, proposal, receipt);
      const verify = () => verifyMcpRecovery(proposal, store.knowledgeAdmissionEvidence([knowledge]).envelopes, [contract], new Date(at(9)));
      expect(store.knowledgeAdmissionEvidence([knowledge]).envelopes).toEqual(events);
      expect(verify()).toBeDefined();
      add(store, event("peer", 3, { operationId: "competitor", parentEventId: user.event.eventId, content: { toolArguments: { path: "package.json" } } }));
      expect(verify()).toBeUndefined();
      const lateFailure = event("late-failure", 20, { eventType: "tool.failed", operationId: "second", parentEventId: retry.event.eventId, completionStatus: "failed" });
      add(store, lateFailure);
      expect(store.knowledgeAdmissionEvidence([knowledge]).envelopes.map(entry => entry.event.eventId)).toContain(lateFailure.event.eventId);
    } finally { store.close(); }
  });

  it("retains counterevidence in a session discovered through an ancestor", () => {
    const store = new CanonicalSqliteStore(":memory:");
    const event = (id: string, second: number, patch: Partial<Parameters<typeof createCaptureEnvelope>[0]>) => createCaptureEnvelope({
      adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: id, sessionId: "source-session",
      repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo", timestamp: at(second),
      eventType: "tool.started", trust: "tool", ...patch,
    });
    const ancestor = event("ancestor", 0, { sessionId: "ancestor-session", eventType: "agent.message", trust: "model" });
    const source = event("source", 1, { parentEventId: ancestor.event.eventId });
    const counter = event("counter", 2, { sessionId: "ancestor-session", eventType: "test.completed",
      completionStatus: "failed", parentEventId: source.event.eventId });
    try {
      for (const entry of [ancestor, source, counter]) add(store, entry);
      const knowledge = candidate([source.event.eventId]);
      const selected = store.knowledgeAdmissionEvidence([knowledge]).envelopes;
      const expected = directKnowledgeCounterevidence([ancestor, source, counter], new Set(knowledge.sourceEvidenceIds), knowledge.createdAt);
      expect(expected.map((item) => item.event.eventId)).toEqual([counter.event.eventId]);
      expect(directKnowledgeCounterevidence(selected, new Set(knowledge.sourceEvidenceIds), knowledge.createdAt)).toEqual(expected);
    } finally { store.close(); }
  });
});
