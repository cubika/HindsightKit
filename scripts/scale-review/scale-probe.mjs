// Synthetic diagnostic probe; see docs/scalability-review.md for scope and limits.
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { CURRENT_SCHEMA_VERSION } from '@provenloop/contracts';
import { WorkEpisodeBuilder, createCaptureEnvelope } from '@provenloop/domain';
import { CanonicalSqliteStore, DatabaseSync } from '@provenloop/storage-sqlite';
import { SqliteFtsKnowledgeBackend, ContextRetrievalService, KnowledgeProjectionManager, knowledgeProjectionFromCandidate } from '@provenloop/retrieval';

const root = resolve(process.env.PROVENLOOP_SCALE_OUTPUT_DIR ?? join('evaluation-output', 'scale-review-' + new Date().toISOString().replaceAll(':', '-')));
process.env.PROVENLOOP_SCALE_OUTPUT_DIR = root;
mkdirSync(root, { recursive: true });
const round = n => Math.round(n * 100) / 100;
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const timed = async fn => { const start = performance.now(); const value = await fn(); return { ms: round(performance.now() - start), value }; };
const mode = process.argv[2];
const count = Number(process.argv[3]);

if (mode === 'episodes') {
  const associationMode = process.env.PROVENLOOP_SCALE_ASSOCIATION_MODE ?? 'all';
  if (!['all', 'sparse', 'connected'].includes(associationMode)) throw new Error('Invalid association mode.');
  const events = Array.from({ length: count }, (_, i) => createCaptureEnvelope({
    adapter: 'copilot-cli', adapterVersion: '1.0.82-0',
    sessionId: `session-${i}`, sourceEventId: `event-${i}`,
    repoId: 'repo-1', branch: `task-${i}`,
    timestamp: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString(),
    eventType: 'prompt.submitted', trust: 'user',
    content: { message: `Investigate independent issue ${i}` },
  }));
  new WorkEpisodeBuilder({ associationMode }).build(events.slice(0, 10));
  const measurements = [];
  let episodes, associations;
  for (let repeat = 0; repeat < 3; repeat++) {
    global.gc?.();
    const result = await timed(() => new WorkEpisodeBuilder({ associationMode }).build(events));
    measurements.push(result.ms);
    episodes = result.value.episodes.length;
    associations = result.value.associations.length;
  }
  console.log(JSON.stringify({ mode, associationMode, sessions: count, events: count, episodes, associations, medianMs: median(measurements), samplesMs: measurements, rssMiB: round(process.memoryUsage().rss / 1048576) }));
} else if (mode === 'retrieval') {
  const directory = join(root, `run-${Date.now()}-${count}`);
  mkdirSync(directory, { recursive: true });
  const store = new CanonicalSqliteStore(join(directory, 'canonical.db'));
  const backendPath = join(directory, 'knowledge.db');
  const backend = new SqliteFtsKnowledgeBackend(backendPath);
  const makeCandidate = (id, scopeId) => ({
    schemaVersion: CURRENT_SCHEMA_VERSION, knowledgeId: id,
    topicKey: 'package validation', content: 'Run package validation before merging code.',
    appliesWhen: ['Running package validation.'], nonApplicability: [],
    scope: 'repository', scopeId, kind: 'procedural', state: 'active',
    evidenceTier: 'user_confirmed', evidenceMarks: ['user_confirmed'],
    sourceEpisodeIds: [], sourceEvidenceIds: [], conflictsWith: [],
    createdAt: '2026-09-11T00:00:00.000Z', importance: 1,
    utility: { applied: 0, helpful: 0, harmful: 0 },
    coverage: { applicableOpportunities: 0, observedOutcomes: 0 },
  });
  const candidates = [
    ...Array.from({ length: count - 1 }, (_, i) => makeCandidate(`a-noise-${String(i).padStart(6, '0')}`, 'other-repo')),
    makeCandidate('z-target', 'target-repo'),
  ];
  try {
    const seed = await timed(() => store.upsertKnowledgeCandidates(candidates));
    const projections = candidates.map(candidate => knowledgeProjectionFromCandidate(candidate));
    const rebuild = await timed(() => backend.rebuild({ records: projections }));
    await backend.healthWithTimeout(30000);
    const query = { text: 'package validation', match: 'any', limit: 100 };
    const pageTimes = [];
    for (let i = 0; i < 5; i++) pageTimes.push((await timed(() => backend.searchWithTimeout(query, 30000))).ms);
    let pages = 0;
    const originalSearch = backend.searchWithTimeout.bind(backend);
    backend.searchWithTimeout = (...args) => { pages++; return originalSearch(...args); };
    const service = new ContextRetrievalService({ backend, store });
    const context = await timed(() => service.context({ cwd: 'C:/scale-probe', prompt: 'package validation', repoId: 'target-repo', sessionId: `scope-${count}`, tokenBudget: 1200 }));
    const crossScope = { elapsedMs: context.ms, reportedMs: context.value.latencyMs, status: context.value.status, items: context.value.items.map(item => item.id), detail: context.value.statusDetail, pages };
    await backend.healthWithTimeout(30000);
    const singleIndexTimes = [];
    for (let i = 0; i < 3; i++) {
      singleIndexTimes.push((await timed(() => backend.index([projections[0]]))).ms);
      await backend.healthWithTimeout(30000);
    }
    const changedIndexTimes = [];
    for (let i = 0; i < 3; i++) {
      changedIndexTimes.push((await timed(() => backend.index([{
        ...projections[0], content: 'Run package validation before merging code. Revision ' + i,
      }]))).ms);
      await backend.healthWithTimeout(30000);
    }
    console.log(JSON.stringify({ mode, knowledgeRecords: count, seedCanonicalMs: seed.ms, rebuildMs: rebuild.ms, searchPageMedianMs: median(pageTimes), searchPageSamplesMs: pageTimes, singleRecordIndexMedianMs: median(singleIndexTimes), singleRecordIndexSamplesMs: singleIndexTimes,
      changedRecordIndexMedianMs: median(changedIndexTimes), changedRecordIndexSamplesMs: changedIndexTimes,
      crossScope, databaseMiB: round(statSync(backendPath).size / 1048576), rssMiB: round(process.memoryUsage().rss / 1048576) }));
  } finally {
    await backend.closeAsync(); store.close();
  }
} else if (mode === 'quality') {
  const makeCandidate = (id, content = 'Run npm test before merging code.', exclusions = []) => ({
    schemaVersion: CURRENT_SCHEMA_VERSION, knowledgeId: id, topicKey: id, content,
    appliesWhen: ['Changing code.'], nonApplicability: exclusions,
    scope: 'repository', scopeId: 'repo-1', kind: 'procedural', state: 'active',
    evidenceTier: 'user_confirmed', evidenceMarks: ['user_confirmed'],
    sourceEpisodeIds: [], sourceEvidenceIds: [], conflictsWith: [],
    createdAt: '2026-09-11T00:00:00.000Z', importance: 1,
    utility: { applied: 0, helpful: 0, harmful: 0 },
    coverage: { applicableOpportunities: 0, observedOutcomes: 0 },
  });
  const run = async (candidates, prompt, repeats = 1) => {
    const store = new CanonicalSqliteStore(':memory:');
    const backend = new SqliteFtsKnowledgeBackend(':memory:');
    try {
      store.upsertKnowledgeCandidates(candidates);
      await new KnowledgeProjectionManager({ backend, store }).rebuild();
      const service = new ContextRetrievalService({ backend, store, timeoutMs: 5000 });
      const responses = [];
      for (let i = 0; i < repeats; i++) {
        const response = await service.context({ cwd: 'C:/repo', repoId: 'repo-1', sessionId: 'quality-session', prompt, tokenBudget: 1200 });
        responses.push({ status: response.status, items: response.items.map(item => ({ id: item.id, content: item.content, rank: item.rank })), candidateKnowledgeIds: store.contextUseRecords('quality-session').at(-1).candidateKnowledgeIds });
      }
      return { knowledgeCount: candidates.length, prompt, responses };
    } finally { await backend.closeAsync(); store.close(); }
  };
  const valid = makeCandidate('valid', 'Tests execute repository validation after all selected checks complete.');
  const results = {
    exclusionBaseline: await run([valid], 'Run tests before release'),
    exclusionAfterGrowth: await run([
      ...Array.from({ length: 20 }, (_, i) => makeCandidate(`excluded-${String(i).padStart(2, '0')}`, 'Run tests before release.', ['release'])), valid,
    ], 'Run tests before release'),
    identicalContent: await run(Array.from({ length: 21 }, (_, i) => makeCandidate(`duplicate-${String(i).padStart(2, '0')}`)), 'Run npm test before merging code.', 8),
    weakOverlap: await run([makeCandidate('tests')], 'Run database migration in production.'),
  };
  writeFileSync(join(root, 'quality-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} else if (mode === 'lock') {
  const directory = join(root, `lock-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  const databasePath = join(directory, 'canonical.db');
  new CanonicalSqliteStore(databasePath).close();
  const writer = new DatabaseSync(databasePath);
  writer.exec('BEGIN IMMEDIATE;');
  try {
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    const snapshot = reader.prepare('PRAGMA user_version').get();
    reader.close();
    const started = performance.now();
    let error;
    try { new CanonicalSqliteStore(databasePath, { busyTimeoutMs: 25 }).close(); }
    catch (caught) { error = caught.message; }
    const result = { mode, directReadonlySchemaVersion: snapshot.user_version, canonicalOpenError: error, canonicalOpenMs: round(performance.now() - started) };
    writeFileSync(join(root, 'lock-results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally { writer.exec('ROLLBACK;'); writer.close(); }
} else {
  const results = { timestamp: new Date().toISOString(), node: process.version, platform: process.platform, notes: 'Synthetic isolated local probes against the current compiled working tree. Warm read worker; no model calls. Cross-scope case intentionally ties lexical rank with other-repository records. Episode case has one prompt per distinct branch/session, spaced one day apart. Timings are not production SLA measurements.', episodes: [], retrieval: [] };
  for (const [kind, sizes] of [['episodes', [50, 100, 200, 400, 800]], ['retrieval', [100, 1000, 5000, 10000, 50000]]]) {
    for (const size of sizes) {
      const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), kind, String(size)], { encoding: 'utf8', timeout: 90000, windowsHide: true });
      if (child.status !== 0) {
        results[kind].push({ size, error: child.error?.message ?? child.stderr, status: child.status });
      } else {
        const row = JSON.parse(child.stdout.trim().split(/\r?\n/u).at(-1));
        results[kind].push(row); console.log(JSON.stringify(row));
      }
      writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2));
    }
  }
}
