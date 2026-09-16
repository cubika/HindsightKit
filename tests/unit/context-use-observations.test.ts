import assert from "node:assert/strict";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "@provenloop/contracts";
import { KnowledgeControlService } from "@provenloop/host";
import {
  ContextRetrievalService,
  KnowledgeProjectionManager,
  SqliteFtsKnowledgeBackend,
} from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

const fixture = () => {
  const store = new CanonicalSqliteStore(":memory:");
  const backend = new SqliteFtsKnowledgeBackend(":memory:");
  cleanup.push(async () => {
    await backend.closeAsync();
    store.close();
  });
  const projection = new KnowledgeProjectionManager({ backend, store });
  const control = new KnowledgeControlService({
    store,
    projection: {
      acquireLease: async () => ({ release: async () => undefined }),
      rebuild: () => projection.rebuild().then(() => undefined),
    },
  });
  const service = new ContextRetrievalService({
    backend,
    store,
    timeoutMs: 5_000,
  });
  return { store, control, service };
};

describe("honest context usage observations", () => {
  it("does not turn analyzer feedback or helpfulness into reported application", async () => {
    const { control, service, store } = fixture();
    const remembered = await control.remember({
      content: "Run focused tests.",
      appliesWhen: ["Testing code."],
      scope: "personal",
    });
    assert(remembered.candidate !== undefined, "Remember must return a candidate.");
    const targetId = remembered.candidate.knowledgeId;
    const response = await service.context({
      cwd: "C:\\repo",
      prompt: "Run focused tests",
      repoId: "repo-one",
      branch: "main",
      sessionId: "session-one",
      tokenBudget: 600,
    });
    const request = {
      action: "helpful" as const,
      requestId: response.requestId,
      sessionId: "session-one",
      targetId,
    };
    expect(await service.feedback({
      ...request,
      userReportedApplied: true,
    })).toMatchObject({ adoption: "not_reported", outcome: "unknown" });
    expect(store.feedbackEvents(targetId)[0]?.source).toBe("analyzer");
    expect(await service.feedback({
      ...request,
      source: "user",
    })).toMatchObject({ adoption: "not_reported", outcome: "unknown" });
    expect(store.contextUseRecords("session-one")[0]).toMatchObject({
      appliedKnowledgeIds: [],
      branch: "main",
      repoId: "repo-one",
      retrievalStatus: "provided",
    });
    expect(await service.feedback({
      ...request,
      source: "user",
      userReportedApplied: true,
    })).toMatchObject({ adoption: "user_reported", outcome: "unknown" });
    expect(store.contextUseRecords("session-one")[0]?.appliedKnowledgeIds)
      .toEqual([`knowledge:${targetId}`]);
  });

  it("records typed Branch Context feedback without inventing verified outcomes", async () => {
    const { service, store } = fixture();
    store.replaceBranchContextProjection({
      contexts: [{
        schemaVersion: CURRENT_SCHEMA_VERSION,
        acceptedDecisions: [],
        branch: "main",
        branchContextId: "branch-one",
        sourceSessionIds: ["session-one"],
        explicitConstraints: [],
        goal: "Continue the parser.",
        headSha: "abc123",
        implementationState: [],
        recentVerificationEvidenceIds: [],
        repoId: "repo-one",
        sourceEpisodeIds: [],
        sourceEventIds: [],
        unfinishedItems: [],
        updatedAt: new Date().toISOString(),
      }],
    });
    const response = await service.context({
      branch: "main",
      cwd: "C:\\repo",
      headSha: "abc123",
      prompt: "Continue the parser",
      repoId: "repo-one",
      sessionId: "session-one",
      tokenBudget: 600,
    });
    expect(response.items[0]?.kind).toBe("branch_context");
    const request = {
      action: "helpful" as const,
      requestId: response.requestId,
      sessionId: "session-one",
      source: "user" as const,
      targetId: "branch-one",
      targetKind: "branch_context" as const,
      userReportedApplied: true,
    };
    expect(await service.feedback(request)).toMatchObject({
      adoption: "user_reported",
      outcome: "unknown",
      status: "recorded",
    });
    expect(await service.feedback(request)).toMatchObject({
      status: "already_recorded",
    });
    expect(store.contextUseRecords("session-one")[0]?.appliedKnowledgeIds)
      .toEqual(["branch-context:branch-one"]);
    expect(await service.feedback({
      ...request,
      targetKind: "knowledge",
    })).toMatchObject({ status: "not_previously_retrieved" });
  });
});
