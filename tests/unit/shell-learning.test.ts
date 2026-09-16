import { describe, expect, it } from "vitest";
import { CopilotEventMapper, type CopilotSessionEvent } from "@provenloop/copilot-adapter";
import { buildLearningWindows, createCaptureEnvelope, learningKnowledgeCandidate, learningSourceDigest, verifyShellRecovery, KnowledgeAdmissionPolicy } from "@provenloop/domain";
import type { CaptureEnvelope, RuleProposal } from "@provenloop/contracts";
import { captureQueueItemSchema, learningProposalSource } from "@provenloop/contracts";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { LearningCoordinator } from "@provenloop/host";

const fixture = (variant = "valid") => {
  const failedCommand = variant === "reverse" ? "npm test" : variant === "package-script" ? "npm run test:wrong" : "pnpm test";
  const command = variant === "reverse" ? "pnpm test" : variant === "package-script" ? "npm run test:unit" : "npm test";
  const mapper = new CopilotEventMapper({ adapterVersion: "1.0.84-1", sessionId: variant === "reverse" ? "reverse-session" : "shell-session", copyLimits: { maxStringChars: 16384 },
    workspace: { repoId: "repo", repositoryState: "known_repo", cwd: "C:/repo", worktree: "C:/repo", branch: "main", commitSha: "a".repeat(40) } });
  const native: CopilotSessionEvent[] = [
    { id: "failed-start", parentId: null, type: "tool.execution_start", data: { toolCallId: "failed", toolName: "powershell", arguments: { command: failedCommand, cwd: "C:/repo" }, ...(variant === "mcp" ? { mcpServerName: "remote", mcpToolName: "powershell" } : {}) } },
    { id: "failed-result", parentId: "failed-start", type: "tool.execution_complete", data: { toolCallId: "failed", success: true, result: { content: "Native shell result", contents: [{ type: "shell_exit", shellId: "one", cwd: "C:/repo", exitCode: 1 }] } } },
    { id: "user", parentId: "failed-result", type: "user.message", data: { content: variant === "unquoted-command" ? "Use the repository test command." : `这个仓库用 ${command}，不是 ${failedCommand}，请用 ${command} 重试。` } },
    { id: "turn", parentId: "user", type: "assistant.turn_start", data: { turnId: "turn" } },
    { id: "retry-start", parentId: "turn", type: "tool.execution_start", data: { toolCallId: "retry", toolName: "powershell", arguments: { command, cwd: "C:/repo" }, ...(variant === "mcp" ? { mcpServerName: "remote", mcpToolName: "powershell" } : {}) } },
    { id: "retry-result", parentId: variant === "unrelated" ? "failed-result" : "retry-start", type: "tool.execution_complete", data: { toolCallId: "retry", success: true, result: variant === "text-only" ? { content: "All tests passed" } : { content: "Native shell result", contents: [{ type: "shell_exit", shellId: "two", cwd: variant === "outside" ? "C:/other" : "C:/repo", exitCode: variant === "failed" ? 1 : 0 }] } } },
  ];
  if (variant === "preparation" || variant === "overflow") {
    let parentId = "turn";
    const preparations: CopilotSessionEvent[] = [];
    for (let i = 0; i < (variant === "overflow" ? 14 : 1); i += 1) {
      const startId = `prepare-start-${i}`, resultId = `prepare-result-${i}`, toolCallId = `prepare-${i}`;
      preparations.push({ id: startId, parentId, type: "tool.execution_start", data: { toolCallId, toolName: "powershell", arguments: { command: "Get-Content package.json", cwd: "C:/repo" } } },
        { id: resultId, parentId: startId, type: "tool.execution_complete", data: { toolCallId, success: true, result: { contents: [{ type: "shell_exit", shellId: toolCallId, cwd: "C:/repo", exitCode: 0 }] } } });
      parentId = resultId;
    }
    const retry = native[4];
    if (!retry) throw new Error("Missing retry");
    native[4] = { ...retry, parentId };
    native.splice(4, 0, ...preparations);
  }
  for (const [i, event] of native.entries()) native[i] = { ...event, timestamp: new Date(Date.UTC(2026, 8, 8, 0, 0, i)).toISOString() };
  if (variant === "bridge") {
    const completion = native.at(-1);
    if (!completion) throw new Error("Missing completion");
    native.splice(native.length - 1, 0, { id: "retry-hook", parentId: "retry-start", type: "hook.end", timestamp: "2026-09-08T00:00:04.500Z", data: {} });
    native[native.length - 1] = { ...completion, parentId: "retry-hook" };
  }
  const events: CaptureEnvelope[] = [];
  for (const event of native) {
    const mapped = mapper.map(event);
    if (mapped.status === "ignored" && event.type === "hook.end") continue;
    if (mapped.status !== "mapped") throw new Error(`Fixture native event ${event.type} failed`);
    for (const value of [mapped.value, ...(mapped.additionalEvents ?? [])]) events.push(createCaptureEnvelope(value));
  }
  const find = (source: string, type: string) => { const result = events.find((entry) => entry.sourceEventId === source && entry.event.eventType === type); if (!result) throw new Error("Missing fixture event"); return result; };
  const user = find("user", "prompt.submitted");
  const proposal: RuleProposal = { schemaVersion: 1, proposalId: "shell-proposal", jobId: "shell-job", knowledgeId: "learning-knowledge-shell",
    rule: "Use npm test", trigger: "Test repository", exclusions: ["Other revisions"], createdAt: user.event.timestamp, expiresAt: "2026-10-08T00:00:00Z",
    userSource: { eventId: user.event.eventId, quote: user.content?.message ?? "" }, failedOperationEventId: find("failed-start", "tool.started").event.eventId,
    retryOperationEventId: find("retry-start", "tool.started").event.eventId, completionEventId: find("retry-result", "tool.completed").event.eventId,
    shellPredicate: { kind: "repository_test_command", toolName: "powershell", failedCommand, command },
    sourceDigests: events.map((entry) => ({ eventId: entry.event.eventId, digest: learningSourceDigest(entry) })),
  };
  return { events, proposal };
};

describe("native shell correction learning", () => {
  it("withholds opposite verified rules atomically and exposes a conflict even when retrieval selects one", async () => {
    const store = new CanonicalSqliteStore(":memory:");
    try {
      for (const variant of ["valid", "reverse"]) {
        const { events, proposal } = fixture(variant);
        for (const envelope of events) store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `conflict-${envelope.event.eventId}`,
          state: "pending", attemptCount: 0, failureCount: 0, createdAt: envelope.event.timestamp, updatedAt: envelope.event.timestamp, envelope }));
        const coordinator = new LearningCoordinator({ store, enabled: async () => true, now: () => new Date("2026-09-08T00:01:00Z"),
          lease: { tryAcquire: async () => ({ release: async () => undefined }) }, provider: { identity: { provider: "fixture", model: "fixture", version: "1" }, infer: async () => ({
            schemaVersion: 1, proposals: [{ rule: proposal.rule, trigger: proposal.trigger, exclusions: proposal.exclusions, userSource: proposal.userSource,
              failedOperationEventId: proposal.failedOperationEventId, retryOperationEventId: proposal.retryOperationEventId, completionEventId: proposal.completionEventId, shellPredicate: proposal.shellPredicate }],
          }) } });
        expect(await coordinator.run()).toMatchObject({ status: "evaluated", qualified: 1 });
      }
      const candidates = store.knowledgeCandidates();
      expect(candidates).toHaveLength(2);
      expect(candidates.every((candidate) => candidate.state === "disputed" && candidate.conflictsWith.length === 1)).toBe(true);
      expect(store.learningReceipts()).toHaveLength(2);
      expect(store.pendingLearningActivationIds()).toEqual([]);
      for (const candidate of candidates) {
        const evidence = store.knowledgeAdmissionEvidence([candidate]);
        expect(evidence.learningReceipts).toHaveLength(2);
        expect(new KnowledgeAdmissionPolicy().evaluate({ candidate, ...evidence }).admitted).toBe(false);
      }
      // A legacy active state must also fail admission when only one retrieval hit is selected.
      store.upsertKnowledgeCandidates(candidates.map((candidate) => ({ ...candidate, state: "active", conflictsWith: [] })));
      const selected = store.knowledgeCandidates()[0];
      if (!selected) throw new Error("Missing candidate.");
      expect(new KnowledgeAdmissionPolicy().evaluate({ candidate: selected, ...store.knowledgeAdmissionEvidence([selected]) }).admitted).toBe(false);
      const withdrawn = store.knowledgeCandidates().find((candidate) => candidate.knowledgeId !== selected.knowledgeId);
      if (!withdrawn) throw new Error("Missing conflicting candidate.");
      store.upsertKnowledgeCandidates([{ ...withdrawn, state: "archived" }]);
      expect(store.knowledgeAdmissionEvidence([selected]).learningReceipts).toHaveLength(1);
      expect(new KnowledgeAdmissionPolicy().evaluate({ candidate: selected, ...store.knowledgeAdmissionEvidence([selected]) }).admitted).toBe(true);
    } finally { store.close(); }
  });
  it.each(["preserved", "changed"])("finds delayed bound proof after later turns and requires its original timestamp (%s)", async (timestamp) => {
    const { events, proposal } = fixture();
    const store = new CanonicalSqliteStore(":memory:");
    const proof = events.find((entry) => entry.event.eventType === "test.completed" && entry.event.exitCode === 0);
    if (!proof) throw new Error("Missing proof fixture.");
    const add = (envelope: CaptureEnvelope) => store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `late-${envelope.event.eventId}`,
      state: "pending", attemptCount: 0, failureCount: 0, createdAt: envelope.event.timestamp, updatedAt: envelope.event.timestamp, envelope }));
    const time = new Date("2026-09-08T00:10:00Z");
    let calls = 0;
    const coordinator = new LearningCoordinator({ store, enabled: async () => true, now: () => time,
      lease: { tryAcquire: async () => ({ release: async () => undefined }) }, provider: { identity: { provider: "fixture", model: "fixture", version: "1" }, infer: async () => {
        calls += 1; return { schemaVersion: 1, proposals: [{ rule: proposal.rule, trigger: proposal.trigger, exclusions: proposal.exclusions, userSource: proposal.userSource,
          failedOperationEventId: proposal.failedOperationEventId, retryOperationEventId: proposal.retryOperationEventId, completionEventId: proposal.completionEventId, shellPredicate: proposal.shellPredicate }] };
      } } });
    try {
      events.filter((entry) => entry !== proof).forEach(add);
      expect(await coordinator.run()).toMatchObject({ status: "idle" });
      for (let index = 0; index < 80; index += 1) {
        add(createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: `later-${index}`, sessionId: "shell-session",
          repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo", timestamp: new Date(Date.parse("2026-09-08T00:01:00Z") + index * 1000).toISOString(),
          eventType: index === 0 ? "prompt.submitted" : "agent.message", trust: index === 0 ? "user" : "model", content: { message: "A later unrelated task." } }));
      }
      for (const work of store.learningPromptWork(time, 128)) store.completeLearningPromptWork(work);
      add(timestamp === "preserved" ? proof : { ...proof, event: { ...proof.event, timestamp: "2026-09-08T00:04:00Z" } });
      const work = store.learningPromptWork(time, 128).find((entry) => entry.eventId === learningProposalSource(proposal).eventId);
      expect(work).toBeDefined();
      expect(work?.events.length).toBeLessThanOrEqual(128);
      expect(work?.events.some((entry) => entry.event.eventId === proof.event.eventId)).toBe(true);
      expect(await coordinator.run()).toMatchObject({ status: "evaluated", qualified: timestamp === "preserved" ? 1 : 0 });
      expect(calls).toBe(1);
      expect(store.learningReceipts()).toHaveLength(timestamp === "preserved" ? 1 : 0);
    } finally { store.close(); }
  });
  it("retains shell preparations until the actual test retry and defers partial windows", () => {
    const { events, proposal } = fixture("preparation");
    const retryIndex = events.findIndex((entry) => entry.event.eventId === proposal.retryOperationEventId);
    const now = new Date("2026-09-08T00:01:00Z");
    expect(buildLearningWindows(events.slice(0, retryIndex), now)).toEqual([]);
    expect(buildLearningWindows(events.slice(0, retryIndex + 1), now)).toEqual([]);
    const retryOperation = events[retryIndex]?.event.operationId;
    expect(buildLearningWindows(events.filter((entry) => entry.event.eventType !== "test.completed" || entry.event.operationId !== retryOperation), now)).toEqual([]);
    const window = buildLearningWindows(events, now)[0];
    expect(window?.events.map((entry) => entry.event.eventId)).toEqual(expect.arrayContaining(events.map((entry) => entry.event.eventId)));
    expect(verifyShellRecovery(proposal, events, now)).toBeDefined();
    expect(buildLearningWindows([...events].reverse(), now)).toEqual([window]);
    expect(buildLearningWindows(fixture("overflow").events, now)).toEqual([]);
  });
  it("keeps admitted shell evidence valid after later ordinary calls while rejecting competing retries", () => {
    const { events, proposal } = fixture();
    const retry = events.find((entry) => entry.event.eventId === proposal.retryOperationEventId);
    const completion = events.find((entry) => entry.event.eventId === proposal.completionEventId);
    if (!retry || !completion || !proposal.shellPredicate) throw new Error("Missing retry sources");
    const now = new Date("2026-09-08T00:01:00Z");
    for (const command of ["Get-Content package.json", proposal.shellPredicate.command]) {
      const later = { ...retry, sourceEventId: "later-call", event: { ...retry.event, eventId: "later-call", operationId: "later",
        timestamp: "2026-09-08T00:00:06Z", parentEventId: completion.event.eventId, redactedArguments: { command, cwd: "C:/repo" } } };
      expect(verifyShellRecovery(proposal, [...events, later], now)).toBeDefined();
      expect(buildLearningWindows([...events, later], now)).toEqual(buildLearningWindows(events, now));
    }
    const competing = { ...retry, sourceEventId: "competing-call", event: { ...retry.event, eventId: "competing-call", operationId: "competing", timestamp: "2026-09-08T00:00:04.500Z" } };
    expect(verifyShellRecovery(proposal, [...events, competing], now)).toBeUndefined();
    const contradiction = { ...completion, sourceEventId: "late-failure", event: { ...completion.event, eventId: "late-failure",
      timestamp: "2026-09-08T00:00:08Z", completionStatus: "failed" as const, exitCode: 1 } };
    expect(verifyShellRecovery(proposal, [...events, contradiction], now)).toBeUndefined();
    const failedEvent = { ...contradiction, event: { ...contradiction.event, eventType: "tool.failed", completionStatus: undefined, exitCode: undefined } };
    expect(verifyShellRecovery(proposal, [...events, failedEvent], now)).toBeUndefined();
  });
  it("accepts a same-timestamp descendant of the shell result but rejects a causal peer", () => {
    const { events, proposal } = fixture();
    const retry = events.find((entry) => entry.event.eventId === proposal.retryOperationEventId);
    const completion = events.find((entry) => entry.event.eventId === proposal.completionEventId);
    if (!retry || !completion) throw new Error("Missing retry sources");
    const later = { ...retry, sourceEventId: "same-time-call", event: { ...retry.event, eventId: "same-time-call",
      operationId: "later", parentEventId: completion.event.eventId, timestamp: completion.event.timestamp } };
    expect(verifyShellRecovery(proposal, [...events, later], new Date())).toBeDefined();
    const peer = { ...later, event: { ...later.event, parentEventId: retry.event.parentEventId } };
    expect(verifyShellRecovery(proposal, [...events, peer], new Date())).toBeUndefined();
  });
  it("binds derived verification directly while accepting exact legacy copied bridges", () => {
    const { proposal, events } = fixture("bridge");
    const completion = events.find((entry) => entry.event.eventId === proposal.completionEventId);
    const proof = events.find((entry) => entry.event.eventType === "test.completed" && entry.event.operationId === completion?.event.operationId);
    if (!completion || !proof) throw new Error("Missing native proof");
    expect(completion.event.parentBridge).toHaveLength(1);
    expect(proof.event.parentBridge).toBeUndefined();
    expect(verifyShellRecovery(proposal, events, new Date())).toBeDefined();
    const legacy = events.map((entry) => entry === proof ? { ...entry, event: { ...entry.event, parentBridge: completion.event.parentBridge, originalParentSourceEventId: completion.event.originalParentSourceEventId } } : entry);
    const legacyProposal = { ...proposal, sourceDigests: legacy.map((entry) => ({ eventId: entry.event.eventId, digest: learningSourceDigest(entry) })) };
    expect(verifyShellRecovery(legacyProposal, legacy, new Date())).toBeDefined();
    const altered = legacy.map((entry) => entry.event.eventId === proof.event.eventId ? { ...entry, event: { ...entry.event, originalParentSourceEventId: "unrelated-native-parent" } } : entry);
    expect(verifyShellRecovery({ ...proposal, sourceDigests: altered.map((entry) => ({ eventId: entry.event.eventId, digest: learningSourceDigest(entry) })) }, altered, new Date())).toBeUndefined();
  });
  it("persists native-derived shell qualification through the coordinator and purges its receipt with source deletion", async () => {
    const { events, proposal } = fixture("package-script");
    const store = new CanonicalSqliteStore(":memory:");
    try {
      for (const [index, envelope] of events.entries()) store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `shell-${index}`, state: "pending", attemptCount: 0, failureCount: 0, createdAt: envelope.event.timestamp, updatedAt: envelope.event.timestamp, envelope }));
      const coordinator = new LearningCoordinator({ store, enabled: async () => true, now: () => new Date("2026-09-08T00:00:10Z"),
        lease: { tryAcquire: async () => ({ release: async () => undefined }) }, provider: { identity: { provider: "fixture", model: "fixture", version: "1" }, infer: async () => ({ schemaVersion: 1, proposals: [{
          rule: proposal.rule, trigger: proposal.trigger, exclusions: proposal.exclusions, userSource: proposal.userSource,
          failedOperationEventId: proposal.failedOperationEventId, retryOperationEventId: proposal.retryOperationEventId, completionEventId: proposal.completionEventId, shellPredicate: proposal.shellPredicate,
        }] }) } });
      expect(await coordinator.run()).toMatchObject({ status: "evaluated", qualified: 1 });
      const candidate = store.knowledgeCandidates()[0];
      if (!candidate) throw new Error("Missing qualified shell rule");
      expect(new KnowledgeAdmissionPolicy().evaluate({ candidate, ...store.knowledgeAdmissionEvidence([candidate]) }).admitted).toBe(true);
      expect(store.learningReceipts()).toEqual([expect.objectContaining({ proves: "repository_test_command" })]);
      const target = { targetType: "source" as const, targetId: learningProposalSource(proposal).eventId };
      const deletion = store.beginDeletion(target); store.deleteCanonicalTarget(deletion.deletionId, target);
      expect(store.knowledgeCandidates()).toEqual([]); expect(store.learningReceipts()).toEqual([]); expect(store.learningJobs()).toEqual([]);
    } finally { store.close(); }
  });
  it("uses native package-script exit evidence for a corrected test:unit invocation", () => {
    const { proposal, events } = fixture("package-script");
    expect(verifyShellRecovery(proposal, events, new Date())).toMatchObject({ proves: "repository_test_command", predicate: { failedCommand: "npm run test:wrong", command: "npm run test:unit" } });
  });
  it("qualifies an ordinary correction from native shell exits without rewriting its trust", () => {
    const { events, proposal } = fixture();
    const now = new Date("2026-09-08T00:00:10Z");
    const receipt = verifyShellRecovery(proposal, events, now);
    expect(receipt).toMatchObject({ proves: "repository_test_command", commitSha: "a".repeat(40), predicate: { command: "npm test" } });
    expect(events.filter((entry) => entry.event.eventType === "user.corrected")).toEqual([]);
    const window = buildLearningWindows(events, now)[0];
    expect(window?.events.some((entry) => entry.event.eventType === "test.completed" && entry.event.exitCode === 0)).toBe(true);
    if (!window || !receipt) throw new Error("Expected a verified window");
    const candidate = learningKnowledgeCandidate(window, proposal, receipt);
    expect(candidate).toMatchObject({ state: "active", evidenceTier: "externally_verified" });
    expect(new KnowledgeAdmissionPolicy().evaluate({ candidate, envelopes: events, correctionKeys: [], correctionSourceEventIds: new Set(), workEpisodes: [], learningProposals: [proposal], learningReceipts: [receipt] }).admitted).toBe(true);
  });
  it.each(["failed", "text-only", "mcp", "outside", "unrelated", "unquoted-command"])("does not qualify %s evidence", (variant) => {
    const { events, proposal } = fixture(variant);
    expect(verifyShellRecovery(proposal, events, new Date())).toBeUndefined();
  });
  it("rejects injected command expressions, changed revision and omitted native evidence", () => {
    const { events, proposal } = fixture();
    if (!proposal.shellPredicate) throw new Error("Missing shell predicate");
    for (const command of ["npm test && publish", "npm run deploy", "npm test --ignore-scripts"]) {
      expect(verifyShellRecovery({ ...proposal, shellPredicate: { ...proposal.shellPredicate, command } }, events, new Date())).toBeUndefined();
    }
    const changed = events.map((entry) => entry.event.eventId === proposal.completionEventId ? { ...entry, event: { ...entry.event, commitSha: "b".repeat(40) } } : entry);
    expect(verifyShellRecovery({ ...proposal, sourceDigests: changed.map((entry) => ({ eventId: entry.event.eventId, digest: learningSourceDigest(entry) })) }, changed, new Date())).toBeUndefined();
    expect(verifyShellRecovery({ ...proposal, sourceDigests: proposal.sourceDigests.filter((source) => !events.find((entry) => entry.event.eventId === source.eventId && entry.event.eventType === "test.completed")) }, events, new Date())).toBeUndefined();
  });
});
