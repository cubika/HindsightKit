import {
  discoveryMetadataSchema, discoveryProfileSchema,
  type DiscoveryBasis, type DiscoveryEntity, type DiscoveryFeature, type DiscoveryMetadata,
  type DiscoveryPolarity, type DiscoveryProfile, type ExperiencePurpose, type KnowledgeCandidate,
} from "@provenloop/contracts";
import { sha256 } from "./digest.js";

export const DISCOVERY_VOCABULARY_VERSION = "engineering-2026-09-11.2";
export const DISCOVERY_POLICY_VERSION = "discovery-relevance-1";

export interface DiscoveryConcept {
  readonly id: string; readonly label: string; readonly aliases: readonly string[];
  readonly definition: string; readonly related: readonly string[];
}

const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/** Aliases are equivalent labels; related concepts are one-hop search hints only. */
export const DISCOVERY_VOCABULARY: readonly DiscoveryConcept[] = freeze([
  { id: "retries", label: "Retries", definition: "Attempting an operation again after failure or uncertainty.",
    aliases: ["retry", "retries", "retrying", "reattempt", "try again", "repeat the request", "重试", "重新尝试", "再次请求"],
    related: ["idempotency", "duplicate-effects", "external-effects", "timeouts"] },
  { id: "idempotency", label: "Idempotency", definition: "Repeating an operation preserves the intended effect.",
    aliases: ["idempotency", "idempotent", "idempotency key", "deduplication", "deduplicate", "dedup", "stable operation identity", "幂等", "幂等性", "去重", "稳定操作标识"],
    related: ["retries", "duplicate-effects"] },
  { id: "duplicate-effects", label: "Duplicate effects", definition: "An operation produces its effect more than once.",
    aliases: ["duplicate effect", "duplicate effects", "duplicate write", "duplicate writes", "double write", "double charge", "repeated effect", "repeated effects", "effect only once", "takes effect only once", "exactly once", "重复副作用", "重复写入", "重复执行", "多次写入", "重复扣款", "只生效一次", "仅生效一次", "只执行一次"],
    related: ["idempotency", "retries", "external-effects"] },
  { id: "external-effects", label: "External effects", definition: "An operation changes observable state beyond the caller.",
    aliases: ["external effect", "external effects", "external write", "external writes", "external operation", "external operations", "side effect", "side effects", "side-effect", "side-effects", "duplicate writes", "database write", "mutating operation", "外部副作用", "副作用", "外部写入", "外部操作", "重复写入", "多次写入"],
    related: ["idempotency", "duplicate-effects"] },
  { id: "read-only", label: "Read-only operations", definition: "Operations that only inspect state.",
    aliases: ["read-only", "read only", "readonly", "只读"], related: [] },
  { id: "queues", label: "Queues", definition: "Buffered work consumed asynchronously.",
    aliases: ["queue", "queues", "queued", "queue worker", "message broker", "message consumer", "消息队列", "队列", "消息消费"],
    related: ["at-least-once", "retries", "concurrency"] },
  { id: "caching", label: "Caching", definition: "Reusing previously computed or fetched values.",
    aliases: ["cache", "caches", "cached", "caching", "memoization", "缓存"], related: ["cache-invalidation", "concurrency"] },
  { id: "cache-invalidation", label: "Cache invalidation", definition: "Removing or versioning stale cached values.",
    aliases: ["cache invalidation", "invalidate cache", "stale cache", "stale entries", "revision isolation", "缓存失效", "缓存过期", "缓存一致性"],
    related: ["caching", "concurrency"] },
  { id: "schema-migration", label: "Schema migration", definition: "Changing persisted or exchanged data structure across versions.",
    aliases: ["schema migration", "schema migrations", "database migration", "database migrations", "schema evolution", "数据库迁移", "模式迁移", "表结构变更", "数据结构迁移"],
    related: ["deployment", "concurrency"] },
  { id: "concurrency", label: "Concurrency", definition: "Overlapping operations that may interact through shared state.",
    aliases: ["concurrency", "concurrent", "parallel", "race condition", "race conditions", "locking", "deadlock", "并发", "竞态", "死锁", "互斥"],
    related: ["resource-limits", "idempotency"] },
  { id: "resource-limits", label: "Resource limits", definition: "Bounded CPU, memory, connections or work capacity.",
    aliases: ["resource limit", "resource limits", "memory limit", "out of memory", "connection pool", "rate limit", "backpressure", "capacity limit", "资源限制", "内存限制", "内存耗尽", "连接池", "限流", "背压"],
    related: ["concurrency", "queues"] },
  { id: "testing", label: "Testing", definition: "Checking system behavior against expected outcomes.",
    aliases: ["test", "tests", "testing", "测试"], related: [] },
  { id: "documentation", label: "Documentation", definition: "Written technical material for a project or system.",
    aliases: ["documentation", "document", "documents", "docs", "文档"], related: [] },
  { id: "conversation", label: "Conversation", definition: "Conversational communication with a user.",
    aliases: ["chat", "conversation", "conversationally", "chat communication", "会话", "对话", "交流", "聊天"], related: [] },
  { id: "deployment", label: "Deployment", definition: "Delivering a changed system into a runtime environment.",
    aliases: ["deploy", "deploys", "deployment", "rollout", "rollback", "release pipeline", "部署", "发布", "回滚", "上线"], related: ["schema-migration"] },
  { id: "timeouts", label: "Timeouts", definition: "A caller stops waiting before it knows the final outcome.",
    aliases: ["timeout", "timeouts", "timed out", "ambiguous completion", "response was lost", "lost response", "超时", "响应丢失", "结果不确定"],
    related: ["retries", "duplicate-effects"] },
  { id: "at-least-once", label: "At-least-once delivery", definition: "Delivery can repeat while attempts continue until acknowledgment.",
    aliases: ["at-least-once", "at least once", "redelivery", "redelivered", "至少一次", "重复投递", "重新投递"], related: ["queues", "idempotency", "duplicate-effects"] },
]);

const concepts = new Map(DISCOVERY_VOCABULARY.map((concept) => [concept.id, concept]));
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const escapePattern = (text: string): string => text.replace(/[.*+?^$()|[\]{}\\]/gu, "\\$&");
const patterns = DISCOVERY_VOCABULARY.flatMap((concept) => concept.aliases.map((alias) => ({
  id: concept.id, expression: new RegExp((/^[a-z0-9]/iu.test(alias) ? "(?<![a-z0-9])" : "") + escapePattern(alias) + (/[a-z0-9]$/iu.test(alias) ? "(?![a-z0-9])" : ""), "giu"),
})));

interface ConceptMatch { id: string; start: number; end: number; polarity: "positive" | "negative" | "unknown" }
// Failure-prevention verbs (avoid/prevent) are not absence assertions.
const negativePrefix = /(?:\b(?:not|without|no|never|excluding|except|neither)\b(?:\s+[\p{L}\p{N}_-]+){0,6}\s*|(?:不适用(?:于)?|不涉及|不包含|没有|无需|无(?:任何)?|排除|除了)[^,;。；，.!?\s]{0,16})$/iu;
const unknownSuffix = /^.{0,24}(?:\b(?:unspecified|unknown|unclear|not specified|not known)\b|未指定|未知|不明确|尚不清楚)/iu;

const occurrencePolarity = (text: string, start: number, end: number): ConceptMatch["polarity"] => {
  const prefix = (text.slice(Math.max(0, start - 128), start).split(/[,;。；，.!?]|\b(?:but|however)\b|但是|然而/iu).at(-1) ?? "").slice(-96);
  const suffix = text.slice(end, end + 48).split(/[,;。；，.!?]|\b(?:but|however)\b|但是|然而/iu)[0] ?? "";
  if (/\bnot\s+(?:only|just)(?:\s+[\p{L}\p{N}_-]+){0,5}\s*$/iu.test(prefix) || /(?:不仅|不但)[^，,;；。\n]{0,16}$/u.test(prefix) ||
    /\b(?:not|never)\s+(?:skip|exclude|omit|avoid)\s*$/iu.test(prefix) || /(?:不要|不应|不能)(?:跳过|排除|省略)[^，,;；。\n]{0,8}$/u.test(prefix)) return "positive";
  const negative = negativePrefix.test(prefix) || /^\s+(?:is|are|does|do)\s+not\s+(?:present|used|allowed|apply|exist)/iu.test(suffix) || /^[^\s,;。；，.!?]{0,8}(?:不适用|不存在|不涉及|不包含|保持原样|保持不变)/u.test(suffix);
  return negative ? "negative" : unknownSuffix.test(suffix) ? "unknown" : "positive";
};

const conceptMatches = (text: string): ConceptMatch[] => {
  const matches: ConceptMatch[] = [];
  for (const { id, expression } of patterns) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      const start = match.index;
      matches.push({ id, start, end: start + match[0].length, polarity: occurrencePolarity(text, start, start + match[0].length) });
    }
  }
  return matches.sort((left, right) => left.start - right.start || right.end - left.end || left.id.localeCompare(right.id));
};

const positiveConcepts = (text: string): string[] => unique(conceptMatches(text).filter((match) => match.polarity === "positive").map((match) => match.id));
const negativeConcepts = (text: string): string[] => unique(conceptMatches(text).filter((match) => match.polarity === "negative").map((match) => match.id));

const stopWords = new Set(("a an the and or to of for from in on at by with as is are be been being was were has have had it its this that these those their our your i we you they would could should will can may must need please help how what why when while after before then if only use using used run running change changes changing changed modify modifying modified code coding work working task tasks new system systems design designing implement implementing ensure check checking inspect investigate investigation fix fixing do does doing make making also some all any each other unrelated project projects repository repositories repo relevant context operation operations applicable applies during whenever always writing write" +
  " without no not never except excluded including caller only whenever given has having involved involves concern concerning creating editing user responding later within requires modifies 的 了 在 和 与 为 是 请 如何 怎么 需要 使用 修改 代码 工作 任务 系统 设计 检查 运行 执行 进行 时候 当 然后 如果 之后 之前 相关 项目 仓库").split(/\s+/u));
const normalizeTerm = (term: string): string => {
  const lowered = term.toLowerCase();
  if (lowered === "retries" || lowered === "retrying") return "retry";
  return lowered.length > 4 && lowered.endsWith("s") && !lowered.endsWith("ss") ? lowered.slice(0, -1) : lowered;
};
const terms = (text: string): string[] => {
  const english = [...text.matchAll(/[\p{L}\p{N}_-]+/gu)].map((match) => match[0]).filter((word) => !/\p{Script=Han}/u.test(word));
  const chinese = [...text.matchAll(/[\p{Script=Han}]+/gu)].flatMap((match) => {
    const value = match[0];
    return value.length <= 3 ? [value] : Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
  });
  return unique([...english, ...chinese].map(normalizeTerm).filter((word) => word.length >= 2 && !stopWords.has(word)));
};

const entityValues = (text: string): DiscoveryEntity[] => {
  const result: DiscoveryEntity[] = [];
  const add = (kind: string, value: string) => {
    const cleaned = value.trim().replace(/[.,;:!?]+$/u, "");
    const existing = result.find((item) => item.value === cleaned);
    if (existing?.kind === "literal" && ["command", "flag"].includes(kind)) existing.kind = kind;
    if (cleaned && cleaned.length <= 512 && !existing) result.push({ kind, value: cleaned });
  };
  for (const match of text.matchAll(/\x60([^\x60\n]{1,512})\x60/gu)) add("literal", match[1] ?? "");
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>\x60"()]+/gu)) add("url", match[0]);
  for (const match of text.matchAll(/(?:[A-Za-z]:[\\/]|(?:\.{0,2}[\\/])?)(?:[\w.@-]+[\\/])+[\w.@-]+|\b[\w@.-]+\.(?:ts|tsx|js|jsx|py|json|yaml|yml|md|sql|cs|rs|go)\b/gu)) add("path", match[0]);
  for (const match of text.matchAll(/\b[a-zA-Z][a-zA-Z0-9_-]*\s+(?:--?[a-zA-Z][a-zA-Z0-9_-]*)(?:\s+--?[a-zA-Z][a-zA-Z0-9_-]*)*/gu)) add("command", match[0]);
  for (const match of text.matchAll(/(?:^|\s)(--?[A-Za-z][\w-]*)(?=\s|$|[.,;])/gu)) add("flag", match[1] ?? "");
  for (const match of text.matchAll(/\b(?:[A-Z][a-z]+(?:[A-Z][A-Za-z0-9]*)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{2,}[0-9]*)\b/gu)) add("identifier", match[0]);
  return result.slice(0, 16);
};

const positiveEntityOccurrence = (text: string, value: string): boolean => {
  let position = text.indexOf(value);
  while (position >= 0) {
    if (occurrencePolarity(text, position, position + value.length) === "positive") return true;
    position = text.indexOf(value, position + value.length);
  }
  return false;
};

const positiveTerms = (text: string): string[] => {
  const source = text.toLowerCase();
  return terms(text).filter((term) => {
    const expression = new RegExp(escapePattern(term), "gu");
    for (const match of source.matchAll(expression)) if (occurrencePolarity(source, match.index, match.index + match[0].length) === "positive") return true;
    // Stemming can change a word; retain it only when the original occurrence is positive.
    return [...source.matchAll(/[\p{L}\p{N}_-]+/gu)].some((match) => normalizeTerm(match[0]) === term && occurrencePolarity(source, match.index, match.index + match[0].length) === "positive");
  });
};

const isBroadCondition = (text: string): boolean => terms(text).length === 0 ||
  /^(?:when )?(?:changing|modifying|working on|writing|implementing|editing) (?:the )?(?:repository |project |source )?(?:code|software|files|systems?)[.!]?$/iu.test(text.trim()) ||
  /^(?:修改|编写|开发)(?:仓库|项目)?代码(?:时|后)?[。.]?$/u.test(text.trim());

type SemanticCandidate = Pick<KnowledgeCandidate, "content" | "appliesWhen" | "nonApplicability">;
const canonicalBasis = (candidate: SemanticCandidate): DiscoveryBasis[] => {
  let remainingBytes = 24_576;
  return [
  ...(candidate.content.length <= 8_192 ? [{ id: "content:0", field: "content" as const, clauseIndex: 0, text: candidate.content }] : []),
  ...candidate.appliesWhen.slice(0, 16).flatMap((text, clauseIndex) => text.length <= 8_192 ? [{ id: "appliesWhen:" + clauseIndex, field: "appliesWhen" as const, clauseIndex, text }] : []),
  ...candidate.nonApplicability.slice(0, 16).flatMap((text, clauseIndex) => text.length <= 8_192 ? [{ id: "nonApplicability:" + clauseIndex, field: "nonApplicability" as const, clauseIndex, text }] : []),
  ].filter((basis) => {
    const bytes = Buffer.byteLength(JSON.stringify(basis), "utf8");
    if (basis.text.trim().length === 0 || bytes > remainingBytes) return false;
    remainingBytes -= bytes;
    return true;
  });
};

/** Utility, eligibility state and timestamps do not alter discovery semantics. */
export const knowledgeDiscoveryDigest = (candidate: KnowledgeCandidate): string => sha256({
  version: 1, knowledgeId: candidate.knowledgeId, content: candidate.content, kind: candidate.kind,
  topicKey: candidate.topicKey, appliesWhen: candidate.appliesWhen, nonApplicability: candidate.nonApplicability,
  scope: candidate.scope, scopeId: candidate.scopeId, sourceEpisodeIds: candidate.sourceEpisodeIds, sourceEvidenceIds: candidate.sourceEvidenceIds,
  discovery: candidate.discovery ?? null,
});

/** Deterministic checks supplement independent semantic review; they do not replace it. */
export const validateDiscoveryMetadata = (candidate: SemanticCandidate, metadata: unknown): metadata is DiscoveryMetadata => {
  const parsed = discoveryMetadataSchema.safeParse(metadata);
  if (!parsed.success) return false;
  const value = parsed.data;
  const basis = canonicalBasis(candidate);
  const byId = new Map(basis.map((entry) => [entry.id, entry]));
  const features = [...(value.purposes ?? []), ...(value.topics ?? []), ...(value.entities ?? []), ...(value.paraphrases ?? []), ...(value.shorterSummary ? [value.shorterSummary] : [])];
  for (const feature of features) {
    const supports = feature.basisIds.map((id) => byId.get(id));
    if (unique(feature.basisIds).length !== feature.basisIds.length || supports.some((entry) => entry === undefined)) return false;
    if (feature.polarity !== "excluded_context" && supports.every((entry) => entry?.field === "nonApplicability")) return false;
    if (feature.polarity === "positive" && supports.every((entry) => entry?.field === "appliesWhen")) return false;
  }
  for (const feature of value.topics ?? []) {
    if (!concepts.has(feature.value)) return false;
    if (feature.polarity !== "excluded_context") {
      const matches = feature.basisIds.flatMap((id) => { const entry = byId.get(id); return entry && entry.field !== "nonApplicability" ? conceptMatches(entry.text) : []; }).filter((match) => match.id === feature.value);
      if (matches.length > 0 && matches.every((match) => match.polarity !== "positive")) return false;
    }
  }
  for (const feature of value.entities ?? []) {
    if (!feature.basisIds.some((id) => byId.get(id)?.text.includes(feature.value.value))) return false;
    if (feature.polarity !== "excluded_context" && !feature.basisIds.some((id) => {
      const entry = byId.get(id);
      return entry && entry.field !== "nonApplicability" && positiveEntityOccurrence(entry.text, feature.value.value);
    })) return false;
  }
  const material = basis.filter((entry) => entry.field === "appliesWhen" && !isBroadCondition(entry.text));
  const excludedConcepts = unique(basis.filter((entry) => entry.field === "nonApplicability").flatMap((entry) => positiveConcepts(entry.text)));
  const positiveCanonical = unique(basis.filter((entry) => entry.field !== "nonApplicability").flatMap((entry) => positiveConcepts(entry.text)));
  for (const feature of [...(value.paraphrases ?? []), ...(value.shorterSummary ? [value.shorterSummary] : [])]) {
    if (feature.polarity === "excluded_context") continue;
    if (material.some((entry) => !feature.basisIds.includes(entry.id))) return false;
    const text = typeof feature.value === "string" ? feature.value : feature.value.text;
    if (positiveConcepts(text).some((id) => excludedConcepts.includes(id) && !positiveCanonical.includes(id))) return false;
    if (material.some((entry) => positiveConcepts(entry.text).some((id) => negativeConcepts(text).includes(id)))) return false;
  }
  return true;
};

const purposesFor = (candidate: KnowledgeCandidate, basis: DiscoveryBasis[]): DiscoveryFeature<ExperiencePurpose>[] => {
  if (!basis.some((entry) => entry.id === "content:0")) return [];
  const values: ExperiencePurpose[] = [];
  if (/\b(?:must|always|never|required|requirement|only|shall)\b|必须|不得|只能|禁止/iu.test(candidate.content)) values.push("constraint");
  if (/\b(?:because|tradeoff|trade-off|chosen|selected|rationale)\b|因为|权衡|选择.{0,8}原因/iu.test(candidate.content)) values.push("rationale");
  if (candidate.kind === "episodic" || /\b(?:incident|failed|failure|lesson|avoid|prevent|duplicate|retry)\b|事故|故障|教训|避免|重复/iu.test(candidate.content)) values.push("lesson");
  if (candidate.kind === "procedural") values.push("procedure");
  if (values.length === 0) values.push("fact");
  return unique(values).slice(0, 2).map((value) => ({ value, basisIds: ["content:0"], polarity: "positive" }));
};

export interface DiscoveryBuildOptions { reviewedBy?: string; reviewVersion?: string }

export const buildDiscoveryProfile = (
  candidate: KnowledgeCandidate, metadata?: DiscoveryMetadata, options: DiscoveryBuildOptions = {},
): DiscoveryProfile => {
  const basis = canonicalBasis(candidate);
  const topics: DiscoveryProfile["topics"] = [];
  const entities: DiscoveryProfile["entities"] = [];
  for (const entry of basis) {
    for (const match of conceptMatches(entry.text)) {
      if (match.polarity === "unknown") continue;
      const polarity: DiscoveryPolarity = entry.field === "nonApplicability" || match.polarity === "negative" ? "excluded_context" : entry.field === "appliesWhen" ? "required_condition" : "positive";
      const existing = topics.find((feature) => feature.value === match.id && feature.polarity === polarity);
      if (existing) { if (!existing.basisIds.includes(entry.id)) existing.basisIds.push(entry.id); }
      else topics.push({ value: match.id, basisIds: [entry.id], polarity });
    }
    for (const value of entityValues(entry.text)) {
      const polarity: DiscoveryPolarity = entry.field === "nonApplicability" || !positiveEntityOccurrence(entry.text, value.value) ? "excluded_context" : entry.field === "appliesWhen" ? "required_condition" : "positive";
      const existing = entities.find((feature) => feature.value.value === value.value && feature.polarity === polarity);
      if (existing) { if (!existing.basisIds.includes(entry.id)) existing.basisIds.push(entry.id); }
      else entities.push({ value, basisIds: [entry.id], polarity });
    }
  }
  // Canonical conditions are assessed separately even when the discovery facet budget is full.
  const checkedMetadata = metadata && validateDiscoveryMetadata(candidate, metadata) ? discoveryMetadataSchema.parse(metadata) : undefined;
  const requestedProducer = checkedMetadata?.producer ?? "model_reviewed";
  const acceptedMetadata = checkedMetadata && (requestedProducer === "user" || Boolean(options.reviewedBy)) ? checkedMetadata : undefined;
  const producer = acceptedMetadata ? requestedProducer === "user" ? "user" as const : "model_reviewed" as const : "deterministic" as const;
  const features = {
    purposes: acceptedMetadata?.purposes ?? purposesFor(candidate, basis),
    topics: acceptedMetadata?.topics ?? topics.slice(0, 8), entities: acceptedMetadata?.entities ?? entities.slice(0, 16),
    paraphrases: acceptedMetadata?.paraphrases ?? [],
    ...(acceptedMetadata?.shorterSummary ? { shorterSummary: acceptedMetadata.shorterSummary } : {}),
    sourceReferences: acceptedMetadata?.sourceReferences ?? [],
  };
  const knowledgeDigest = knowledgeDiscoveryDigest(candidate);
  const discoveryInputDigest = sha256({ knowledgeDigest, vocabularyVersion: DISCOVERY_VOCABULARY_VERSION, metadata: acceptedMetadata ?? null });
  const result = discoveryProfileSchema.safeParse({ schemaVersion: 1, knowledgeId: candidate.knowledgeId, knowledgeDigest,
    vocabularyVersion: DISCOVERY_VOCABULARY_VERSION, ...features, basis, producer, discoveryInputDigest, profileDigest: "0".repeat(64) });
  if (!result.success && acceptedMetadata) return buildDiscoveryProfile(candidate);
  const parsed = result.success ? result.data : discoveryProfileSchema.parse({ schemaVersion: 1, knowledgeId: candidate.knowledgeId.slice(0, 256), knowledgeDigest,
    vocabularyVersion: DISCOVERY_VOCABULARY_VERSION, purposes: [], topics: [], entities: [], paraphrases: [], sourceReferences: [], basis: [],
    producer: "deterministic", discoveryInputDigest, profileDigest: "0".repeat(64) });
  const bound = { schemaVersion: parsed.schemaVersion, knowledgeId: parsed.knowledgeId, knowledgeDigest: parsed.knowledgeDigest,
    vocabularyVersion: parsed.vocabularyVersion, purposes: parsed.purposes, topics: parsed.topics, entities: parsed.entities,
    paraphrases: parsed.paraphrases, ...(parsed.shorterSummary ? { shorterSummary: parsed.shorterSummary } : {}),
    sourceReferences: parsed.sourceReferences, basis: parsed.basis, producer: parsed.producer, discoveryInputDigest: parsed.discoveryInputDigest };
  const profileDigest = sha256(bound);
  const review = producer === "model_reviewed" ? (() => {
    const receipt = { discoveryInputDigest, profileDigest, reviewVersion: options.reviewVersion ?? "discovery-review-1", reviewer: options.reviewedBy ?? "", accepted: true };
    return { ...receipt, reviewDigest: sha256(receipt) };
  })() : undefined;
  return freeze(discoveryProfileSchema.parse({ ...bound, profileDigest, ...(review ? { review } : {}) }));
};

export const validateDiscoveryProfile = (candidate: KnowledgeCandidate, profile: unknown): profile is DiscoveryProfile => {
  const parsed = discoveryProfileSchema.safeParse(profile);
  if (!parsed.success || sha256(parsed.data) !== sha256(profile)) return false;
  const { profileDigest, review, ...bound } = parsed.data;
  if (bound.knowledgeId !== candidate.knowledgeId || bound.knowledgeDigest !== knowledgeDiscoveryDigest(candidate) || bound.vocabularyVersion !== DISCOVERY_VOCABULARY_VERSION || sha256(bound) !== profileDigest) return false;
  if (sha256(bound.basis) !== sha256(canonicalBasis(candidate))) return false;
  if (!validateDiscoveryMetadata(candidate, { purposes: bound.purposes, topics: bound.topics, entities: bound.entities, paraphrases: bound.paraphrases, ...(bound.shorterSummary ? { shorterSummary: bound.shorterSummary } : {}), sourceReferences: bound.sourceReferences })) return false;
  if (bound.producer === "model_reviewed") {
    if (!review) return false;
    const { reviewDigest, ...receipt } = review;
    if (!receipt.accepted || receipt.discoveryInputDigest !== bound.discoveryInputDigest || receipt.profileDigest !== profileDigest || reviewDigest !== sha256(receipt)) return false;
  }
  return true;
};

export const discoveryConceptToken = (id: string): string => "plconcept_" + id.replace(/[^a-z0-9]/giu, "_").toLowerCase();

// Keep supported prose intact in the profile; only positive clauses become phrase postings.
const positivePhrasePostings = (text: string): string[] => text.split(/[;。；.!?]|\b(?:but|however)\b|但是|然而/iu)
  .map((clause) => clause.trim())
  .filter((clause) => clause.length > 0 && !/(?:\b(?:not|without|no|never|neither|except|excluding|excluded|unspecified|unknown|unclear)\b|不适用|不涉及|不包含|没有|无需|排除|除了|未知|不明确|尚不清楚)/iu.test(clause));

/** Exclusion-only contexts never enter the positive concept or phrase postings. */
export const discoverySearchText = (profile: DiscoveryProfile): string => unique([
  ...profile.topics.filter((feature) => feature.polarity !== "excluded_context").flatMap((feature) => {
    const concept = concepts.get(feature.value);
    return concept ? [discoveryConceptToken(concept.id), ...concept.aliases] : [];
  }),
  ...profile.entities.filter((feature) => feature.polarity !== "excluded_context").map((feature) => feature.value.value),
  ...profile.paraphrases.filter((feature) => feature.polarity !== "excluded_context").flatMap((feature) => positivePhrasePostings(feature.value.text)),
]).join(" ");

export interface DiscoveryQuery {
  concepts: string[]; relatedConcepts: string[]; entities: string[]; negativeConcepts: string[]; terms: string[]; signature: string;
  unqualifiedNegativeConcepts?: string[];
}
export interface DiscoveryQueryHints { conceptHints?: readonly string[]; entityHints?: readonly string[] }

export const buildDiscoveryQuery = (text: string, hints: DiscoveryQueryHints = {}): DiscoveryQuery => {
  const bounded = text.length <= 16_384 ? text : text.slice(0, 8_192) + " " + text.slice(-8_192);
  const matches = conceptMatches(bounded);
  const positive = unique(matches.filter((match) => match.polarity === "positive").map((match) => match.id)).slice(0, 8);
  const negative = unique(matches.filter((match) => match.polarity === "negative").map((match) => match.id)).slice(0, 8);
  const unqualifiedNegative = unique(matches.filter((match) => match.polarity === "negative" &&
    !(match.id === "testing" && /(?:\b(?:unit|integration|regression)\s+|单元|集成|回归)$/iu.test(bounded.slice(Math.max(0, match.start - 32), match.start))))
    .map((match) => match.id)).slice(0, 8);
  const hinted = (hints.conceptHints ?? []).slice(0, 8).flatMap((hint) => concepts.has(hint) ? [hint] : positiveConcepts(hint));
  const related = unique([...hinted, ...positive.flatMap((id) => concepts.get(id)?.related ?? [])]).filter((id) => !positive.includes(id) && !negative.includes(id)).slice(0, 4);
  const literal = unique([...(hints.entityHints ?? []).slice(0, 8).filter((hint) => hint.length > 0 && hint.length <= 512), ...entityValues(bounded).filter((entity) => positiveEntityOccurrence(bounded, entity.value)).map((entity) => entity.value)]).slice(0, 16);
  const queryTerms = positiveTerms(bounded);
  const reservedTerms = unique([...queryTerms.slice(0, 24), ...queryTerms.slice(-24)]);
  const features = { concepts: positive, relatedConcepts: related, entities: literal, negativeConcepts: negative, unqualifiedNegativeConcepts: unqualifiedNegative, terms: reservedTerms };
  const signature = sha256({ version: DISCOVERY_POLICY_VERSION, concepts: [...positive].sort(), negativeConcepts: [...negative].sort(), entities: [...literal].sort(), terms: [...reservedTerms].sort() });
  return { ...features, signature };
};

export interface DiscoveryRelevance {
  band: "direct" | "conditional" | "weak"; score: number; matchedConcepts: string[];
  matchedEntities: string[]; unresolvedConditions: string[]; reasons: string[];
}

const establishesClause = (text: string, query: DiscoveryQuery): boolean => {
  const positive = positiveConcepts(text);
  const negative = negativeConcepts(text);
  if (positive.some((id) => !query.concepts.includes(id)) || negative.some((id) => !query.negativeConcepts.includes(id))) return false;
  const exact = entityValues(text);
  if (exact.some((entity) => !query.entities.includes(entity.value))) return false;
  const conceptCovered = Array.from(text);
  for (const match of conceptMatches(text)) for (let index = match.start; index < match.end; index += 1) conceptCovered[index] = " ";
  const required = terms(conceptCovered.join("")).filter((word) => !exact.some((entity) => terms(entity.value).includes(word)));
  if (positive.length + negative.length > 0) return required.every((word) => query.terms.includes(word));
  if (required.length === 0) return exact.length > 0;
  return required.filter((word) => query.terms.includes(word)).length >= Math.min(2, required.length);
};

export const assessDiscoveryRelevance = (candidate: KnowledgeCandidate, profile: DiscoveryProfile, query: DiscoveryQuery, options: { exclusionsChecked?: boolean; applicabilityQuery?: DiscoveryQuery } = {}): DiscoveryRelevance => {
  const applicability = options.applicabilityQuery ?? query;
  const matchedConcepts = unique(profile.topics.filter((feature) => feature.polarity !== "excluded_context" && query.concepts.includes(feature.value)).map((feature) => feature.value));
  const related = unique(profile.topics.filter((feature) => feature.polarity !== "excluded_context" && query.relatedConcepts.includes(feature.value)).map((feature) => feature.value));
  const matchedEntities = unique(profile.entities.filter((feature) => feature.polarity !== "excluded_context" && query.entities.includes(feature.value.value)).map((feature) => feature.value.value));
  const semanticTerms = terms([candidate.content, ...candidate.appliesWhen, ...profile.paraphrases.filter((feature) => feature.polarity !== "excluded_context").map((feature) => feature.value.text)].join(" "));
  const matchedTerms = semanticTerms.filter((word) => query.terms.includes(word));
  const unresolvedConditions = candidate.appliesWhen.filter((clause) => !isBroadCondition(clause) && !establishesClause(clause, applicability));
  const reasons: string[] = [];
  const result = (band: DiscoveryRelevance["band"]): DiscoveryRelevance => ({ band,
    score: band === "weak" ? Math.min(29, matchedTerms.length * 2 + related.length * 3) :
      Math.min(band === "direct" ? 100 : 69, (band === "direct" ? 75 : 40) + matchedConcepts.length * 8 + matchedEntities.length * 10 + Math.min(12, matchedTerms.length * 2)),
    matchedConcepts, matchedEntities, unresolvedConditions, reasons });
  if (profile.knowledgeDigest !== knowledgeDiscoveryDigest(candidate)) { reasons.push("Discovery profile is stale for the canonical knowledge revision."); return result("weak"); }
  for (const clause of options.exclusionsChecked ? [] : candidate.nonApplicability) {
    if (/^(?:do not|don['’]t|must not|never|preserve|keep|不要|不得|保留|保持)\b/iu.test(clause.trim()) && !/apply|适用/iu.test(clause)) continue;
    if (!isBroadCondition(clause) && establishesClause(clause, applicability)) { reasons.push("Excluded context: " + clause); return result("weak"); }
  }
  const requiredConcepts = candidate.appliesWhen.flatMap(positiveConcepts);
  const contradicted = unique(requiredConcepts.filter((id) => (applicability.unqualifiedNegativeConcepts ?? applicability.negativeConcepts).includes(id) && !applicability.concepts.includes(id)));
  if (contradicted.length > 0 || (requiredConcepts.includes("external-effects") && applicability.concepts.includes("read-only"))) {
    reasons.push("Task contradicts a required condition: " + (contradicted.join(", ") || "external effects versus read-only operation") + "."); return result("weak");
  }
  const contentNegative = negativeConcepts(candidate.content).filter((id) => !positiveConcepts(candidate.content).includes(id));
  if (contentNegative.some((id) => applicability.concepts.includes(id))) { reasons.push("The task matches an excluded context in the saved content."); return result("weak"); }
  const candidateCommands = profile.entities.filter((feature) => feature.polarity !== "excluded_context" && ["command", "flag"].includes(feature.value.kind)).map((feature) => feature.value.value);
  if (candidateCommands.some((entity) => applicability.entities.some((literal) => literal.toLowerCase() === entity.toLowerCase() && literal !== entity)) && !candidateCommands.some((entity) => applicability.entities.includes(entity))) {
    reasons.push("A case-sensitive command or flag differs from the saved operation."); return result("weak");
  }
  if (requiredConcepts.includes("external-effects") && applicability.concepts.includes("testing") && !applicability.concepts.includes("external-effects")) {
    reasons.push("A testing-only match does not establish external-effect applicability."); return result("weak");
  }
  if (matchedConcepts.length === 0 && matchedEntities.length === 0 && matchedTerms.length === 0) { reasons.push(related.length > 0 ? "Only a related concept matches; task support is still missing." : "No supported problem, operation or exact entity matches."); return result("weak"); }
  const subjectMatches = conceptMatches(candidate.content).filter((match) => match.polarity === "positive");
  const firstConceptOffset = subjectMatches[0]?.start;
  const subjectKinds = new Set(["caching", "cache-invalidation", "queues", "schema-migration", "documentation", "conversation", "resource-limits", "testing"]);
  const subjectConcepts = unique(subjectMatches.filter((match) => match.start === firstConceptOffset && subjectKinds.has(match.id)).map((match) => match.id));
  if (matchedEntities.length === 0 && subjectConcepts.length > 0 &&
      !subjectConcepts.some((id) => query.concepts.includes(id) || query.relatedConcepts.includes(id)) &&
      matchedConcepts.length < 2 && matchedTerms.length < 2) {
    reasons.push("Only incidental wording or a secondary mechanism matches; the saved problem is not established."); return result("weak");
  }
  if (matchedConcepts.length > 0) reasons.push("Shared concepts: " + matchedConcepts.join(", ") + ".");
  if (matchedEntities.length > 0) reasons.push("Exact entities: " + matchedEntities.join(", ") + ".");
  if (matchedTerms.length > 0) reasons.push("Shared task terms: " + matchedTerms.slice(0, 8).join(", ") + ".");
  if (unresolvedConditions.length > 0) { reasons.push("Material applicability conditions remain unresolved."); return result("conditional"); }
  return result("direct");
};
