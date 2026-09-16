import type { BranchContext, KnowledgeCandidate, LearningJob, LearningWindow, WorkEpisode } from "@provenloop/contracts";
import { sha256 } from "@provenloop/domain";
import type { CanonicalRawEventRecord } from "@provenloop/storage-sqlite";

/** Suggested review window; no background deletion is enabled by this default. */
export const SUGGESTED_CAPTURE_RETENTION_DAYS = 90;
export interface CaptureRetentionStore {
  rawEvents(): readonly CanonicalRawEventRecord[];
  workEpisodes(): readonly WorkEpisode[];
  knowledgeCandidates(): readonly KnowledgeCandidate[];
  branchContexts(): readonly BranchContext[];
  learningJobs(): readonly LearningJob[];
  learningWindow(jobId: string): LearningWindow | undefined;
  hasActiveDeletion(): boolean;
}
export interface CaptureRetentionSession {
  readonly sessionId: string;
  readonly eventCount: number;
  readonly estimatedBytes: number;
  readonly lastEventAt: string;
  readonly reasons: readonly string[];
}
export interface CaptureRetentionPlan {
  readonly olderThan: string;
  readonly expectedDigest: string;
  readonly candidates: readonly CaptureRetentionSession[];
  readonly protected: readonly CaptureRetentionSession[];
  readonly candidateEventCount: number;
  readonly estimatedCandidateBytes: number;
  readonly orphanEventCount: number;
}

/** Plan whole-session deletion without exposing captured content or removing evidence. */
export const planCaptureRetention = (
  store: CaptureRetentionStore, options: { readonly olderThan?: Date; readonly now?: Date } = {},
): CaptureRetentionPlan => {
  const now = options.now ?? new Date();
  const olderThan = options.olderThan ?? new Date(now.getTime() - SUGGESTED_CAPTURE_RETENTION_DAYS * 86_400_000);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(olderThan.getTime()) || olderThan >= now) throw new RangeError("Retention cutoff must precede the current time.");
  const groups = new Map<string, CanonicalRawEventRecord[]>();
  let orphanEventCount = 0;
  for (const event of store.rawEvents()) {
    if (!event.sessionId) { orphanEventCount += 1; continue; }
    const values = groups.get(event.sessionId) ?? [];
    values.push(event); groups.set(event.sessionId, values);
  }
  const episodes = store.workEpisodes();
  const knowledge = store.knowledgeCandidates();
  const branches = store.branchContexts();
  const jobs = store.learningJobs();
  const busySessions = new Set<string>();
  for (const job of jobs) if (["pending", "running", "paused", "waiting_evidence", "failed"].includes(job.state)) {
    const window = store.learningWindow(job.jobId);
    if (window) busySessions.add(window.sessionId);
  }
  const deletionActive = store.hasActiveDeletion();
  const sessions: CaptureRetentionSession[] = [];
  const sourceRevisions: unknown[] = [];
  for (const [sessionId, records] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    records.sort((left, right) => left.envelope.event.timestamp.localeCompare(right.envelope.event.timestamp) || left.eventId.localeCompare(right.eventId));
    const ids = new Set(records.flatMap((record) => [record.eventId, record.sourceEventId, record.deduplicationKey]));
    const episodeIds = new Set(episodes.filter((episode) => episode.sessionIds.includes(sessionId)).map((episode) => episode.episodeId));
    const lastEvent = records.reduce((latest, record) => Math.max(latest, Date.parse(record.envelope.event.timestamp)), 0);
    const reasons = new Set<string>();
    if (deletionActive) reasons.add("deletion_in_progress");
    if (lastEvent >= olderThan.getTime() || records.some((record) => record.lastSeenAt !== undefined && Date.parse(record.lastSeenAt) >= olderThan.getTime())) reasons.add("recent_activity");
    const ended = records.some((record) => record.eventType === "session.ended" && record.envelope.event.trust === "system" && Date.parse(record.envelope.event.timestamp) >= lastEvent);
    if (!ended) reasons.add("session_not_closed");
    if (records.some((record) => record.eventType === "capture_gap" || record.parseStatus !== "supported")) reasons.add("incomplete_capture");
    if (knowledge.some((item) => item.sourceEvidenceIds.some((id) => ids.has(id)) || item.sourceEpisodeIds.some((id) => episodeIds.has(id)))) reasons.add("knowledge_reference");
    if (branches.some((item) => [...item.sourceEventIds, ...item.recentVerificationEvidenceIds].some((id) => ids.has(id)) || item.sourceEpisodeIds.some((id) => episodeIds.has(id)))) reasons.add("branch_context_reference");
    if (busySessions.has(sessionId)) reasons.add("learning_in_progress");
    const estimatedBytes = records.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record.envelope), "utf8"), 0);
    sessions.push({ sessionId, eventCount: records.length, estimatedBytes, lastEventAt: new Date(lastEvent).toISOString(), reasons: [...reasons].sort() });
    sourceRevisions.push(records.map((record) => [record.deduplicationKey, sha256(record.envelope), record.lastSeenAt ?? null]));
  }
  const candidates = sessions.filter((session) => session.reasons.length === 0);
  return { olderThan: olderThan.toISOString(), candidates, protected: sessions.filter((session) => session.reasons.length > 0),
    expectedDigest: sha256([olderThan.toISOString(), sessions, sourceRevisions]), orphanEventCount,
    candidateEventCount: candidates.reduce((count, session) => count + session.eventCount, 0),
    estimatedCandidateBytes: candidates.reduce((count, session) => count + session.estimatedBytes, 0) };
};

/** The caller holds the existing deletion leases and delegates each target to DeletionService. */
export const applyCaptureRetention = async (
  store: CaptureRetentionStore,
  input: { readonly olderThan: Date; readonly expectedDigest: string; readonly sessionIds: readonly string[]; readonly userConfirmed: boolean; readonly now?: Date },
  deleteSession: (sessionId: string) => Promise<unknown>,
): Promise<{ readonly deletedSessionIds: readonly string[] }> => {
  if (!input.userConfirmed) throw new Error("Capture retention requires explicit user confirmation.");
  const plan = planCaptureRetention(store, input);
  if (plan.expectedDigest !== input.expectedDigest) throw new Error("Capture retention changed after review. Generate a new plan.");
  const selected = [...new Set(input.sessionIds)];
  if (selected.length === 0 || selected.some((id) => !plan.candidates.some((session) => session.sessionId === id))) throw new Error("Select only eligible sessions from the reviewed plan.");
  const deletedSessionIds: string[] = [];
  for (const sessionId of selected) {
    if (!planCaptureRetention(store, input).candidates.some((session) => session.sessionId === sessionId)) throw new Error("A selected session is no longer eligible for retention cleanup.");
    await deleteSession(sessionId);
    if (store.rawEvents().some((record) => record.sessionId === sessionId)) throw new Error("Session deletion did not remove its captured events.");
    deletedSessionIds.push(sessionId);
  }
  return { deletedSessionIds };
};
