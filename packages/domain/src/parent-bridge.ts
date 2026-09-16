import type { CaptureEnvelope } from "@provenloop/contracts";

/** Check every omitted host bookkeeping link before treating its retained ancestor as a parent. */
export const validCapturedParent = (child: CaptureEnvelope, parent: CaptureEnvelope): boolean => {
  const bridge = child.event.parentBridge;
  if (bridge === undefined) return true;
  if (child.event.originalParentSourceEventId !== bridge[0]?.sourceEventId) return false;
  let timestamp = Date.parse(child.event.timestamp);
  const seen = new Set<string>();
  for (let index = 0; index < bridge.length; index += 1) {
    const entry = bridge[index];
    if (!entry || entry.schemaVersion !== 1 || entry.trust !== "system" ||
        !["hook.start", "hook.end", "system.message", "permission.requested", "permission.completed", "session.usage_checkpoint", "session.info", "session.model_change"].includes(entry.eventType) ||
        seen.has(entry.sourceEventId) || entry.sessionId !== child.event.sessionId || entry.repoId !== child.event.repoId ||
        entry.worktree !== child.event.worktree || Date.parse(entry.timestamp) > timestamp ||
        entry.parentSourceEventId !== (bridge[index + 1]?.sourceEventId ?? parent.sourceEventId)) return false;
    seen.add(entry.sourceEventId); timestamp = Date.parse(entry.timestamp);
  }
  return Date.parse(parent.event.timestamp) <= timestamp && parent.event.sessionId === child.event.sessionId &&
    parent.event.repoId === child.event.repoId && parent.event.worktree === child.event.worktree;
};
