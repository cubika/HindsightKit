import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli, type CliDependencies } from "@provenloop/cli";
import type { AgentAdapter } from "@provenloop/contracts";
import { CopilotCliAdapter } from "@provenloop/copilot-adapter";
import { buildDiscoveryProfile } from "@provenloop/domain";
import { KnowledgeControlService, type RememberKnowledgeInput } from "@provenloop/host";
import { resolveWindowsProvenLoopPaths } from "@provenloop/platform-windows";
import { knowledgeProjectionFromCandidate, SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const roots: string[] = [];
const stores: CanonicalSqliteStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const lesson: RememberKnowledgeInput = {
  content: "Use an idempotency key before retrying an external write after an ambiguous timeout.",
  appliesWhen: ["Retrying an external write after an ambiguous timeout."],
  scope: "personal",
};

const memoryFixture = () => {
  const store = new CanonicalSqliteStore(":memory:");
  stores.push(store);
  const service = new KnowledgeControlService({ store, projection: {
    acquireLease: async () => ({ release: async () => undefined }), rebuild: async () => undefined,
  } });
  return { store, service };
};

describe("manual experience discovery metadata", () => {
  it("shows only enrichment overlays validated against the current knowledge revision", async () => {
    const { service, store } = memoryFixture();
    const saved = await service.remember(lesson);
    assert(saved.candidate);
    const candidate = saved.candidate;
    const overlay = buildDiscoveryProfile(candidate, { producer: "model_reviewed",
      purposes: [{ value: "rationale", basisIds: ["content:0"], polarity: "positive" }] }, { reviewedBy: "review-provider/model" });
    const lookup = vi.spyOn(store, "discoveryProfiles").mockReturnValue(new Map([[candidate.knowledgeId, overlay]]));
    expect(service.review({ knowledgeId: candidate.knowledgeId, scope: "personal" }).discoveryProfile).toEqual(overlay);
    lookup.mockReturnValue(new Map([[candidate.knowledgeId, { ...overlay, knowledgeDigest: "a".repeat(64) }]]));
    expect(service.review({ knowledgeId: candidate.knowledgeId, scope: "personal" }).discoveryProfile?.profileDigest).not.toBe(overlay.profileDigest);
  });

  it("replaces metadata through the existing review guards and retains superseded history", async () => {
    const { service, store } = memoryFixture();
    const saved = await service.remember({ ...lesson, purposes: ["procedure"], topics: ["retries"],
      sourceReferences: [{ kind: "url", locator: "https://example.com/old" }] });
    assert(saved.candidate);
    const original = saved.candidate;
    const review = service.review({ knowledgeId: original.knowledgeId, scope: "personal" });
    expect(review.discoveryProfile?.purposes.map((purpose) => purpose.value)).toEqual(["procedure"]);
    const replace = { knowledgeId: original.knowledgeId, scope: "personal" as const, expectedDigest: review.expectedDigest,
      userConfirmed: true, content: original.content, replacementDiscovery: { purposes: ["lesson" as const] } };
    await expect(service.resolve({ ...replace, userConfirmed: false })).rejects.toThrow("explicit user confirmation");
    await expect(service.resolve({ ...replace, expectedDigest: "a".repeat(64) })).rejects.toThrow("changed after review");
    const replaced = await service.resolve(replace);
    assert(replaced.candidate);
    expect(replaced.candidate).toMatchObject({ evidenceTier: "user_confirmed", supersedes: original.knowledgeId,
      discovery: { producer: "user", purposes: [{ value: "lesson" }], topics: original.discovery?.topics,
        sourceReferences: original.discovery?.sourceReferences } });
    expect(store.knowledgeCandidates([original.knowledgeId])[0]).toMatchObject({
      state: "superseded", discovery: original.discovery,
    });
    expect(store.feedbackEvents(original.knowledgeId)[0]).toMatchObject({ kind: "confirm", source: "user" });
    const refreshed = service.review({ knowledgeId: replaced.candidate.knowledgeId, scope: "personal" });
    const corrected = await service.resolve({ knowledgeId: replaced.candidate.knowledgeId, scope: "personal",
      expectedDigest: refreshed.expectedDigest, userConfirmed: true, replacementDiscovery: { topics: ["idempotency"],
        sourceReferences: [{ kind: "directory", locator: "C:\\runbooks" }] } });
    expect(corrected.candidate?.discovery).toMatchObject({ purposes: [{ value: "lesson" }],
      topics: [{ value: "idempotency" }], sourceReferences: [{ kind: "directory", relationship: "investigation_start" }] });
  });

  it("drops previous discovery when semantic content changes and requires fresh metadata to classify the replacement", async () => {
    const { service } = memoryFixture();
    const saved = await service.remember({ ...lesson, purposes: ["lesson"], topics: ["retries"],
      sourceReferences: [{ kind: "url", locator: "https://example.com/old" }] });
    assert(saved.candidate);
    const review = service.review({ knowledgeId: saved.candidate.knowledgeId, scope: "personal" });
    const replaced = await service.resolve({ knowledgeId: saved.candidate.knowledgeId, scope: "personal",
      expectedDigest: review.expectedDigest, userConfirmed: true, content: "Run focused regression tests after changing code.",
      appliesWhen: ["Changing code."] });
    assert(replaced.candidate);
    expect(replaced.candidate.discovery).toBeUndefined();
    expect(service.review({ knowledgeId: replaced.candidate.knowledgeId, scope: "personal" }).discoveryProfile?.topics
      .map((topic) => topic.value)).toContain("testing");
  });

  it("keeps summary-only remember compatible and includes explicit facets and pointers in identity", async () => {
    const { service } = memoryFixture();
    const plain = await service.remember(lesson);
    expect(plain.candidate?.discovery).toBeUndefined();
    expect((await service.remember(lesson)).candidate?.knowledgeId).toBe(plain.candidate?.knowledgeId);
    const withMetadata: RememberKnowledgeInput = { ...lesson, purposes: ["lesson", "rationale"],
      topics: ["retries", "idempotency"], sourceReferences: [
        { kind: "url", locator: "https://example.com/incidents/42#lesson" },
        { kind: "directory", locator: "C:\\runbooks\\payments" },
      ] };
    const saved = await service.remember(withMetadata);
    assert(saved.candidate);
    expect(saved.candidate.knowledgeId).not.toBe(plain.candidate?.knowledgeId);
    expect(saved.candidate).toMatchObject({ state: "active", evidenceTier: "user_confirmed",
      evidenceMarks: ["user_confirmed"], sourceEpisodeIds: [], sourceEvidenceIds: [],
      discovery: { producer: "user",
        purposes: [{ value: "lesson", basisIds: ["content:0"], polarity: "positive" },
          { value: "rationale", basisIds: ["content:0"], polarity: "positive" }],
        topics: [{ value: "idempotency" }, { value: "retries" }],
      },
    });
    const refs = saved.candidate.discovery?.sourceReferences;
    expect(refs).toHaveLength(2);
    expect(refs?.find((entry) => entry.kind === "directory")).toMatchObject({
      availability: "pointer_only", evidenceIds: [], relationship: "investigation_start",
    });
    expect(refs?.find((entry) => entry.kind === "url")).toMatchObject({
      availability: "pointer_only", evidenceIds: [], relationship: "background",
    });
    for (const ref of refs ?? []) {
      expect(ref).not.toHaveProperty("revision");
      expect(ref).not.toHaveProperty("contentDigest");
      expect(ref).not.toHaveProperty("observedAt");
    }
    const repeated = await service.remember({ ...withMetadata, purposes: ["rationale", "lesson"],
      topics: ["idempotency", "retries"], sourceReferences: [...(withMetadata.sourceReferences ?? [])].reverse() });
    expect(repeated).toMatchObject({ changed: false, candidate: { knowledgeId: saved.candidate.knowledgeId } });
    const changed = await service.remember({ ...withMetadata, sourceReferences: [{ kind: "url", locator: "https://example.com/incidents/43" }] });
    expect(changed.candidate?.knowledgeId).not.toBe(saved.candidate.knowledgeId);
    expect(knowledgeProjectionFromCandidate(saved.candidate).discoveryProfile).toMatchObject({
      producer: "user", sourceReferences: refs, purposes: saved.candidate.discovery?.purposes,
    });
  });

  it.each([
    { topics: ["unknown-topic"] },
    { topics: Array(9).fill("retries") },
    { topics: [""] },
    { purposes: ["lesson", "procedure", "rationale"] },
    { sourceReferences: [{ kind: "url", locator: "file:///private/file" }] },
    { sourceReferences: [{ kind: "directory", locator: "C:\\runbooks", relationship: "supports" }] },
    { sourceReferences: [{ kind: "file", locator: "x".repeat(2_049) }] },
    { sourceReferences: [{ kind: "url", locator: "https://example.com/?api_key=super-secret-token-value" }] },
  ])("rejects invalid classification or locator metadata without storing it: %j", async (input) => {
    const { service, store } = memoryFixture();
    await expect(service.remember({ ...lesson, ...input } as RememberKnowledgeInput)).rejects.toThrow();
    expect(store.knowledgeCandidates()).toEqual([]);
  });
});

const cliFixture = async () => {
  const root = await mkdtemp(join(process.cwd(), ".remember-discovery-"));
  roots.push(root);
  const paths = resolveWindowsProvenLoopPaths(root);
  await mkdir(paths.data, { recursive: true });
  await mkdir(paths.backends, { recursive: true });
  await writeFile(paths.rootMarker, JSON.stringify({ product: "ProvenLoop", root, schemaVersion: 1 }));
  new CanonicalSqliteStore(paths.database).close();
  const errors: string[] = [];
  const logs: string[] = [];
  const adapter = new CopilotCliAdapter({ dataRoot: root });
  const identity = vi.spyOn(adapter, "resolveSession").mockImplementation(async (input) => ({
    sessionId: input.sessionId, internalSession: false, repositoryId: "repository-1", branch: "main",
  }));
  const dependencies: CliDependencies = { createAdapter: () => adapter, runMcpServer: async () => undefined };
  const args = ["remember", "--content", lesson.content, "--when", lesson.appliesWhen[0] ?? "", "--data-root", root];
  return { root, paths, identity, logs, errors, dependencies, args,
    io: { log: (message: string) => { logs.push(message); }, error: (message: string) => { errors.push(message); } } };
};

describe("remember discovery CLI", () => {
  it("shows computed classification and corrects it through knowledge replace", async () => {
    const f = await cliFixture();
    expect(await runCli([...f.args, "--purpose", "procedure", "--topics", "retries", "--source", "https://example.com/old"],
      f.io, f.dependencies), f.errors.join("\n")).toBe(0);
    const store = new CanonicalSqliteStore(f.paths.database);
    let id: string;
    try { id = store.knowledgeCandidates()[0]?.knowledgeId ?? ""; } finally { store.close(); }
    expect(await runCli(["knowledge", "show", id, "--data-root", f.root], f.io, f.dependencies)).toBe(0);
    const review = JSON.parse(f.logs.at(-1) ?? "{}");
    expect(review.discoveryProfile).toMatchObject({ purposes: [{ value: "procedure" }] });
    const replaceArgs = ["knowledge", "replace", id, "--content", lesson.content, "--expect", review.expectedDigest as string,
      "--confirm", "--purpose", "lesson", "--topics", "idempotency", "--source", "docs/corrected",
      "--source-kind", "directory", "--cwd", f.root, "--data-root", f.root];
    expect(await runCli(replaceArgs.filter((value) => value !== "--confirm"), f.io, f.dependencies)).toBe(2);
    expect(await runCli(replaceArgs, f.io, f.dependencies), f.errors.join("\n")).toBe(0);
    expect(await runCli(["knowledge", "list", "--state", "active", "--data-root", f.root], f.io, f.dependencies)).toBe(0);
    const listing = JSON.parse(f.logs.at(-1) ?? "[]");
    expect(listing).toHaveLength(1);
    expect(listing[0]).toMatchObject({ candidate: { supersedes: id, discovery: { purposes: [{ value: "lesson" }],
      topics: [{ value: "idempotency" }], sourceReferences: [{ kind: "directory", locator: resolve(f.root, "docs/corrected") }] } },
      discoveryProfile: { producer: "user", purposes: [{ value: "lesson" }] } });
  });

  it.each([
    { source: "docs/missing-incident.md", kind: "file" },
    { source: "docs/missing-runbooks", kind: "directory" },
    { source: "https://example.com/not-fetched", kind: "url" },
  ])("stores an explicit $kind pointer and projects the classification without opening the source", async ({ source, kind }) => {
    const f = await cliFixture();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("A source pointer must not be fetched."));
    const args = [...f.args, "--cwd", f.root, "--purpose", "lesson", "--topics", "retries,idempotency", "--source", source,
      ...(kind === "directory" ? ["--source-kind", kind] : [])];
    expect(await runCli(args, f.io, f.dependencies), f.errors.join("\n")).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(f.identity).toHaveBeenCalledWith(expect.objectContaining({ cwd: f.root }));
    const store = new CanonicalSqliteStore(f.paths.database);
    let knowledgeId: string;
    try {
      const candidates = store.knowledgeCandidates();
      expect(candidates).toHaveLength(1);
      assert(candidates[0]);
      knowledgeId = candidates[0].knowledgeId;
      expect(candidates[0]).toMatchObject({ evidenceTier: "user_confirmed", scopeId: "repository-1",
        discovery: { producer: "user", purposes: [{ value: "lesson" }],
          sourceReferences: [{ kind, locator: kind === "url" ? source : resolve(f.root, source), availability: "pointer_only" }] } });
    } finally { store.close(); }
    const backend = new SqliteFtsKnowledgeBackend(f.paths.knowledgeDatabase);
    try { expect((await backend.get(knowledgeId))?.discoveryProfile?.topics.map((topic) => topic.value)).toContain("idempotency"); }
    finally { await backend.closeAsync(); }
    expect(await runCli(args, f.io, f.dependencies)).toBe(0);
    expect(f.logs.at(-1)).toContain("already remembered");
  });

  it.each([
    ["--source-kind", "directory"], ["--source", "docs/readme.md", "--source-kind", "archive"],
    ["--purpose", "design"], ["--topics", "retry,,cache"], ["--topics", "x".repeat(129)],
  ])("rejects malformed options before storage: %j", async (...extra) => {
    const dependencies = { createAdapter: vi.fn<() => AgentAdapter>(), runMcpServer: async () => undefined };
    const errors: string[] = [];
    const exitCode = await runCli(["remember", "--content", lesson.content, "--when", "Retrying external writes.", ...extra],
      { log: () => undefined, error: (error) => { errors.push(error); } }, dependencies);
    expect(exitCode).toBe(2);
    expect(dependencies.createAdapter).not.toHaveBeenCalled();
    expect(errors[0]).toContain("--source-kind");
  });
});
