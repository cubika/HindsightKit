import assert from "node:assert/strict";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeControlService } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const stores: CanonicalSqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

const fixture = () => {
  const store = new CanonicalSqliteStore(":memory:");
  stores.push(store);
  const service = new KnowledgeControlService({
    store,
    projection: {
      acquireLease: async () => ({ release: async () => undefined }),
      rebuild: async () => undefined,
    },
  });
  return { service, store };
};

describe("explicit Knowledge review controls", () => {
  it("moves an explicitly reviewed rule to its intended repository as a new manual rule", async () => {
    const { service, store } = fixture();
    const saved = await service.remember({ content: "Keep derived uniqueness fields private.", appliesWhen: ["Implementing uniqueness"], scope: "repository", scopeId: "wrong-repo" });
    assert(saved.candidate);
    const knowledgeId = saved.candidate.knowledgeId;
    const review = service.review({ knowledgeId, scope: "repository", scopeId: "wrong-repo" });
    const moved = await service.resolve({ knowledgeId, scope: "repository", scopeId: "wrong-repo", expectedDigest: review.expectedDigest,
      userConfirmed: true, replacementScope: { scope: "repository", scopeId: "target-repo" } });
    expect(moved.candidate).toMatchObject({ scopeId: "target-repo", state: "active", evidenceTier: "user_confirmed", supersedes: knowledgeId });
    expect(store.knowledgeCandidates([knowledgeId])[0]?.state).toBe("superseded");
    expect(service.list({ scope: "repository", scopeId: "target-repo" })).toHaveLength(1);
  });
  it("lists disputed items without making them active or crossing repository scope", async () => {
    const { service } = fixture();
    const remembered = await service.remember({
      content: "Run focused tests.",
      appliesWhen: ["Changing code."],
      scope: "repository",
      scopeId: "repo-one",
    });
    assert(remembered.candidate !== undefined, "Remember must return a candidate.");
    const id = remembered.candidate.knowledgeId;
    await service.correct({ knowledgeId: id });
    expect(service.list({ scope: "repository", scopeId: "repo-two" })).toEqual([]);
    const review = service.review({
      knowledgeId: id,
      scope: "repository",
      scopeId: "repo-one",
    });
    expect(review.candidate.state).toBe("disputed");
    expect(review.expectedDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => service.review({
      knowledgeId: id,
      scope: "repository",
      scopeId: "repo-two",
    })).toThrow("selected scope");
  });

  it("requires explicit confirmation and rejects stale review digests", async () => {
    const { service } = fixture();
    const remembered = await service.remember({
      content: "Run focused tests.",
      appliesWhen: ["Changing code."],
      scope: "personal",
    });
    assert(remembered.candidate !== undefined, "Remember must return a candidate.");
    const knowledgeId = remembered.candidate.knowledgeId;
    const review = service.review({ knowledgeId, scope: "personal" });
    await expect(service.resolve({
      knowledgeId,
      scope: "personal",
      expectedDigest: review.expectedDigest,
      userConfirmed: false,
    })).rejects.toThrow("explicit user confirmation");
    await service.correct({ knowledgeId });
    await expect(service.resolve({
      knowledgeId,
      scope: "personal",
      expectedDigest: review.expectedDigest,
      userConfirmed: true,
    })).rejects.toThrow("changed after review");
  });

  it("rejects an unconfigured workflow instead of creating unreachable Knowledge", async () => {
    const { service, store } = fixture();
    await expect(service.remember({
      content: "Run focused tests.",
      appliesWhen: ["Changing code."],
      scope: "workflow",
      scopeId: "unconfigured",
    })).rejects.toThrow("configured trusted workflow");
    expect(store.knowledgeCandidates()).toEqual([]);
  });

  it("revokes a reviewed rule without deleting its audit history", async () => {
    const { service, store } = fixture();
    const remembered = await service.remember({
      content: "Run focused tests.",
      appliesWhen: ["Changing code."],
      scope: "personal",
    });
    assert(remembered.candidate !== undefined, "Remember must return a candidate.");
    const knowledgeId = remembered.candidate.knowledgeId;
    const review = service.review({ knowledgeId, scope: "personal" });
    const result = await service.revoke({
      knowledgeId,
      scope: "personal",
      expectedDigest: review.expectedDigest,
      userConfirmed: true,
    });
    expect(result.candidate?.state).toBe("archived");
    expect(store.feedbackEvents(knowledgeId)).toEqual([
      expect.objectContaining({ kind: "revoke", source: "user" }),
    ]);
  });

  it("atomically replaces a disputed item with a distinct user-confirmed rule", async () => {
    const { service, store } = fixture();
    const remembered = await service.remember({
      content: "Run every test.",
      appliesWhen: ["Changing code."],
      scope: "personal",
    });
    assert(remembered.candidate !== undefined, "Remember must return a candidate.");
    const knowledgeId = remembered.candidate.knowledgeId;
    await service.correct({ knowledgeId, reason: "Use the focused test first." });
    const review = service.review({ knowledgeId, scope: "personal" });
    const result = await service.resolve({
      knowledgeId,
      scope: "personal",
      content: "Run focused tests before the full suite.",
      expectedDigest: review.expectedDigest,
      resolvesEvidenceIds: review.unresolvedEvidenceIds,
      userConfirmed: true,
    });
    expect(result.candidate).toMatchObject({
      evidenceMarks: ["user_confirmed"],
      evidenceTier: "user_confirmed",
      sourceEpisodeIds: [],
      sourceEvidenceIds: [],
      state: "active",
      supersedes: knowledgeId,
    });
    expect(result.candidate?.knowledgeId).not.toBe(knowledgeId);
    expect(store.knowledgeCandidates([knowledgeId])[0]?.state)
      .toBe("superseded");
  });
});
