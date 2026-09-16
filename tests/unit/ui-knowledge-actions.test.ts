import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureQueueItemSchema, type KnowledgeCandidate, type RuleProposal } from "@provenloop/contracts";
import { assessLearningRetention, createCaptureEnvelope, learningSourceUse, redactCaptureEnvelopeForPersistence, sha256 } from "@provenloop/domain";
import { KnowledgeControlService } from "@provenloop/host";
import { resolveWindowsProvenLoopPaths } from "@provenloop/platform-windows";
import { SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";
import { CanonicalSqliteStore, DatabaseSync, readInspection } from "@provenloop/storage-sqlite";
import { startUiServer, type UiServer } from "../../packages/cli/src/run-ui.js";

const roots: string[] = []; const servers: UiServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) { assert(resolve(root).startsWith(resolve(process.cwd()) + "/") || resolve(root).startsWith(resolve(process.cwd()) + "\\")); await rm(root, { recursive: true, force: true }); }
});
const fixture = async () => {
  const root = await mkdtemp(join(process.cwd(), ".ui-actions-test-")); roots.push(root);
  const paths = resolveWindowsProvenLoopPaths(root); await mkdir(paths.data, { recursive: true }); await writeFile(paths.rootMarker, "{}");
  const store = new CanonicalSqliteStore(paths.database); let candidate: KnowledgeCandidate;
  try {
    const remembered = await new KnowledgeControlService({ store, projection: { acquireLease: async () => ({ release: async () => undefined }), rebuild: async () => undefined } }).remember({ content: "Run focused tests after code changes.", appliesWhen: ["Changing this repository."], scope: "repository", scopeId: "C:\\repos\\example\\.git" });
    assert(remembered.candidate); candidate = { ...remembered.candidate, state: "candidate", evidenceTier: "inferred", evidenceMarks: [] };
    store.upsertKnowledgeCandidates([candidate]);
    const timestamp = new Date().toISOString();
    const envelope = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "source-ui-action", eventType: "prompt.submitted", sessionId: "session-ui-action", repoId: "C:\\repos\\example\\.git", timestamp, trust: "user", content: { message: "Run focused tests after code changes." } });
    store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: "queue-ui-action", state: "pending", attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope }));
  } finally { store.close(); }
  const server = await startUiServer({ dataRoot: root }); servers.push(server);
  return { root, paths, candidate, server };
};
const controls = async (server: UiServer, id: string) => {
  const response = await fetch(`${server.url}knowledge/${id}`); const html = await response.text(); expect(response.status, html).toBe(200);
  const csrf = html.match(/name="csrf" value="([a-f0-9]{64})"/u)?.[1];
  const expectedDigest = html.match(/name="expectedDigest" value="([a-f0-9]{64})"/u)?.[1]; assert(csrf && expectedDigest);
  return { html, csrf, expectedDigest };
};
const post = (server: UiServer, id: string, form: URLSearchParams, headers: Record<string, string> = {}) => fetch(`${server.url}knowledge/${id}/actions`, { method: "POST", redirect: "manual", headers: { origin: new URL(server.url).origin, "sec-fetch-site": "same-origin", ...headers }, body: form });
const formFor = async (server: UiServer, id: string, action: string) => { const { csrf, expectedDigest } = await controls(server, id); return new URLSearchParams({ csrf, expectedDigest, action, confirmed: action }); };

describe("reviewed knowledge actions in the local UI", () => {
  it("adopts a candidate as user confirmed and updates the actual search projection", async () => {
    const { candidate, paths, server } = await fixture();
    const response = await post(server, candidate.knowledgeId, await formFor(server, candidate.knowledgeId, "confirm"));
    expect(response.status, await response.text()).toBe(303);
    const target = new URL(response.headers.get("location") ?? "", server.url); const newId = target.pathname.split("/").at(-1); assert(newId);
    expect(newId).not.toBe(candidate.knowledgeId);
    readInspection(paths.database, (reader) => {
      expect(reader.knowledge(candidate.knowledgeId)?.candidate.state).toBe("superseded");
      expect(reader.knowledge(newId)?.candidate).toMatchObject({ state: "active", evidenceTier: "user_confirmed", evidenceMarks: ["user_confirmed"], sourceEvidenceIds: [] });
      expect(reader.list("knowledge").total).toBe(1);
      expect(reader.list("knowledge", { state: "all" }).total).toBe(2);
      expect(reader.list("knowledge", { state: "superseded" }).total).toBe(1);
    });
    const backend = new SqliteFtsKnowledgeBackend(paths.knowledgeDatabase); try { expect(await backend.get(newId)).toMatchObject({ knowledgeId: newId }); } finally { await backend.closeAsync(); }
    expect((await fetch(target)).status).toBe(200);
  });

  it("saves edited content and explicit repository scope as a distinct confirmed replacement", async () => {
    const { candidate, paths, server } = await fixture(); const form = await formFor(server, candidate.knowledgeId, "replace");
    for (const [key, value] of Object.entries({ content: "Use package test scripts.", appliesWhen: "Changing code.\nBefore review.", nonApplicability: "Generated files.", replacementScope: "repository", replacementScopeId: "repo-target" })) form.set(key, value);
    const response = await post(server, candidate.knowledgeId, form); expect(response.status, await response.text()).toBe(303);
    const id = new URL(response.headers.get("location") ?? "", server.url).pathname.split("/").at(-1); assert(id);
    readInspection(paths.database, (reader) => expect(reader.knowledge(id)?.candidate).toMatchObject({ content: "Use package test scripts.", appliesWhen: ["Changing code.", "Before review."], scopeId: "repo-target", evidenceTier: "user_confirmed" }));
  });

  it("archives through review feedback and permanently deletes only after the typed confirmation", async () => {
    const { candidate, paths, server } = await fixture();
    expect((await post(server, candidate.knowledgeId, await formFor(server, candidate.knowledgeId, "revoke"))).status).toBe(303);
    readInspection(paths.database, (reader) => { const item = reader.knowledge(candidate.knowledgeId); expect(item?.candidate.state).toBe("archived"); expect(item?.feedback[0]?.kind).toBe("revoke"); });
    const form = await formFor(server, candidate.knowledgeId, "delete");
    expect((await post(server, candidate.knowledgeId, form)).status).toBe(400);
    form.set("deleteId", candidate.knowledgeId);
    const response = await post(server, candidate.knowledgeId, form); expect(response.status, await response.text()).toBe(303);
    readInspection(paths.database, (reader) => { expect(reader.knowledge(candidate.knowledgeId)).toBeUndefined(); expect(reader.summary().counts.events).toBe(1); });
    expect((await fetch(`${server.url}knowledge/${candidate.knowledgeId}`)).status).toBe(404);
    const backend = new SqliteFtsKnowledgeBackend(paths.knowledgeDatabase); try { expect(await backend.get(candidate.knowledgeId)).toBeUndefined(); } finally { await backend.closeAsync(); }
  });

  it("requires current digest, explicit action confirmation and acknowledgements for counterevidence", async () => {
    const { candidate, paths, server } = await fixture(); const stale = await formFor(server, candidate.knowledgeId, "confirm");
    const store = new CanonicalSqliteStore(paths.database);
    try { await new KnowledgeControlService({ store, projection: { acquireLease: async () => ({ release: async () => undefined }), rebuild: async () => undefined } }).correct({ knowledgeId: candidate.knowledgeId, reason: "This rule needs review." }); } finally { store.close(); }
    expect((await post(server, candidate.knowledgeId, stale)).status).toBe(409);
    const page = await controls(server, candidate.knowledgeId); expect(page.html).toContain("Unresolved counterevidence");
    const form = new URLSearchParams({ csrf: page.csrf, expectedDigest: page.expectedDigest, action: "confirm" });
    expect((await post(server, candidate.knowledgeId, form)).status).toBe(400); form.set("confirmed", "confirm");
    expect((await post(server, candidate.knowledgeId, form)).status).toBe(409);
    const id = readInspection(paths.database, (reader) => reader.knowledge(candidate.knowledgeId)?.unresolvedEvidenceIds[0]); assert(id); form.append("resolve", id);
    expect((await post(server, candidate.knowledgeId, form)).status).toBe(303);
  });

  it("rejects missing or foreign origin, bad CSRF, duplicate fields and oversized bodies without changing data", async () => {
    const { candidate, paths, server } = await fixture(); const form = await formFor(server, candidate.knowledgeId, "confirm");
    const before = await readFile(paths.database);
    expect((await fetch(`${server.url}knowledge/${candidate.knowledgeId}/actions`, { method: "POST", body: form })).status).toBe(403);
    expect((await post(server, candidate.knowledgeId, form, { origin: "https://foreign.example" })).status).toBe(403);
    expect((await post(server, candidate.knowledgeId, form, { "sec-fetch-site": "same-site" })).status).toBe(403);
    const invalid = new URLSearchParams(form); invalid.set("csrf", "a".repeat(64)); expect((await post(server, candidate.knowledgeId, invalid)).status).toBe(403);
    const duplicate = new URLSearchParams(form); duplicate.append("action", "delete"); expect((await post(server, candidate.knowledgeId, duplicate)).status).toBe(400);
    const oversized = new URLSearchParams(form); oversized.set("content", "x".repeat(33_000)); expect((await post(server, candidate.knowledgeId, oversized)).status).toBe(413);
    expect((await fetch(`${server.url}knowledge/${candidate.knowledgeId}/actions?${form.toString()}`)).status).toBe(404);
    expect(await readFile(paths.database)).toEqual(before);
    expect(readInspection(paths.database, (reader) => reader.knowledge(candidate.knowledgeId)?.expectedDigest)).toBe(sha256(candidate));
  });

  it("distinguishes cumulative capture counts and ingestion growth from queue backlog in the selected root", async () => {
    const { paths, server } = await fixture();
    const summary = readInspection(paths.database, (reader) => reader.summary());
    expect(summary.growth).toMatchObject({ lastDay: 1, lastWeek: 1, sessions: 1, deliveries: 1 });
    expect(summary.eventTypes).toEqual([{ label: "prompt.submitted", count: 1 }]);
    expect(summary.adapterVersions).toEqual([{ label: "1.0.84-1", count: 1 }]);
    const html = await (await fetch(server.url)).text();
    for (const label of ["Captured events · cumulative", "New events in last 24 hours", "Capture queue backlog", "Canonical database and sidecars (bytes)", "Event types", paths.root]) expect(html).toContain(label);
    const knowledge = await controls(server, (readInspection(paths.database, (reader) => reader.list("knowledge").rows)[0] as KnowledgeCandidate).knowledgeId);
    expect(knowledge.html).toContain("does not claim external verification");
  });

  it("shows sourced conventions as qualified candidates without claiming external verification", async () => {
    const { candidate, paths, server } = await fixture();
    const timestamp = new Date().toISOString();
    const sourceInput = redactCaptureEnvelopeForPersistence(createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "lasting-convention", eventType: "prompt.submitted", sessionId: "session-lasting", repoId: candidate.scopeId, worktree: "C:/repos/example", repositoryState: "known_repo", timestamp, trust: "user", content: { message: "Always run focused tests for future changes in this repository." } })).envelope;
    const source = JSON.parse(JSON.stringify(sourceInput)) as typeof sourceInput;
    const updated = { ...candidate, content: source.content?.message ?? "", nonApplicability: ["Other repositories."], sourceEvidenceIds: [source.event.eventId], createdAt: timestamp };
    const proposal: RuleProposal = { schemaVersion: 1, proposalId: "proposal-lasting", jobId: "job-lasting", knowledgeId: candidate.knowledgeId, rule: updated.content, trigger: candidate.appliesWhen[0] ?? "Changing code.", exclusions: updated.nonApplicability, userSource: { eventId: source.event.eventId, quote: updated.content }, supportingSources: [{ eventId: source.event.eventId, quote: updated.content }], sourceDigests: [{ eventId: source.event.eventId, digest: sha256(source) }], createdAt: timestamp, expiresAt: "2099-01-01T00:00:00.000Z", retention: { kind: "convention", lifetime: "durable", rationale: "Explicit convention for future changes.", futureUse: "Future edits in this repository.", targetRepository: { status: "captured", repoId: candidate.scopeId } } };
    const store = new CanonicalSqliteStore(paths.database);
    try { store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: "queue-lasting", state: "pending", attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope: source })); store.upsertKnowledgeCandidates([updated]); } finally { store.close(); }
    const database = new DatabaseSync(paths.database); try {
      const job = { schemaVersion: 1, jobId: proposal.jobId, windowId: "window-lasting", revision: "b".repeat(64), state: "waiting_evidence", attempts: 1, createdAt: timestamp, updatedAt: timestamp, expiresAt: proposal.expiresAt, extractorVersion: "fixture", result: "candidate" };
      database.prepare("INSERT INTO learning_jobs VALUES (?,?,?,?,?,?,?,?)").run(job.jobId, job.windowId, job.revision, job.state, JSON.stringify(job), "{}", timestamp, timestamp);
      database.prepare("INSERT INTO learning_proposals VALUES (?,?,?,?,NULL)").run(proposal.proposalId, proposal.jobId, proposal.knowledgeId, JSON.stringify(proposal));
    } finally { database.close(); }
    const detail = readInspection(paths.database, (reader) => reader.knowledge(candidate.knowledgeId));
    expect(assessLearningRetention(proposal, [source], { repoId: candidate.scopeId ?? "", worktree: "C:/repos/example" })).toMatchObject({ retain: true, reusable: true });
    expect(learningSourceUse(updated, [proposal], [source])).toBeDefined();
    const persisted = readInspection(paths.database, (reader) => reader.event(source.event.eventId));
    expect(persisted?.envelope).toEqual(source);
    expect(sha256(persisted?.envelope)).toBe(sha256(source));
    expect(detail?.candidate).toEqual(updated);
    expect(detail?.unresolvedEvidenceIds).toEqual([]);
    expect(detail?.missingEvidenceIds).toEqual([]);
    expect(detail?.proposals[0]?.proposal).toEqual(proposal);
    expect(detail?.availableAs).toMatchObject({ mode: "convention", worktree: "C:/repos/example" });
    const html = (await controls(server, candidate.knowledgeId)).html;
    expect(html).toContain("qualify this candidate as a convention"); expect(html).toContain("Retention assessment");
    expect((await fetch(`${server.url}events/${source.event.eventId}`)).status).toBe(200);
  });

  it("suggests similar rules only in the same scope and leaves their records intact", async () => {
    const { candidate, paths, server } = await fixture(); const store = new CanonicalSqliteStore(paths.database);
    try { store.upsertKnowledgeCandidates([{ ...candidate, knowledgeId: "peer-same", topicKey: "same" }, { ...candidate, knowledgeId: "peer-elsewhere", topicKey: "elsewhere", scopeId: "other-repository" }]); } finally { store.close(); }
    const detail = readInspection(paths.database, (reader) => reader.knowledge(candidate.knowledgeId));
    expect(detail?.similar).toEqual([{ knowledgeId: "peer-same", reason: "same_text" }]);
    const html = (await controls(server, candidate.knowledgeId)).html; expect(html).toContain("Similar rules in this scope"); expect(html).toContain("No rules or evidence have been merged");
    expect(readInspection(paths.database, (reader) => reader.list("knowledge").total)).toBe(3);
  });
});
