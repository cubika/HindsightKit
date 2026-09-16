import { describe, expect, it } from "vitest";
import { discoveryMetadataSchema, discoveryProfileSchema, sourceReferenceSchema, type DiscoveryMetadata, type KnowledgeCandidate } from "@provenloop/contracts";
import {
  assessDiscoveryRelevance, buildDiscoveryProfile, buildDiscoveryQuery, discoveryConceptToken,
  discoverySearchText, knowledgeDiscoveryDigest, validateDiscoveryMetadata, validateDiscoveryProfile,
} from "@provenloop/domain";

const candidate = (overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate => ({
  schemaVersion: 1, knowledgeId: "retry-lesson", topicKey: "ambiguous-external-write", kind: "episodic",
  content: "A lost response caused a retry to duplicate writes. Preserve stable operation identity and deduplication around external effects.",
  appliesWhen: ["Operations have external effects"], nonApplicability: ["Read-only operations without repeated effects"],
  scope: "repository", scopeId: "repo", sourceEpisodeIds: ["episode"], sourceEvidenceIds: ["evidence"],
  conflictsWith: [], evidenceMarks: ["user_confirmed"], evidenceTier: "user_confirmed", state: "active",
  importance: 1, utility: { applied: 0, harmful: 0, helpful: 0 },
  coverage: { applicableOpportunities: 0, observedOutcomes: 0 }, createdAt: "2026-09-11T00:00:00.000Z", ...overrides,
});
const relevance = (text: string, item = candidate()) => assessDiscoveryRelevance(item, buildDiscoveryProfile(item), buildDiscoveryQuery(text));

describe("discovery classification and query interpretation", () => {
  it("normalizes bilingual equivalents while keeping retry and idempotency distinct", () => {
    expect(buildDiscoveryQuery("幂等性和去重").concepts).toEqual(["idempotency"]);
    const retry = buildDiscoveryQuery("重试");
    expect(retry.concepts).toEqual(["retries"]);
    expect(retry.relatedConcepts).toContain("idempotency");
    expect(retry.relatedConcepts.length).toBeLessThanOrEqual(4);
    expect(retry.relatedConcepts).not.toContain("queues");
  });

  it.each([
    "Ensure the task external operation takes effect only once",
    "确保任务的外部操作只生效一次",
    "Prevent duplicate writes when the worker retries after a timeout",
  ])("matches paraphrases with established side effects: %s", (text) => {
    expect(relevance(text)).toMatchObject({ band: "direct", unresolvedConditions: [] });
  });

  it.each([
    "Design a queue worker with retries; side effects are unspecified",
    "Design a queue worker with retries",
    "设计一个支持重试的消息队列，副作用尚不清楚",
  ])("does not invent unspecified applicability: %s", (text) => {
    expect(relevance(text)).toMatchObject({ band: "conditional", unresolvedConditions: ["Operations have external effects"] });
  });

  it.each([
    "Retry a read-only health probe",
    "Retry without external effects",
    "重试只读健康检查，没有外部副作用",
    "Change the retry count in a unit test",
  ])("omits contradicted or testing-only uses: %s", (text) => {
    expect(relevance(text).band).toBe("weak");
  });

  it("keeps excluded contexts out of positive postings", () => {
    const item = candidate({ content: "Deduplicate external writes. This does not apply to read-only retries.", appliesWhen: [] });
    const profile = buildDiscoveryProfile(item);
    expect(profile.topics).toContainEqual(expect.objectContaining({ value: "read-only", polarity: "excluded_context" }));
    expect(discoverySearchText(profile)).not.toContain(discoveryConceptToken("read-only"));
    expect(discoverySearchText(profile)).not.toContain("health probe");
    expect(discoverySearchText(profile)).not.toContain(discoveryConceptToken("retries"));
    expect(discoverySearchText(profile)).toContain(discoveryConceptToken("external-effects"));
    expect(buildDiscoveryQuery("只读查询不适用").negativeConcepts).toContain("read-only");
    expect(buildDiscoveryQuery("只读查询不适用").concepts).not.toContain("read-only");
  });

  it("does not treat a related expansion as evidence that the task has that mechanism", () => {
    const item = candidate({ content: "Apply idempotency to preserve the intended state.", appliesWhen: [], nonApplicability: [] });
    expect(relevance("Retry the request", item)).toMatchObject({ band: "weak", matchedConcepts: [] });
    const query = buildDiscoveryQuery("Plan the service", { conceptHints: ["external-effects"] });
    expect(query.concepts).not.toContain("external-effects");
    expect(query.relatedConcepts).toContain("external-effects");
    const cache = candidate({ content: "Cache invalidation requires a revision key to isolate stale entries.", appliesWhen: ["Changing code"], nonApplicability: [] });
    expect(relevance("Use an idempotency key when retrying external writes", cache).band).toBe("weak");
    const queue = { ...cache, content: "Queue consumers must tolerate redelivery with a stable operation identity." };
    expect(relevance("Use an idempotency key when retrying external writes", queue).band).toBe("weak");
  });

  it("keeps original applicability authoritative when an alternate supplies discovery support", () => {
    const item = candidate();
    const alternate = buildDiscoveryQuery("retry external writes");
    const original = buildDiscoveryQuery("Plan a worker with retries");
    expect(assessDiscoveryRelevance(item, buildDiscoveryProfile(item), alternate, { applicabilityQuery: original })).toMatchObject({
      band: "conditional", unresolvedConditions: ["Operations have external effects"],
    });
    expect(assessDiscoveryRelevance(item, buildDiscoveryProfile(item), alternate, { applicabilityQuery: buildDiscoveryQuery("Retry read-only requests") }).band).toBe("weak");
  });

  it("preserves exact command spelling and case", () => {
    const item = candidate({ content: "Use tool -X to select expanded output.", appliesWhen: ["Changing code."], nonApplicability: [] });
    expect(buildDiscoveryQuery("tool -X").entities).toContain("tool -X");
    expect(relevance("Run tool -X", item).band).toBe("direct");
    expect(relevance("Run tool -x", item).band).toBe("weak");
    const quoted = { ...item, content: "Use " + String.fromCharCode(96) + "tool -X" + String.fromCharCode(96) + " to inspect the package manifest." };
    expect(relevance("Inspect tool -x package manifest", quoted).band).toBe("weak");
  });

  it("retains file hint entities and does not make an entity-only match unconditional", () => {
    const item = candidate({ content: "InvoiceParser must retain stable operation identity.", appliesWhen: ["Operations have external effects"], nonApplicability: [] });
    const query = buildDiscoveryQuery("Inspect parser behavior", { entityHints: ["InvoiceParser"] });
    expect(assessDiscoveryRelevance(item, buildDiscoveryProfile(item), query)).toMatchObject({
      band: "conditional", matchedEntities: ["InvoiceParser"], unresolvedConditions: ["Operations have external effects"],
    });
  });

  it("keeps legacy lexical knowledge usable without treating generic actions as matches", () => {
    const item = candidate({ content: "Run npm test before merging.", appliesWhen: ["Changing code."], nonApplicability: [] });
    expect(relevance("Run npm test", item).band).toBe("direct");
    expect(relevance("Change the code", item).band).toBe("weak");
    expect(relevance("请运行", item).band).toBe("weak");
  });

  it("requires exclusion qualifiers instead of treating all testing as an exclusion", () => {
    const item = candidate({ content: "Use npm test for tests.", appliesWhen: ["Changing code"], nonApplicability: ["Production database tests", "integration tests"] });
    expect(relevance("Run npm tests", item).band).toBe("direct");
    expect(relevance("Run integration tests", item).band).toBe("weak");
    expect(relevance("Run production database tests", item).band).toBe("weak");
    const conditionalItem = { ...item, appliesWhen: ["When running tests"] };
    const mixed = buildDiscoveryQuery("Run package unit tests, without running integration tests.");
    expect(assessDiscoveryRelevance(conditionalItem, buildDiscoveryProfile(conditionalItem), mixed, { exclusionsChecked: true }).band).toBe("direct");
    const packageValidation = buildDiscoveryQuery("验证刚修改的包代码，不涉及集成测试。");
    expect(packageValidation.negativeConcepts).toContain("testing");
    expect(packageValidation.unqualifiedNegativeConcepts).not.toContain("testing");
  });

  it("keeps negated arbitrary exclusion names out of positive query conditions", () => {
    const item = candidate({ content: "Write documentation in English. 文档使用英语", appliesWhen: ["Changing code"], nonApplicability: ["Historical archives", "历史存档"] });
    for (const prompt of ["补充文档，不涉及历史存档", "补充文档，历史存档保持原样", "Update documentation; do not touch historical archives.", "Update documentation without historical archives."]) {
      expect(relevance(prompt, item).band, prompt).toBe("direct");
    }
    for (const prompt of ["更新历史存档中的文档", "Update historical archives documentation.", "Update documentation, not only historical archives.", "不要跳过历史存档中的文档"]) {
      expect(relevance(prompt, item).band, prompt).toBe("weak");
    }
  });

  it("finds Chinese duplicate-operation paraphrases", () => {
    expect(relevance("如何避免重复执行产生多次写入？").band).toBe("direct");
  });

  it("does not discard a late concrete task in a long introductory query", () => {
    const query = buildDiscoveryQuery("introductory background ".repeat(1_000) + " src/InvoiceParser.ts duplicate writes");
    expect(query.concepts).toContain("duplicate-effects");
    expect(query.entities).toContain("src/InvoiceParser.ts");
    expect(query.terms).toContain("duplicate");
    expect(query.terms.length).toBeLessThanOrEqual(48);
  });
});

describe("discovery provenance and revision binding", () => {
  it("binds semantic fields and source identities, excluding utility and lifecycle changes", () => {
    const item = candidate();
    const digest = knowledgeDiscoveryDigest(item);
    const nonSemantic = candidate({ utility: { applied: 5, helpful: 2, harmful: 0 }, state: "archived", evidenceTier: "disputed", validatedAt: "2026-09-12T00:00:00.000Z" });
    expect(knowledgeDiscoveryDigest(nonSemantic)).toBe(digest);
    for (const material of [candidate({ content: "Changed lesson" }), candidate({ sourceEvidenceIds: ["other-evidence"] }), candidate({ scopeId: "other-repo" }), candidate({ appliesWhen: ["New condition"] })]) {
      expect(knowledgeDiscoveryDigest(material)).not.toBe(digest);
    }
    expect(knowledgeDiscoveryDigest(candidate({ discovery: { producer: "user", purposes: [{ value: "lesson", basisIds: ["content:0"], polarity: "positive" }] } }))).not.toBe(digest);
  });

  it("freezes profiles and rejects tampered or stale profile content", () => {
    const item = candidate();
    const profile = buildDiscoveryProfile(item);
    expect(validateDiscoveryProfile(item, profile)).toBe(true);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.topics)).toBe(true);
    expect(() => profile.topics.push({ value: "testing", basisIds: ["content:0"], polarity: "positive" })).toThrow();
    expect(validateDiscoveryProfile(item, { ...profile, knowledgeDigest: "0".repeat(64) })).toBe(false);
    expect(validateDiscoveryProfile(candidate({ content: "Changed lesson" }), profile)).toBe(false);
  });

  it("requires bound basis, known topics and conditions on positive paraphrases", () => {
    const item = candidate();
    expect(validateDiscoveryMetadata(item, { topics: [{ value: "read-only", basisIds: ["nonApplicability:0"], polarity: "positive" }] })).toBe(false);
    expect(validateDiscoveryMetadata(item, { topics: [{ value: "retries", basisIds: ["missing"], polarity: "positive" }] })).toBe(false);
    expect(validateDiscoveryMetadata(item, { topics: [{ value: "imagined-topic", basisIds: ["content:0"], polarity: "positive" }] })).toBe(false);
    const paraphrase = { value: { language: "zh", text: "有外部副作用时应避免重复写入" }, basisIds: ["content:0"], polarity: "positive" };
    expect(validateDiscoveryMetadata(item, { paraphrases: [paraphrase] })).toBe(false);
    expect(validateDiscoveryMetadata(item, { paraphrases: [{ ...paraphrase, basisIds: ["content:0", "appliesWhen:0"] }] })).toBe(true);
  });

  it("does not accept a self-reported model review and binds an accepted review to both digests", () => {
    const item = candidate();
    const metadata: DiscoveryMetadata = { producer: "model_reviewed", paraphrases: [{
      value: { language: "zh", text: "有外部副作用时应避免重复写入" }, basisIds: ["content:0", "appliesWhen:0"], polarity: "positive",
    }] };
    expect(buildDiscoveryProfile(item, metadata)).toMatchObject({ producer: "deterministic", paraphrases: [] });
    const reviewed = buildDiscoveryProfile(item, metadata, { reviewedBy: "trusted-host-reviewer" });
    expect(reviewed.producer).toBe("model_reviewed");
    expect(reviewed.review).toMatchObject({ discoveryInputDigest: reviewed.discoveryInputDigest, profileDigest: reviewed.profileDigest, accepted: true });
    expect(validateDiscoveryProfile(item, reviewed)).toBe(true);
    expect(validateDiscoveryProfile(item, { ...reviewed, review: { ...reviewed.review, accepted: false } })).toBe(false);
  });

  it("does not amplify negative paraphrase clauses or excluded entities", () => {
    const item = candidate({ content: "Use CurrentParser for queued requests. Not LegacyParser.", appliesWhen: [], nonApplicability: ["Read-only requests"] });
    const metadata: DiscoveryMetadata = { producer: "user", paraphrases: [{
      value: { language: "en", text: "CurrentParser handles queues. Not applicable to read-only requests." }, basisIds: ["content:0", "nonApplicability:0"], polarity: "positive",
    }] };
    const profile = buildDiscoveryProfile(item, metadata);
    expect(profile.paraphrases[0]?.value.text).toContain("read-only");
    expect(discoverySearchText(profile)).not.toContain("read-only");
    expect(discoverySearchText(profile)).not.toContain("LegacyParser");
    expect(discoverySearchText(profile)).toContain("CurrentParser");
    expect(profile.entities).toContainEqual({ value: { kind: "identifier", value: "LegacyParser" }, basisIds: ["content:0"], polarity: "excluded_context" });
    expect(validateDiscoveryMetadata(item, { entities: [{ value: { kind: "identifier", value: "LegacyParser" }, basisIds: ["content:0"], polarity: "positive" }] })).toBe(false);
    expect(buildDiscoveryQuery("Inspect CurrentParser, not LegacyParser").entities).not.toContain("LegacyParser");
  });

  it("validates navigation separately from evidence and forbids directory citations", () => {
    const pointer = { sourceRefId: "incident", kind: "file", locator: "docs/incidents/retry.md", evidenceIds: [], availability: "pointer_only", relationship: "background" };
    expect(sourceReferenceSchema.safeParse(pointer).success).toBe(true);
    expect(sourceReferenceSchema.safeParse({ ...pointer, kind: "directory", locator: "docs/incidents", relationship: "supports" }).success).toBe(false);
    expect(sourceReferenceSchema.safeParse({ ...pointer, kind: "url", locator: "javascript:alert(1)" }).success).toBe(false);
    expect(sourceReferenceSchema.safeParse({ ...pointer, kind: "url", locator: "https://example.com/incidents/1" }).success).toBe(true);
    expect(buildDiscoveryProfile(candidate()).sourceReferences).toEqual([]);
  });

  it("bounds profiles and falls back safely for unusually large legacy content", () => {
    const item = candidate({ content: "legacy text ".repeat(2_000), appliesWhen: Array.from({ length: 40 }, (_, index) => "Required condition " + index + "中文".repeat(3_000)) });
    const profile = buildDiscoveryProfile(item);
    expect(discoveryProfileSchema.safeParse(profile).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(profile))).toBeLessThanOrEqual(65_536);
    expect(discoveryMetadataSchema.safeParse({ topics: Array.from({ length: 9 }, () => ({ value: "testing", basisIds: ["content:0"], polarity: "positive" })) }).success).toBe(false);
  });
});
