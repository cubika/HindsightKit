import { performance } from "node:perf_hooks";
import { z } from "zod";
import { knowledgeCandidateSchema, type KnowledgeCandidate } from "@provenloop/contracts";
import { sha256 } from "@provenloop/domain";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { ContextRetrievalService, KnowledgeProjectionManager, SqliteFtsKnowledgeBackend,
  type KnowledgeBackend, type KnowledgeProjection, type KnowledgeQuery, type KnowledgeRecord } from "@provenloop/retrieval";

const id = z.string().trim().min(1).max(256);
export const experienceRetrievalCorpusSchema = z.object({
  schemaVersion: z.literal(1), name: id, sourceKind: z.enum(["synthetic", "local_labeled"]),
  asOf: z.string().datetime({ offset: true }),
  labelSource: z.string().trim().min(1).max(512),
  knowledge: z.array(knowledgeCandidateSchema).min(1).max(512),
  queries: z.array(z.object({
    id, text: z.string().trim().min(1).max(16_384), repoId: id, cwd: z.string().trim().min(1).max(2_048),
    relevantKnowledgeIds: z.array(id).max(64),
    strata: z.array(z.enum(["literal", "paraphrase", "bilingual", "negative", "exact_entity", "scope", "lifecycle", "conditional"])).min(1).max(8),
    fileHints: z.array(z.string().min(1).max(512)).max(8).optional(),
  }).strict()).min(1).max(1_024),
}).strict().superRefine((corpus, context) => {
  const ids = new Set(corpus.knowledge.map((candidate) => candidate.knowledgeId));
  if (ids.size !== corpus.knowledge.length || new Set(corpus.queries.map((query) => query.id)).size !== corpus.queries.length) {
    context.addIssue({ code: "custom", message: "Corpus knowledge and query IDs must be unique." });
  }
  for (const query of corpus.queries) if (new Set(query.relevantKnowledgeIds).size !== query.relevantKnowledgeIds.length ||
      query.relevantKnowledgeIds.some((value) => !ids.has(value))) {
    context.addIssue({ code: "custom", message: "Each relevance label must identify one unique corpus item." });
  }
  if (Buffer.byteLength(JSON.stringify(corpus), "utf8") > 16 * 1024 * 1024) context.addIssue({ code: "custom", message: "Corpus exceeds 16 MiB." });
});
export type ExperienceRetrievalCorpus = z.infer<typeof experienceRetrievalCorpusSchema>;
export type ExperienceRetrievalQuery = ExperienceRetrievalCorpus["queries"][number];
export interface ExperienceRetrievalObservation {
  readonly candidateIds: readonly string[]; readonly returnedIds: readonly string[];
  readonly latencyMs: number; readonly degraded: boolean;
}
export type ExperienceRetrievalRunner = (query: ExperienceRetrievalQuery) => Promise<ExperienceRetrievalObservation>;
export interface ExperienceRetrievalCaseResult extends ExperienceRetrievalObservation {
  readonly queryId: string; readonly relevantIds: readonly string[]; readonly strata: readonly string[];
  readonly retrievedRelevant: number; readonly returnedRelevant: number; readonly top3Relevant: number;
  readonly error?: "retrieval_failed" | "invalid_observation";
}
export interface ExperienceRetrievalMetrics {
  readonly queries: number; readonly applicableQueries: number; readonly negativeQueries: number;
  readonly candidateRecall: number | null; readonly returnedItemPrecision: number | null;
  readonly precisionAt3: number | null; readonly hitCoverage: number | null;
  readonly irrelevantInjectionRate: number; readonly negativeQueryInjectionRate: number | null;
  readonly returnedItems: number; readonly relevantReturnedItems: number;
  readonly meanLatencyMs: number; readonly p50LatencyMs: number; readonly p95LatencyMs: number;
  readonly degradedQueries: number; readonly failedQueries: number;
}
export interface ExperienceRetrievalReport {
  readonly schemaVersion: 1; readonly evidenceKind: "local_retrieval_ablation"; readonly corpusName: string;
  readonly sourceKind: ExperienceRetrievalCorpus["sourceKind"]; readonly labelSource: string; readonly corpusDigest: string;
  readonly startedAt: string; readonly completedAt: string; readonly limitations: readonly string[];
  readonly metricDefinitions: Readonly<Record<string, string>>;
  readonly current: { readonly metrics: ExperienceRetrievalMetrics; readonly cases: readonly ExperienceRetrievalCaseResult[] };
  readonly lexicalBaseline: { readonly metrics: ExperienceRetrievalMetrics; readonly cases: readonly ExperienceRetrievalCaseResult[] };
  readonly strata: Readonly<Record<string, { readonly current: ExperienceRetrievalMetrics; readonly lexicalBaseline: ExperienceRetrievalMetrics }>>;
}
const ratio = (numerator: number, denominator: number): number | null => denominator === 0 ? null : numerator / denominator;
const unique = (values: readonly string[]): string[] => [...new Set(values)];
const metrics = (cases: readonly ExperienceRetrievalCaseResult[]): ExperienceRetrievalMetrics => {
  const applicable = cases.filter((entry) => entry.relevantIds.length > 0);
  const negative = cases.filter((entry) => entry.relevantIds.length === 0);
  const latency = cases.map((entry) => entry.latencyMs).sort((left, right) => left - right);
  const sum = (fn: (entry: ExperienceRetrievalCaseResult) => number): number => cases.reduce((value, entry) => value + fn(entry), 0);
  const returnedItems = sum((entry) => entry.returnedIds.length);
  const relevantReturnedItems = sum((entry) => entry.returnedRelevant);
  return { queries: cases.length, applicableQueries: applicable.length, negativeQueries: negative.length,
    candidateRecall: ratio(sum((entry) => entry.retrievedRelevant), sum((entry) => entry.relevantIds.length)),
    returnedItemPrecision: ratio(relevantReturnedItems, returnedItems),
    precisionAt3: ratio(applicable.reduce((value, entry) => value + entry.top3Relevant, 0), applicable.length * 3),
    hitCoverage: ratio(applicable.filter((entry) => entry.returnedRelevant > 0).length, applicable.length),
    irrelevantInjectionRate: cases.filter((entry) => entry.returnedIds.length > entry.returnedRelevant).length / cases.length,
    negativeQueryInjectionRate: ratio(negative.filter((entry) => entry.returnedIds.length > 0).length, negative.length),
    returnedItems, relevantReturnedItems, meanLatencyMs: sum((entry) => entry.latencyMs) / cases.length,
    p50LatencyMs: latency[Math.max(0, Math.ceil(latency.length * 0.5) - 1)] ?? 0,
    p95LatencyMs: latency[Math.max(0, Math.ceil(latency.length * 0.95) - 1)] ?? 0,
    degradedQueries: cases.filter((entry) => entry.degraded).length, failedQueries: cases.filter((entry) => entry.error).length };
};

/** Labels are supplied before retrieval. Returned text cannot change the expected answers. */
export const evaluateExperienceRetrieval = async (input: ExperienceRetrievalCorpus, options: {
  readonly current: ExperienceRetrievalRunner; readonly lexicalBaseline: ExperienceRetrievalRunner; readonly now?: () => Date;
}): Promise<ExperienceRetrievalReport> => {
  const corpus = experienceRetrievalCorpusSchema.parse(input);
  const now = options.now ?? (() => new Date()); const startedAt = now().toISOString();
  const known = new Set(corpus.knowledge.map((candidate) => candidate.knowledgeId));
  const run = async (query: ExperienceRetrievalQuery, runner: ExperienceRetrievalRunner): Promise<ExperienceRetrievalCaseResult> => {
    const start = performance.now();
    let observation: ExperienceRetrievalObservation; let error: ExperienceRetrievalCaseResult["error"];
    try {
      const output = await runner(structuredClone(query));
      if (!Array.isArray(output.candidateIds) || !Array.isArray(output.returnedIds) ||
          output.candidateIds.length > 10_000 || output.returnedIds.length > 60 ||
          ![...output.candidateIds, ...output.returnedIds].every((value) => known.has(value)) ||
          !Number.isFinite(output.latencyMs) || output.latencyMs < 0 || typeof output.degraded !== "boolean" ||
          output.returnedIds.some((value) => !output.candidateIds.includes(value))) {
        error = "invalid_observation"; throw new Error("Invalid local retrieval observation.");
      }
      observation = { ...output, candidateIds: unique(output.candidateIds), returnedIds: unique(output.returnedIds) };
    } catch {
      observation = { candidateIds: [], returnedIds: [], latencyMs: performance.now() - start, degraded: true };
      error ??= "retrieval_failed";
    }
    const relevant = new Set(query.relevantKnowledgeIds);
    return { ...observation, queryId: query.id, relevantIds: query.relevantKnowledgeIds, strata: query.strata,
      retrievedRelevant: observation.candidateIds.filter((value) => relevant.has(value)).length,
      returnedRelevant: observation.returnedIds.filter((value) => relevant.has(value)).length,
      top3Relevant: observation.returnedIds.slice(0, 3).filter((value) => relevant.has(value)).length, ...(error ? { error } : {}) };
  };
  const current: ExperienceRetrievalCaseResult[] = []; const baseline: ExperienceRetrievalCaseResult[] = [];
  for (const [index, query] of corpus.queries.entries()) {
    // Alternate execution order so one strategy does not always run first.
    if (index % 2 === 0) { current.push(await run(query, options.current)); baseline.push(await run(query, options.lexicalBaseline)); }
    else { baseline.push(await run(query, options.lexicalBaseline)); current.push(await run(query, options.current)); }
  }
  return { schemaVersion: 1, evidenceKind: "local_retrieval_ablation", corpusName: corpus.name, sourceKind: corpus.sourceKind,
    labelSource: corpus.labelSource, corpusDigest: sha256(corpus), startedAt, completedAt: now().toISOString(),
    limitations: [corpus.sourceKind === "synthetic" ? "Synthetic author-labeled regression cases; this is not a real incident corpus or field acceptance evidence." :
      "Local labels are caller-supplied; this run does not independently certify their correctness.",
      "The built-in baseline disables concept discovery postings and requests while retaining current canonical admission, applicability and ranking. It is not a replay of a historical product binary.",
      "The built-in replay makes no network requests or live source reads. Injected runners must provide local observations. Candidate recall measures backend shortlist IDs before canonical admission.",
      "The built-in replay loads candidate snapshots without captured evidence or learned proposal records; source-backed learned candidates need an injected runner with their complete canonical snapshot.",
      "Latency covers each local request after backend setup and warmup; it does not measure installed-host startup or production tail latency."],
    metricDefinitions: { candidateRecall: "Relevant IDs in the backend shortlist / all labeled relevant IDs (micro average).",
      returnedItemPrecision: "Relevant returned items / all returned items; null when no items are returned.",
      precisionAt3: "Relevant items in the first three positions / (3 * applicable queries); unfilled positions score zero.",
      hitCoverage: "Applicable queries returning at least one relevant item / applicable queries.",
      irrelevantInjectionRate: "Queries returning any unlabeled item / all queries.",
      negativeQueryInjectionRate: "Queries with no relevant labels that return any item / all negative queries." },
    current: { metrics: metrics(current), cases: current }, lexicalBaseline: { metrics: metrics(baseline), cases: baseline },
    strata: Object.fromEntries(unique(corpus.queries.flatMap((query) => query.strata)).sort().map((stratum) => [stratum, {
      current: metrics(current.filter((entry) => entry.strata.includes(stratum))),
      lexicalBaseline: metrics(baseline.filter((entry) => entry.strata.includes(stratum))),
    }])) };
};

/** Run the real local context service over an isolated canonical snapshot. */
export const runLocalExperienceRetrievalEvaluation = async (input: ExperienceRetrievalCorpus = createSyntheticExperienceRetrievalCorpus()): Promise<ExperienceRetrievalReport> => {
  const corpus = experienceRetrievalCorpusSchema.parse(input);
  const resources: { store: CanonicalSqliteStore; backend: SqliteFtsKnowledgeBackend }[] = [];
  const prepare = async (lexical: boolean): Promise<ExperienceRetrievalRunner> => {
    const store = new CanonicalSqliteStore(":memory:"); const backend = new SqliteFtsKnowledgeBackend(":memory:"); resources.push({ store, backend });
    store.upsertKnowledgeCandidates(corpus.knowledge);
    let observed: string[] = [];
    const project = (records: readonly KnowledgeProjection[]): readonly KnowledgeProjection[] => !lexical ? records : records.map((record) => {
      const { discoveryProfile: _profile, ...plain } = record; void _profile; return plain;
    });
    const search = async (query: KnowledgeQuery, timeout?: number): Promise<readonly KnowledgeRecord[]> => {
      if (lexical && /(?:^|\s)plconcept_/u.test(query.text)) return [];
      const result = timeout === undefined ? await backend.search(query) : await backend.searchWithTimeout(query, timeout);
      observed.push(...result.map((record) => record.knowledgeId)); return result;
    };
    const instrumented: KnowledgeBackend = {
      get: (value) => backend.get(value), health: () => backend.health(), healthWithTimeout: (timeout) => backend.healthWithTimeout(timeout),
      index: (records) => backend.index(project(records)), rebuild: (snapshot) => backend.rebuild({ records: project(snapshot.records) }),
      synchronize: (snapshot) => backend.synchronize({ records: project(snapshot.records) }), remove: (values) => backend.remove(values),
      search: (query) => search(query), searchWithTimeout: (query, timeout) => search(query, timeout),
    };
    await new KnowledgeProjectionManager({ backend: instrumented, store }).rebuild();
    await backend.healthWithTimeout(5_000);
    const service = new ContextRetrievalService({ backend: instrumented, store, timeoutMs: 5_000, now: () => new Date(corpus.asOf) });
    let sequence = 0;
    return async (query) => {
      observed = [];
      const response = await service.context({ prompt: query.text, repoId: query.repoId, cwd: query.cwd,
        sessionId: "experience-evaluation-" + sequence++, tokenBudget: 1_200, ...(query.fileHints ? { fileHints: query.fileHints } : {}) });
      return { candidateIds: unique(observed), returnedIds: response.items.filter((item) => item.kind === "knowledge").map((item) => item.id),
        latencyMs: response.latencyMs, degraded: response.status === "degraded" };
    };
  };
  try {
    const current = await prepare(false); const lexicalBaseline = await prepare(true);
    return await evaluateExperienceRetrieval(corpus, { current, lexicalBaseline });
  } finally {
    for (const { store, backend } of resources.reverse()) { await backend.closeAsync(); store.close(); }
  }
};

export const createSyntheticExperienceRetrievalCorpus = (): ExperienceRetrievalCorpus => {
  const candidate = (knowledgeId: string, content: string, appliesWhen = "Changing code.", options: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate => ({
    schemaVersion: 1, knowledgeId, content, appliesWhen: [appliesWhen], nonApplicability: [], conflictsWith: [],
    kind: "semantic", scope: "repository", scopeId: "repo", createdAt: "2026-09-01T00:00:00.000Z",
    topicKey: knowledgeId, sourceEpisodeIds: [], sourceEvidenceIds: [], evidenceMarks: ["user_confirmed"],
    evidenceTier: "user_confirmed", state: "active", importance: 1, utility: { applied: 0, helpful: 0, harmful: 0 },
    coverage: { applicableOpportunities: 0, observedOutcomes: 0 }, ...options,
  });
  const knowledge = [
    candidate("duplicate-write", "Use an idempotency key so external writes cannot produce duplicate effects.", "Retrying external writes.", { nonApplicability: ["Read-only health checks"] }),
    candidate("cache-revision", "Cache invalidation requires a revision key to isolate stale entries."),
    candidate("migration", "Schema migration must keep old readers compatible until deployment completes."),
    candidate("pool", "Bound connection pool concurrency and apply backpressure before exhausting resources."),
    candidate("queue", "Queue consumers must tolerate redelivery with a stable operation identity."),
    candidate("upper-flag", "Use `tool -X` to inspect the package manifest."),
    candidate("lower-flag", "Use `tool -x` to extract the package archive."),
    candidate("error-code", "Handle ERR_WIDGET_STALE by rebuilding the widget revision cache."),
    candidate("parser", "InvoiceParser must stream rows from src/InvoiceParser.ts instead of buffering the whole file."),
    candidate("unit-tests", "Run unit tests for the changed module before merging."),
    candidate("rollback", "Deployment rollback must restore the previous schema-compatible build."),
    candidate("chinese-cache", "缓存条目必须保存版本信息，失效时重新读取。"),
    candidate("another-repo", "InvoiceParser in this repository uses a schema-generated decoder.", "Changing code.", { scopeId: "other" }),
    candidate("archived", "LegacyGate requires archived deployment configuration.", "Changing code.", { state: "archived" }),
    candidate("expired", "ExpiredGate requires the old concurrency limit.", "Changing code.", { expiresAt: "2026-09-02T00:00:00.000Z" }),
  ];
  const query = (id: string, text: string, relevantKnowledgeIds: string[], strata: ExperienceRetrievalQuery["strata"],
    overrides: Partial<ExperienceRetrievalQuery> = {}): ExperienceRetrievalQuery => ({ id, text, relevantKnowledgeIds, strata, repoId: "repo", cwd: "C:/repo", ...overrides });
  return experienceRetrievalCorpusSchema.parse({ schemaVersion: 1, name: "engineering-discovery-synthetic-v1", sourceKind: "synthetic",
    asOf: "2026-09-11T12:00:00.000Z",
    labelSource: "Author-supplied synthetic regression labels; no independent human field review.", knowledge, queries: [
      query("literal-retry", "Use an idempotency key when retrying external writes", ["duplicate-write"], ["literal"]),
      query("zh-write", "外部写入重试如何避免重复副作用", ["duplicate-write"], ["bilingual", "paraphrase"]),
      query("retry-design", "Design retries after an ambiguous timeout for an external operation", ["duplicate-write"], ["paraphrase", "conditional"]),
      query("readonly", "Retrying read-only health checks without external writes", [], ["negative", "conditional"]),
      query("literal-cache", "Cache invalidation and stale entries", ["cache-revision", "chinese-cache", "error-code"], ["literal"]),
      query("zh-cache", "缓存失效时如何处理旧版本条目", ["cache-revision", "chinese-cache", "error-code"], ["bilingual"]),
      query("migration-en", "Schema migration during deployment", ["migration", "rollback"], ["literal"]),
      query("migration-zh", "数据库迁移上线要保留旧读者兼容性", ["migration", "rollback"], ["bilingual", "paraphrase"]),
      query("pool", "Connection pool concurrency and backpressure", ["pool"], ["literal"]),
      query("pool-zh", "并发太多导致连接池资源耗尽，如何限流", ["pool"], ["bilingual", "paraphrase"]),
      query("queue", "Queue consumer redelivery and deduplication", ["queue", "duplicate-write"], ["literal", "conditional"]),
      query("queue-zh", "消息队列重复投递时如何用稳定操作标识去重", ["queue", "duplicate-write"], ["bilingual", "paraphrase"]),
      query("flag-upper", "Inspect `tool -X` package manifest", ["upper-flag"], ["exact_entity"]),
      query("flag-lower", "Extract archive with `tool -x`", ["lower-flag"], ["exact_entity"]),
      query("error-code", "ERR_WIDGET_STALE", ["error-code"], ["exact_entity"]),
      query("file-hint", "Improve row processing memory", ["parser"], ["exact_entity"], { fileHints: ["src/InvoiceParser.ts"] }),
      query("tests", "Run changed module unit tests", ["unit-tests"], ["literal"]),
      query("tests-zh", "合并代码前运行单元测试", ["unit-tests"], ["bilingual"]),
      query("rollback-zh", "部署回滚时保留数据结构兼容性", ["rollback", "migration"], ["bilingual", "paraphrase"]),
      query("other-scope", "InvoiceParser schema-generated decoder", ["another-repo"], ["scope"], { repoId: "other", cwd: "C:/other" }),
      query("empty-scope", "InvoiceParser", [], ["scope", "negative"], { repoId: "empty", cwd: "C:/empty" }),
      query("archived", "LegacyGate", [], ["lifecycle", "negative"]),
      query("expired", "ExpiredGate", [], ["lifecycle", "negative"]),
      query("unrelated", "Choose a font for the homepage heading", [], ["negative"]),
      query("generic-only", "Please implement the change and run it", [], ["negative"]),
    ] });
};
