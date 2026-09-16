// Synthetic diagnostic probe; see docs/scalability-review.md for scope and limits.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { CURRENT_SCHEMA_VERSION } from '@provenloop/contracts';
import { createCaptureEnvelope, WorkEpisodeBuilder } from '@provenloop/domain';
import { CanonicalSqliteStore } from '@provenloop/storage-sqlite';

const root = resolve(process.env.PROVENLOOP_SCALE_OUTPUT_DIR ?? join('evaluation-output', 'scale-review-' + new Date().toISOString().replaceAll(':', '-')));
process.env.PROVENLOOP_SCALE_OUTPUT_DIR = root;
mkdirSync(root, { recursive: true });
const count = Number(process.argv[2]);
const round = value => Math.round(value * 100) / 100;
const measure = fn => {
  const samples = []; let result;
  for (let i = 0; i < 3; i++) {
    global.gc?.();
    const started = performance.now();
    result = fn(); samples.push(round(performance.now() - started));
  }
  return { medianMs: [...samples].sort((a,b) => a-b)[1], samplesMs: samples, result };
};

if (count > 0) {
  const store = new CanonicalSqliteStore(':memory:');
  const sessions = 10;
  let first;
  try {
    for (let i = 0; i < count; i++) {
      const session = i % sessions;
      const timestamp = new Date(Date.UTC(2026, 0, session + 1) + Math.floor(i / sessions) * 1000).toISOString();
      const isPrompt = i < sessions;
      const envelope = createCaptureEnvelope({
        adapter: 'copilot-cli', adapterVersion: '1.0.84-1', sourceEventId: `event-${i}`,
        eventType: isPrompt ? 'prompt.submitted' : 'tool.completed',
        trust: isPrompt ? 'user' : 'tool', sessionId: `session-${session}`,
        repoId: 'repo-1', branch: `task-${session}`, worktree: 'C:/event-probe',
        repositoryState: 'known_repo', timestamp,
        ...(isPrompt ? { content: { message: `Investigate independent issue ${session}.` } } : {}),
      });
      if (i === 0) first = envelope;
      store.ingestQueueItem({
        schemaVersion: 1, queueItemId: `queue-${i}`, state: 'pending',
        attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope,
      });
    }
    const candidate = {
      schemaVersion: CURRENT_SCHEMA_VERSION, knowledgeId: 'learning-knowledge-event-probe',
      topicKey: 'package validation', content: 'Run package validation before merging code.',
      appliesWhen: ['Running package validation.'], nonApplicability: [],
      scope: 'repository', scopeId: 'repo-1', kind: 'procedural', state: 'active',
      evidenceTier: 'user_confirmed', evidenceMarks: ['user_confirmed'],
      sourceEpisodeIds: [], sourceEvidenceIds: [first.event.eventId], conflictsWith: [],
      createdAt: '2026-01-01T00:00:00.000Z', importance: 1,
      utility: { applied: 0, helpful: 0, harmful: 0 },
      coverage: { applicableOpportunities: 0, observedOutcomes: 0 },
    };
    store.upsertKnowledgeCandidates([candidate]);
    const read = measure(() => store.episodeSourceEnvelopes());
    const build = measure(() => new WorkEpisodeBuilder().build(read.result));
    const admission = measure(() => store.knowledgeAdmissionEvidence([candidate]));
    console.log(JSON.stringify({ totalEvents: count, sessions, knowledgeRecords: 1, sourceEvidenceIds: 1,
      readAllEventsMedianMs: read.medianMs, readAllEventsSamplesMs: read.samplesMs,
      episodeBuildMedianMs: build.medianMs, episodeBuildSamplesMs: build.samplesMs,
      resultingEpisodes: build.result.episodes.length, associations: build.result.associations.length,
      evidenceReadMedianMs: admission.medianMs, evidenceReadSamplesMs: admission.samplesMs,
      evidenceEnvelopesReturned: admission.result.envelopes.length }));
  } finally { store.close(); }
} else {
  const results = { timestamp: new Date().toISOString(), node: process.version,
    notes: 'Synthetic in-memory canonical SQLite; fixed 10 sessions and 1 knowledge record, varying only event count. Each session has one prompt followed by small tool.completed events. Public ingestion API used. Three timed samples per operation; seeding excluded. Evidence read calls knowledgeAdmissionEvidence directly for one learning-prefixed candidate referencing one event; this isolates source-session expansion, not an end-to-end context request or proof of admission. Episode build excludes storage read and projection persistence. Timings are not production SLA measurements.', rows: [] };
  for (const size of [100, 1000, 10000]) {
    const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), String(size)],
      { encoding: 'utf8', timeout: 60000, windowsHide: true });
    const row = child.status === 0 ? JSON.parse(child.stdout.trim().split(/\r?\n/u).at(-1))
      : { totalEvents: size, error: child.error?.message ?? child.stderr, exitCode: child.status };
    results.rows.push(row); console.log(JSON.stringify(row));
    writeFileSync(join(root, 'event-results.json'), JSON.stringify(results, null, 2));
  }
}
