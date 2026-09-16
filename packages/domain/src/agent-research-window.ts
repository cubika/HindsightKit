import type { CaptureEnvelope, RawEvent } from "@provenloop/contracts";
import { learningEventTargetsWorkspace } from "./learning-retention.js";
import { isInternalWorkSource } from "./work-source.js";

const compare = (left: CaptureEnvelope, right: CaptureEnvelope): number =>
  Date.parse(left.event.timestamp) - Date.parse(right.event.timestamp) || left.event.eventId.localeCompare(right.event.eventId);

export interface ResearchTurnEvent extends Pick<RawEvent, "eventId" | "timestamp" | "eventType" | "trust" | "actorId" | "participantId" | "completionStatus"> {
  readonly hasMessage: boolean;
}

/** Native turn_end closes one model iteration. Later tools/turns invalidate that fallback. */
export const closedAgentResearchTurn = (
  events: Iterable<ResearchTurnEvent>,
  participantId?: string,
): { summary: ResearchTurnEvent; closure: ResearchTurnEvent } | undefined => {
  let summary: ResearchTurnEvent | undefined;
  let closed: { summary: ResearchTurnEvent; closure: ResearchTurnEvent } | undefined;
  for (const entry of events) {
    if (isInternalWorkSource(entry) || entry.participantId !== participantId) continue;
    if (entry.trust === "user") break;
    if (entry.eventType === "agent.turn_started" ||
        (entry.trust === "tool" && ["tool.started", "tool.completed", "tool.failed"].includes(entry.eventType))) {
      // The final finding must follow its evidence; an interim tool-call message cannot anchor it.
      closed = undefined; summary = undefined;
    } else if (entry.eventType === "agent.message" && entry.trust === "model") {
      if (entry.completionStatus === "running") { summary = undefined; closed = undefined; }
      else if (!closed && entry.hasMessage) summary = entry;
    } else if (entry.eventType === "agent.turn_completed" && entry.trust === "model" && summary &&
        (entry.actorId === undefined || summary.actorId === undefined || entry.actorId === summary.actorId)) {
      closed = { summary, closure: entry };
    } else if (entry.eventType === "session.idle" && entry.trust === "system") {
      return closed ?? (summary ? { summary, closure: entry } : undefined);
    }
  }
  return closed;
};

export const researchTerms = (text: string): string[] => [...new Set(
  text.toLowerCase().match(/[a-z][a-z0-9_./-]{2,}|[\p{Script=Han}]{2,6}/gu) ?? [],
)].filter((term) => ![
  "the", "and", "for", "this", "that", "with", "from", "have", "has", "are",
  "was", "not", "but", "into", "can", "could", "should", "would", "will",
  "repository", "project", "source", "code", "file", "files", "result", "summary",
].includes(term)).slice(0, 64);

/** Rank original tool evidence against the final finding without rewriting captured text. */
export const researchEvidenceScore = (entry: CaptureEnvelope, terms: readonly string[]): number => {
  const pending: unknown[] = [entry.content?.message, entry.content?.safeError, entry.content?.toolResult];
  const found = new Set<string>();
  let visited = 0;
  while (pending.length > 0 && visited++ < 4096) {
    const value = pending.pop();
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      for (const term of terms) if (lower.includes(term)) found.add(term);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value).slice(0, 4096 - visited)) {
        if (!/^(?:base64|image|audio|embedding)$/iu.test(key)) pending.push(child);
      }
    }
  }
  return [...found].reduce((score, term) => score + (/[./-]/u.test(term) ? 4 : 1), 0);
};

/**
 * Stream one closed task with bounded retained events. Long tasks keep the task,
 * final summary, closure and the best original tool results. Dropping all operation
 * starts in a sampled task prevents partial traces from qualifying recovery rules.
 */
export const selectAgentResearchEvents = (
  events: Iterable<CaptureEnvelope>,
  task: CaptureEnvelope,
  summary: CaptureEnvelope,
  closure: CaptureEnvelope,
): CaptureEnvelope[] => {
  const first: CaptureEnvelope[] = [];
  const ranked: { entry: CaptureEnvelope; score: number }[] = [];
  const terms = researchTerms(summary.content?.message ?? "");
  let count = 0;
  let targetsWorkspace = true;
  for (const entry of events) {
    if (isInternalWorkSource(entry.event) || compare(entry, task) < 0 || compare(entry, closure) > 0) continue;
    count += 1;
    if (first.length < 32) first.push(entry);
    if (!learningEventTargetsWorkspace(entry, summary.event.worktree ?? "")) targetsWorkspace = false;
    if (entry.event.trust !== "tool" || !["tool.completed", "tool.failed"].includes(entry.event.eventType) ||
        compare(entry, summary) >= 0 || entry.event.sessionId !== summary.event.sessionId || entry.event.repoId !== summary.event.repoId ||
        entry.event.worktree !== summary.event.worktree || entry.event.repositoryState !== "known_repo" ||
        entry.event.participantId !== summary.event.participantId ||
        entry.event.branch !== summary.event.branch || entry.event.commitSha !== summary.event.commitSha ||
        (entry.event.actorId !== undefined && summary.event.actorId !== undefined && entry.event.actorId !== summary.event.actorId) ||
        entry.redaction.redactedPaths.length > 0 || entry.redaction.droppedPaths.length > 0 || entry.redaction.truncatedPaths.length > 0 ||
        (entry.event.captureQuality?.omittedFields.length ?? 0) > 0 || (entry.event.captureQuality?.truncatedFields.length ?? 0) > 0 ||
        ![entry.content?.message, entry.content?.safeError, entry.content?.toolResult].some((value) => value !== undefined)) continue;
    ranked.push({ entry, score: researchEvidenceScore(entry, terms) });
    ranked.sort((left, right) => right.score - left.score || compare(right.entry, left.entry));
    if (ranked.length > 29) ranked.pop();
  }
  if (count <= 32) return first;
  if (!targetsWorkspace || ranked.length === 0) return [];
  return [task, ...ranked.map(({ entry }) => entry), summary, closure].sort(compare);
};
