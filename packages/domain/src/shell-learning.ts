import { shellRecoveryReceiptSchema, learningProposalSource, type CaptureEnvelope, type RuleProposal, type ShellRecoveryReceipt } from "@provenloop/contracts";
import { sha256 } from "./digest.js";
import { sameVerificationWorkspace } from "./verification-proof.js";
import { validCapturedParent } from "./parent-bridge.js";
import { posix, win32 } from "node:path";
import { validAgentLearningSource } from "./agent-learning-source.js";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
// These forms are already classified as test.completed by the native command evidence bridge.
export const supportedLearningTestCommand = (command: string): boolean => /^(?:npm|pnpm|yarn) (?:test|run test(?::[a-z0-9][a-z0-9_-]*)?)$/u.test(command);

const workspaceIdentity = (path: string): string | undefined => {
  const normalized = path.trim().replaceAll("\\", "/");
  if (/^[a-z]:\//iu.test(normalized) || /^\/\/[^/]+\/[^/]+(?:\/|$)/u.test(normalized)) {
    return win32.normalize(normalized).replace(/[\\]+$/u, "").toLocaleLowerCase("en-US");
  }
  return posix.isAbsolute(normalized) && !normalized.startsWith("//")
    ? posix.normalize(normalized).replace(/\/+$/u, "") || "/"
    : undefined;
};

/** Compare already-verified command receipts; their lifecycle and authority are checked by admission. */
export const conflictingShellLearning = (left: ShellRecoveryReceipt, right: ShellRecoveryReceipt): boolean => {
  const worktree = workspaceIdentity(left.worktree);
  return worktree !== undefined && worktree === workspaceIdentity(right.worktree) &&
    left.repoId === right.repoId && left.branch === right.branch && left.commitSha === right.commitSha &&
    left.predicate.toolName === right.predicate.toolName && left.predicate.command !== right.predicate.command &&
    [left.predicate.failedCommand, left.predicate.command].some((command) =>
      [right.predicate.failedCommand, right.predicate.command].includes(command));
};

export const verifyShellRecovery = (proposal: RuleProposal, events: readonly CaptureEnvelope[], now: Date): ShellRecoveryReceipt | undefined => {
  const predicate = proposal.shellPredicate;
  if (!predicate || proposal.predicate || !supportedLearningTestCommand(predicate.command) ||
      !supportedLearningTestCommand(predicate.failedCommand) || predicate.command === predicate.failedCommand ||
      !proposal.failedOperationEventId || !proposal.retryOperationEventId || !proposal.completionEventId) return undefined;
  const agentOrigin = proposal.agentSource !== undefined;
  if (agentOrigin && (proposal.agentSource?.kind !== "recovery" ||
      !validAgentLearningSource(proposal, events.filter((entry) => proposal.sourceDigests.some((item) => item.eventId === entry.event.eventId))))) return undefined;
  if (!proposal.userSource && !proposal.agentSource) return undefined;
  const source = learningProposalSource(proposal);
  const byId = new Map(events.map((entry) => [entry.event.eventId, entry]));
  const failed = byId.get(proposal.failedOperationEventId), retry = byId.get(proposal.retryOperationEventId), completion = byId.get(proposal.completionEventId), user = byId.get(source.eventId);
  if (!failed || !retry || !completion || !user ||
      user.event.trust !== (agentOrigin ? "model" : "user") || user.event.eventType !== (agentOrigin ? "agent.message" : "prompt.submitted") ||
      !user.content?.message?.includes(source.quote) || !source.quote.includes(predicate.command)) return undefined;
  if (agentOrigin && events.some((entry) => entry.event.sessionId === user.event.sessionId && entry.event.trust === "user" &&
      Date.parse(entry.event.timestamp) > Date.parse(failed.event.timestamp) && Date.parse(entry.event.timestamp) <= Date.parse(user.event.timestamp))) return undefined;
  const failure = events.find((entry) => entry.event.sessionId === user.event.sessionId && entry.event.operationId === failed.event.operationId &&
    ["tool.failed", "tool.completed"].includes(entry.event.eventType) && entry.event.exitCode !== undefined && entry.event.exitCode !== 0);
  const proof = events.find((entry) => entry.event.eventType === "test.completed" && entry.event.operationId === retry.event.operationId &&
    entry.event.sessionId === user.event.sessionId && entry.event.evidence?.sourceStartEventId === retry.sourceEventId && entry.event.evidence.sourceCompleteEventId === completion.sourceEventId);
  if (!failure || !proof || !user.event.repoId || !user.event.sessionId || !user.event.worktree || !user.event.branch ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(user.event.commitSha ?? "")) return undefined;
  const chain = agentOrigin ? [failed, failure, retry, completion, user] : [failed, failure, user, retry, completion];
  const executionActors = new Set([failed, failure, retry, completion, proof, ...(agentOrigin ? [user] : [])].flatMap((entry) =>
    entry.event.actorId === undefined ? [] : [entry.event.actorId]));
  if (executionActors.size > 1 || executionActors.has("provenloop-internal")) return undefined;
  const complete = (entry: CaptureEnvelope): boolean => !entry.event.mcp && sameVerificationWorkspace(user, entry) &&
    entry.event.sessionId === user.event.sessionId && entry.event.branch === user.event.branch && entry.event.commitSha === user.event.commitSha &&
    entry.redaction.redactedPaths.length === 0 && entry.redaction.droppedPaths.length === 0 && entry.redaction.truncatedPaths.length === 0 &&
    (entry.event.captureQuality?.truncatedFields.length ?? 0) === 0 && (entry.event.captureQuality?.omittedFields.length ?? 0) === 0;
  if (![...chain, proof].every(complete) || chain.some((entry, index) => index > 0 && Date.parse(entry.event.timestamp) <= Date.parse(chain[index - 1]?.event.timestamp ?? ""))) return undefined;
  if (failed.event.eventType !== "tool.started" || retry.event.eventType !== "tool.started" || completion.event.eventType !== "tool.completed" ||
      [failed, failure, retry, completion, proof].some((entry) => entry.event.trust !== "tool" || entry.event.toolName !== predicate.toolName) ||
      failed.event.operationId === undefined || retry.event.operationId === undefined || failed.event.operationId === retry.event.operationId ||
      completion.event.operationId !== retry.event.operationId || completion.event.completionStatus !== "succeeded" || completion.event.exitCode !== 0 ||
      proof.event.completionStatus !== "succeeded" || proof.event.exitCode !== 0 || proof.event.evidence?.exitCode !== 0 ||
      proof.event.evidence.kind !== "command_verification" || proof.event.evidence.repositoryState !== "known_repo" ||
      proof.event.evidence.operationId !== retry.event.operationId ||
      proof.event.evidence.commandFamily !== `${predicate.command.split(" ")[0]}-test`) return undefined;
  const before = record(failed.event.redactedArguments), after = record(retry.event.redactedArguments);
  if (before.command !== predicate.failedCommand || after.command !== predicate.command ||
      Object.keys(before).some((key) => !["command", "cwd", "mode", "detach", "description", "timeout_ms"].includes(key)) ||
      Object.keys(after).some((key) => !["command", "cwd", "mode", "detach", "description", "timeout_ms"].includes(key)) ||
      (after.mode !== undefined && after.mode !== "sync") || (after.detach !== undefined && after.detach !== false)) return undefined;
  for (const [entry, args] of [[failed, before], [retry, after]] as const) {
    const directory = typeof args.cwd === "string"
      ? (/^[a-z]:[\\/]|^[\\/]{2}/iu.test(user.event.worktree) ? win32 : posix).resolve(user.event.worktree, args.cwd)
      : undefined;
    if (args.cwd !== undefined && (typeof args.cwd !== "string" ||
        !sameVerificationWorkspace(user, { ...entry, event: { ...entry.event, worktree: directory } }))) return undefined;
  }
  const relevant = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).filter(([key]) => !["command", "description", "timeout_ms"].includes(key)));
  if (sha256(relevant(before)) !== sha256(relevant(after))) return undefined;
  const shellExit = (entry: CaptureEnvelope): Record<string, unknown> | undefined => {
    const result = record(entry.content?.toolResult);
    const items = Array.isArray(result.contents) ? result.contents.map(record).filter((item) => item.type === "shell_exit") : [];
    return items.length === 1 ? items[0] : undefined;
  };
  const failedExit = shellExit(failure), retryExit = shellExit(completion);
  if (!failedExit || !retryExit || failedExit.exitCode !== failure.event.exitCode || retryExit.exitCode !== 0 ||
      typeof failedExit.shellId !== "string" || typeof retryExit.shellId !== "string") return undefined;
  for (const [entry, exit] of [[failure, failedExit], [completion, retryExit]] as const) {
    if (typeof exit.cwd !== "string" || !sameVerificationWorkspace(user, { ...entry, event: { ...entry.event, worktree: exit.cwd } })) return undefined;
  }
  if (!proof.event.evidence.workingDirectory || !sameVerificationWorkspace(user, { ...proof, event: { ...proof.event, worktree: proof.event.evidence.workingDirectory } })) return undefined;
  const trace = (entry: CaptureEnvelope, target: CaptureEnvelope): boolean => {
    const seen = new Set<string>(); let child = entry;
    while (child.event.parentEventId && !seen.has(child.event.eventId)) {
      seen.add(child.event.eventId); const parent = byId.get(child.event.parentEventId);
      if (!parent || !complete(parent) || Date.parse(parent.event.timestamp) > Date.parse(child.event.timestamp) || !validCapturedParent(child, parent)) return false;
      if (parent.event.eventId === target.event.eventId) return true;
      if (parent.event.trust === "user" || parent.event.trust === "external-content") return false;
      child = parent;
    }
    return false;
  };
  // The adapter's derived verification is a direct child of the same native completion.
  // Older capture copied that completion's own bridge onto the derived child; accept only
  // the exact copied metadata, never an unrelated or inferred ancestry bypass.
  const derivedCompletion = proof.event.parentEventId === completion.event.eventId && proof.sourceEventId === completion.sourceEventId &&
    proof.event.timestamp === completion.event.timestamp && proof.event.adapter === completion.event.adapter && proof.event.adapterVersion === completion.event.adapterVersion &&
    proof.event.evidence?.sourceCompleteEventId === completion.sourceEventId && proof.event.evidence.sourceStartEventId === retry.sourceEventId &&
    (proof.event.parentBridge === undefined || (sha256(proof.event.parentBridge) === sha256(completion.event.parentBridge) &&
      proof.event.originalParentSourceEventId === completion.event.originalParentSourceEventId));
  if (!trace(failure, failed) || !trace(completion, retry) || !derivedCompletion ||
      (agentOrigin ? (!trace(retry, failure) || !trace(user, completion)) : (!trace(user, failure) || !trace(retry, user)))) return undefined;
  const recoveryAnchor = agentOrigin ? failure : user;
  const competingRetries = events.filter((entry) => {
    const args = record(entry.event.redactedArguments);
    return entry.event.eventType === "tool.started" && entry.event.toolName === predicate.toolName && !entry.event.mcp &&
      Date.parse(entry.event.timestamp) <= Date.parse(completion.event.timestamp) && args.command === predicate.command &&
      sha256(relevant(args)) === sha256(relevant(before)) && trace(entry, recoveryAnchor) && !trace(entry, completion);
  });
  if (competingRetries.length !== 1 ||
      events.some((entry) => entry.event.sessionId === user.event.sessionId && entry.event.operationId === retry.event.operationId &&
        (entry.event.eventType === "tool.failed" || entry.event.completionStatus === "failed" || (entry.event.exitCode !== undefined && entry.event.exitCode !== 0)))) return undefined;
  if (proposal.sourceDigests.some((source) => !byId.has(source.eventId) || sha256(byId.get(source.eventId)) !== source.digest) ||
      [...chain, proof].some((entry) => !proposal.sourceDigests.some((source) => source.eventId === entry.event.eventId))) return undefined;
  return shellRecoveryReceiptSchema.parse({ schemaVersion: 1, receiptId: `shell-recovery-${sha256([proposal.proposalId, predicate]).slice(0, 24)}`, proposalId: proposal.proposalId, predicate,
    proves: "repository_test_command", failureEventId: failure.event.eventId,
    ...(agentOrigin ? { agentEventId: user.event.eventId } : { userEventId: user.event.eventId }), failedOperationEventId: failed.event.eventId,
    retryOperationEventId: retry.event.eventId, completionEventId: completion.event.eventId, nativeVerificationEventId: proof.event.eventId,
    repoId: user.event.repoId, worktree: user.event.worktree, branch: user.event.branch, commitSha: user.event.commitSha, sourceDigests: proposal.sourceDigests, verifiedAt: now.toISOString() });
};
