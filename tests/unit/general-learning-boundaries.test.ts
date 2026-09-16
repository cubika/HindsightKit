import { describe, expect, it } from "vitest";
import type { CaptureEnvelope, ContextUseRecord, KnowledgeCandidate, LearningRecoveryReceipt, RuleProposal } from "@provenloop/contracts";
import { CopilotEventMapper, CopilotLearningToolRegistry, type CopilotSessionEvent } from "@provenloop/copilot-adapter";
import { buildLearningWindows, conflictingShellLearning, createCaptureEnvelope, KnowledgeAdmissionPolicy, learningKnowledgeCandidate, learningSourceDigest, verifyMcpRecovery, verifyShellRecovery, type CaptureEventInput } from "@provenloop/domain";
import { CanonicalKnowledgeRetriever, knowledgeProjectionFromCandidate, type KnowledgeRetrievalQuery } from "@provenloop/retrieval";
import { learningApplicable } from "../../packages/retrieval/src/learning-applicability.js";
import { captureQueueItemSchema } from "@provenloop/contracts";
import { LearningCoordinator } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const now = new Date("2026-09-08T00:01:00Z");
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 8, 0, 0, seconds)).toISOString();
const sources = (events: readonly CaptureEnvelope[]) => events.map((entry) => ({ eventId: entry.event.eventId, digest: learningSourceDigest(entry) }));
const patch = (events: readonly CaptureEnvelope[], sourceId: string, change: Partial<CaptureEnvelope["event"]>) =>
  events.map((entry) => entry.sourceEventId === sourceId ? { ...entry, event: { ...entry.event, ...change } } : entry);

const mcpFixture = () => {
  const registry = new CopilotLearningToolRegistry();
  const metadata = { name: "reader", mcpServerName: "files", mcpToolName: "read", input_schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } };
  registry.replace([metadata], "1.0.84-1");
  const contract = registry.find(metadata.name);
  if (!contract) throw new Error("Expected an authoritative tool contract");
  const event = (id: string, seconds: number, extra: Partial<CaptureEventInput>) => createCaptureEnvelope({
    adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: id, timestamp: at(seconds),
    eventType: "tool.started", trust: "tool", sessionId: "session", repoId: "repo", repositoryState: "known_repo", worktree: "C:/repo",
    toolName: "reader", mcp: { serverName: "files", toolName: "read", contractDigest: contract.digest }, ...extra,
  });
  const failed = event("failed", 0, { operationId: "first", content: { toolArguments: {} } });
  const failure = event("failure", 1, { eventType: "tool.failed", operationId: "first", parentEventId: failed.event.eventId,
    completionStatus: "failed", mcp: { ...failed.event.mcp, serverName: "files", toolName: "read", isError: true, failureArgument: "path" } });
  const user = event("user", 2, { eventType: "prompt.submitted", trust: "user", parentEventId: failure.event.eventId,
    content: { message: "Supply path. For this request use customer-A.json; exclude archived records and sort by ID." } });
  const retry = event("retry", 3, { operationId: "second", parentEventId: user.event.eventId,
    content: { toolArguments: { path: "customer-A.json" } } });
  const completion = event("completion", 4, { eventType: "tool.completed", operationId: "second", parentEventId: retry.event.eventId,
    completionStatus: "succeeded", mcp: { ...retry.event.mcp, serverName: "files", toolName: "read", isError: false },
    content: { toolResult: { records: [{ archived: true, id: 2 }, { archived: false, id: 1 }] } } });
  const events = [failed, failure, user, retry, completion];
  const proposal: RuleProposal = { schemaVersion: 1, proposalId: "mcp-proposal", knowledgeId: "learning-knowledge-reader", jobId: "job",
    createdAt: user.event.timestamp, expiresAt: "2026-10-08T00:00:00Z", rule: "Always read customer-A.json, exclude archived records and sort by ID.",
    trigger: "Read customer records", exclusions: ["Other repositories"], userSource: { eventId: user.event.eventId, quote: user.content?.message ?? "" },
    failedOperationEventId: failed.event.eventId, retryOperationEventId: retry.event.eventId, completionEventId: completion.event.eventId,
    predicate: { kind: "required_argument", serverName: "files", toolName: "read", argument: "path", contractDigest: contract.digest }, sourceDigests: sources(events) };
  return { events, proposal, contract, metadata, registry, event };
};

const shellFixture = (options: { worktree?: string; output?: string; sameCommand?: boolean; cwd?: string; mode?: string; detached?: boolean;
  sessionId?: string; failedCommand?: string; command?: string; commitSha?: string } = {}) => {
  const worktree = options.worktree ?? "C:/repo";
  const toolName = worktree.startsWith("/") ? "bash" : "powershell";
  const failedCommand = options.failedCommand ?? (options.sameCommand ? "npm test" : "pnpm test");
  const command = options.command ?? "npm test";
  const args = (command: string) => ({ command, cwd: options.cwd ?? worktree,
    ...(options.mode ? { mode: options.mode } : {}), ...(options.detached ? { detach: true } : {}) });
  const mapper = new CopilotEventMapper({ adapterVersion: "1.0.84-1", sessionId: options.sessionId ?? "session", copyLimits: { maxStringChars: 16_384 },
    workspace: { cwd: worktree, worktree, repoId: "repo", repositoryState: "known_repo", branch: "main", commitSha: options.commitSha ?? "a".repeat(40) } });
  const native: CopilotSessionEvent[] = [
    { id: "failed", timestamp: at(0), parentId: null, type: "tool.execution_start", data: { toolCallId: "first", toolName, arguments: args(failedCommand) } },
    { id: "failure", timestamp: at(1), parentId: "failed", type: "tool.execution_complete", data: { toolCallId: "first", success: true,
      result: { content: "Native command failed", contents: [{ type: "shell_exit", shellId: "first", cwd: worktree, exitCode: 1 }] } } },
    { id: "user", timestamp: at(2), parentId: "failure", type: "user.message", data: { content: "Run " + command + " instead of " + failedCommand + " for this repository." } },
    { id: "retry", timestamp: at(3), parentId: "user", type: "tool.execution_start", data: { toolCallId: "second", toolName, arguments: args(command) } },
    { id: "completion", timestamp: at(4), parentId: "retry", type: "tool.execution_complete", data: { toolCallId: "second", success: true,
      result: { content: options.output ?? "Native shell completed", contents: [{ type: "shell_exit", shellId: "second", cwd: worktree, exitCode: 0 }] } } },
  ];
  const events = native.flatMap((entry) => {
    const mapped = mapper.map(entry);
    if (mapped.status !== "mapped") throw new Error("Unexpected native mapping: " + entry.type);
    return [mapped.value, ...(mapped.additionalEvents ?? [])].map((value) => createCaptureEnvelope(value));
  });
  const find = (id: string, type: string) => {
    const entry = events.find((item) => item.sourceEventId === id && item.event.eventType === type);
    if (!entry) throw new Error("Missing fixture event " + id + "/" + type);
    return entry;
  };
  const user = find("user", "prompt.submitted");
  const proposal: RuleProposal = { schemaVersion: 1, proposalId: "shell-proposal", knowledgeId: "learning-knowledge-shell", jobId: "shell-job",
    createdAt: user.event.timestamp, expiresAt: "2026-10-08T00:00:00Z", rule: "The original defect is fixed and all tests have run.",
    trigger: "Testing repository", exclusions: ["Other revisions"], userSource: { eventId: user.event.eventId, quote: user.content?.message ?? "" },
    failedOperationEventId: find("failed", "tool.started").event.eventId, retryOperationEventId: find("retry", "tool.started").event.eventId,
    completionEventId: find("completion", "tool.completed").event.eventId,
    shellPredicate: { kind: "repository_test_command", toolName, failedCommand, command }, sourceDigests: sources(events) };
  return { events, proposal };
};

const candidateFor = (events: readonly CaptureEnvelope[], proposal: RuleProposal, receipt?: LearningRecoveryReceipt) => {
  const window = buildLearningWindows(events, now)[0];
  if (!window) throw new Error("Expected a complete learning window");
  return learningKnowledgeCandidate(window, proposal, receipt);
};
const admission = (events: readonly CaptureEnvelope[], proposal: RuleProposal, candidate: KnowledgeCandidate, receipts: LearningRecoveryReceipt[], contextUseRecords: ContextUseRecord[] = []) =>
  new KnowledgeAdmissionPolicy().evaluate({ candidate, envelopes: events, learningProposals: [proposal], learningReceipts: receipts,
    correctionKeys: [], correctionSourceEventIds: new Set(), workEpisodes: [], contextUseRecords });
const retrieve = async (events: readonly CaptureEnvelope[], proposal: RuleProposal, candidate: KnowledgeCandidate, receipts: LearningRecoveryReceipt[], query: KnowledgeRetrievalQuery) => {
  const hit = { ...knowledgeProjectionFromCandidate(candidate), score: 1 };
  return new CanonicalKnowledgeRetriever({ backend: { get: async () => hit, search: async () => [hit],
    index: async () => undefined, rebuild: async () => undefined, remove: async () => undefined,
    health: async () => ({ fts5Available: true, quickCheck: "ok", recordCount: 1, status: "healthy" }) },
  store: { knowledgeCandidates: () => [candidate], knowledgeCandidatesWithUnavailableSources: () => new Set(),
    knowledgeAdmissionEvidence: () => ({ envelopes: events, learningProposals: [proposal], learningReceipts: receipts,
      correctionKeys: [], correctionSourceEventIds: new Set(), workEpisodes: [], contextUseRecords: [], feedbackEvents: [] }) } }).search(query);
};

describe("general learning catalog: proof, trust and scope boundaries", () => {
  it("LIF-03: conflicting shell directions suppress both stored rules even when ranking returns one", async () => {
    const first = shellFixture({ sessionId: "direction-a" });
    const second = shellFixture({ sessionId: "direction-b", failedCommand: "npm test", command: "pnpm test" });
    const fixtures = new Map([["direction-a", first], ["direction-b", second]]);
    const store = new CanonicalSqliteStore(":memory:");
    try {
      const coordinator = new LearningCoordinator({ store, enabled: async () => true, now: () => now,
        lease: { tryAcquire: async () => ({ release: async () => undefined }) }, provider: {
          identity: { provider: "fixture", model: "fixture", version: "1" }, infer: async (window) => {
            const source = fixtures.get(window.sessionId)?.proposal;
            if (!source) throw new Error("Missing independent correction fixture");
            return { schemaVersion: 1, proposals: [{ rule: source.rule, trigger: source.trigger, exclusions: source.exclusions,
              userSource: source.userSource, failedOperationEventId: source.failedOperationEventId, retryOperationEventId: source.retryOperationEventId,
              completionEventId: source.completionEventId, shellPredicate: source.shellPredicate }] };
          },
        } });
      const ingest = (f: ReturnType<typeof shellFixture>) => {
        for (const envelope of f.events) store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1,
          queueItemId: "conflict-" + envelope.event.eventId, state: "pending", attemptCount: 0, failureCount: 0,
          createdAt: envelope.event.timestamp, updatedAt: envelope.event.timestamp, envelope }));
      };
      ingest(first);
      expect(await coordinator.run()).toMatchObject({ status: "evaluated", qualified: 1 });
      const firstRule = store.knowledgeCandidates()[0];
      if (!firstRule) throw new Error("Expected first active rule");
      ingest(second);
      expect(await coordinator.run()).toMatchObject({ status: "evaluated" });
      expect(store.learningReceipts()).toHaveLength(2);
      const candidates = store.knowledgeCandidates();
      expect(candidates).toHaveLength(2);
      expect(new Set(candidates.map((entry) => entry.content)).size).toBe(2);
      for (const candidate of candidates) {
        expect(candidate.state).toBe("disputed");
        expect(candidate.conflictsWith).toEqual(candidates.filter((other) => other.knowledgeId !== candidate.knowledgeId).map((other) => other.knowledgeId));
      }
      const policy = new KnowledgeAdmissionPolicy();
      for (const candidate of candidates) {
        expect(policy.evaluate({ candidate, ...store.knowledgeAdmissionEvidence([candidate]) }).admitted).toBe(false);
        const hit = { ...knowledgeProjectionFromCandidate(candidate), score: 1 };
        const retriever = new CanonicalKnowledgeRetriever({ store, backend: {
          get: async () => hit, search: async () => [hit], index: async () => undefined, rebuild: async () => undefined, remove: async () => undefined,
          health: async () => ({ fts5Available: true, quickCheck: "ok", recordCount: 1, status: "healthy" }),
        } });
        expect(await retriever.search({ now, limit: 3, text: "npm test", repositoryScopeId: "repo",
          shellInvocation: { toolName: "powershell", command: "npm test", cwd: "C:/repo", branch: "main", commitSha: "a".repeat(40) } })).toEqual([]);
      }
    } finally { store.close(); }
  });

  it("LIF-03: detects overlapping destinations symmetrically but preserves disjoint or equivalent shell guidance", () => {
    const a = shellFixture({ sessionId: "conflict-a" });
    const b = shellFixture({ sessionId: "conflict-b", failedCommand: "npm test", command: "pnpm test" });
    const left = verifyShellRecovery(a.proposal, a.events, now);
    const right = verifyShellRecovery(b.proposal, b.events, now);
    if (!left || !right) throw new Error("Expected independently verified shell receipts");
    expect(conflictingShellLearning(left, right)).toBe(true);
    expect(conflictingShellLearning(right, left)).toBe(true);
    expect(conflictingShellLearning(left, { ...right, worktree: "c:\\REPO\\" })).toBe(true);
    expect(conflictingShellLearning(left, { ...right, predicate: { ...right.predicate, failedCommand: "pnpm test", command: "npm run test:unit" } })).toBe(true);
    for (const variant of [
      { ...right, repoId: "different-repo" }, { ...right, branch: "other" }, { ...right, commitSha: "b".repeat(40) },
      { ...right, worktree: "C:/repo/legacy" }, { ...right, predicate: { ...right.predicate, toolName: "bash" as const } },
      { ...right, predicate: { ...right.predicate, failedCommand: "yarn test", command: "npm test" } },
      { ...right, predicate: { ...right.predicate, failedCommand: "npm run test:old", command: "npm run test:new" } },
    ]) expect(conflictingShellLearning(left, variant)).toBe(false);
    expect(conflictingShellLearning({ ...left, worktree: "/repo/Project" }, { ...right, worktree: "/repo/project" })).toBe(false);
  });

  it("INT-06 / SCP-01: renders only the required-argument clause, without copying an example customer or unsupported semantics", async () => {
    const f = mcpFixture();
    const receipt = verifyMcpRecovery(f.proposal, f.events, [f.contract], now);
    expect(receipt?.proves).toBe("invocation_contract");
    const candidate = candidateFor(f.events, f.proposal, receipt);
    expect(candidate.content).toBe("Supply the required path argument when calling files/read.");
    expect(candidate.content).not.toMatch(/customer-A|archived|sort/u);
    const result = await retrieve(f.events, f.proposal, candidate, receipt ? [receipt] : [], { now, limit: 3,
      text: "Read customer-B.json", repositoryScopeId: "repo", toolInvocation: { serverName: "files", toolName: "read", contractDigest: f.contract.digest } });
    expect(result).toHaveLength(1);
    expect(result[0]?.candidate.content).not.toContain("customer-A");
    expect(candidate.nonApplicability.join(" ")).toContain("semantic correctness");
  });

  it("SCP-02 / SCP-05 / SCP-07: refuses another repository, broader scope and changed authoritative contracts before retrieval", async () => {
    const f = mcpFixture(); const receipt = verifyMcpRecovery(f.proposal, f.events, [f.contract], now);
    if (!receipt) throw new Error("Expected MCP proof");
    const candidate = candidateFor(f.events, f.proposal, receipt);
    const query = { now, limit: 3, text: "files read", repositoryScopeId: "repo", toolInvocation: { serverName: "files", toolName: "read", contractDigest: f.contract.digest } };
    expect(await retrieve(f.events, f.proposal, candidate, [receipt], { ...query, repositoryScopeId: "other-repo" })).toEqual([]);
    expect(admission(f.events, f.proposal, { ...candidate, scope: "personal", scopeId: undefined }, [receipt]).reasons).toContain("scope_mismatch");
    for (const change of [{ version: "2" }, { schema: { ...f.metadata.input_schema, required: ["path", "tenant"] } }, { server: "other-files" }]) {
      f.registry.replace([{ ...f.metadata, ...(change.schema ? { input_schema: change.schema } : {}), ...(change.server ? { mcpServerName: change.server } : {}) }], change.version ?? "1.0.84-1");
      const changed = f.registry.find(f.metadata.name);
      if (!changed) throw new Error("Expected changed contract");
      expect(await retrieve(f.events, f.proposal, candidate, [receipt], { ...query,
        toolInvocation: { serverName: changed.serverName, toolName: changed.toolName, contractDigest: changed.digest } })).toEqual([]);
    }
  });

  it("CAU-01 / VER-08: identical arguments after transient or flaky recovery cannot prove a correction", () => {
    const f = mcpFixture();
    const unchanged = patch(f.events, "failed", { redactedArguments: { path: "customer-A.json" } });
    expect(verifyMcpRecovery({ ...f.proposal, sourceDigests: sources(unchanged) }, unchanged, [f.contract], now)).toBeUndefined();
    const shell = shellFixture({ sameCommand: true });
    expect(verifyShellRecovery(shell.proposal, shell.events, now)).toBeUndefined();
  });

  it("CAU-02: changing unrelated arguments cannot isolate the recovered parameter", () => {
    const f = mcpFixture();
    const events = patch(f.events, "retry", { redactedArguments: { path: "customer-A.json", runtime: "new", config: "changed" } });
    expect(verifyMcpRecovery({ ...f.proposal, sourceDigests: sources(events) }, events, [f.contract], now)).toBeUndefined();
  });

  it.each(["different-session", "different-actor", "different-operation"])("CAU-04 / TRU-08: cannot borrow a completion with %s", (variant) => {
    const f = mcpFixture();
    let events = f.events;
    if (variant === "different-actor") events = events.map((entry) => entry.event.trust === "tool" ? { ...entry, event: { ...entry.event, actorId: entry.sourceEventId === "completion" ? "agent-b" : "agent-a" } } : entry);
    else events = patch(events, "completion", variant === "different-session" ? { sessionId: "other-session" } : { operationId: "other-operation" });
    expect(verifyMcpRecovery({ ...f.proposal, sourceDigests: sources(events) }, events, [f.contract], now)).toBeUndefined();
  });

  it("CAU-04: native proof preserves a consistent actor and rejects a borrowed or internal actor", () => {
    const f = shellFixture();
    const consistent = f.events.map((entry) => entry.event.trust === "tool" ? { ...entry, event: { ...entry.event, actorId: "agent-a" } } : entry);
    expect(verifyShellRecovery({ ...f.proposal, sourceDigests: sources(consistent) }, consistent, now)).toBeDefined();
    for (const actorId of ["agent-b", "provenloop-internal"]) {
      const events = patch(consistent, "completion", { actorId });
      expect(verifyShellRecovery({ ...f.proposal, sourceDigests: sources(events) }, events, now)).toBeUndefined();
    }
  });
  it("TRU-07: an entirely internal MCP trace cannot qualify an external rule", () => {
    const f = mcpFixture();
    const events = f.events.map((entry) => entry.event.trust === "tool"
      ? { ...entry, event: { ...entry.event, actorId: "provenloop-internal" } } : entry);
    expect(verifyMcpRecovery({ ...f.proposal, sourceDigests: sources(events) }, events, [f.contract], now)).toBeUndefined();
  });

  it("CAU-07: receiving the rule during its own recovery cannot count as independent evidence", () => {
    const f = mcpFixture(); const receipt = verifyMcpRecovery(f.proposal, f.events, [f.contract], now);
    if (!receipt) throw new Error("Expected MCP proof");
    const candidate = candidateFor(f.events, f.proposal, receipt);
    const record: ContextUseRecord = { schemaVersion: 1, requestId: "context-use", sessionId: "session", repoId: "repo",
      createdAt: at(3), appliedKnowledgeIds: [], candidateKnowledgeIds: [], returnedKnowledgeIds: [candidate.knowledgeId], latencyMs: 1, renderedTokens: 10 };
    expect(admission(f.events, f.proposal, candidate, [receipt], [record]).reasons).toContain("recalled_knowledge_evidence");
  });

  it("CAU-08: linked later failure blocks previously qualified guidance", async () => {
    const f = mcpFixture(); const receipt = verifyMcpRecovery(f.proposal, f.events, [f.contract], now);
    if (!receipt) throw new Error("Expected MCP proof");
    const candidate = candidateFor(f.events, f.proposal, receipt);
    const later = f.event("later-failure", 10, { eventType: "test.completed", completionStatus: "failed", exitCode: 1, parentEventId: f.proposal.completionEventId });
    expect(admission([...f.events, later], f.proposal, candidate, [receipt]).reasons).toContain("unresolved_counterevidence");
    expect(await retrieve([...f.events, later], f.proposal, candidate, [receipt], { now, limit: 3, text: "files read", repositoryScopeId: "repo",
      toolInvocation: { serverName: "files", toolName: "read", contractDigest: f.contract.digest } })).toEqual([]);
  });

  it.each([
    ["VER-01", "No test files found. 0 tests executed."], ["VER-02", "Cached output from yesterday: all tests passed."],
    ["VER-04", "Assertion disabled. No failures."], ["VER-07", "Mock bypassed original behavior. Test passed."],
  ])("%s: native zero exit qualifies only command invocation, never prose asserting defect repair", (_id, output) => {
    const f = shellFixture({ output }); const receipt = verifyShellRecovery(f.proposal, f.events, now);
    expect(receipt?.proves).toBe("repository_test_command");
    const candidate = candidateFor(f.events, f.proposal, receipt);
    expect(candidate.content).toBe("Use npm test instead of pnpm test for this repository's tests at the verified revision.");
    expect(candidate.content).not.toMatch(/defect|coverage|all tests|passed/u);
  });

  it.each([{ mode: "async" }, { detached: true }])("VER-05: asynchronous acceptance %j is insufficient for native completion", (options) => {
    const f = shellFixture(options);
    expect(verifyShellRecovery(f.proposal, f.events, now)).toBeUndefined();
  });

  it.each(["model", "external-content"] as const)("VER-06 / TRU-03 / TRU-04: %s cannot supply user correction or native proof", (trust) => {
    const f = mcpFixture();
    for (const source of ["user", "completion"]) {
      const events = patch(f.events, source, { trust });
      expect(verifyMcpRecovery({ ...f.proposal, sourceDigests: sources(events) }, events, [f.contract], now)).toBeUndefined();
    }
    const shell = shellFixture(); const events = patch(shell.events, "completion", { trust });
    expect(verifyShellRecovery({ ...shell.proposal, sourceDigests: sources(events) }, events, now)).toBeUndefined();
  });

  it("TRU-02: permission refusal lacks parameter-failure authority even after a successful retry", () => {
    const f = mcpFixture();
    const events = patch(f.events, "failure", { mcp: { serverName: "files", toolName: "read", contractDigest: f.contract.digest, isError: true } });
    expect(verifyMcpRecovery({ ...f.proposal, sourceDigests: sources(events) }, events, [f.contract], now)).toBeUndefined();
  });

  it("TRU-08: invented contracts, absent operation IDs and changed source hashes cannot qualify proof", () => {
    const f = mcpFixture();
    expect(verifyMcpRecovery(f.proposal, f.events, [], now)).toBeUndefined();
    if (!f.proposal.predicate) throw new Error("Expected MCP predicate");
    const invented = { ...f.contract, digest: "f".repeat(64) };
    expect(verifyMcpRecovery({ ...f.proposal, predicate: { ...f.proposal.predicate, contractDigest: invented.digest } }, f.events, [invented], now)).toBeUndefined();
    for (const source of ["failed", "retry"]) {
      const events = patch(f.events, source, { operationId: undefined });
      expect(verifyMcpRecovery({ ...f.proposal, sourceDigests: sources(events) }, events, [f.contract], now)).toBeUndefined();
    }
    const events = patch(f.events, "retry", { redactedArguments: { path: "customer-B.json" } });
    expect(verifyMcpRecovery(f.proposal, events, [f.contract], now)).toBeUndefined();
    const wrongUserType = patch(f.events, "user", { eventType: "agent.message" });
    expect(verifyMcpRecovery({ ...f.proposal, sourceDigests: sources(wrongUserType) }, wrongUserType, [f.contract], now)).toBeUndefined();
  });

  it.each(["truncated", "omitted", "unknown-workspace"])("TRU-08: intermediary %s evidence cannot bridge proof", (variant) => {
    const f = mcpFixture(); const user = f.events.find((entry) => entry.sourceEventId === "user");
    if (!user) throw new Error("Missing user");
    let bridge = f.event("bridge", 2.5, { eventType: "agent.message", trust: "model", parentEventId: user.event.eventId });
    if (variant === "unknown-workspace") bridge = { ...bridge, event: { ...bridge.event, repositoryState: "unknown" } };
    else bridge = { ...bridge, event: { ...bridge.event, captureQuality: { schemaVersion: 1, originalLengths: {},
      omittedFields: variant === "omitted" ? ["message"] : [], truncatedFields: variant === "truncated" ? ["message"] : [] } } };
    const events = [...patch(f.events, "retry", { parentEventId: bridge.event.eventId }), bridge];
    expect(verifyMcpRecovery({ ...f.proposal, sourceDigests: sources(events) }, events, [f.contract], now)).toBeUndefined();
  });

  it("SCP-03 / VER-03: nested packages cannot borrow root success or override its recorded cwd", async () => {
    const f = shellFixture(); const receipt = verifyShellRecovery(f.proposal, f.events, now);
    if (!receipt) throw new Error("Expected native receipt");
    const candidate = candidateFor(f.events, f.proposal, receipt);
    for (const cwd of ["C:/repo/legacy", "C:/repo/sibling", "C:/repository"]) {
      expect(await retrieve(f.events, f.proposal, candidate, [receipt], { now, limit: 3, text: "npm test", repositoryScopeId: "repo",
        shellInvocation: { toolName: "powershell", command: "pnpm test", cwd, branch: "main", commitSha: "a".repeat(40) } })).toEqual([]);
    }
    const mismatch = shellFixture({ cwd: "C:/repo/legacy" });
    expect(verifyShellRecovery(mismatch.proposal, mismatch.events, now)).toBeUndefined();
    const relativeRoot = shellFixture({ cwd: "." });
    expect(verifyShellRecovery(relativeRoot.proposal, relativeRoot.events, now)).toBeDefined();
  });

  it("SCP-04 / SCP-06 / SCP-08: command guidance requires exact revision, native surface and platform path identity", () => {
    for (const worktree of ["C:/repo", "//server/share/repo", "/repo/Project"]) {
      const f = shellFixture({ worktree }); const receipt = verifyShellRecovery(f.proposal, f.events, now);
      if (!receipt || !f.proposal.shellPredicate) throw new Error("Expected native receipt for " + worktree);
      const candidate = candidateFor(f.events, f.proposal, receipt);
      const shellInvocation = { toolName: f.proposal.shellPredicate.toolName, command: "pnpm test", cwd: worktree, branch: "main", commitSha: "a".repeat(40) };
      const query = { now, limit: 3, text: "npm test", repositoryScopeId: "repo", shellInvocation };
      expect(learningApplicable(candidate, [f.proposal], query, [receipt])).toBe(true);
      for (const change of [{ commitSha: "b".repeat(40) }, { branch: "other" }, { cwd: "relative/repo" }, { cwd: worktree + "-copy" }]) {
        expect(learningApplicable(candidate, [f.proposal], { ...query, shellInvocation: { ...shellInvocation, ...change } }, [receipt])).toBe(false);
      }
      expect(learningApplicable(candidate, [f.proposal], { ...query, shellInvocation: { ...shellInvocation, cwd: worktree.toUpperCase() } }, [receipt])).toBe(worktree !== "/repo/Project");
      expect(learningApplicable(candidate, [f.proposal], { now, limit: 3, text: "npm test", repositoryScopeId: "repo",
        toolInvocation: { serverName: "wrapper", toolName: "shell", contractDigest: "f".repeat(64) } }, [receipt])).toBe(false);
    }
  });

  it("VER-03 / TRU-08: rejects inconsistent native operation proof and persisted receipt identity", async () => {
    const f = shellFixture(); const receipt = verifyShellRecovery(f.proposal, f.events, now);
    if (!receipt) throw new Error("Expected native receipt");
    const candidate = candidateFor(f.events, f.proposal, receipt);
    const events = f.events.map((entry) => entry.event.eventType === "test.completed" && entry.event.operationId === "second" && entry.event.evidence
      ? { ...entry, event: { ...entry.event, evidence: { ...entry.event.evidence, operationId: "borrowed" } } } : entry);
    expect(verifyShellRecovery({ ...f.proposal, sourceDigests: sources(events) }, events, now)).toBeUndefined();
    const tampered = { ...receipt, worktree: "C:/other", commitSha: "b".repeat(40) };
    expect(admission(f.events, f.proposal, candidate, [tampered]).reasons).toContain("invalid_verification_evidence");
    expect(await retrieve(f.events, f.proposal, candidate, [tampered], { now, limit: 3, text: "npm test", repositoryScopeId: "repo",
      shellInvocation: { toolName: "powershell", command: "pnpm test", cwd: tampered.worktree, branch: "main", commitSha: tampered.commitSha } })).toEqual([]);
    const predicateMismatch = { ...receipt, predicate: { ...receipt.predicate, command: "npm run test:other" } };
    expect(learningApplicable(candidate, [f.proposal], { now, limit: 3, text: "npm test", repositoryScopeId: "repo",
      shellInvocation: { toolName: "powershell", command: "pnpm test", cwd: "C:/repo", branch: "main", commitSha: "a".repeat(40) } }, [predicateMismatch])).toBe(false);
  });

  it.each(["wrong-working-directory", "stale-revision", "wrapper-surface", "omitted-output"])("SCP-06 / VER-02 / VER-03 / TRU-08: rejects native %s evidence", (variant) => {
    const f = shellFixture();
    const events = f.events.map((entry) => {
      if (entry.sourceEventId !== "completion") return entry;
      if (variant === "stale-revision") return { ...entry, event: { ...entry.event, commitSha: "b".repeat(40) } };
      if (variant === "wrapper-surface") return { ...entry, event: { ...entry.event, mcp: { serverName: "wrapper", toolName: "powershell" } } };
      if (variant === "omitted-output") return { ...entry, event: { ...entry.event,
        captureQuality: { schemaVersion: 1 as const, originalLengths: {}, truncatedFields: [], omittedFields: ["toolResult.contents"] } } };
      return entry.event.evidence ? { ...entry, event: { ...entry.event, evidence: { ...entry.event.evidence, workingDirectory: "C:/repo/other" } } } : entry;
    });
    expect(verifyShellRecovery({ ...f.proposal, sourceDigests: sources(events) }, events, now)).toBeUndefined();
  });
});
