import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureQueueItemSchema, type LearningJob, type RuleProposal } from "@provenloop/contracts";
import { createCaptureEnvelope, sha256 } from "@provenloop/domain";
import { KnowledgeControlService } from "@provenloop/host";
import { CanonicalSqliteStore, DatabaseSync, readInspection } from "@provenloop/storage-sqlite";
import { beginUpgradeMaintenance, resolveWindowsProvenLoopPaths } from "@provenloop/platform-windows";
import { runCli } from "@provenloop/cli";
import { createDefaultCopilotAdapterState, SpawnCommandRunner, writeCopilotAdapterState } from "@provenloop/copilot-adapter";
import { startUiServer, type UiServer } from "../../packages/cli/src/run-ui.js";

const directories: string[] = [];
const servers: UiServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0)) {
    assert(resolve(directory).startsWith(resolve(process.cwd()) + "\\") || resolve(directory).startsWith(resolve(process.cwd()) + "/"));
    await rm(directory, { recursive: true, force: true });
  }
});

const timestamp = "2026-09-08T08:00:00.000Z";
const fixture = async (eventCount = 1) => {
  const root = await mkdtemp(join(process.cwd(), ".ui-test-")); directories.push(root);
  const paths = resolveWindowsProvenLoopPaths(root);
  await mkdir(paths.data, { recursive: true });
  await writeFile(paths.rootMarker, "{}");
  const store = new CanonicalSqliteStore(paths.database);
  let knowledgeId: string;
  let sourceId = "";
  let sourceKey = "";
  try {
    const service = new KnowledgeControlService({ store, projection: { acquireLease: async () => ({ release: async () => undefined }), rebuild: async () => undefined } });
    const remembered = await service.remember({ content: "Run package scripts <script>alert(1)</script>", appliesWhen: ["Running tests"], scope: "repository", scopeId: "repo-ui" });
    assert(remembered.candidate); knowledgeId = remembered.candidate.knowledgeId;
    for (let index = 0; index < eventCount; index++) {
      const envelope = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: `source-ui-${index}`,
        eventType: "tool.completed", sessionId: "session-ui", repoId: "repo-ui", worktree: "C:\\project", timestamp, trust: "tool",
        content: { message: "Captured <img src=x onerror=alert(1)> evidence" } });
      const queue = captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `queue-ui-${index}`, state: "pending", attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope });
      expect(store.ingestQueueItem(queue).status).toBe("stored");
      sourceId = envelope.event.eventId; sourceKey = envelope.deduplicationKey;
    }
    const source = store.rawEvent(sourceKey); assert(source);
    expect(store.enrichRawEvent({ envelope: { ...source.envelope, content: { ...source.envelope.content, toolResult: "Retained enrichment" } }, sourceDigest: "a".repeat(64) }).status).toBe("enriched");
    store.appendContextUseRecord({ schemaVersion: 1, requestId: "request-ui", createdAt: timestamp, sessionId: "session-ui",
      candidateKnowledgeIds: [knowledgeId], returnedKnowledgeIds: [`knowledge:${knowledgeId}`], appliedKnowledgeIds: [], latencyMs: 12, renderedTokens: 25, retrievalStatus: "provided" });
  } finally { store.close(); }
  const database = new DatabaseSync(paths.database);
  try {
    const job: LearningJob = { schemaVersion: 1, jobId: "job-ui", windowId: "window-ui", revision: "b".repeat(64), state: "waiting_evidence", attempts: 1, createdAt: timestamp, updatedAt: timestamp, expiresAt: "2026-10-01T00:00:00.000Z", extractorVersion: "fixture", result: "candidate" };
    database.prepare("INSERT INTO learning_jobs VALUES (?,?,?,?,?,?,?,?)").run(job.jobId, job.windowId, job.revision, job.state, JSON.stringify(job), "{}", timestamp, timestamp);
  } finally { database.close(); }
  return { root, paths, knowledgeId, sourceId, sourceKey };
};

const serve = async (root: string): Promise<UiServer> => { const server = await startUiServer({ dataRoot: root }); servers.push(server); return server; };
const getText = async (url: string) => { const response = await fetch(url); return { status: response.status, body: await response.text(), headers: response.headers }; };

describe("local read-only learning explorer", () => {
  it("explains quality rejections even when extraction retains no proposal", async () => {
    const data = await fixture(); const database = new DatabaseSync(data.paths.database);
    try {
      const stored = database.prepare("SELECT body_json FROM learning_jobs WHERE job_id='job-ui'").get(); assert(stored);
      const job: LearningJob = { ...JSON.parse(String(stored.body_json)), state: "evaluated", result: "no_rule",
        distillation: { proposed: 2, accepted: 0, rejected: 2, reasons: ["Repeats the transcript without a future action.", "The source does not support this scope."] } };
      database.prepare("UPDATE learning_jobs SET state=?,body_json=? WHERE job_id='job-ui'").run(job.state, JSON.stringify(job));
    } finally { database.close(); }
    const server = await serve(data.root); const page = await getText(server.url + "jobs/job-ui");
    expect(page.status).toBe(200);
    expect(page.body).toContain("Quality review");
    expect(page.body).toContain("Rejected by quality review</dt><dd>2</dd>");
    expect(page.body).toContain("Accepted for evidence checks</dt><dd>0</dd>");
    expect(page.body).toContain("Repeats the transcript without a future action.");
    expect(page.body).toContain("Accepted proposals still need evidence checks before delivery.");
  });

  it("explains preparation failures and the separate legacy recovery allowance", async () => {
    const data = await fixture();
    const database = new DatabaseSync(data.paths.database);
    try {
      const stored = database.prepare("SELECT body_json FROM learning_jobs WHERE job_id='job-ui'").get(); assert(stored);
      const job: LearningJob = { ...JSON.parse(String(stored.body_json)), state: "failed", attempts: 3, failureKind: "input_too_large", preflightFailures: 1,
        inputBudgetRecovery: { previousAttempts: 3, fromExtractorVersion: "old-extractor", grantedAt: timestamp, retryDispatched: false } };
      database.prepare("UPDATE learning_jobs SET state=?,body_json=? WHERE job_id='job-ui'").run(job.state, JSON.stringify(job));
    } finally { database.close(); }
    const server = await serve(data.root);
    const page = await getText(server.url + "jobs/job-ui");
    expect(page.status).toBe(200);
    expect(page.body).toContain("No model request was sent for this preparation failure");
    expect(page.body).toContain("3 historical attempt(s)");
    expect(page.body).toContain("One recovery request is available");
    expect(page.body).toContain("Not paused");
    expect(page.body).toContain("Not scheduled");
  });
  it("reads records without creating a missing database or rewriting canonical data", async () => {
    const data = await fixture();
    const before = await readFile(data.paths.database);
    const key = await readFile(`${data.paths.database}.deletion.key`);
    const filenames = await readdir(data.paths.data);
    const summary = readInspection(data.paths.database, (reader) => ({ overview: reader.summary(), knowledge: reader.knowledge(data.knowledgeId) }));
    expect(summary.overview.counts.knowledge).toBe(1);
    expect(summary.overview.usage).toMatchObject({ provided: 1, adopted: 0 });
    expect(summary.knowledge?.candidate.content).toContain("Run package scripts");
    expect(await readFile(data.paths.database)).toEqual(before);
    expect(await readFile(`${data.paths.database}.deletion.key`)).toEqual(key);
    // SQLite can create empty WAL/shared-memory sidecars even on a read-only connection.
    expect((await readdir(data.paths.data)).filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm"))).toEqual(filenames);
    expect(() => readInspection(join(data.root, "missing.db"), () => undefined)).toThrow("No ProvenLoop database");
    expect(await readdir(data.root)).not.toContain("missing.db");
  });

  it("paginates and filters evidence without returning captured content in list rows", async () => {
    const data = await fixture(43);
    readInspection(data.paths.database, (reader) => {
      expect(reader.list("events").rows).toHaveLength(40);
      expect(reader.list("events", { page: 2, session: "session-ui" }).rows).toHaveLength(3);
      expect(JSON.stringify(reader.list("events"))).not.toContain("Captured <img");
      expect(reader.list("events", { session: "other" }).total).toBe(0);
      expect(reader.list("knowledge", { query: "package", scope: "repository", state: "active" }).total).toBe(1);
      expect(reader.list("knowledge", { query: "' OR 1=1 --" }).total).toBe(0);
      expect(() => reader.list("events", { page: -1 })).toThrow("Invalid page");
    });
  });

  it("renders navigable records with escaped evidence and verified enrichments", async () => {
    const data = await fixture();
    const server = await serve(data.root);
    for (const route of ["", "knowledge", "events", "jobs", "usage", "episodes", `knowledge/${data.knowledgeId}`, "jobs/job-ui"]) {
      const page = await getText(server.url + route); expect(page.status, page.body).toBe(200);
    }
    const knowledge = await getText(`${server.url}knowledge/${data.knowledgeId}`);
    expect(knowledge.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(knowledge.body).not.toContain("<script>");
    const event = await getText(`${server.url}events/${data.sourceId}`);
    expect(event.status).toBe(200); expect(event.body).toContain("Retained enrichment");
    expect(event.body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(event.headers.get("cache-control")).toBe("no-store");
    expect(event.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect((await getText(`${server.url}events/missing`)).status).toBe(404);
    const css = await getText(`${server.url}style.css`); expect(css.status).toBe(200); expect(css.headers.get("content-type")).toContain("text/css");
  });

  it("shows proposal source quotations and leaves unverified findings as candidates", async () => {
    const data = await fixture();
    const proposal: RuleProposal = { schemaVersion: 1, proposalId: "proposal-ui", jobId: "job-ui", knowledgeId: data.knowledgeId,
      rule: "Use the package script", trigger: "Running tests", exclusions: ["Other repository"],
      userSource: { eventId: data.sourceId, quote: "Use the package script" }, sourceDigests: [{ eventId: data.sourceId, digest: "c".repeat(64) }],
      createdAt: timestamp, expiresAt: "2026-10-01T00:00:00.000Z" };
    const database = new DatabaseSync(data.paths.database);
    try { database.prepare("INSERT INTO learning_proposals VALUES (?,?,?,?,NULL)").run(proposal.proposalId, proposal.jobId, proposal.knowledgeId, JSON.stringify(proposal)); } finally { database.close(); }
    const server = await serve(data.root);
    const detail = await getText(`${server.url}jobs/job-ui`);
    expect(detail.body).toContain("Source quotation"); expect(detail.body).toContain("No supported recovery receipt");
    expect(detail.body).toContain(`events/${data.sourceId}`);
  });

  it("distinguishes a model-reviewed summary from externally verified guidance", async () => {
    const data = await fixture();
    const proposal: RuleProposal = { schemaVersion: 1, proposalId: "proposal-reviewed-ui", jobId: "job-ui", knowledgeId: data.knowledgeId,
      rule: "Use the package test script from the repository root", trigger: "Running tests", exclusions: ["Other repository"],
      userSource: { eventId: data.sourceId, quote: "Use the package script" }, sourceDigests: [{ eventId: data.sourceId, digest: "c".repeat(64) }],
      createdAt: timestamp, expiresAt: "2026-10-01T00:00:00.000Z",
      distillation: { schemaVersion: 1, inputDigest: "d".repeat(64), reviewDigest: "e".repeat(64), comparisonBasis: "provided_material",
        criteria: { supported: true, scoped: true, reusable: true, actionable: true, concise: true, nonredundant: true },
        rationale: "Connects the repository constraint to the next test run.", reviewedAt: timestamp,
        reviewer: { provider: "fixture", model: "fixture", version: "1" } } };
    const database = new DatabaseSync(data.paths.database);
    try { database.prepare("INSERT INTO learning_proposals VALUES (?,?,?,?,NULL)").run(proposal.proposalId, proposal.jobId, proposal.knowledgeId, JSON.stringify(proposal)); } finally { database.close(); }
    const server = await serve(data.root);
    const page = await getText(server.url + "knowledge/" + data.knowledgeId);
    expect(page.status).toBe(200);
    expect(page.body).toContain("Model-reviewed lesson; not external verification.");
    expect(page.body).toContain("Connects the repository constraint to the next test run.");
    expect(page.body).toContain("No supported recovery receipt");
    expect(page.body).toContain("It does not compare all stored knowledge or project instructions.");
  });

  it("redacts historical secret values in both prose and expandable records", async () => {
    const data = await fixture();
    const secret = "not-a-real-test-secret";
    const database = new DatabaseSync(data.paths.database);
    try { database.prepare("UPDATE knowledge_candidates SET body_json = json_set(body_json, '$.content', ?)").run(`password=${secret}`); } finally { database.close(); }
    const server = await serve(data.root);
    for (const route of ["knowledge", `knowledge/${data.knowledgeId}`]) {
      const page = await getText(server.url + route); expect(page.status).toBe(200);
      expect(page.body).not.toContain(secret); expect(page.body).toContain("[REDACTED]");
    }
  });

  it("shows effective learning defaults and explicit opt-out rather than a missing consent flag", async () => {
    const data = await fixture(); const initial = createDefaultCopilotAdapterState(new Date());
    const state = { ...initial, installed: true, capabilities: { ...initial.capabilities, capture: { enabled: true }, worker: { enabled: true }, correction_learning: { enabled: true } } };
    await writeCopilotAdapterState(data.paths.adapterState, state);
    const server = await serve(data.root);
    expect((await getText(server.url)).body).toContain("automatic learning: on (automatic)");
    await writeCopilotAdapterState(data.paths.adapterState, { ...state, automaticLearning: { enabled: false, notificationsEnabled: true } });
    expect((await getText(server.url)).body).toContain("automatic learning: off (explicitly_disabled)");
  });

  it("shows repository hook blockers before users mistake enabled extraction for automatic reuse", async () => {
    const data = await fixture(); const initial = createDefaultCopilotAdapterState(new Date());
    await writeCopilotAdapterState(data.paths.adapterState, { ...initial, installed: true, pluginInstalled: true, pluginEnabled: true,
      detectedCopilotVersion: "1.0.84-1", capabilities: { ...initial.capabilities, capture: { enabled: true },
        worker: { enabled: true }, correction_learning: { enabled: true }, retrieval: { enabled: true } } });
    const copilotHome = join(data.root, "copilot"); await mkdir(copilotHome); vi.stubEnv("COPILOT_HOME", copilotHome);
    vi.spyOn(SpawnCommandRunner.prototype, "run").mockResolvedValue({ exitCode: 0, stdout: data.root, stderr: "" });
    const server = await serve(data.root);
    const blocked = await getText(server.url);
    expect(blocked.status).toBe(200);
    expect(blocked.body).toContain("Ready for this repository?");
    expect(blocked.body).toContain("repository hook approval missing");
    expect(blocked.body).toContain("approve-hooks --cwd");
    expect(blocked.body).toContain("Restart Copilot");
    expect(blocked.body).toContain("Not verified by this check");
    await writeFile(join(copilotHome, "permissions-config.json"), JSON.stringify({ locations: { [data.root]: {
      tool_approvals: [{ kind: "extension-permission-access", extensionName: "plugin:provenloop:event-capture" }],
    } } }));
    const approved = await getText(server.url);
    expect(approved.status).toBe(200);
    expect(approved.body).toContain("configured for next session");
    expect(approved.body).not.toContain("approve-hooks --cwd");
    expect(approved.body).toContain("Not verified by this check");
    expect(approved.body).toContain("With guidance provided");
    expect(approved.body).toContain("With explicit adoption");
  });

  it("rejects unauthenticated, cross-origin, and mutating requests", async () => {
    const data = await fixture(); const server = await serve(data.root); const origin = new URL(server.url).origin;
    expect((await fetch(origin)).status).toBe(404);
    expect((await fetch(server.url, { method: "POST" })).status).toBe(405);
    expect((await fetch(server.url, { headers: { origin: "https://foreign.example" } })).status).toBe(403);
    expect((await fetch(server.url, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    const badHost = await new Promise<number | undefined>((resolveResponse, reject) => {
      const req = request(server.url, { headers: { host: "foreign.example" } }, (res) => { res.resume(); res.on("end", () => resolveResponse(res.statusCode)); });
      req.on("error", reject); req.end();
    });
    expect(badHost).toBe(403);
    const head = await fetch(server.url, { method: "HEAD" }); expect(head.status).toBe(200); expect(await head.text()).toBe("");
  });

  it("blocks browsing during deletion and does not serve cached deleted records", async () => {
    const data = await fixture(); const server = await serve(data.root);
    const path = `${server.url}knowledge/${data.knowledgeId}`; expect((await getText(path)).status).toBe(200);
    const store = new CanonicalSqliteStore(data.paths.database);
    try { store.beginDeletion({ targetType: "knowledge", targetId: data.knowledgeId }, "ui-deletion"); } finally { store.close(); }
    const unavailable = await getText(path); expect(unavailable.status).toBe(503); expect(unavailable.body).not.toContain("Run package scripts");
    expect(unavailable.body).toContain("deletion is pending");
  });

  it("rejects a changed identity, restore, incompatible schema, and upgrade maintenance", async () => {
    const data = await fixture(); const server = await serve(data.root);
    const maintenance = await beginUpgradeMaintenance(data.root);
    try { const page = await getText(server.url); expect(page.status).toBe(503); expect(page.body).toContain("upgrade is in progress"); } finally { await maintenance.release(); }
    await writeFile(`${data.paths.database}.restore.lock`, "fixture");
    expect(() => readInspection(data.paths.database, (reader) => reader.summary())).toThrow("restored or replaced");
    await rm(`${data.paths.database}.restore.lock`);
    await writeFile(`${data.paths.database}.deletion.key`, "invalid");
    expect(() => readInspection(data.paths.database, (reader) => reader.summary())).toThrow("missing or malformed");
    await writeFile(`${data.paths.database}.deletion.key`, "d".repeat(64));
    const database = new DatabaseSync(data.paths.database);
    try { database.exec("PRAGMA user_version = 999;"); } finally { database.close(); }
    expect(() => readInspection(data.paths.database, (reader) => reader.summary())).toThrow("schema 999");
  });

  it("detects tampered enriched evidence instead of displaying it", async () => {
    const data = await fixture(); const database = new DatabaseSync(data.paths.database);
    try { database.prepare("UPDATE raw_event_enrichments SET original_digest = ?").run(sha256("unrelated")); } finally { database.close(); }
    expect(() => readInspection(data.paths.database, (reader) => reader.event(data.sourceId))).toThrow("does not match");
  });

  it("reports missing data without inventing empty success and validates CLI options", async () => {
    const root = await mkdtemp(join(process.cwd(), ".ui-empty-")); directories.push(root);
    const server = await serve(root); const page = await getText(server.url); expect(page.status).toBe(503); expect(page.body).toContain("No ProvenLoop installation");
    for (const args of [["--port", "65536"], ["--port", "-1"], ["--host", "0.0.0.0"], ["--port"], ["--no-open", "--no-open"]]) {
      const errors: string[] = [];
      expect(await runCli(["ui", ...args], { log: () => undefined, error: (message) => { errors.push(message); } })).toBe(2);
      expect(errors[0]).toContain("provenloop ui");
    }
  });
});
