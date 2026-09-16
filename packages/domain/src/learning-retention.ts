import { posix, win32 } from "node:path";
import type { CaptureEnvelope, LearningRetention, LearningToolContract, RuleProposalInput } from "@provenloop/contracts";
import { capturedToolQuote, validAgentLearningSource } from "./agent-learning-source.js";
import { containsPotentialSecret } from "./redaction.js";
import { isInternalWorkSource } from "./work-source.js";
import { hasAcceptedLearningDistillation } from "./learning-distillation.js";
import { sha256 } from "./digest.js";

export interface LearningRetentionAssessment {
  readonly retain: boolean;
  readonly reusable: boolean;
  readonly reason: string;
  readonly kind?: LearningRetention["kind"];
}

const reject = (reason: string): LearningRetentionAssessment => ({ retain: false, reusable: false, reason });
const normalize = (value: string): string => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const complete = (entry: CaptureEnvelope): boolean => entry.redaction.redactedPaths.length === 0 &&
  entry.redaction.droppedPaths.length === 0 && entry.redaction.truncatedPaths.length === 0 &&
  (entry.event.captureQuality?.omittedFields.length ?? 0) === 0 && (entry.event.captureQuality?.truncatedFields.length ?? 0) === 0;
const inside = (path: string, root: string): boolean => {
  const windows = /^[a-z]:[\\/]|^\\\\/iu.test(root);
  const api = windows ? win32 : posix;
  if (!api.isAbsolute(root)) return false;
  const from = windows ? api.normalize(root).toLowerCase() : api.normalize(root);
  const resolved = api.resolve(root, path);
  const to = windows ? resolved.toLowerCase() : resolved;
  const relative = api.relative(from, to);
  return relative === "" || (!relative.startsWith(".." + api.sep) && relative !== ".." && !api.isAbsolute(relative));
};
const pathsInText = (text: string): string[] => text.match(/(?:[a-z]:[\\/]|\\\\|\.\.[\\/])[^\s"'`<>|，。；]+/giu) ?? [];
const operationPaths = (entry: CaptureEnvelope): string[] => {
  const args = entry.event.redactedArguments;
  const record: Readonly<Record<string, unknown>> = args !== null && typeof args === "object" && !Array.isArray(args)
    ? args as Readonly<Record<string, unknown>> : {};
  const api = /^[a-z]:[\\/]|^\\\\/iu.test(entry.event.worktree ?? "") ? win32 : posix;
  const root = entry.event.worktree;
  const reportedCwd = entry.event.evidence?.workingDirectory ?? (typeof record.cwd === "string" ? record.cwd : root);
  const effectiveCwd = root && reportedCwd ? api.resolve(root, reportedCwd) : undefined;
  return [entry.event.evidence?.workingDirectory, ...(entry.event.evidence?.targetPaths ?? []),
    ...Object.entries(record).flatMap(([key, value]) => {
      if (/^(?:cwd|path|file|filePath|filepath|targetPath)$/u.test(key) && typeof value === "string") return [value];
      if (/^(?:paths|files|targets|changedFiles)$/u.test(key) && Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
      return key === "command" && typeof value === "string" ? pathsInText(value) : [];
    })].filter((value): value is string => typeof value === "string")
    .map((path) => effectiveCwd && !api.isAbsolute(path) ? api.resolve(effectiveCwd, path) : path);
};

export const learningEventTargetsWorkspace = (entry: CaptureEnvelope, worktree: string): boolean =>
  operationPaths(entry).every((path) => inside(path, worktree));

// Only native, explicitly read-only auxiliary tools can be omitted from a user
// convention's target check. Shell composition and unknown tools remain conservative.
const auxiliaryRead = (entry: CaptureEnvelope): boolean => {
  if (entry.event.trust !== "tool" || entry.event.mcp || !complete(entry)) return false;
  if (/^(?:view|read_file|readFile|read|glob|grep|list_dir|list_directory|rg)$/u.test(entry.event.toolName ?? "")) return true;
  if (!["powershell", "bash"].includes(entry.event.toolName ?? "")) return false;
  const args = entry.event.redactedArguments;
  const command = args && typeof args === "object" && !Array.isArray(args) ? (args as Readonly<Record<string, unknown>>).command : undefined;
  return typeof command === "string" && !/[;&|<>`$\r\n]/u.test(command) &&
    /^(?:Get-Content(?:\s+-LiteralPath)?|cat|head|tail)\s+(?:"[^"]+"|'[^']+'|[^\s]+)\s*$/iu.test(command);
};

const taskOnly = /\b(?:this|current) (?:task|session|change|edit|deployment|run|branch)\b|\b(?:for now|just this once|one[- ]time)\b|(?:这次|本次|当前任务|当前会话|当前分支|这个分支|暂时|先别)/iu;
const commitRestriction = /\b(?:do not commit|don't commit|without committing)\b|(?:不要|别|不|无需)\s*(?:提交|commit\b)/iu;
const shortApproval = /^(?:yes|yeah|ok(?:ay)?|sure|correct|do it|delete it|remove it|嗯|恩|好|好的|可以|对|删掉|删除|删了|删吧)[\s,，.!！。]*(?:(?:delete|remove)(?: it)?|(?:就|那就)?(?:删掉|删除|删了|删吧))?(?:一下)?[\s,，.!！。]*$/iu;
const lastingIntent = /\b(?:always|every time|from now on|in future|for future|by default|as a rule|repository convention|team convention)\b|(?:以后|今后|每次|一律|始终|长期|统一约定|团队约定|仓库约定|默认都)/iu;
const nonAssertedInstruction = /\b(?:example|hypothetical|suppose|imagine|quotation|quoted|quote|do not adopt|don't adopt|rule to reject|unsuitable|explain why|evaluate whether|discuss whether|someone said|they said|should we)\b|(?:举例|例子|假设|假如|设想|引用|引文|示例|不要采纳|不应采纳|解释为什么|讨论是否|是否应该)|[?？]|^\s*>|```/iu;
const editRequest = /\b(?:set|change|switch|configure).{0,70}\b(?:default model|model default|gpt[- .]?\d)|\b(?:rename|remove|delete)\b.{0,90}\b(?:name|qualifier|prefix|setting|config|postcomments)\b|(?:默认(?:的)?\s*(?:模型|model).{0,30}(?:改|设)|(?:改|设).{0,30}默认(?:的)?\s*(?:模型|model)|(?:删|去掉|移除|不用提|不再提).{0,40}(?:SDM|限定|前缀|postComments)|(?:SDM|限定|前缀|postComments).{0,40}(?:删|去掉|移除|不用提|不再提)|重命名|改名)/iu;
const explanatorySource = /\b(?:because|requires?|must|cannot|fails?|unless|only when|instead of|causes?|prevents?|depends on)\b|(?:因为|由于|必须|需要|不能|否则|失败|仅当|才会|避免|取决于)/iu;

/** Check retained provenance and duration. This grants reference use, never execution proof. */
export const assessLearningRetention = (
  proposal: RuleProposalInput,
  events: readonly CaptureEnvelope[],
  scope: { readonly repoId: string; readonly worktree: string },
): LearningRetentionAssessment => {
  const sourceId = proposal.userSource?.eventId ?? proposal.agentSource?.eventId;
  const anchor = events.find((entry) => entry.event.eventId === sourceId);
  const sourceText = proposal.userSource ? anchor?.content?.message ?? proposal.userSource.quote : proposal.agentSource?.quote ?? "";
  const distilled = hasAcceptedLearningDistillation(proposal, events.map((entry) => ({ eventId: entry.event.eventId, digest: sha256(entry) })));
  if (proposal.distillation && !distilled) return reject("invalid_distillation_review");
  if (anchor && isInternalWorkSource(anchor.event)) return reject("internal_source");
  if (shortApproval.test(sourceText.trim()) || (!distilled && taskOnly.test(sourceText)) || taskOnly.test(proposal.trigger)) return reject("task_only");
  if (!distilled && commitRestriction.test(sourceText) && !lastingIntent.test(sourceText)) return reject("task_only");
  if (!distilled && proposal.userSource && editRequest.test(sourceText) && !lastingIntent.test(sourceText)) return reject("requested_state_change");
  const retention = proposal.retention;
  if (!retention) return { retain: true, reusable: false, reason: "legacy_unreviewed" };
  if (retention.lifetime !== "durable") return reject("task_only");
  if (retention.targetRepository.status !== "captured" || retention.targetRepository.repoId !== scope.repoId) return reject("scope_unresolved");
  if ([retention.rationale, retention.futureUse, proposal.canonicalKey ?? ""].some(containsPotentialSecret)) return reject("sensitive_retention");
  const sources = proposal.supportingSources;
  if (!sources?.length || new Set(sources.map((source) => source.eventId)).size !== sources.length) return reject("missing_support");
  if (!anchor) return reject("missing_source");
  if (proposal.userSource && (anchor.event.trust !== "user" || anchor.event.eventType !== "prompt.submitted" ||
      !anchor.content?.message?.includes(proposal.userSource.quote))) return reject("invalid_source");
  if (proposal.agentSource && !validAgentLearningSource(proposal, events)) return reject("invalid_source");
  const material: CaptureEnvelope[] = [anchor];
  for (const source of sources) {
    const entry = events.find((event) => event.event.eventId === source.eventId);
    if (!entry || !complete(entry) || containsPotentialSecret(source.quote) || entry.event.actorId === "provenloop-internal" ||
        !(entry.event.trust === "user" && entry.event.eventType === "prompt.submitted" && entry.content?.message?.includes(source.quote)) &&
        !(entry && capturedToolQuote(entry, source.quote))) return reject("invalid_support");
    material.push(entry);
  }
  if (material.some((entry) => !complete(entry) || entry.event.sessionId !== anchor.event.sessionId ||
      entry.event.adapter !== anchor.event.adapter || entry.event.adapterVersion !== anchor.event.adapterVersion ||
      entry.event.branch !== anchor.event.branch || entry.event.commitSha !== anchor.event.commitSha ||
      entry.event.repoId !== scope.repoId || entry.event.worktree !== scope.worktree || entry.event.repositoryState !== "known_repo")) return reject("scope_unresolved");
  const citedPaths = [...sources.flatMap((source) => pathsInText(source.quote)), ...pathsInText(anchor.content?.message ?? "")];
  const citedIds = new Set(material.map((entry) => entry.event.eventId));
  const citedOperations = new Set(material.flatMap((entry) => entry.event.operationId ? [entry.event.operationId] : []));
  const targets = events.filter((entry) => !(distilled && proposal.userSource && retention.kind === "convention" &&
    !citedIds.has(entry.event.eventId) && !citedOperations.has(entry.event.operationId ?? "") && auxiliaryRead(entry)));
  if ([...citedPaths, ...targets.flatMap(operationPaths)].some((path) => !inside(path, scope.worktree))) return reject("cross_repository_target");
  if (taskOnly.test(retention.futureUse)) return reject("task_only");
  if (!distilled && (normalize(retention.futureUse).length < 16 || normalize(retention.rationale).length < 16 ||
      normalize(retention.rationale) === normalize(proposal.rule))) return reject("missing_future_value");
  const typed = proposal.predicate !== undefined || proposal.shellPredicate !== undefined;
  if (retention.kind === "convention") {
    if (!distilled && nonAssertedInstruction.test(sourceText)) return reject("unasserted_convention");
    if (!proposal.userSource || !sources.some((source) => source.eventId === proposal.userSource?.eventId &&
        (distilled || lastingIntent.test(source.quote))) || (!distilled && !lastingIntent.test(sourceText))) return reject("duration_unproven");
  } else if (retention.kind === "reference") {
    if (typed || !sources.some((source) => {
      const event = events.find((entry) => entry.event.eventId === source.eventId);
      // Research may derive an explanation from code rather than a prose sentence
      // containing words such as "requires". Exact captured provenance and the
      // retention assessment still apply; this grants reference use only.
      return event?.event.trust === "tool" &&
        (distilled || proposal.agentSource?.kind === "research" || explanatorySource.test(source.quote));
    })) return reject("missing_reusable_finding");
  } else if (!typed) return reject("unsupported_recovery");
  return { retain: true, reusable: !typed, reason: "source_supported", kind: retention.kind };
};

/** Wait only when a supported proof has a specific missing capture or contract. */
export const learningRecoveryMayGainEvidence = (
  proposal: RuleProposalInput, events: readonly CaptureEnvelope[], contracts: readonly LearningToolContract[],
): boolean => {
  if (!proposal.predicate && !proposal.shellPredicate) return false;
  const ids = [proposal.failedOperationEventId, proposal.retryOperationEventId, proposal.completionEventId];
  const operations = ids.map((id) => events.find((entry) => entry.event.eventId === id));
  if (operations.some((entry) => entry === undefined || !complete(entry))) return true;
  if (proposal.predicate && !contracts.some((contract) => contract.digest === proposal.predicate?.contractDigest &&
      contract.serverName === proposal.predicate.serverName && contract.toolName === proposal.predicate.toolName)) return true;
  if (proposal.shellPredicate && !events.some((entry) => entry.event.eventType === "test.completed" &&
      entry.event.evidence?.sourceCompleteEventId === operations[2]?.sourceEventId)) return true;
  return false;
};
