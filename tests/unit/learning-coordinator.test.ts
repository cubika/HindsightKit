import { describe, expect, it, vi } from "vitest";
import { captureQueueItemSchema } from "@provenloop/contracts";
import { createCaptureEnvelope, redactCaptureEnvelopeForPersistence, sha256, buildLearningWindows, type CaptureEventInput } from "@provenloop/domain";
import { LearningCoordinator } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const base = Date.parse("2026-09-07T00:00:00.000Z");
const now = () => new Date(base + 10_000);
const fixture = () => {
  const store = new CanonicalSqliteStore(":memory:");
  const events = [
    { id: "fail-start", type: "tool.started", trust: "tool" as const },
    { id: "fail-result", type: "tool.failed", trust: "tool" as const },
    { id: "user", type: "prompt.submitted", trust: "user" as const, message: "这个工具需要 path 参数，请补上再试。" },
    { id: "retry", type: "tool.started", trust: "tool" as const },
    { id: "result", type: "tool.completed", trust: "tool" as const },
  ];
  for (const [index, event] of events.entries()) {
    const timestamp = new Date(base + index * 1_000).toISOString();
    const envelope = redactCaptureEnvelopeForPersistence(createCaptureEnvelope({
      adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: event.id,
      sessionId: "session", repoId: "repo", worktree: "C:\repo", repositoryState: "known_repo",
      eventType: event.type, timestamp, trust: event.trust, ...(event.message ? { content: { message: event.message } } : {}),
    })).envelope;
    store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `queue-${index}`, state: "pending", attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope }));
  }
  const captured = store.episodeSourceEnvelopes();
  let calls = 0;
  const provider = { identity: { provider: "test", model: "test", version: "1" }, infer: async () => {
    calls += 1;
    return { schemaVersion: 1, proposals: [{ rule: "Supply the path argument.", trigger: "Call the path tool", exclusions: ["Other tools"],
      userSource: { eventId: captured[2]?.event.eventId, quote: "需要 path 参数" },
      failedOperationEventId: captured[0]?.event.eventId, retryOperationEventId: captured[3]?.event.eventId, completionEventId: captured[4]?.event.eventId }] };
  } };
  const options = { store, provider, lease: { tryAcquire: async () => ({ release: async () => undefined }) }, enabled: async () => true, now };
  return { store, options, calls: () => calls, captured };
};

describe("automatic learning coordinator", () => {
  it("does not charge deterministic preparation failures or retry the same extractor", async () => {
    const f = fixture();
    const reserve = vi.spyOn(f.store, "reserveLearningAttempt");
    const prepare = vi.fn(() => { throw Object.assign(new Error("The bounded input cannot fit."), { code: "input_too_large", permanent: true }); });
    const provider = { ...f.options.provider, prepare };
    try {
      const coordinator = new LearningCoordinator({ ...f.options, provider });
      expect(await coordinator.run()).toMatchObject({ status: "failed", reason: "input_too_large" });
      expect(f.store.learningJobs()[0]).toMatchObject({ state: "failed", failureKind: "input_too_large", attempts: 0, preflightFailures: 1 });
      expect(await coordinator.run()).toMatchObject({ status: "idle" });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(reserve).not.toHaveBeenCalled(); expect(f.calls()).toBe(0);
      expect(await new LearningCoordinator({ ...f.options, provider: {
        ...f.options.provider, identity: { ...provider.identity, version: "2" }, prepare: () => undefined,
      } }).run()).toMatchObject({ status: "evaluated" });
      expect(f.store.learningJobs()[0]).toMatchObject({ attempts: 1, preflightFailures: 1 });
      expect(reserve).toHaveBeenCalledTimes(1); expect(f.calls()).toBe(1);
    } finally { f.store.close(); }
  });

  it.each(["Learning window exceeds the inference budget.", "Error: Learning window exceeds the inference budget."])("grants one audited recovery dispatch for exhausted legacy failure: %s", async (error) => {
    const f = fixture();
    const window = buildLearningWindows(f.captured, now())[0];
    if (!window) throw new Error("Expected a learning window.");
    const job = f.store.scheduleLearningWindow(window, new Date(base + 30 * 86_400_000).toISOString(), now());
    if (!job) throw new Error("Expected a learning job.");
    f.store.transitionLearningJob({ ...job, state: "failed", attempts: 3, extractorVersion: "correction-extractor-1/legacy", error }, "pending");
    let calls = 0;
    const provider = { ...f.options.provider, identity: { ...f.options.provider.identity, version: "2" }, prepare: () => undefined, infer: async () => {
      calls += 1; throw new Error("Malformed provider output.");
    } };
    try {
      expect(await new LearningCoordinator({ ...f.options, provider }).run()).toMatchObject({ status: "failed" });
      expect(f.store.learningJobs()[0]).toMatchObject({ attempts: 3, inputBudgetRecovery: {
        fromExtractorVersion: "correction-extractor-1/legacy", previousAttempts: 3, retryDispatched: true,
      } });
      expect(f.store.learningJobs()[0]?.expiresAt).toBe(job.expiresAt);
      expect(await new LearningCoordinator({ ...f.options, provider }).run()).toMatchObject({ status: "idle" });
      expect(await new LearningCoordinator({ ...f.options, provider: { ...provider, identity: { ...provider.identity, version: "3" } } }).run()).toMatchObject({ status: "idle" });
      expect(calls).toBe(1);
    } finally { f.store.close(); }
  });

  it("keeps legacy recovery available when preparation fails and when the daily budget is full", async () => {
    const f = fixture(); const window = buildLearningWindows(f.captured, now())[0];
    if (!window) throw new Error("Expected a learning window.");
    const job = f.store.scheduleLearningWindow(window, new Date(base + 30 * 86_400_000).toISOString(), now());
    if (!job) throw new Error("Expected a learning job.");
    f.store.transitionLearningJob({ ...job, state: "failed", attempts: 3, extractorVersion: "legacy", error: "Learning window exceeds the inference budget." }, "pending");
    let time = now();
    try {
      const failure = { ...f.options.provider, prepare: () => { throw Object.assign(new Error("Still oversized."), { code: "input_too_large", permanent: true }); } };
      expect(await new LearningCoordinator({ ...f.options, provider: failure }).run()).toMatchObject({ reason: "input_too_large" });
      expect(f.store.learningJobs()[0]?.inputBudgetRecovery?.retryDispatched).toBe(false);
      f.store.reserveLearningAttempt(time, 1);
      const provider = { ...f.options.provider, prepare: () => undefined, identity: { ...f.options.provider.identity, version: "2" } };
      const coordinator = new LearningCoordinator({ ...f.options, provider, dailyLimit: 1, now: () => time });
      expect(await coordinator.run()).toMatchObject({ reason: "daily_budget" });
      expect(f.store.learningJobs()[0]?.inputBudgetRecovery?.retryDispatched).toBe(false);
      time = new Date(base + 86_400_000);
      expect(await coordinator.run()).toMatchObject({ status: "evaluated" });
      expect(f.store.learningJobs()[0]).toMatchObject({ attempts: 3, preflightFailures: 1, inputBudgetRecovery: { retryDispatched: true } });
      expect(f.calls()).toBe(1);
    } finally { f.store.close(); }
  });

  it("does not spend the recovery allowance when cancellation arrives before calling the provider", async () => {
    const f = fixture(); const window = buildLearningWindows(f.captured, now())[0];
    if (!window) throw new Error("Expected a learning window.");
    const job = f.store.scheduleLearningWindow(window, new Date(base + 30 * 86_400_000).toISOString(), now());
    if (!job) throw new Error("Expected a learning job.");
    f.store.transitionLearningJob({ ...job, state: "failed", attempts: 3, extractorVersion: "legacy", error: "Learning window exceeds the inference budget." }, "pending");
    const stopped = new AbortController();
    try {
      const cancelled = new LearningCoordinator({ ...f.options, signal: stopped.signal,
        provider: { ...f.options.provider, prepare: () => { stopped.abort(); } },
      });
      expect(await cancelled.run()).toMatchObject({ status: "cancelled" });
      expect(f.calls()).toBe(0);
      expect(f.store.learningJobs()[0]).toMatchObject({ state: "paused", attempts: 3, pauseReason: "host_stopped", inputBudgetRecovery: { retryDispatched: false } });
      expect(await new LearningCoordinator({ ...f.options, provider: { ...f.options.provider, prepare: () => undefined } }).run()).toMatchObject({ status: "evaluated" });
      expect(f.calls()).toBe(1);
      expect(f.store.learningJobs()[0]?.inputBudgetRecovery?.retryDispatched).toBe(true);
    } finally { f.store.close(); }
  });

  it("counts a synchronous provider throw as a called recovery attempt", async () => {
    const f = fixture(); const window = buildLearningWindows(f.captured, now())[0];
    if (!window) throw new Error("Expected a learning window.");
    const job = f.store.scheduleLearningWindow(window, new Date(base + 30 * 86_400_000).toISOString(), now());
    if (!job) throw new Error("Expected a learning job.");
    f.store.transitionLearningJob({ ...job, state: "failed", attempts: 3, extractorVersion: "legacy", error: "Learning window exceeds the inference budget." }, "pending");
    let calls = 0;
    try {
      const coordinator = new LearningCoordinator({ ...f.options, provider: {
        ...f.options.provider, prepare: () => undefined,
        infer: () => { calls += 1; throw new Error("Synchronous provider failure."); },
      } });
      expect(await coordinator.run()).toMatchObject({ status: "failed" });
      expect(f.store.learningJobs()[0]?.inputBudgetRecovery?.retryDispatched).toBe(true);
      expect(await coordinator.run()).toMatchObject({ status: "idle" });
      expect(calls).toBe(1);
    } finally { f.store.close(); }
  });

  it.each(["archived", "cancelled", "superseded", "other_error", "same_extractor", "expired"])("does not recover ineligible legacy failure: %s", async (scenario) => {
    const f = fixture(); const window = buildLearningWindows(f.captured, now())[0];
    if (!window) throw new Error("Expected a learning window.");
    const job = f.store.scheduleLearningWindow(window, new Date(base + 30 * 86_400_000).toISOString(), now());
    if (!job) throw new Error("Expected a learning job.");
    const state = scenario === "archived" || scenario === "cancelled" || scenario === "superseded" ? scenario : "failed";
    f.store.transitionLearningJob({ ...job, state, attempts: 3, extractorVersion: scenario === "same_extractor" ? "correction-extractor-1/2" : "legacy",
      error: scenario === "other_error" ? "Provider output invalid." : "Learning window exceeds the inference budget.",
      ...(scenario === "expired" ? { expiresAt: new Date(base).toISOString() } : {}),
    }, "pending");
    try {
      expect(f.store.recoverLearningInputFailures("correction-extractor-1/2", now())).toBe(0);
      expect(f.store.learningJobs()[0]?.inputBudgetRecovery).toBeUndefined();
    } finally { f.store.close(); }
  });

  it("does not recover changed sources or a failed job with existing extracted records", async () => {
    const f = fixture();
    try {
      await new LearningCoordinator(f.options).run();
      const job = f.store.learningJobs()[0];
      if (!job) throw new Error("Expected a completed learning job.");
      f.store.transitionLearningJob({ ...job, state: "failed", attempts: 3, extractorVersion: "legacy", error: "Learning window exceeds the inference budget." }, job.state);
      expect(f.store.recoverLearningInputFailures("correction-extractor-1/2", now())).toBe(0);
      expect(f.store.learningProposals()).toHaveLength(1);
    } finally { f.store.close(); }

    const changed = fixture();
    try {
      const window = buildLearningWindows(changed.captured, now())[0];
      if (!window) throw new Error("Expected a learning window.");
      const job = changed.store.scheduleLearningWindow(window, new Date(base + 30 * 86_400_000).toISOString(), now());
      if (!job) throw new Error("Expected a learning job.");
      changed.store.transitionLearningJob({ ...job, state: "failed", attempts: 3, extractorVersion: "legacy", error: "Learning window exceeds the inference budget." }, "pending");
      const source = changed.captured[4];
      if (!source) throw new Error("Expected a result source.");
      expect(changed.store.enrichRawEvent({ envelope: { ...source, content: { message: "Newly captured result details." } }, sourceDigest: "e".repeat(64) })).toMatchObject({ status: "enriched" });
      expect(changed.store.recoverLearningInputFailures("correction-extractor-1/2", now())).toBe(0);
      expect(changed.store.learningJobs()[0]?.inputBudgetRecovery).toBeUndefined();
    } finally { changed.store.close(); }
  });

  it("carries the consumed legacy allowance into a new revision without resetting its attempts", async () => {
    const f = fixture(); const window = buildLearningWindows(f.captured, now())[0];
    if (!window) throw new Error("Expected a learning window.");
    const job = f.store.scheduleLearningWindow(window, new Date(base + 30 * 86_400_000).toISOString(), now());
    if (!job) throw new Error("Expected a learning job.");
    f.store.transitionLearningJob({ ...job, state: "failed", attempts: 3, extractorVersion: "legacy", error: "Learning window exceeds the inference budget." }, "pending");
    let calls = 0;
    try {
      const provider = { ...f.options.provider, prepare: () => undefined, infer: async () => { calls += 1; throw new Error("Malformed output."); } };
      await new LearningCoordinator({ ...f.options, provider }).run();
      const source = f.captured[4];
      if (!source) throw new Error("Expected a result source.");
      f.store.enrichRawEvent({ envelope: { ...source, content: { message: "Enriched result details." } }, sourceDigest: "f".repeat(64) });
      const revised = buildLearningWindows(f.store.episodeSourceEnvelopes(), now()).find((entry) => entry.windowId === window.windowId);
      if (!revised) throw new Error("Expected an enriched window.");
      const next = f.store.scheduleLearningWindow(revised, new Date(base + 60 * 86_400_000).toISOString(), now());
      expect(next).toMatchObject({ attempts: 3, expiresAt: job.expiresAt, inputBudgetRecovery: { retryDispatched: true } });
      expect((await new LearningCoordinator({ ...f.options, provider }).run()).status).toBe("idle");
      expect(calls).toBe(1);
    } finally { f.store.close(); }
  });

  it("retains the inference lease until cancelled provider cleanup settles", async () => {
    const f=fixture();const stopped=new AbortController();let release=false;let finish:()=>void=()=>undefined;let started:()=>void=()=>undefined;
    const entered=new Promise<void>((resolve)=>{started=resolve;});
    try {
      const running=new LearningCoordinator({...f.options,signal:stopped.signal,lease:{tryAcquire:async()=>({release:async()=>{release=true;}})},provider:{...f.options.provider,infer:async()=>{started();await new Promise<void>((resolve)=>{finish=resolve;});return {schemaVersion:1,proposals:[]};}}}).run();
      await entered;stopped.abort();await new Promise<void>((resolve)=>setImmediate(resolve));expect(release).toBe(false);
      finish();expect(await running).toMatchObject({status:"cancelled"});expect(release).toBe(true);
    } finally {f.store.close();}
  });
  it("cancels a running provider on host shutdown without committing its response", async () => {
    const f = fixture();
    const stopped = new AbortController();
    let aborted = false;
    try {
      const coordinator = new LearningCoordinator({ ...f.options, signal: stopped.signal, provider: { ...f.options.provider, infer: async (_window, options) => {
        options.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        stopped.abort();
        return f.options.provider.infer();
      } } });
      expect(await coordinator.run()).toMatchObject({ status: "cancelled" });
      expect(aborted).toBe(true);
      expect(f.store.learningJobs()[0]).toMatchObject({ state: "paused", attempts: 0, pauseReason: "host_stopped" });
      expect(f.store.learningProposals()).toEqual([]);
      expect(f.store.knowledgeCandidates()).toEqual([]);
      expect((await coordinator.run()).status).toBe("disabled");
      expect(f.calls()).toBe(1);
      expect(await new LearningCoordinator(f.options).run()).toMatchObject({ status: "evaluated", proposals: 1 });
      expect(f.calls()).toBe(2);
    } finally { f.store.close(); }
  });
  it("bounds correction windows to the actual failed operation and retry completion", () => {
    const f = fixture();
    try {
      const source = f.captured[0];
      const completion = f.captured[4];
      if (!source || !completion) throw new Error("Missing fixture sources.");
      const relevant = f.captured.map((entry, index) => index <= 1 ? { ...entry, event: { ...entry.event, operationId: "failed-operation" } } : entry);
      const earlier = { ...source, sourceEventId: "unrelated-user", event: { ...source.event, eventId: "earlier-user", eventType: "prompt.submitted", trust: "user" as const, timestamp: new Date(base - 1000).toISOString() }, content: { message: "A separate request" } };
      const tail = { ...completion, sourceEventId: "tail", event: { ...completion.event, eventId: "tail", eventType: "agent.message", trust: "model" as const, timestamp: new Date(base + 5000).toISOString() }, content: { message: "Large unrelated response ".repeat(2000) } };
      const windows = buildLearningWindows([earlier, ...relevant, tail], now());
      const selected = windows.find((window) => window.createdAt === f.captured[2]?.event.timestamp);
      expect(selected?.events.map((entry) => entry.event.eventId)).toEqual(relevant.map((entry) => entry.event.eventId));
      expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThan(30 * 1024);
    } finally { f.store.close(); }
  });
  it("resumes after consent is disabled during extraction without accepting the stale output", async () => {
    const f = fixture(); let enabled = true;
    try {
      expect(await new LearningCoordinator({ ...f.options, enabled: async () => enabled, provider: { ...f.options.provider, infer: async () => {
        enabled = false; return f.options.provider.infer();
      } } }).run()).toMatchObject({ status: "disabled" });
      expect(f.store.learningJobs()[0]).toMatchObject({ state: "paused", attempts: 0, pauseReason: "learning_disabled" });
      expect(f.store.knowledgeCandidates()).toEqual([]);
      enabled = true;
      expect(await new LearningCoordinator({ ...f.options, enabled: async () => enabled }).run()).toMatchObject({ status: "evaluated" });
    } finally { f.store.close(); }
  });

  it.each(["signed_out", "rate_limited", "unavailable"] as const)("pauses %s without exhausting extraction retries and still charges every dispatch", async (code) => {
    const f = fixture(); let time = now(); let unavailable = true; let calls = 0;
    const provider = { ...f.options.provider, infer: async () => {
      calls += 1;
      if (unavailable) throw Object.assign(new Error(`Provider ${code}.`), { code });
      return f.options.provider.infer();
    } };
    const coordinator = new LearningCoordinator({ ...f.options, provider, now: () => time, dailyLimit: 4 });
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect(await coordinator.run()).toMatchObject({ status: "paused", reason: code });
        const job = f.store.learningJobs()[0];
        expect(job).toMatchObject({ state: "paused", attempts: 0, pauseReason: code });
        expect(await coordinator.run()).toMatchObject({ status: "idle" });
        expect(calls).toBe(attempt + 1);
        time = new Date(job?.retryAfter ?? "");
      }
      unavailable = false;
      expect(await coordinator.run()).toMatchObject({ status: "paused", reason: "daily_budget" });
      expect(calls).toBe(4);
      time = new Date(base + 86_400_000);
      expect(await coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1 });
      expect(f.store.learningJobs()[0]?.attempts).toBe(1);
      expect(calls).toBe(5);
    } finally { f.store.close(); }
  });

  it("refuses a result that arrives after the original candidate expiry", async () => {
    const f = fixture(); let time = now();
    try {
      const result = await new LearningCoordinator({ ...f.options, now: () => time, candidateDays: 1, provider: { ...f.options.provider, infer: async () => {
        const response = await f.options.provider.infer(); time = new Date(base + 2 * 86_400_000); return response;
      } } }).run();
      expect(result).toMatchObject({ status: "cancelled", reason: "expired" });
      expect(f.store.learningJobs()[0]?.state).toBe("archived");
      expect(f.store.learningProposals()).toEqual([]);
      expect(f.store.knowledgeCandidates()).toEqual([]);
    } finally { f.store.close(); }
  });
  it("purges sibling derived rules when deleting their shared learning job", async () => {
    const f = fixture();
    try {
      const infer = f.options.provider.infer;
      await new LearningCoordinator({ ...f.options, provider: { ...f.options.provider, infer: async () => {
        const response = await infer();
        const first = response.proposals[0];
        if (!first) throw new Error("Missing fixture proposal.");
        return { ...response, proposals: [first, { ...first, rule: "Check the file path before calling.", trigger: "Read another file" }] };
      } } }).run();
      const candidates = f.store.knowledgeCandidates();
      expect(candidates).toHaveLength(2);
      const target = { targetType: "knowledge" as const, targetId: candidates[0]?.knowledgeId ?? "missing" };
      const deletion = f.store.beginDeletion(target);
      const removed = f.store.deleteCanonicalTarget(deletion.deletionId, target);
      expect(f.store.learningJobs()).toEqual([]);
      expect(f.store.learningProposals()).toEqual([]);
      expect(f.store.knowledgeCandidates()).toEqual([]);
      expect(removed.dependentIds).toEqual(expect.arrayContaining(candidates.map((candidate) => `knowledge:${candidate.knowledgeId}`)));
      expect(f.store.rawEvents()).toHaveLength(5);
    } finally { f.store.close(); }
  });
  it.each(["late_contract", "enrichment", "enrichment_revoked", "archived", "expired", "deleted", "revoked"] as const)("reevaluates without inference and respects %s", async (scenario) => {
    const store = new CanonicalSqliteStore(":memory:");
    const contractBody = { schemaVersion: 1 as const, serverName: "files", toolName: "read", version: "1", sourceSchemaDigest: sha256({ required: ["path"] }), requiredArguments: ["path"], absolutePathArguments: [] };
    const contract = { ...contractBody, digest: sha256(contractBody) };
    const mcp = { serverName: "files", toolName: "read", contractDigest: contract.digest };
    const captured: ReturnType<typeof createCaptureEnvelope>[] = [];
    const add = (extra: Partial<CaptureEventInput>) => {
      const index = captured.length;
      const envelope = redactCaptureEnvelopeForPersistence(createCaptureEnvelope({
        adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: `late-${index}`, sessionId: "late-session",
        repoId: "repo", worktree: "C:\repo", repositoryState: "known_repo", eventType: "tool.started", trust: "tool",
        timestamp: new Date(base + index * 1000).toISOString(), toolName: "files-read", mcp,
        ...(captured.at(-1) ? { parentEventId: captured.at(-1)?.event.eventId } : {}), ...extra,
      })).envelope;
      captured.push(envelope);
      store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `late-queue-${index}`, state: "pending", attemptCount: 0, failureCount: 0, createdAt: envelope.event.timestamp, updatedAt: envelope.event.timestamp, envelope }));
      return envelope;
    };
    const failed = add({ operationId: "failed", content: { toolArguments: {} } });
    add({ eventType: "tool.failed", operationId: "failed", completionStatus: "failed", mcp: { ...mcp, isError: true, failureArgument: "path" } });
    const user = add({ eventType: "prompt.submitted", trust: "user", content: { message: "Always include the path argument." } });
    const retry = add({ operationId: "retry", content: { toolArguments: { path: "README.md" } } });
    const completed = add({ eventType: "tool.completed", operationId: "retry", completionStatus: "succeeded", mcp: { ...mcp, isError: false } });
    let calls = 0; let available = false;
    let time = now();
    const coordinator = new LearningCoordinator({ store, now: () => time, enabled: async () => true,
      contracts: () => available ? [contract] : [], lease: { tryAcquire: async () => ({ release: async () => undefined }) },
      provider: { identity: { provider: "fixture", model: "fixture", version: "1" }, infer: async () => { calls += 1; return { schemaVersion: 1, proposals: [{
        rule: "Supply path.", trigger: "Read files", exclusions: ["Other tools"], userSource: { eventId: user.event.eventId, quote: "Always include the path argument." },
        failedOperationEventId: failed.event.eventId, retryOperationEventId: retry.event.eventId, completionEventId: completed.event.eventId,
        predicate: { kind: "required_argument", serverName: "files", toolName: "read", argument: "path", contractDigest: contract.digest },
      }] }; } },
    });
    try {
      expect(await coordinator.run()).toMatchObject({ status: "evaluated", qualified: 0 });
      const candidate = store.knowledgeCandidates()[0];
      if (!candidate) throw new Error("Expected a waiting candidate.");
      const proposal = store.learningProposals()[0];
      const job = store.learningJobs()[0];
      if (scenario === "archived") store.upsertKnowledgeCandidates([{ ...candidate, state: "archived" }]);
      if (scenario === "revoked" || scenario === "enrichment_revoked") store.recordKnowledgeFeedback({ event: { schemaVersion: 1, feedbackId: "revoked-late-contract", kind: "revoke", source: "user", targetType: "knowledge", targetId: candidate.knowledgeId, evidenceRef: "real-user-revocation", timestamp: new Date(base + 6000).toISOString() } });
      if (scenario.startsWith("enrichment")) {
        expect(store.enrichRawEvent({ envelope: { ...completed, content: { message: "Recovered result body." } }, sourceDigest: "f".repeat(64) })).toMatchObject({ status: "enriched" });
      }
      if (scenario === "expired") time = new Date(base + 31 * 86_400_000);
      if (scenario === "deleted") {
        const target = { targetType: "knowledge" as const, targetId: candidate.knowledgeId };
        const deletion = store.beginDeletion(target); store.deleteCanonicalTarget(deletion.deletionId, target);
      }
      available = true;
      let result = await coordinator.run();
      if (scenario === "enrichment") result = await coordinator.run();
      expect(calls).toBe(1);
      if (scenario === "late_contract" || scenario === "enrichment") {
        expect(result).toMatchObject({ status: "evaluated", qualified: 1 });
        expect(store.knowledgeCandidates()[0]).toMatchObject({ state: "active", evidenceTier: "externally_verified", createdAt: candidate.createdAt, sourceEvidenceIds: candidate.sourceEvidenceIds });
        if (scenario === "late_contract") expect(store.learningProposals()).toEqual([proposal]);
        else expect(store.learningProposals()).toHaveLength(2);
        expect(store.learningJobs().find((entry) => entry.state === "evaluated")).toMatchObject({ attempts: job?.attempts, expiresAt: job?.expiresAt, state: "evaluated" });
        expect(store.learningReceipts()).toHaveLength(1);
        expect((await coordinator.run()).status).toBe("idle");
        expect(store.learningReceipts()).toHaveLength(1);
      } else {
        expect(store.knowledgeCandidates().some((entry) => entry.state === "active")).toBe(false);
        expect(store.learningReceipts()).toEqual([]);
      }
    } finally { store.close(); }
  });
  it("analyzes an ordinary source once, retains a candidate and preserves raw provenance", async () => {
    const f = fixture();
    try {
      const before = f.store.rawEvents();
      expect(await new LearningCoordinator(f.options).run()).toMatchObject({ status: "evaluated", proposals: 1, qualified: 0 });
      expect(f.store.learningJobs()[0]?.state).toBe("evaluated");
      expect(f.store.knowledgeCandidates()[0]).toMatchObject({ state: "candidate", evidenceTier: "inferred" });
      expect(f.store.rawEvents()).toEqual(before);
      expect(await new LearningCoordinator(f.options).run()).toMatchObject({ status: "idle" });
      expect(f.calls()).toBe(1);
    } finally { f.store.close(); }
  });

  it("finishes legacy waiting jobs with no typed verification to wait for", async () => {
    const f = fixture();
    try {
      await new LearningCoordinator(f.options).run();
      const job = f.store.learningJobs()[0];
      if (!job) throw new Error("Expected a persisted job.");
      f.store.transitionLearningJob({ ...job, state: "waiting_evidence" }, job.state);
      expect((await new LearningCoordinator(f.options).run()).status).toBe("idle");
      expect(f.store.learningJobs()[0]?.state).toBe("evaluated");
      expect(f.store.knowledgeCandidates()[0]?.state).toBe("candidate");
      expect(f.calls()).toBe(1);
    } finally { f.store.close(); }
  });

  it("does not commit an in-flight response after source deletion", async () => {
    const f = fixture();
    try {
      const original = f.options.provider.infer;
      const result = await new LearningCoordinator({ ...f.options, provider: { ...f.options.provider, infer: async () => {
        const response = await original();
        const target = { targetType: "source" as const, targetId: f.captured[2]?.event.eventId ?? "missing" };
        const deletion = f.store.beginDeletion(target);
        f.store.deleteCanonicalTarget(deletion.deletionId, target);
        return response;
      } } }).run();
      expect(result.status).toBe("cancelled");
      expect(f.store.learningJobs()).toEqual([]);
      expect(f.store.learningProposals()).toEqual([]);
      expect(f.store.knowledgeCandidates()).toEqual([]);
    } finally { f.store.close(); }
  });

  it("charges malformed inference attempts and stops at three", async () => {
    const f = fixture();
    try {
      const coordinator = new LearningCoordinator({ ...f.options, provider: { ...f.options.provider, infer: async () => ({ schemaVersion: 1, proposals: [{ rule: "invented" }] }) } });
      for (let i = 0; i < 3; i += 1) expect((await coordinator.run()).status).toBe("failed");
      expect((await coordinator.run()).status).toBe("idle");
      expect(f.store.learningJobs()[0]?.attempts).toBe(3);
      expect(f.store.learningProposals()).toEqual([]);
    } finally { f.store.close(); }
  });

  it("retries extraction that points at a failure result rather than its operation start", async () => {
    const f = fixture();
    try {
      const infer = f.options.provider.infer;
      const coordinator = new LearningCoordinator({ ...f.options, provider: { ...f.options.provider, infer: async () => {
        const response = await infer();
        return { ...response, proposals: response.proposals.map((proposal) => ({ ...proposal, failedOperationEventId: f.captured[1]?.event.eventId })) };
      } } });
      expect((await coordinator.run()).status).toBe("failed");
      expect(f.store.learningProposals()).toEqual([]);
      expect(f.store.knowledgeCandidates()).toEqual([]);
      expect((await new LearningCoordinator(f.options).run()).status).toBe("evaluated");
      expect(f.calls()).toBe(2);
      expect(f.store.learningJobs()[0]?.attempts).toBe(2);
    } finally { f.store.close(); }
  });

  it("treats zero proposals as no-rule, honors disabled learning and bounds settings", async () => {
    const f = fixture();
    try {
      expect((await new LearningCoordinator({ ...f.options, enabled: async () => false }).run()).status).toBe("disabled");
      expect(f.calls()).toBe(0);
      expect(() => new LearningCoordinator({ ...f.options, dailyLimit: -1 })).toThrow();
      expect(await new LearningCoordinator({ ...f.options, provider: { ...f.options.provider, infer: async () => ({ schemaVersion: 1, proposals: [] }) } }).run()).toMatchObject({ status: "evaluated", proposals: 0 });
      expect(f.store.learningJobs()[0]?.result).toBe("no_rule");
    } finally { f.store.close(); }
  });
});
