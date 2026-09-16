import { posix, win32 } from "node:path";

import type { CaptureEnvelope, VerificationBinding } from "@provenloop/contracts";
import { validCapturedParent } from "./parent-bridge.js";

export type VerificationOutcome = "succeeded" | "failed" | "unknown";
export type { VerificationBinding } from "@provenloop/contracts";

const verificationTypes = new Set([
  "test.completed",
  "build.completed",
  "verification.completed",
]);

export const trustedExecution = (envelope: CaptureEnvelope): boolean =>
  envelope.event.trust === "tool" || envelope.event.trust === "system";

export const isCreatedCommitEvent = (envelope: CaptureEnvelope): boolean =>
  envelope.event.eventType === "git.commit" &&
  trustedExecution(envelope) &&
  !envelope.sourceEventId.startsWith("workspace-commit-");

export const isVerificationEvent = (envelope: CaptureEnvelope): boolean =>
  verificationTypes.has(envelope.event.eventType) && trustedExecution(envelope);

export const verificationOutcome = (
  envelope: CaptureEnvelope,
): VerificationOutcome => {
  const event = envelope.event;
  if (!isVerificationEvent(envelope)) {
    return "unknown";
  }
  if (
    event.completionStatus !== undefined &&
    !["succeeded", "failed"].includes(event.completionStatus)
  ) {
    return "unknown";
  }
  if (
    event.completionStatus === "failed" ||
    (event.exitCode !== undefined && event.exitCode !== 0)
  ) {
    return "failed";
  }
  return event.completionStatus === "succeeded" || event.exitCode === 0
    ? "succeeded"
    : "unknown";
};

const worktreeIdentity = (worktree: string): string | undefined => {
  const normalized = worktree.trim().replaceAll("\\", "/");
  if (/^[a-z]:\//iu.test(normalized) || /^\/\/[^/]+\/[^/]+(?:\/|$)/u.test(normalized)) {
    return win32.normalize(normalized).replace(/[\\]+$/u, "").toLocaleLowerCase("en-US");
  }
  return posix.isAbsolute(normalized) && !normalized.startsWith("//")
    ? posix.normalize(normalized).replace(/\/+$/u, "") || "/"
    : undefined;
};

export const sameVerificationWorkspace = (
  left: CaptureEnvelope,
  right: CaptureEnvelope,
): boolean => {
  const identityUnavailable = (envelope: CaptureEnvelope): boolean =>
    (
      envelope.event.repositoryState !== undefined &&
      envelope.event.repositoryState !== "known_repo"
    ) ||
    (
      envelope.event.evidence !== undefined &&
      envelope.event.evidence.repositoryState !== "known_repo"
    ) ||
    [
      ...envelope.redaction.redactedPaths,
      ...envelope.redaction.droppedPaths,
      ...envelope.redaction.truncatedPaths,
    ].some((path) => path === "event.repoId" || path === "event.worktree");
  if (identityUnavailable(left) || identityUnavailable(right)) {
    return false;
  }
  const leftWorktree = left.event.worktree === undefined
    ? undefined
    : worktreeIdentity(left.event.worktree);
  const rightWorktree = right.event.worktree === undefined
    ? undefined
    : worktreeIdentity(right.event.worktree);
  return left.event.repoId !== undefined &&
    left.event.repoId === right.event.repoId &&
    leftWorktree !== undefined &&
    leftWorktree === rightWorktree;
};

export const verificationBinding = (
  envelope: CaptureEnvelope,
): VerificationBinding | undefined =>
  envelope.event.verificationBinding;

export const boundVerificationOperation = (
  correction: CaptureEnvelope,
  verification: CaptureEnvelope,
  eventsById: ReadonlyMap<string, CaptureEnvelope>,
): CaptureEnvelope | undefined => {
  const binding = verificationBinding(verification);
  if (
    binding === undefined ||
    binding.correctionEventId !== correction.event.eventId ||
    correction.event.eventType !== "user.corrected" ||
    correction.event.trust !== "user" ||
    !trustedExecution(verification) ||
    !verificationTypes.has(verification.event.eventType) ||
    !sameVerificationWorkspace(correction, verification) ||
    correction.event.sessionId === undefined ||
    correction.event.sessionId !== verification.event.sessionId ||
    Date.parse(correction.event.timestamp) >= Date.parse(verification.event.timestamp)
  ) {
    return undefined;
  }
  const operation = eventsById.get(binding.operationEventId);
  const argumentsValue = operation?.event.redactedArguments;
  const command =
    argumentsValue !== null &&
    typeof argumentsValue === "object" &&
    !Array.isArray(argumentsValue) &&
    "command" in argumentsValue &&
    typeof argumentsValue.command === "string"
      ? argumentsValue.command.trim()
      : undefined;
  const targetUnavailable = operation !== undefined &&
    [...operation.redaction.truncatedPaths, ...operation.redaction.droppedPaths]
      .some((path) =>
        path === "event.redactedArguments" ||
        path === "event.redactedArguments.command",
      );
  if (
    operation === undefined ||
    operation.event.eventType !== "tool.started" ||
    !trustedExecution(operation) ||
    !sameVerificationWorkspace(correction, operation) ||
    operation.event.sessionId !== correction.event.sessionId ||
    operation.event.operationId === undefined ||
    operation.event.operationId !== verification.event.operationId ||
    operation.event.toolName === undefined ||
    command === undefined ||
    command.length === 0 ||
    targetUnavailable ||
    Date.parse(operation.event.timestamp) < Date.parse(correction.event.timestamp) ||
    Date.parse(operation.event.timestamp) >= Date.parse(verification.event.timestamp)
  ) {
    return undefined;
  }
  // A binding is evidence only when the captured operation also traces to that user turn.
  const visited = new Set<string>();
  let parentId = operation.event.parentEventId;
  let childTimestamp = Date.parse(operation.event.timestamp);
  let child = operation;
  while (parentId !== undefined && !visited.has(parentId)) {
    const linkedParent = eventsById.get(parentId);
    if (linkedParent === undefined || !validCapturedParent(child, linkedParent)) return undefined;
    if (parentId === correction.event.eventId) {
      return operation;
    }
    visited.add(parentId);
    const parent = eventsById.get(parentId);
    if (
      parent === undefined ||
      parent.event.sessionId !== correction.event.sessionId ||
      !sameVerificationWorkspace(correction, parent) ||
      parent.event.trust === "user" ||
      parent.event.trust === "external-content" ||
      Date.parse(parent.event.timestamp) < Date.parse(correction.event.timestamp) ||
      Date.parse(parent.event.timestamp) > childTimestamp
    ) {
      return undefined;
    }
    childTimestamp = Date.parse(parent.event.timestamp);
    child = parent;
    parentId = parent.event.parentEventId;
  }
  return undefined;
};

export const independentlyVerifiedCorrections = (
  corrections: readonly CaptureEnvelope[],
  verifications: readonly CaptureEnvelope[],
  eventsById: ReadonlyMap<string, CaptureEnvelope>,
): readonly string[] => {
  const operations = new Set<string>();
  const matched: string[] = [];
  for (const correction of [...corrections].sort((left, right) =>
    Date.parse(left.event.timestamp) - Date.parse(right.event.timestamp) ||
    left.event.eventId.localeCompare(right.event.eventId),
  )) {
    const operation = verifications.flatMap((verification) => {
      if (verificationOutcome(verification) !== "succeeded") {
        return [];
      }
      const bound = boundVerificationOperation(correction, verification, eventsById);
      return bound === undefined ? [] : [bound];
    }).find((candidate) => !operations.has(JSON.stringify([
      candidate.event.sessionId,
      candidate.event.operationId,
    ])));
    if (operation !== undefined) {
      operations.add(JSON.stringify([
        operation.event.sessionId,
        operation.event.operationId,
      ]));
      matched.push(correction.event.eventId);
    }
  }
  return matched;
};

export const verificationProofEventIds = (
  correction: CaptureEnvelope,
  verification: CaptureEnvelope,
  eventsById: ReadonlyMap<string, CaptureEnvelope>,
): readonly string[] => {
  const operation = boundVerificationOperation(correction, verification, eventsById);
  if (operation === undefined) {
    return [];
  }
  const ids = [operation.event.eventId];
  let parentId = operation.event.parentEventId;
  while (parentId !== undefined && parentId !== correction.event.eventId) {
    ids.push(parentId);
    parentId = eventsById.get(parentId)?.event.parentEventId;
  }
  return ids;
};
