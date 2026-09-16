import type { CaptureEnvelope, LearningWindow, RuleProposalInput } from "@provenloop/contracts";
import { researchEvidenceScore, researchTerms, sha256 } from "@provenloop/domain";

export const LEARNING_REQUEST_MAX_BYTES = 32 * 1024;
export const LEARNING_REQUEST_MAX_CHARACTERS = 24_000;

export class LearningInputBudgetError extends Error {
  public readonly code = "input_too_large";
  public readonly permanent = true;
  public constructor() { super("Learning input cannot fit the request budget after selecting source excerpts. No model request was sent."); }
}

export interface LearningExcerpt {
  readonly field: string;
  readonly offset: number;
  readonly text: string;
}
interface InferenceEvent {
  readonly event: Readonly<Record<string, unknown>>;
  readonly excerpts: LearningExcerpt[];
  readonly contentOmitted: boolean;
  readonly argumentsOmitted?: boolean;
}
export interface PreparedLearningInput {
  readonly prompt: string;
  readonly view: {
    readonly windowId: string; readonly sessionId: string; readonly repoId: string; readonly worktree: string;
    readonly origin: "user" | "agent"; readonly anchorEventId: string; readonly events: InferenceEvent[];
    readonly selection: { readonly omittedEvents: number; readonly excerptedEvents: number; readonly originalEvents: number };
  };
  readonly bytes: number;
  readonly characters: number;
}

interface TextSource { readonly field: string; readonly text: string }

// Traverse only bounded string leaves. Base64-like blobs and repeated log lines add no useful excerpt.
const textSources = (entry: CaptureEnvelope, keywords: readonly string[]): TextSource[] => {
  const pending: { field: string; value: unknown }[] = [
    { field: "content.toolResult", value: entry.content?.toolResult },
    { field: "content.safeError", value: entry.content?.safeError },
    { field: "content.message", value: entry.content?.message },
  ];
  const result: TextSource[] = []; const seenText = new Set<string>();
  let visited = 0;
  while (pending.length && visited++ < 4096) {
    const item = pending.pop(); if (!item) break;
    if (typeof item.value === "string") {
      if (item.value.trim() && !seenText.has(item.value) && !(item.value.length > 512 && /^[A-Za-z0-9+/=\s]+$/u.test(item.value) && !item.value.includes(" "))) {
        seenText.add(item.value); result.push({ field: item.field, text: item.value });
      }
    } else if (item.value && typeof item.value === "object") {
      const children = Object.entries(item.value).slice(0, 4096 - visited);
      for (const [key, value] of children.reverse()) {
        if (/^(?:base64|image|audio|embedding)$/iu.test(key)) continue;
        pending.push({ field: `${item.field}[${JSON.stringify(key)}]`, value });
      }
    }
  }
  const score = (source: TextSource) => (source.field === "content.message" ? 1000 : source.field === "content.safeError" ? 900 : 0) +
    (evidenceWords.test(source.text) ? 8 : 0) + keywords.filter((keyword) => source.text.toLowerCase().includes(keyword)).length * 4;
  return result.sort((a, b) => score(b) - score(a)).slice(0, 256);
};

const safeSlice = (value: string, start: number, end: number): { offset: number; text: string } => {
  let from = Math.max(0, start); let to = Math.min(value.length, end);
  if (from > 0 && /[\uDC00-\uDFFF]/u.test(value[from] ?? "")) from -= 1;
  if (to > from && /[\uD800-\uDBFF]/u.test(value[to - 1] ?? "")) to -= 1;
  return { offset: from, text: value.slice(from, to) };
};
const terms = (value: string): string[] => [...new Set(value.toLowerCase().match(/[a-z][a-z0-9_.-]{3,}|[\p{Script=Han}]{2,8}/gu) ?? [])]
  .filter((term) => !["this", "that", "with", "from", "have", "please", "should", "repository"].includes(term)).slice(0, 32);
const evidenceWords = /error|fail|exception|because|requires?|must|cannot|unless|only when|caus|pass|success|错误|失败|异常|因为|必须|需要|不能|仅当|成功|通过|原因/iu;

/** Select disjoint continuous spans; offsets always address one original source string. */
const excerpts = (sources: readonly TextSource[], keywords: readonly string[], allowance: number, preserveMessageEdges = false): LearningExcerpt[] => {
  const choices: { source: TextSource; start: number; end: number; score: number }[] = [];
  for (const source of sources) {
    if (source.text.length <= allowance) {
      const lower = source.text.toLowerCase();
      choices.push({ source, start: 0, end: source.text.length, score: 8 + keywords.filter((term) => lower.includes(term)).length * 4 + (evidenceWords.test(lower) ? 8 : 0) });
      continue;
    }
    const width = Math.min(640, Math.max(96, Math.floor(allowance / 3)));
    const messageEdges = preserveMessageEdges && source.field === "content.message";
    choices.push({ source, start: 0, end: width, score: messageEdges ? 1000 : 6 });
    choices.push({ source, start: Math.max(0, source.text.length - width), end: source.text.length, score: messageEdges ? 999 : 7 });
    let offset = 0; let lineCount = 0;
    const seenLines = new Set<string>();
    while (offset < source.text.length && lineCount++ < 8000) {
      const newline = source.text.indexOf("\n", offset);
      const end = newline < 0 ? source.text.length : newline + 1;
      const line = source.text.slice(offset, Math.min(end, offset + 4096));
      const lower = line.toLowerCase();
      const score = keywords.filter((term) => lower.includes(term)).length * 4 + (evidenceWords.test(line) ? 8 : 0);
      if (score > 0 && !seenLines.has(line)) {
        seenLines.add(line);
        const focus = lower.search(evidenceWords);
        const start = Math.max(offset, offset + Math.max(0, focus) - 80);
        choices.push({ source, start, end: Math.min(end, start + width), score });
      }
      offset = end;
    }
    // Single-line tool bodies can place the useful text near the end.
    for (const keyword of keywords.slice(0, 8)) {
      const at = source.text.toLowerCase().indexOf(keyword);
      if (at >= 0) {
        const lineStart = source.text.lastIndexOf("\n", at) + 1;
        const nextLine = source.text.indexOf("\n", at);
        const lineEnd = nextLine < 0 ? source.text.length : nextLine;
        const start = lineEnd - lineStart <= width ? lineStart : Math.max(lineStart, at - Math.min(80, Math.floor(width / 4)));
        choices.push({ source, start, end: Math.min(lineEnd, start + width), score: 12 });
      }
    }
  }
  choices.sort((a, b) => b.score - a.score || a.source.field.localeCompare(b.source.field) || a.start - b.start);
  const result: LearningExcerpt[] = []; let used = 0;
  for (const choice of choices) {
    if (result.length >= 4 || allowance - used < 64) break;
    if (result.some((entry) => entry.field === choice.source.field && choice.start < entry.offset + entry.text.length && choice.end > entry.offset)) continue;
    const selected = safeSlice(choice.source.text, choice.start, Math.min(choice.end, choice.start + allowance - used));
    if (!selected.text.trim()) continue;
    result.push({ field: choice.source.field, ...selected }); used += selected.text.length;
  }
  return result.sort((a, b) => a.field.localeCompare(b.field) || a.offset - b.offset);
};

const anchorFor = (window: LearningWindow): CaptureEnvelope | undefined => window.origin === "agent"
  ? window.events.find((entry) => entry.event.eventId === window.anchorEventId && entry.event.trust === "model")
  : window.events.find((entry) => entry.event.trust === "user" && `learning-window-${sha256(entry.event.eventId).slice(0, 24)}` === window.windowId)
    ?? window.events.find((entry) => entry.event.trust === "user" && entry.event.timestamp === window.createdAt);

/** A disposable model input. Original capture envelopes and their proof digests never change. */
export const prepareLearningInput = (window: LearningWindow, instructions: string): PreparedLearningInput => {
  const anchor = anchorFor(window);
  if (!anchor?.content?.message) throw new LearningInputBudgetError();
  const keywords = terms(anchor.content.message);
  const findingTerms = researchTerms(anchor.content.message);
  const sourceCache = new Map(window.events.map((entry) => [entry, textSources(entry, keywords)]));
  const agentEvidence = window.origin === "agent" ? window.events.filter((entry) => entry.event.trust === "tool" &&
    ["tool.completed", "tool.failed"].includes(entry.event.eventType) && (sourceCache.get(entry)?.length ?? 0) > 0 &&
    Date.parse(entry.event.timestamp) < Date.parse(anchor.event.timestamp))
    .sort((left, right) => researchEvidenceScore(right, findingTerms) - researchEvidenceScore(left, findingTerms) ||
      Date.parse(right.event.timestamp) - Date.parse(left.event.timestamp))[0] : undefined;
  const agentClosure = window.origin === "agent" ? window.events.find((entry) =>
    ["agent.turn_completed", "session.idle"].includes(entry.event.eventType) && Date.parse(entry.event.timestamp) >= Date.parse(anchor.event.timestamp)) : undefined;
  if (window.origin === "agent" && (!agentEvidence || !agentClosure)) throw new LearningInputBudgetError();
  const keyCompletion = agentEvidence ?? window.events.filter((entry) => entry.event.trust === "tool" &&
    ["tool.completed", "tool.failed"].includes(entry.event.eventType) && Date.parse(entry.event.timestamp) >= Date.parse(anchor.event.timestamp)).at(-1);
  const failedOperation = window.events.filter((entry) => entry.event.eventType === "tool.failed" || entry.event.completionStatus === "failed")
    .filter((entry) => keyCompletion === undefined || Date.parse(entry.event.timestamp) <= Date.parse(keyCompletion.event.timestamp)).at(-1);
  const keyOperations = new Set([keyCompletion?.event.operationId, failedOperation?.event.operationId].filter((id): id is string => id !== undefined));
  const criticalIds = new Set([anchor.event.eventId, agentClosure?.event.eventId, ...window.events.filter((entry) =>
    entry.event.operationId !== undefined && keyOperations.has(entry.event.operationId)).map((entry) => entry.event.eventId)].filter((id): id is string => id !== undefined));
  // Causal parents retain the connection between the failed operation, correction, retry and result.
  const eventMap = new Map(window.events.map((entry) => [entry.event.eventId, entry]));
  for (const id of [...criticalIds]) {
    let parent = eventMap.get(id)?.event.parentEventId; const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      visited.add(parent); const entry = eventMap.get(parent); if (!entry) break;
      criticalIds.add(parent); parent = entry.event.parentEventId;
    }
  }
  const ranked = window.events.map((entry, index) => ({ entry, index, priority: entry === anchor ? 1000
    : entry === agentEvidence || entry === agentClosure ? 950
      : criticalIds.has(entry.event.eventId) ? 920
    : entry.event.trust === "user" ? 900
      : entry.event.eventType === "tool.failed" || entry.event.completionStatus === "failed" ? 850
        : entry.event.eventType === "tool.completed" ? 800 + Math.min(49, researchEvidenceScore(entry, findingTerms))
          : ["tool.started", "test.completed", "agent.turn_completed", "session.idle"].includes(entry.event.eventType) ? 750
            : entry.event.eventType === "agent.message" ? 500 : 100 }));
  const textBudget = (entry: CaptureEnvelope, scale: number) => Math.max(96, Math.floor((entry === anchor ? 3072
    : entry.event.trust === "user" ? 1024 : ["tool.completed", "tool.failed"].includes(entry.event.eventType) ? 2048 : 512) * scale));
  const fits = (value: string) => Buffer.byteLength(value, "utf8") <= LEARNING_REQUEST_MAX_BYTES && value.length <= LEARNING_REQUEST_MAX_CHARACTERS;
  for (const scale of [1, 0.65, 0.4, 0.25, 0.125]) {
    const records = ranked.map(({ entry, index, priority }) => {
      const event = entry.event; const selected = excerpts(sourceCache.get(entry) ?? [], keywords, textBudget(entry, scale), entry === anchor || event.trust === "user");
      const argumentsText = JSON.stringify(event.redactedArguments);
      const keepArguments = argumentsText !== undefined && argumentsText.length <= Math.max(256, Math.floor(2048 * scale));
      const metadata = { eventId: event.eventId, eventType: event.eventType, timestamp: event.timestamp, trust: event.trust,
        operationId: event.operationId, parentEventId: event.parentEventId, toolName: event.toolName, mcp: event.mcp,
        completionStatus: event.completionStatus, exitCode: event.exitCode,
        ...(event.repoId !== window.repoId ? { repoId: event.repoId } : {}),
        ...(event.worktree !== window.worktree ? { worktree: event.worktree } : {}),
        ...(keepArguments ? { redactedArguments: event.redactedArguments } : {}),
      };
      const sources = sourceCache.get(entry) ?? [];
      const contentOmitted = (entry.content?.toolResult !== undefined && typeof entry.content.toolResult !== "string") ||
        sources.some((source) => !selected.some((excerpt) => excerpt.field === source.field && excerpt.offset === 0 && excerpt.text.length === source.text.length)) ||
        sources.length === 256 || (sources.length === 0 && entry.content !== undefined);
      return { index, priority, value: { event: metadata, excerpts: selected, contentOmitted,
        ...(argumentsText !== undefined && !keepArguments ? { argumentsOmitted: true } : {}) } as InferenceEvent };
    });
    const view = { windowId: window.windowId, sessionId: window.sessionId, repoId: window.repoId, worktree: window.worktree,
      origin: window.origin ?? "user" as const, anchorEventId: anchor.event.eventId, events: records.map((item) => item.value),
      selection: { originalEvents: window.events.length, omittedEvents: 0, excerptedEvents: records.filter((item) => item.value.contentOmitted).length } };
    let prompt = instructions + JSON.stringify(view);
    const hasRequiredText = () => view.events.some((entry) => entry.event.eventId === anchor.event.eventId && entry.excerpts.some((excerpt) => excerpt.field === "content.message")) &&
      (agentEvidence === undefined || view.events.some((entry) => entry.event.eventId === agentEvidence.event.eventId && entry.excerpts.length > 0));
    if (fits(prompt) && hasRequiredText()) return { prompt, view, bytes: Buffer.byteLength(prompt, "utf8"), characters: prompt.length };
    if (scale !== 0.125) continue;
    // Drop optional background as whole records. Keep all user turns and the selected anchor.
    for (const removable of [...records].filter((item) => item.priority < 900).sort((a, b) => a.priority - b.priority || a.index - b.index)) {
      view.events = view.events.filter((item) => item !== removable.value);
      view.selection.omittedEvents += 1;
      view.selection.excerptedEvents = view.events.filter((item) => item.contentOmitted).length;
      prompt = instructions + JSON.stringify(view);
      if (fits(prompt) && hasRequiredText()) return { prompt, view, bytes: Buffer.byteLength(prompt, "utf8"), characters: prompt.length };
    }
  }
  throw new LearningInputBudgetError();
};

/** Quotes must have been shown, and must fit one original leaf; IDs alone are not proof. */
export const validateDisplayedLearningSources = (prepared: PreparedLearningInput, proposals: readonly RuleProposalInput[]): void => {
  const byId = new Map(prepared.view.events.map((entry) => [entry.event.eventId, entry]));
  const shown = (eventId: string, quote: string, messageOnly = false) => byId.get(eventId)?.excerpts.some((entry) =>
    (!messageOnly || entry.field === "content.message") && entry.text.includes(quote));
  for (const proposal of proposals) {
    if (proposal.userSource && !shown(proposal.userSource.eventId, proposal.userSource.quote, true)) throw new Error("Learning response quotes a source outside the selected excerpts.");
    if (proposal.agentSource && !shown(proposal.agentSource.eventId, proposal.agentSource.quote, true)) throw new Error("Learning response quotes a source outside the selected excerpts.");
    for (const source of [...(proposal.supportingSources ?? []), ...(proposal.agentSource?.evidenceSources ?? [])]) {
      if (!shown(source.eventId, source.quote)) throw new Error("Learning response quotes a source outside the selected excerpts.");
    }
    for (const id of [proposal.failedOperationEventId, proposal.retryOperationEventId, proposal.completionEventId]) {
      if (id !== undefined && !byId.has(id)) throw new Error("Learning response references an omitted operation.");
    }
    if (proposal.predicate || proposal.shellPredicate) {
      if ([proposal.failedOperationEventId, proposal.retryOperationEventId].some((id) => id !== undefined && byId.get(id)?.argumentsOmitted)) {
        throw new Error("Learning response proposes recovery from omitted arguments.");
      }
    }
  }
};
