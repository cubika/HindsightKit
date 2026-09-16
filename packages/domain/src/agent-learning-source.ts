import type { CaptureEnvelope, RuleProposalInput } from "@provenloop/contracts";
import { isInternalWorkSource } from "./work-source.js";

const complete = (entry: CaptureEnvelope): boolean =>
  entry.redaction.redactedPaths.length === 0 && entry.redaction.droppedPaths.length === 0 && entry.redaction.truncatedPaths.length === 0 &&
  (entry.event.captureQuality?.omittedFields.length ?? 0) === 0 && (entry.event.captureQuality?.truncatedFields.length ?? 0) === 0;

/** Match captured text values, never an invented serialization, object key, URL fetch or model paraphrase. */
export const capturedToolQuote = (entry: CaptureEnvelope, quote: string): boolean => {
  if (typeof quote !== "string" || quote.trim().length === 0 || entry.event.trust !== "tool" ||
      !["tool.completed", "tool.failed"].includes(entry.event.eventType) || isInternalWorkSource(entry.event)) return false;
  const pending: unknown[] = [entry.content?.toolResult, entry.content?.message, entry.content?.safeError];
  const seen = new Set<object>();
  let visited = 0;
  while (pending.length > 0 && visited < 4096) {
    visited += 1;
    const value = pending.pop();
    if (typeof value === "string" && value.includes(quote)) return true;
    if (value !== null && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      pending.push(...Object.values(value).slice(0, 4096 - visited));
    }
  }
  return false;
};

/** Validate the captured role and quoted provenance; this does not establish semantic correctness. */
export const validAgentLearningSource = (proposal: RuleProposalInput, events: readonly CaptureEnvelope[]): boolean => {
  const source = proposal.agentSource;
  if (!source || proposal.userSource || !["research", "recovery"].includes(source.kind) ||
      typeof source.quote !== "string" || source.quote.trim().length === 0 || !Array.isArray(source.evidenceSources) ||
      source.evidenceSources.length === 0 || source.evidenceSources.length > 8 ||
      source.evidenceSources.some((item) => item === null || typeof item !== "object" || typeof item.eventId !== "string" || typeof item.quote !== "string") ||
      new Set(source.evidenceSources.map((item) => item.eventId)).size !== source.evidenceSources.length) return false;
  const byId = new Map(events.map((entry) => [entry.event.eventId, entry]));
  const agent = byId.get(source.eventId);
  if (!agent || agent.event.eventType !== "agent.message" || agent.event.trust !== "model" ||
      agent.event.actorId === "provenloop-internal" || typeof agent.content?.message !== "string" ||
      !agent.content.message.includes(source.quote) || !complete(agent) || !agent.event.sessionId || !agent.event.repoId ||
      !agent.event.worktree || agent.event.repositoryState !== "known_repo") return false;
  const sameScope = (entry: CaptureEnvelope): boolean => entry.event.sessionId === agent.event.sessionId &&
    entry.event.repoId === agent.event.repoId && entry.event.worktree === agent.event.worktree && entry.event.repositoryState === "known_repo" &&
    entry.event.adapter === agent.event.adapter && entry.event.adapterVersion === agent.event.adapterVersion &&
    entry.event.participantId === agent.event.participantId &&
    entry.event.branch === agent.event.branch && entry.event.commitSha === agent.event.commitSha;
  const summaryTime = Date.parse(agent.event.timestamp);
  const task = events.filter((entry) => sameScope(entry) && entry.event.eventType === "prompt.submitted" && entry.event.trust === "user" &&
    Date.parse(entry.event.timestamp) < summaryTime).sort((left, right) => Date.parse(right.event.timestamp) - Date.parse(left.event.timestamp))[0];
  if (!task) return false;
  const closes = events.filter((entry) => sameScope(entry) &&
    ((entry.event.eventType === "agent.turn_completed" && entry.event.trust === "model") ||
      (entry.event.eventType === "session.idle" && entry.event.trust === "system")) &&
    entry.event.actorId !== "provenloop-internal" &&
    (entry.event.eventType === "session.idle" || agent.event.actorId === undefined || entry.event.actorId === undefined || entry.event.actorId === agent.event.actorId) &&
    Date.parse(entry.event.timestamp) >= summaryTime && complete(entry));
  if (closes.length === 0) return false;
  const closeTime = Math.min(...closes.map((entry) => Date.parse(entry.event.timestamp)));
  if (events.some((entry) => entry.event.sessionId === agent.event.sessionId && entry.event.trust === "user" &&
      Date.parse(entry.event.timestamp) > summaryTime && Date.parse(entry.event.timestamp) <= closeTime)) return false;
  for (const quote of source.evidenceSources) {
    const evidence = byId.get(quote.eventId);
    if (!evidence || !sameScope(evidence) || !complete(evidence) || !capturedToolQuote(evidence, quote.quote) ||
        Date.parse(evidence.event.timestamp) <= Date.parse(task.event.timestamp) ||
        (agent.event.actorId !== undefined && evidence.event.actorId !== undefined && agent.event.actorId !== evidence.event.actorId) ||
        Date.parse(evidence.event.timestamp) >= summaryTime ||
        events.some((entry) => entry.event.sessionId === agent.event.sessionId && entry.event.trust === "user" &&
          Date.parse(entry.event.timestamp) > Date.parse(evidence.event.timestamp) && Date.parse(entry.event.timestamp) <= summaryTime)) return false;
  }
  return true;
};
