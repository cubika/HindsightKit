import type { RawEvent } from "@provenloop/contracts";

const INTERNAL_WORK_ACTORS = new Set([
  "session-summary",
  "copilot-session-summary",
  "session-summarizer",
  "provenloop-internal",
  "provenloop-learning",
  "provenloop-probe",
  "provenloop-maintenance",
  "copilot-probe",
  "copilot-maintenance",
]);

// Source metadata identifies internal work; prompt wording never does.
export const isInternalWorkSource = (
  event: Pick<RawEvent, "actorId" | "trust">,
): boolean =>
  event.trust !== "user" &&
  event.actorId !== undefined &&
  INTERNAL_WORK_ACTORS.has(event.actorId.trim().toLowerCase());
