import { posix, win32 } from "node:path";
import {
  learningInferenceResponseSchema, learningWindowSchema, mcpRecoveryReceiptSchema, learningProposalSource,
  type CaptureEnvelope, type LearningWindow, type LearningToolContract,
  type RuleProposal, type McpRecoveryReceipt, type LearningRecoveryReceipt, type KnowledgeCandidate,
} from "@provenloop/contracts";
import { sha256 } from "./digest.js";
import { validCapturedParent } from "./parent-bridge.js";
import { supportedLearningTestCommand, verifyShellRecovery } from "./shell-learning.js";
import { containsPotentialSecret } from "./redaction.js";
import { validAgentLearningSource } from "./agent-learning-source.js";
import { assessLearningRetention } from "./learning-retention.js";
import { isInternalWorkSource } from "./work-source.js";
import { closedAgentResearchTurn, selectAgentResearchEvents } from "./agent-research-window.js";
import { hasAcceptedLearningDistillation, validLearningDiscoveryMetadata } from "./learning-distillation.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
export const learningSourceDigest = (event: CaptureEnvelope): string => sha256(event);

export const buildLearningWindows = (events: readonly CaptureEnvelope[], now: Date): LearningWindow[] => {
  const bridgedSources = new Set(events.flatMap((entry) => entry.event.parentBridge?.map((bridge) => bridge.sourceEventId) ?? []));
  const compare = (a: CaptureEnvelope, b: CaptureEnvelope): number =>
    Date.parse(a.event.timestamp) - Date.parse(b.event.timestamp) || a.event.eventId.localeCompare(b.event.eventId);
  const ordered = [...events].filter((entry) => !isInternalWorkSource(entry.event) && !bridgedSources.has(entry.sourceEventId))
    .sort(compare);
  const groups = new Map<string, CaptureEnvelope[]>();
  for (const entry of ordered) {
    const key = JSON.stringify([entry.event.sessionId, entry.event.repoId, entry.event.worktree]);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const windows: { user: CaptureEnvelope; window: LearningWindow }[] = [];
  for (const group of groups.values()) {
    const starts = new Map<string, number>();
    const proofs = new Map<string, CaptureEnvelope[]>();
    const proofKey = (entry: CaptureEnvelope, source: string | undefined): string => JSON.stringify([entry.event.operationId, source]);
    for (const entry of group) {
      if (entry.event.eventType !== "test.completed") continue;
      const key = proofKey(entry, entry.event.evidence?.sourceCompleteEventId);
      const matches = proofs.get(key) ?? [];
      matches.push(entry);
      proofs.set(key, matches);
    }
    let latestFailure: { entry: CaptureEnvelope; index: number; start: number | undefined } | undefined;
    for (const [i, user] of group.entries()) {
      if (user.event.eventType === "tool.started" && user.event.operationId !== undefined) starts.set(user.event.operationId, i);
      if ((user.event.eventType === "tool.failed" || (user.event.eventType === "tool.completed" && user.event.exitCode !== undefined && user.event.exitCode !== 0)) && user.event.operationId !== undefined) {
        latestFailure = { entry: user, index: i, start: starts.get(user.event.operationId) };
      }
      if (user.event.trust !== "user" || user.event.eventType !== "prompt.submitted" ||
          !user.content?.message || !user.event.sessionId || !user.event.repoId || !user.event.worktree ||
          user.event.repositoryState !== "known_repo") continue;
      // A missing recovery chain must not suppress an independent user requirement.
      const recentFailure = latestFailure && i - latestFailure.index <= 12 &&
        (latestFailure.start === undefined || i - latestFailure.start <= 12) ? latestFailure : undefined;
      const failedStart = recentFailure?.start;
      const previous = group.slice(failedStart ?? Math.max(0, i - 8), i);
      const failed = failedStart === undefined ? undefined : group[failedStart];
      const before = record(failed?.event.redactedArguments);
      const relatedRetry = (entry: CaptureEnvelope): boolean => {
        if (!failed?.event.toolName) return true;
        if (entry.event.toolName !== failed.event.toolName) return false;
        if (failed.event.mcp) {
          if (entry.event.mcp?.serverName !== failed.event.mcp.serverName || entry.event.mcp?.toolName !== failed.event.mcp.toolName ||
              entry.event.mcp?.contractDigest !== failed.event.mcp.contractDigest) return false;
          const argument = recentFailure?.entry.event.mcp?.failureArgument;
          if (argument === undefined) return true;
          const after = record(entry.event.redactedArguments);
          const other = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).filter(([key]) => key !== argument));
          return after[argument] !== undefined && after[argument] !== null && sha256(before[argument]) !== sha256(after[argument]) && sha256(other(before)) === sha256(other(after));
        }
        const command = record(entry.event.redactedArguments).command;
        return typeof before.command !== "string" || !supportedLearningTestCommand(before.command) ||
          (!entry.event.mcp && typeof command === "string" && supportedLearningTestCommand(command) && command !== before.command);
      };
      const following: CaptureEnvelope[] = [];
      const retries = new Set<string>();
      const retryStarts = new Map<string, CaptureEnvelope>();
      let completion: CaptureEnvelope | undefined;
      for (let j = i + 1; j < group.length && previous.length + following.length < 31; j += 1) {
        const entry = group[j];
        if (!entry || entry.event.trust === "user") break;
        following.push(entry);
        if (entry.event.eventType === "tool.started" && entry.event.operationId !== undefined && relatedRetry(entry)) {
          retries.add(entry.event.operationId);
          retryStarts.set(entry.event.operationId, entry);
        }
        if (["tool.completed", "tool.failed"].includes(entry.event.eventType) &&
            (!failed?.event.toolName || (entry.event.operationId !== undefined && retries.has(entry.event.operationId)))) {
          completion = entry;
          break;
        }
        if (entry.event.eventType === "session.idle" || entry.event.eventType === "agent.turn_completed") {
          completion = entry;
          break;
        }
      }
      // Preparatory tools and incomplete retries cannot consume the bounded inference budget.
      if (!completion || now.getTime() - Date.parse(completion.event.timestamp) < 2_000) continue;
      const selected = [...previous, user, ...following];
      const nativeProofs = completion.event.eventType === "tool.completed" ? proofs.get(proofKey(completion, completion.sourceEventId)) ?? [] : [];
      const retry = completion.event.operationId === undefined ? undefined : retryStarts.get(completion.event.operationId);
      const command = record(retry?.event.redactedArguments).command;
      if (failed && retry && !retry.event.mcp && typeof command === "string" && supportedLearningTestCommand(command) &&
          completion.event.completionStatus === "succeeded" && completion.event.exitCode === 0 &&
          !nativeProofs.some((proof) => proof.event.evidence?.sourceStartEventId === retry.sourceEventId)) continue;
      const additionalProofs = nativeProofs.filter((proof) => !selected.includes(proof));
      if (selected.length + additionalProofs.length > 32) continue;
      selected.push(...additionalProofs);
      selected.sort(compare);
      const sources = selected.map((entry) => ({ eventId: entry.event.eventId, digest: learningSourceDigest(entry) }));
      const window = learningWindowSchema.parse({
        schemaVersion: 1, windowId: `learning-window-${sha256(user.event.eventId).slice(0, 24)}`,
        revision: sha256(sources), sessionId: user.event.sessionId, repoId: user.event.repoId,
        worktree: user.event.worktree, createdAt: user.event.timestamp, sources, events: selected,
      });
      windows.push({ user, window });
    }
    // Select the final settled model iteration, not the first tool loop's turn_end.
    for (let boundary = 0; boundary < group.length; boundary += 1) {
      const task = group[boundary];
      if (!task || task.event.trust !== "user" || task.event.eventType !== "prompt.submitted") continue;
      let end = boundary + 1;
      while (end < group.length && group[end]?.event.trust !== "user") end += 1;
      const taskEvents = group.slice(boundary + 1, end);
      const turn = closedAgentResearchTurn(taskEvents.map((entry) => ({ ...entry.event, hasMessage: Boolean(entry.content?.message?.trim()) })), task.event.participantId);
      if (turn) {
        const summary = taskEvents.find((entry) => entry.event.eventId === turn.summary.eventId);
        const closure = taskEvents.find((entry) => entry.event.eventId === turn.closure.eventId);
        if (!summary || !closure || now.getTime() - Date.parse(closure.event.timestamp) < 2_000 ||
            !summary.event.sessionId || !summary.event.repoId || !summary.event.worktree || summary.event.repositoryState !== "known_repo") continue;
        const selected = selectAgentResearchEvents([task, ...taskEvents], task, summary, closure);
        const summaryTime = Date.parse(summary.event.timestamp);
        const result = selected.find((item) => item.event.trust === "tool" &&
          ["tool.completed", "tool.failed"].includes(item.event.eventType) && Date.parse(item.event.timestamp) < summaryTime &&
          [item.content?.message, item.content?.safeError, item.content?.toolResult].some((value) => value !== undefined));
        if (!result) continue;
        const sourceDigests = selected.map((item) => ({ eventId: item.event.eventId, digest: learningSourceDigest(item) }));
        const window = learningWindowSchema.parse({ schemaVersion: 1, origin: "agent", anchorEventId: summary.event.eventId,
          windowId: "learning-agent-window-" + sha256(summary.event.eventId).slice(0, 24), revision: sha256(sourceDigests),
          sessionId: summary.event.sessionId, repoId: summary.event.repoId, worktree: summary.event.worktree,
          createdAt: summary.event.timestamp, sources: sourceDigests, events: selected });
        windows.push({ user: summary, window });
      }
      boundary = end - 1;
    }
  }
  return windows.sort((a, b) => compare(a.user, b.user)).map(({ window }) => window);
};

export const validateLearningResponse = (window: LearningWindow, output: unknown, options: { readonly sourcesOnly?: boolean } = {}): ReturnType<typeof learningInferenceResponseSchema.parse> => {
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > 16 * 1024) throw new Error("Learning response exceeds byte budget.");
  const parsed = learningInferenceResponseSchema.parse(output);
  const sources = new Map(window.events.map((entry) => [entry.event.eventId, entry]));
  for (const proposal of parsed.proposals) {
    const source = learningProposalSource(proposal);
    if ([proposal.rule, proposal.trigger, ...proposal.exclusions, source.quote,
      ...(proposal.retrievalScope?.excludedTasks ?? []), ...(proposal.relations ?? []).flatMap((relation) => [relation.reason,
        /^learning-knowledge-[a-f0-9]{24}$/u.test(relation.knowledgeId) ? "" : relation.knowledgeId]),
      ...(proposal.queryTerms?.include ?? []), ...(proposal.queryTerms?.exclude ?? []),
      ...(proposal.agentSource?.evidenceSources.map((item) => item.quote) ?? [])].some(containsPotentialSecret)) {
      throw new Error("Learning proposal contains sensitive content.");
    }
    if (proposal.queryTerms) {
      const quoted = [source.quote, ...(proposal.supportingSources ?? []).map((entry) => entry.quote),
        ...(proposal.agentSource?.evidenceSources ?? []).map((entry) => entry.quote)].map((value) => value.normalize("NFKC").toLowerCase());
      const terms = [...proposal.queryTerms.include, ...proposal.queryTerms.exclude];
      if (terms.some((term) => !quoted.some((quote) => quote.includes(term.normalize("NFKC").toLowerCase())))) {
        throw new Error("Learning query terms must occur in quoted evidence.");
      }
    }
    if (!validLearningDiscoveryMetadata(proposal, window.events)) {
      throw new Error("Learning discovery metadata requires valid clauses and captured source references.");
    }
    if (proposal.predicate && proposal.shellPredicate) throw new Error("A proposal cannot mix shell and MCP predicates.");
    const user = sources.get(source.eventId);
    if (proposal.agentSource) {
      if (window.origin !== "agent" || window.anchorEventId !== source.eventId ||
          "learning-agent-window-" + sha256(source.eventId).slice(0, 24) !== window.windowId ||
          user?.event.repoId !== window.repoId || user.event.sessionId !== window.sessionId || user.event.worktree !== window.worktree ||
          !validAgentLearningSource(proposal, window.events)) throw new Error("Invalid agent source or tool quotation.");
    } else if (window.origin === "agent" || user?.event.trust !== "user" || user.event.eventType !== "prompt.submitted" ||
        `learning-window-${sha256(user.event.eventId).slice(0, 24)}` !== window.windowId ||
        !user.content?.message?.includes(source.quote)) throw new Error("Invalid user source quotation.");
    for (const [id, expectedType] of [[proposal.failedOperationEventId, "tool.started"],
      [proposal.retryOperationEventId, "tool.started"], [proposal.completionEventId, "tool.completed"]] as const) {
      if (id === undefined) continue;
      const source = sources.get(id);
      if (!source) throw new Error("Proposal references an unknown source.");
      if (source.event.eventType !== expectedType) {
        throw new Error("Proposal operation references must identify failed/retry tool.started events and the retry tool.completed event.");
      }
    }
  }
  if (options.sourcesOnly) return parsed;
  const decisions = parsed.proposals.map((proposal) => ({ proposal, decision: assessLearningRetention(proposal, window.events, window) }));
  const proposals = decisions.filter((entry) => entry.decision.retain).map((entry) => entry.proposal);
  const accepted = proposals.filter((proposal) => proposal.distillation !== undefined).length;
  return { ...parsed, proposals, ...(parsed.distillation ? { distillation: { ...parsed.distillation,
    accepted, rejected: parsed.distillation.proposed - accepted,
    reasons: [...parsed.distillation.reasons, ...decisions.filter((entry) => !entry.decision.retain).map((entry) => "Retention: " + entry.decision.reason)].slice(0, 3),
  } } : {}) };
};

export const renderLearningPredicate = (proposal: RuleProposal): string | undefined => {
  if (proposal.shellPredicate && !proposal.predicate) return `Use ${proposal.shellPredicate.command} instead of ${proposal.shellPredicate.failedCommand} for this repository's tests at the verified revision.`;
  const p = proposal.predicate;
  if (p === undefined) return undefined;
  return p.kind === "required_argument"
    ? `Supply the required ${p.argument} argument when calling ${p.serverName}/${p.toolName}.`
    : `Use an absolute path for ${p.argument} when calling ${p.serverName}/${p.toolName} under the recorded tool contract.`;
};

export const verifyMcpRecovery = (proposal: RuleProposal, events: readonly CaptureEnvelope[], contracts: readonly LearningToolContract[], now: Date): McpRecoveryReceipt | undefined => {
  const predicate = proposal.predicate;
  const source = proposal.userSource ?? proposal.agentSource;
  const agentOrigin = proposal.agentSource !== undefined;
  if (predicate === undefined || !source || (proposal.userSource && proposal.agentSource) ||
      (agentOrigin && proposal.agentSource?.kind !== "recovery") ||
      !proposal.failedOperationEventId || !proposal.retryOperationEventId || !proposal.completionEventId) return undefined;
  const contract = contracts.find((item) => item.digest === predicate.contractDigest && item.serverName === predicate.serverName && item.toolName === predicate.toolName);
  if (contract === undefined || sha256({ schemaVersion: contract.schemaVersion, serverName: contract.serverName, toolName: contract.toolName, version: contract.version, sourceSchemaDigest: contract.sourceSchemaDigest, requiredArguments: contract.requiredArguments, absolutePathArguments: contract.absolutePathArguments }) !== contract.digest) return undefined;
  if (!(predicate.kind === "required_argument" ? contract.requiredArguments : contract.absolutePathArguments).includes(predicate.argument)) return undefined;
  const byId = new Map(events.map((entry) => [entry.event.eventId, entry]));
  const failed = byId.get(proposal.failedOperationEventId);
  const retry = byId.get(proposal.retryOperationEventId);
  const completion = byId.get(proposal.completionEventId);
  const user = byId.get(source.eventId);
  const failure = events.find((entry) => entry.event.eventType === "tool.failed" && entry.event.operationId === failed?.event.operationId && entry.event.sessionId === failed?.event.sessionId);
  if (!failed || !retry || !completion || !user || !failure ||
      (!agentOrigin && (user.event.trust !== "user" || user.event.eventType !== "prompt.submitted")) ||
      !failed.event.operationId || !retry.event.operationId ||
      !user.content?.message?.includes(source.quote)) return undefined;
  if (agentOrigin && (!validAgentLearningSource(proposal, events.filter((entry) => proposal.sourceDigests.some((item) => item.eventId === entry.event.eventId))) ||
      events.some((entry) => entry.event.sessionId === user.event.sessionId && entry.event.trust === "user" &&
        Date.parse(entry.event.timestamp) > Date.parse(failed.event.timestamp) && Date.parse(entry.event.timestamp) <= Date.parse(user.event.timestamp)))) return undefined;
  const chain = agentOrigin ? [failed, failure, retry, completion, user] : [failed, failure, user, retry, completion];
  const executionActors = new Set([failed, failure, retry, completion, ...(agentOrigin ? [user] : [])].flatMap((entry) => entry.event.actorId ? [entry.event.actorId] : []));
  if (executionActors.size > 1 || executionActors.has("provenloop-internal")) return undefined;
  if (agentOrigin && chain.some((entry) => entry.event.adapter !== user.event.adapter || entry.event.adapterVersion !== user.event.adapterVersion ||
      entry.event.branch !== user.event.branch || entry.event.commitSha !== user.event.commitSha)) return undefined;
  if (!user.event.sessionId || !user.event.repoId || !user.event.worktree || chain.some((entry) =>
    entry.event.sessionId !== user.event.sessionId || entry.event.repoId !== user.event.repoId ||
    entry.event.worktree !== user.event.worktree || entry.event.repositoryState !== "known_repo" ||
    entry.redaction.truncatedPaths.length > 0 || entry.redaction.droppedPaths.length > 0 ||
    entry.redaction.redactedPaths.length > 0 || (entry.event.captureQuality?.truncatedFields.length ?? 0) > 0 ||
    (entry.event.captureQuality?.omittedFields.length ?? 0) > 0)) return undefined;
  if (chain.some((entry, index) => index > 0 && Date.parse(entry.event.timestamp) <= Date.parse(chain[index - 1]?.event.timestamp ?? ""))) return undefined;
  const native = (entry: CaptureEnvelope): boolean => {
    const metadata = record(record(entry.event).mcp);
    return entry.event.trust === "tool" && metadata.serverName === predicate.serverName && metadata.toolName === predicate.toolName && metadata.contractDigest === contract.digest;
  };
  if (![failed, failure, retry, completion].every(native) || failed.event.eventType !== "tool.started" || retry.event.eventType !== "tool.started" ||
      completion.event.eventType !== "tool.completed" || completion.event.completionStatus !== "succeeded" ||
      completion.event.operationId !== retry.event.operationId || failed.event.operationId === retry.event.operationId ||
      !(completion.event.mcp?.isError === false || completion.event.mcp?.resultType === "success") ||
      !(failure.event.mcp?.isError === true || failure.event.mcp?.resultType === "failure") ||
      failure.event.mcp?.isError === false || failure.event.mcp?.resultType === "success" ||
      completion.event.mcp?.isError === true || completion.event.mcp?.resultType === "failure" ||
      failure.event.mcp?.failureArgument !== predicate.argument) return undefined;
  const before = record(failed.event.redactedArguments);
  const after = record(retry.event.redactedArguments);
  const absolute = (value: unknown): boolean => typeof value === "string" && (win32.isAbsolute(value) || posix.isAbsolute(value));
  const valid = (value: unknown): boolean => predicate.kind === "absolute_path" ? absolute(value) : value !== undefined && value !== null;
  if (valid(before[predicate.argument]) || !valid(after[predicate.argument]) ||
      contract.requiredArguments.some((arg) => after[arg] === undefined || after[arg] === null) ||
      contract.absolutePathArguments.some((arg) => after[arg] !== undefined && !absolute(after[arg]))) return undefined;
  const otherBefore = Object.fromEntries(Object.entries(before).filter(([key]) => key !== predicate.argument));
  const otherAfter = Object.fromEntries(Object.entries(after).filter(([key]) => key !== predicate.argument));
  if (sha256(otherBefore) !== sha256(otherAfter)) return undefined;
  const traces = (entry: CaptureEnvelope, target: string): boolean => {
    if (entry.event.sessionId !== user.event.sessionId || entry.event.repoId !== user.event.repoId ||
        entry.event.worktree !== user.event.worktree || entry.event.repositoryState !== "known_repo") return false;
    const visited = new Set<string>(); let current = entry.event.parentEventId; let childTime = Date.parse(entry.event.timestamp); let child = entry;
    while (current && !visited.has(current)) {
      visited.add(current); const parent = byId.get(current);
      if (!parent || !validCapturedParent(child, parent)) return false;
      if (parent.event.sessionId !== user.event.sessionId || parent.event.repoId !== user.event.repoId ||
          parent.event.worktree !== user.event.worktree || parent.event.repositoryState !== "known_repo" ||
          parent.redaction.truncatedPaths.length > 0 || parent.redaction.droppedPaths.length > 0 || parent.redaction.redactedPaths.length > 0 ||
          (parent.event.captureQuality?.truncatedFields.length ?? 0) > 0 || (parent.event.captureQuality?.omittedFields.length ?? 0) > 0 ||
          Date.parse(parent.event.timestamp) > childTime) return false;
      if (current === target) return true;
      if (parent.event.trust === "user" || parent.event.trust === "external-content") return false;
      if (agentOrigin && (parent.event.actorId === "provenloop-internal" ||
          (parent.event.actorId !== undefined && executionActors.size > 0 && !executionActors.has(parent.event.actorId)) ||
          parent.event.adapter !== user.event.adapter || parent.event.adapterVersion !== user.event.adapterVersion ||
          parent.event.branch !== user.event.branch || parent.event.commitSha !== user.event.commitSha)) return false;
      childTime = Date.parse(parent.event.timestamp);
      child = parent;
      current = parent.event.parentEventId;
    }
    return false;
  };
  const recoveryAnchor = agentOrigin ? failure : user;
  if (!(agentOrigin ? traces(retry, failure.event.eventId) && traces(user, completion.event.eventId) :
      traces(retry, user.event.eventId) && traces(user, failure.event.eventId)) ||
      !traces(failure, failed.event.eventId) || !traces(completion, retry.event.eventId)) return undefined;
  // Only competing corrections before this result make the selected retry ambiguous.
  // Later invocations do not change the immutable evidence for this invocation.
  const competingRetries = events.filter((entry) => {
    const args = record(entry.event.redactedArguments);
    const other = Object.fromEntries(Object.entries(args).filter(([key]) => key !== predicate.argument));
    return entry.event.eventType === "tool.started" && entry.event.toolName === retry.event.toolName && native(entry) &&
      Date.parse(entry.event.timestamp) <= Date.parse(completion.event.timestamp) && valid(args[predicate.argument]) &&
      sha256(other) === sha256(otherBefore) && traces(entry, recoveryAnchor.event.eventId) && !traces(entry, completion.event.eventId);
  });
  if (competingRetries.length !== 1) return undefined;
  if (proposal.sourceDigests.some((source) => { const entry = byId.get(source.eventId); return !entry || learningSourceDigest(entry) !== source.digest; })) return undefined;
  if (chain.some((entry) => !proposal.sourceDigests.some((source) => source.eventId === entry.event.eventId))) return undefined;
  if (events.some((entry) => entry.event.sessionId === user.event.sessionId && entry.event.operationId === retry.event.operationId &&
      (entry.event.eventType === "tool.failed" || entry.event.completionStatus === "failed" || entry.event.mcp?.isError === true || entry.event.mcp?.resultType === "failure"))) return undefined;
  return mcpRecoveryReceiptSchema.parse({ schemaVersion: 1, receiptId: `mcp-recovery-${sha256([proposal.proposalId, contract.digest]).slice(0, 24)}`,
    proposalId: proposal.proposalId, predicate, contract, failureEventId: failure.event.eventId,
    ...(agentOrigin ? { agentEventId: user.event.eventId } : { userEventId: user.event.eventId }),
    failedOperationEventId: failed.event.eventId, retryOperationEventId: retry.event.eventId, completionEventId: completion.event.eventId,
    sourceDigests: proposal.sourceDigests, verifiedAt: now.toISOString(), proves: "invocation_contract" });
};

export const verifyLearningRecovery = (proposal: RuleProposal, events: readonly CaptureEnvelope[], contracts: readonly LearningToolContract[], now: Date): LearningRecoveryReceipt | undefined =>
  proposal.shellPredicate ? verifyShellRecovery(proposal, events, now) : verifyMcpRecovery(proposal, events, contracts, now);

export const learningKnowledgeCandidate = (window: LearningWindow, proposal: RuleProposal, receipt?: LearningRecoveryReceipt): KnowledgeCandidate => ({
  schemaVersion: 1, knowledgeId: proposal.knowledgeId, topicKey: `learning:${sha256([window.repoId, proposal.shellPredicate ?? proposal.predicate ?? proposal.trigger]).slice(0, 24)}`,
  kind: "semantic", scope: "repository", scopeId: window.repoId,
  content: receipt ? renderLearningPredicate(proposal) ?? proposal.rule : proposal.rule,
  appliesWhen: receipt?.proves === "repository_test_command" ? [`Running ${receipt.predicate.failedCommand} or ${receipt.predicate.command} in the verified repository revision.`] : receipt ? [`Calling ${receipt.predicate.serverName}/${receipt.predicate.toolName} under its verified tool contract.`] : [proposal.trigger],
  nonApplicability: receipt ? ["Other repositories, tools, or contract versions; semantic correctness of returned data."] : proposal.exclusions, conflictsWith: [],
  sourceEpisodeIds: [], sourceEvidenceIds: proposal.sourceDigests.map((item) => item.eventId),
  ...(!receipt && proposal.discovery && hasAcceptedLearningDistillation(proposal, proposal.sourceDigests) &&
    validLearningDiscoveryMetadata(proposal, window.events) ? { discovery: proposal.discovery } : {}),
  createdAt: proposal.createdAt, ...(receipt ? { validatedAt: receipt.verifiedAt } : { expiresAt: proposal.expiresAt }),
  evidenceMarks: receipt ? ["externally_verified"] : [], evidenceTier: receipt ? "externally_verified" : "inferred",
  state: receipt ? "active" : "candidate", importance: 0, utility: { applied: 0, harmful: 0, helpful: 0 }, coverage: { applicableOpportunities: 0, observedOutcomes: 0 },
});
