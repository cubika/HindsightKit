import {
  captureEnvelopeSchema,
  CURRENT_SCHEMA_VERSION,
  episodeAssociationSchema,
  episodeGroupingCorrectionSchema,
  workEpisodeSchema,
  type CaptureEnvelope,
  type EpisodeAssociation,
  type EpisodeAssociationEvidence,
  type EpisodeAssociationSignal,
  type EpisodeGroupingCorrection,
  type JsonValue,
  type WorkEpisode,
} from "@provenloop/contracts";

import { sha256 } from "./digest.js";
import { isInternalWorkSource } from "./work-source.js";
import {
  isCreatedCommitEvent,
  isVerificationEvent,
  trustedExecution,
  verificationOutcome,
} from "./verification-proof.js";
import type {
  CommitAncestryResolver,
} from "./commit-ancestry.js";

export interface WorkEpisodeBuilderOptions {
  /** Sparse omits automatic rejections; connected also omits weak suggestions. Both retain all grouping decisions. */
  readonly associationMode?: "all" | "sparse" | "connected";
  readonly associatedThreshold?: number;
  readonly candidateThreshold?: number;
  readonly commitAncestry?: CommitAncestryResolver;
  readonly observationWindowMs?: number;
}

export interface WorkEpisodeBuildResult {
  readonly associations: readonly EpisodeAssociation[];
  readonly episodes: readonly WorkEpisode[];
  readonly excludedSessions: readonly {
    readonly reason: "internal_work" | "no_substantive_work";
    readonly sessionId: string;
    readonly sourceEventIds: readonly string[];
  }[];
  readonly ignoredEventIds: readonly string[];
}

interface SessionSummary {
  readonly branches: ReadonlySet<string>;
  readonly commits: ReadonlySet<string>;
  readonly endMs: number;
  readonly events: readonly CaptureEnvelope[];
  readonly files: ReadonlySet<string>;
  readonly issues: ReadonlySet<string>;
  readonly featureSources: Readonly<Record<SessionFeature, ReadonlyMap<string, string>>>;
  readonly repositorySourceEventId: string;
  readonly pullRequests: ReadonlySet<string>;
  readonly repoKey: string;
  readonly repoId?: string;
  readonly sessionId: string;
  readonly startMs: number;
  readonly testOrErrors: ReadonlySet<string>;
  readonly tokens: ReadonlySet<string>;
}

const SESSION_FEATURES = [
  "branches", "commits", "files", "issues", "pullRequests", "testOrErrors", "tokens",
] as const;
type SessionFeature = typeof SESSION_FEATURES[number];

interface PairCorrection {
  readonly action: "merge" | "split";
  readonly correctionIds: readonly string[];
  readonly reason?: string;
  readonly timestamp: string;
}

const DEFAULT_ASSOCIATED_THRESHOLD = 0.85;
const DEFAULT_CANDIDATE_THRESHOLD = 0.55;
const DEFAULT_OBSERVATION_WINDOW_MS =
  14 * 24 * 60 * 60 * 1_000;
const STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "build",
  "change",
  "create",
  "from",
  "implement",
  "into",
  "please",
  "that",
  "this",
  "using",
  "with",
]);

const sorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort();

const byTimestampAndId = (
  left: CaptureEnvelope,
  right: CaptureEnvelope,
): number =>
  Date.parse(left.event.timestamp) -
    Date.parse(right.event.timestamp) ||
  left.event.eventId.localeCompare(right.event.eventId);

const pairKey = (left: string, right: string): string =>
  left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;

const pairIds = (
  left: string,
  right: string,
): readonly [string, string] =>
  left < right ? [left, right] : [right, left];

const overlap = (
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): {
  readonly intersection: readonly string[];
  readonly jaccard: number;
} => {
  const intersection = sorted(
    [...left].filter((value) => right.has(value)),
  );
  const unionSize = left.size + right.size - intersection.length;
  return {
    intersection,
    jaccard: unionSize === 0 ? 0 : intersection.length / unionSize,
  };
};

const boundedStrings = (
  input: JsonValue | undefined,
  acceptedKeys: ReadonlySet<string>,
  depth = 0,
): string[] => {
  if (input === undefined || depth > 4) {
    return [];
  }
  if (Array.isArray(input)) {
    return input.flatMap((value) =>
      boundedStrings(value, acceptedKeys, depth + 1),
    );
  }
  if (input === null || typeof input !== "object") {
    return [];
  }
  const values: string[] = [];
  for (const [
    key,
    value,
  ] of Object.entries(input)) {
    if (
      acceptedKeys.has(key.toLocaleLowerCase("en-US")) &&
      typeof value === "string" &&
      value.trim().length > 0
    ) {
      values.push(value.trim());
    }
    for (const nested of boundedStrings(value, acceptedKeys, depth + 1)) values.push(nested);
  }
  return values;
};

const eventStrings = (envelope: CaptureEnvelope): string[] => {
  const content = envelope.content;
  return [
    content?.message,
    content?.safeError,
    ...(content?.toolResult === undefined
      ? []
      : [
          JSON.stringify(content.toolResult),
        ]),
  ].filter((value): value is string => value !== undefined);
};

const referenceIds = (
  envelope: CaptureEnvelope,
  kind: "issue" | "pull_request",
): string[] => {
  if (envelope.event.eventType === "prompt.submitted" && !isUserGoal(envelope)) {
    return [];
  }
  const keySet =
    kind === "issue"
      ? new Set([
          "issue",
          "issueid",
          "issuenumber",
        ])
      : new Set([
          "pr",
          "prid",
          "prnumber",
          "pullrequest",
          "pullrequestid",
          "pullrequestnumber",
        ]);
  const keyed = boundedStrings(
    envelope.event.redactedArguments,
    keySet,
  ).flatMap((value) => value.match(/\d+/gu) ?? []);
  const prefix =
    kind === "issue"
      ? /\bissue\s*#?(\d+)\b/giu
      : /\b(?:pr|pull request)\s*#?(\d+)\b/giu;
  const mentioned = eventStrings(envelope).flatMap((value) =>
    [...value.matchAll(prefix)].map((match) => match[1] ?? ""),
  );
  return sorted([
    ...keyed,
    ...mentioned.filter((value) => value.length > 0),
  ]);
};

const fileNames = (envelope: CaptureEnvelope): string[] => {
  if (envelope.event.eventType !== "file.changed") {
    return [];
  }
  const keyed = boundedStrings(
    envelope.event.redactedArguments,
    new Set([
      "changedfiles",
      "file",
      "filepath",
      "files",
      "path",
    ]),
  );
  const content = eventStrings(envelope);
  return sorted(
    [
      ...keyed,
      ...content,
    ].map((value) =>
      value
        .replaceAll("\\", "/")
        .trim()
        .toLocaleLowerCase("en-US"),
    ),
  );
};

const testOrErrorSignatures = (
  envelope: CaptureEnvelope,
): string[] => {
  if (
    ![
      "build.completed",
      "session.error",
      "test.completed",
      "tool.failed",
    ].includes(envelope.event.eventType)
  ) {
    return [];
  }
  return sorted([
    ...eventStrings(envelope).map((value) =>
      value.trim().toLocaleLowerCase("en-US"),
    ),
    ...(envelope.event.resultDigest === undefined
      ? []
      : [
          envelope.event.resultDigest,
        ]),
  ]);
};

const taskTokens = (prompts: readonly string[]): ReadonlySet<string> =>
  new Set(
    prompts.flatMap((prompt) =>
      prompt
        .toLocaleLowerCase("en-US")
        .match(/[\p{L}\p{N}_-]+/gu)
        ?.filter(
          (token) =>
            token.length >= 3 &&
            !STOP_WORDS.has(token),
        ) ?? [],
    ),
  );

const meaningfulText = (value: string | undefined): boolean =>
  value !== undefined &&
  /[\p{L}\p{N}]/u.test(value) &&
  !/^(?:ok(?:ay)?|yes|no|thanks?(?: you)?|done|hello|hi|嗯|好(?:的)?|谢谢|是的|继续)[.!。！\s]*$/iu.test(value.trim());

const isUserMessage = (envelope: CaptureEnvelope): boolean =>
  envelope.event.trust === "user" &&
  ["prompt.submitted", "user.corrected"].includes(envelope.event.eventType) &&
  Boolean(envelope.content?.message?.trim());

const isUserGoal = (envelope: CaptureEnvelope): boolean =>
  isUserMessage(envelope) && meaningfulText(envelope.content?.message);

const isSubstantiveWork = (envelope: CaptureEnvelope): boolean => {
  if (isInternalWorkSource(envelope.event)) return false;
  if (isUserGoal(envelope)) return true;
  const { event } = envelope;
  if (event.eventType === "agent.message") {
    return event.trust === "model" && meaningfulText(envelope.content?.message);
  }
  if (!trustedExecution(envelope)) return false;
  if (isCreatedCommitEvent(envelope) && event.commitSha !== undefined) return true;
  if (isVerificationEvent(envelope)) return true;
  if (event.eventType === "file.changed") {
    return fileNames(envelope).length > 0 ||
      (event.evidence?.targetPaths?.length ?? 0) > 0;
  }
  if (["tool.started", "tool.completed", "tool.failed"].includes(event.eventType)) {
    return event.toolName !== undefined || event.redactedArguments !== undefined ||
      envelope.content?.toolResult !== undefined;
  }
  return ["issue.linked", "pull_request.updated", "review.received", "change.reverted"].includes(event.eventType) &&
    (eventStrings(envelope).some(meaningfulText) || event.redactedArguments !== undefined);
};

const compactGoal = (value: string): string => {
  const text = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(text);
  if (characters.length <= 180) return text;
  const prefix = characters.slice(0, 179).join("");
  const sentence = prefix.match(/^(.{40,}[.!?。！？])(?:\s|$)/u)?.[1];
  if (sentence !== undefined) return `${sentence}…`;
  const wordBoundary = prefix.lastIndexOf(" ");
  return `${wordBoundary >= 120 ? prefix.slice(0, wordBoundary) : prefix}…`;
};

const activityGoal = (envelope: CaptureEnvelope): string => {
  const { event } = envelope;
  if (event.eventType === "agent.message") {
    return compactGoal(`Recorded assistant response: ${envelope.content?.message ?? ""}`);
  }
  if (event.eventType === "file.changed") {
    const files = event.evidence?.targetPaths ?? fileNames(envelope);
    return compactGoal(`Changes recorded in ${files.join(", ")}`);
  }
  if (event.eventType === "git.commit") return compactGoal(`Commit recorded: ${event.commitSha ?? ""}`);
  if (isVerificationEvent(envelope)) {
    return compactGoal(`Recorded ${event.eventType.split(".")[0]} result${event.toolName === undefined ? "" : ` from ${event.toolName}`}`);
  }
  if (event.eventType.startsWith("tool.")) {
    return compactGoal(`Captured tool activity${event.toolName === undefined ? "" : `: ${event.toolName}`}`);
  }
  return compactGoal(`Recorded ${event.eventType.replaceAll(".", " ")}: ${envelope.content?.message ?? "work activity"}`);
};

const sourceWasTruncated = (envelope: CaptureEnvelope): boolean =>
  [...envelope.redaction.truncatedPaths, ...(envelope.event.captureQuality?.truncatedFields ?? [])]
    .some((path) => path === "message" || path === "content" || path.endsWith(".message") || path.endsWith(".content"));

const sessionSummary = (
  sessionId: string,
  events: readonly CaptureEnvelope[],
): SessionSummary => {
  const ordered = [...events].sort(
    byTimestampAndId,
  );
  const repoIds = sorted(
    ordered.flatMap((envelope) => {
      const identity =
        envelope.event.repoId ??
        (envelope.event.repositoryState === "known_repo" ? envelope.event.worktree : undefined);
      return identity === undefined ? [] : [identity];
    }),
  );
  const repoId = repoIds.length === 1 ? repoIds[0] : undefined;
  const featureSources: Record<SessionFeature, Map<string, string>> = {
    branches: new Map(), commits: new Map(), files: new Map(), issues: new Map(),
    pullRequests: new Map(), testOrErrors: new Map(), tokens: new Map(),
  };
  for (const envelope of ordered) {
    const add = (feature: SessionFeature, values: Iterable<string>): void => {
      for (const value of values) {
        // One deterministic witness per feature is sufficient; raw evidence remains canonical.
        if (!featureSources[feature].has(value)) {
          featureSources[feature].set(value, envelope.event.eventId);
        }
      }
    };
    if (envelope.event.branch !== undefined) add("branches", [envelope.event.branch]);
    if (isCreatedCommitEvent(envelope) && envelope.event.commitSha !== undefined) {
      add("commits", [envelope.event.commitSha]);
    }
    add("files", fileNames(envelope));
    add("issues", referenceIds(envelope, "issue"));
    add("pullRequests", referenceIds(envelope, "pull_request"));
    add("testOrErrors", testOrErrorSignatures(envelope));
    if (isUserGoal(envelope) && envelope.content?.message !== undefined) {
      add("tokens", taskTokens([envelope.content.message]));
    }
  }
  return {
    branches: new Set(featureSources.branches.keys()),
    commits: new Set(featureSources.commits.keys()),
    endMs: Date.parse(ordered.at(-1)?.event.timestamp ?? "1970-01-01T00:00:00.000Z"),
    events: ordered,
    featureSources,
    files: new Set(featureSources.files.keys()),
    issues: new Set(featureSources.issues.keys()),
    pullRequests: new Set(featureSources.pullRequests.keys()),
    repositorySourceEventId: ordered.find((envelope) =>
      envelope.event.repoId !== undefined || envelope.event.repositoryState === "known_repo",
    )?.event.eventId ?? ordered[0]?.event.eventId ?? sessionId,
    repoKey:
      repoId ??
      (
        repoIds.length === 0
          ? `unknown:${sessionId}`
          : `ambiguous:${sessionId}`
      ),
    ...(repoId === undefined ? {} : { repoId }),
    sessionId,
    startMs: Date.parse(ordered[0]?.event.timestamp ?? "1970-01-01T00:00:00.000Z"),
    testOrErrors: new Set(featureSources.testOrErrors.keys()),
    tokens: new Set(featureSources.tokens.keys()),
  };
};

const supportingEvents = (
  feature: SessionFeature,
  values: readonly string[],
  left: SessionSummary,
  right: SessionSummary,
): string[] => sorted(values.flatMap((value) =>
  [left.featureSources[feature].get(value), right.featureSources[feature].get(value)]
    .filter((eventId): eventId is string => eventId !== undefined),
));

function* associationPairs(
  summaries: readonly SessionSummary[],
  corrections: readonly EpisodeGroupingCorrection[],
  sparse: boolean,
): Generator<readonly [SessionSummary, SessionSummary]> {
  if (!sparse) {
    for (const [leftIndex, left] of summaries.entries()) {
      for (let rightIndex = leftIndex + 1; rightIndex < summaries.length; rightIndex += 1) {
        const right = summaries[rightIndex];
        if (right !== undefined) yield [left, right];
      }
    }
    return;
  }
  const candidates = new Map<number, Set<number>>();
  const addPair = (first: number, second: number): void => {
    if (first === second) return;
    const left = Math.min(first, second);
    const right = Math.max(first, second);
    const selected = candidates.get(left) ?? new Set<number>();
    selected.add(right);
    candidates.set(left, selected);
  };
  const bySession = new Map(summaries.map((summary, index) => [summary.sessionId, index]));
  for (const correction of corrections) {
    const indexes = correction.sessionIds.flatMap((id) => {
      const index = bySession.get(id);
      return index === undefined ? [] : [index];
    });
    for (const [position, left] of indexes.entries()) {
      for (let next = position + 1; next < indexes.length; next += 1) {
        const right = indexes[next];
        if (right !== undefined) addPair(left, right);
      }
    }
  }
  const repositories = new Map<string, number[]>();
  for (const [index, summary] of summaries.entries()) {
    const indexes = repositories.get(summary.repoKey) ?? [];
    indexes.push(index);
    repositories.set(summary.repoKey, indexes);
  }
  for (const indexes of repositories.values()) {
    // Every nonzero automatic signal requires shared features or temporal proximity.
    // Ancestry alone has no weight, so its corroborating pair is already included.
    for (const feature of SESSION_FEATURES) {
      const postings = new Map<string, number[]>();
      for (const index of indexes) {
        const summary = summaries[index];
        if (summary === undefined) continue;
        for (const value of summary[feature]) {
          const previous = postings.get(value) ?? [];
          for (const other of previous) addPair(other, index);
          previous.push(index);
          postings.set(value, previous);
        }
      }
    }
    const start = (index: number): number => summaries[index]?.startMs ?? 0;
    const end = (index: number): number => summaries[index]?.endMs ?? 0;
    const byStart = [...indexes].sort((left, right) => start(left) - start(right) || left - right);
    const byEnd = [...indexes].sort((left, right) => end(left) - end(right) || left - right);
    const active = new Set<number>();
    let expired = 0;
    for (const index of byStart) {
      while (expired < byEnd.length) {
        const previous = byEnd[expired];
        if (previous === undefined || end(previous) >= start(index) - 24 * 60 * 60 * 1_000) break;
        active.delete(previous);
        expired += 1;
      }
      for (const previous of active) addPair(previous, index);
      active.add(index);
    }
  }
  for (const [leftIndex, left] of summaries.entries()) {
    for (const rightIndex of [...(candidates.get(leftIndex) ?? [])].sort((a, b) => a - b)) {
      const right = summaries[rightIndex];
      if (right !== undefined) yield [left, right];
    }
  }
}

interface SessionInterval {
  readonly index: number;
  readonly endMs: number;
  readonly startMs: number;
  readonly maximumEndMs: number;
  readonly left: SessionInterval | undefined;
  readonly right: SessionInterval | undefined;
}

const sessionIntervals = (
  entries: readonly { readonly index: number; readonly startMs: number; readonly endMs: number }[],
  begin = 0, end = entries.length,
): SessionInterval | undefined => {
  if (begin >= end) return undefined;
  const middle = Math.floor((begin + end) / 2);
  const entry = entries[middle];
  if (entry === undefined) return undefined;
  const left = sessionIntervals(entries, begin, middle);
  const right = sessionIntervals(entries, middle + 1, end);
  return { ...entry, left, right, maximumEndMs: Math.max(
    entry.endMs, left?.maximumEndMs ?? Number.NEGATIVE_INFINITY, right?.maximumEndMs ?? Number.NEGATIVE_INFINITY,
  ) };
};

const featureBits: Readonly<Record<SessionFeature, number>> = {
  branches: 1, commits: 2, files: 4, issues: 8, pullRequests: 16, testOrErrors: 32, tokens: 64,
};
const TEMPORAL_BIT = 128;
const ANCESTRY_BIT = 256;
const CORRECTION_BIT = 512;
const CORROBORATING_BITS = 4 | 8 | 16 | 32 | 64 | TEMPORAL_BIT;
const ASSOCIATION_MAXIMUM_WEIGHTS = [
  [featureBits.branches, 0.72], [featureBits.commits, 0.99], [featureBits.files, 0.8],
  [featureBits.issues, 0.96], [featureBits.pullRequests, 0.98], [featureBits.testOrErrors, 0.78],
  [featureBits.tokens, 0.65], [TEMPORAL_BIT, 0.65], [ANCESTRY_BIT, 0.55],
] as const;

function* connectedAssociationPairs(
  summaries: readonly SessionSummary[],
  corrections: readonly EpisodeGroupingCorrection[],
  associatedThreshold: number,
  hasAncestry: boolean,
): Generator<readonly [SessionSummary, SessionSummary]> {
  interface RepositoryIndex {
    readonly features: ReadonlyMap<SessionFeature, Map<string, number[]>>;
    readonly entries: { readonly index: number; readonly startMs: number; readonly endMs: number }[];
    intervals?: SessionInterval | undefined;
  }
  const repositories = new Map<string, RepositoryIndex>();
  const indexesBySession = new Map<string, number>();
  const correctionsBySession = new Map<string, EpisodeGroupingCorrection[]>();
  for (const correction of corrections) {
    for (const id of correction.sessionIds) {
      const selected = correctionsBySession.get(id) ?? [];
      selected.push(correction);
      correctionsBySession.set(id, selected);
    }
  }
  for (const [index, summary] of summaries.entries()) {
    indexesBySession.set(summary.sessionId, index);
    const repository = repositories.get(summary.repoKey) ?? {
      features: new Map(SESSION_FEATURES.map((feature) => [feature, new Map<string, number[]>()])), entries: [],
    };
    repository.entries.push({ index, startMs: summary.startMs, endMs: summary.endMs });
    for (const feature of SESSION_FEATURES) {
      const postings = repository.features.get(feature);
      if (postings === undefined) continue;
      for (const value of summary[feature]) {
        const indexes = postings.get(value) ?? [];
        indexes.push(index);
        postings.set(value, indexes);
      }
    }
    repositories.set(summary.repoKey, repository);
  }
  for (const repository of repositories.values()) {
    repository.intervals = sessionIntervals(repository.entries.sort((left, right) =>
      left.startMs - right.startMs || left.index - right.index,
    ));
  }
  const upperBounds = new Map<number, number>();
  const couldAssociate = (mask: number): boolean => {
    if ((mask & CORRECTION_BIT) !== 0) return true;
    let upperBound = upperBounds.get(mask);
    if (upperBound === undefined) {
      let remaining = 1;
      for (const [bit, weight] of ASSOCIATION_MAXIMUM_WEIGHTS) {
        if ((mask & bit) !== 0) remaining *= 1 - weight;
      }
      upperBound = 1 - remaining;
      upperBounds.set(mask, upperBound);
    }
    // Conservative slack avoids dropping a boundary case due to floating-point rounding.
    return upperBound + Number.EPSILON * 8 >= associatedThreshold;
  };
  for (const [leftIndex, left] of summaries.entries()) {
    const candidates = new Map<number, number>();
    const add = (index: number, bit: number): void => {
      if (index > leftIndex) candidates.set(index, (candidates.get(index) ?? 0) | bit);
    };
    for (const correction of correctionsBySession.get(left.sessionId) ?? []) {
      for (const sessionId of correction.sessionIds) {
        const index = indexesBySession.get(sessionId);
        if (index !== undefined) add(index, CORRECTION_BIT);
      }
    }
    const repository = repositories.get(left.repoKey);
    for (const feature of SESSION_FEATURES) {
      const postings = repository?.features.get(feature);
      for (const value of left[feature]) {
        for (const index of postings?.get(value) ?? []) add(index, featureBits[feature]);
      }
    }
    const minimumEnd = left.startMs - 24 * 60 * 60 * 1_000;
    const maximumStart = left.endMs + 24 * 60 * 60 * 1_000;
    const visit = (node: SessionInterval | undefined): void => {
      if (node === undefined || node.maximumEndMs < minimumEnd) return;
      visit(node.left);
      if (node.startMs > maximumStart) return;
      if (node.endMs >= minimumEnd) add(node.index, TEMPORAL_BIT);
      visit(node.right);
    };
    visit(repository?.intervals);
    for (const index of [...candidates.keys()].sort((first, second) => first - second)) {
      const right = summaries[index];
      if (right === undefined) continue;
      let mask = candidates.get(index) ?? 0;
      if (hasAncestry && left.repoId !== undefined && left.repoId === right.repoId &&
        left.commits.size > 0 && right.commits.size > 0 && (mask & CORROBORATING_BITS) !== 0) {
        mask |= ANCESTRY_BIT;
      }
      if (couldAssociate(mask)) yield [left, right];
    }
  }
}

const evidence = (
  signal: EpisodeAssociationSignal,
  weight: number,
  detail: string,
  sourceEventIds: readonly string[],
): EpisodeAssociationEvidence => {
  const normalizedSourceEventIds = sorted(sourceEventIds);
  return {
    detail,
    evidenceId:
      `association-evidence-${sha256({
        detail,
        signal,
        sourceEventIds: normalizedSourceEventIds,
        weight,
      }).slice(0, 24)}`,
    signal,
    sourceEventIds: normalizedSourceEventIds,
    weight,
  };
};

const temporalWeight = (
  left: SessionSummary,
  right: SessionSummary,
): number => {
  const gapMs = Math.max(
    0,
    Math.max(left.startMs, right.startMs) -
      Math.min(left.endMs, right.endMs),
  );
  if (gapMs <= 30 * 60 * 1_000) {
    return 0.65;
  }
  if (gapMs <= 2 * 60 * 60 * 1_000) {
    return 0.55;
  }
  if (gapMs <= 6 * 60 * 60 * 1_000) {
    return 0.4;
  }
  if (gapMs <= 24 * 60 * 60 * 1_000) {
    return 0.25;
  }
  return 0;
};

const combinedConfidence = (
  evidenceItems: readonly EpisodeAssociationEvidence[],
): number => {
  const associationWeights = evidenceItems
    .filter((item) => item.signal !== "repository")
    .map((item) => item.weight);
  if (associationWeights.length === 0) {
    return 0;
  }
  return Math.min(
    1,
    1 -
      associationWeights.reduce(
        (remaining, weight) => remaining * (1 - weight),
        1,
      ),
  );
};

const correctionMap = (
  corrections: readonly EpisodeGroupingCorrection[],
): ReadonlyMap<string, PairCorrection> => {
  const pairs = new Map<string, PairCorrection>();
  for (const correction of [...corrections].sort(
    (left, right) =>
      Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
      left.correctionId.localeCompare(right.correctionId),
  )) {
    for (
      let leftIndex = 0;
      leftIndex < correction.sessionIds.length;
      leftIndex += 1
    ) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < correction.sessionIds.length;
        rightIndex += 1
      ) {
        const left = correction.sessionIds[leftIndex];
        const right = correction.sessionIds[rightIndex];
        if (left === undefined || right === undefined) {
          continue;
        }
        const key = pairKey(left, right);
        const previous = pairs.get(key);
        pairs.set(key, {
          action: correction.action,
          correctionIds: [
            ...(previous?.correctionIds ?? []),
            correction.correctionId,
          ],
          ...(correction.reason === undefined
            ? {}
            : {
                reason: correction.reason,
              }),
          timestamp: correction.timestamp,
        });
      }
    }
  }
  return pairs;
};

const pairAssociation = (
  left: SessionSummary,
  right: SessionSummary,
  correction: PairCorrection | undefined,
  commitAncestry: CommitAncestryResolver | undefined,
  thresholds: {
    readonly associated: number;
    readonly candidate: number;
  },
): EpisodeAssociation => {
  const [
    leftSessionId,
    rightSessionId,
  ] = pairIds(left.sessionId, right.sessionId);
  const createdAt =
    correction?.timestamp ??
    new Date(
      Math.min(left.startMs, right.startMs),
    ).toISOString();
  const correctionEvidence =
    correction === undefined
      ? undefined
      : evidence(
          correction.action === "merge"
            ? "explicit_merge"
            : "explicit_split",
          1,
          correction.reason ??
            `User requested an explicit ${correction.action}.`,
          [],
        );
  if (correction?.action === "split") {
    return episodeAssociationSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      associationId:
        `episode-association-${sha256({
          leftSessionId,
          rightSessionId,
        }).slice(0, 24)}`,
      confidence: 1,
      correctionIds: correction.correctionIds,
      createdAt,
      evidence: [
        correctionEvidence,
      ],
      leftSessionId,
      rightSessionId,
      status: "rejected",
    });
  }
  if (correction?.action === "merge") {
    return episodeAssociationSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      associationId:
        `episode-association-${sha256({
          leftSessionId,
          rightSessionId,
        }).slice(0, 24)}`,
      confidence: 1,
      correctionIds: correction.correctionIds,
      createdAt,
      evidence: [
        correctionEvidence,
      ],
      leftSessionId,
      rightSessionId,
      status: "associated",
    });
  }

  const evidenceItems: EpisodeAssociationEvidence[] = [];
  if (left.repoKey !== right.repoKey) {
    evidenceItems.push(
      evidence(
        "repository",
        1,
        `Repository identities differ: ${left.repoKey} vs ${right.repoKey}.`,
        [
          left.repositorySourceEventId,
          right.repositorySourceEventId,
        ],
      ),
    );
    return episodeAssociationSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      associationId:
        `episode-association-${sha256({
          leftSessionId,
          rightSessionId,
        }).slice(0, 24)}`,
      confidence: 0,
      correctionIds: [],
      createdAt,
      evidence: evidenceItems,
      leftSessionId,
      rightSessionId,
      status: "rejected",
    });
  }

  evidenceItems.push(
    evidence(
      "repository",
      1,
      `Both Sessions resolve to repository ${left.repoKey}.`,
      [
        left.repositorySourceEventId,
        right.repositorySourceEventId,
      ],
    ),
  );
  const branchOverlap = overlap(left.branches, right.branches);
  if (branchOverlap.intersection.length > 0) {
    evidenceItems.push(
      evidence(
        "branch",
        0.72,
        `Shared branches: ${branchOverlap.intersection.join(", ")}.`,
        supportingEvents("branches", branchOverlap.intersection, left, right),
      ),
    );
  }
  const commitOverlap = overlap(left.commits, right.commits);
  if (commitOverlap.intersection.length > 0) {
    evidenceItems.push(
      evidence(
        "commit",
        0.99,
        `Shared commits: ${commitOverlap.intersection.join(", ")}.`,
        supportingEvents("commits", commitOverlap.intersection, left, right),
      ),
    );
  }
  const ancestryRepoId =
    left.repoId !== undefined &&
    left.repoId === right.repoId
      ? left.repoId
      : undefined;
  const pullRequestOverlap = overlap(
    left.pullRequests,
    right.pullRequests,
  );
  if (pullRequestOverlap.intersection.length > 0) {
    evidenceItems.push(
      evidence(
        "pull_request",
        0.98,
        `Shared pull requests: ${pullRequestOverlap.intersection.join(", ")}.`,
        supportingEvents("pullRequests", pullRequestOverlap.intersection, left, right),
      ),
    );
  }
  const issueOverlap = overlap(left.issues, right.issues);
  if (issueOverlap.intersection.length > 0) {
    evidenceItems.push(
      evidence(
        "issue",
        0.96,
        `Shared issues: ${issueOverlap.intersection.join(", ")}.`,
        supportingEvents("issues", issueOverlap.intersection, left, right),
      ),
    );
  }
  const fileOverlap = overlap(left.files, right.files);
  if (fileOverlap.intersection.length > 0) {
    evidenceItems.push(
      evidence(
        "changed_file",
        Math.min(0.8, 0.65 + fileOverlap.jaccard * 0.15),
        `Changed-file overlap: ${fileOverlap.intersection.join(", ")}.`,
        supportingEvents("files", fileOverlap.intersection, left, right),
      ),
    );
  }
  const testOverlap = overlap(
    left.testOrErrors,
    right.testOrErrors,
  );
  if (testOverlap.intersection.length > 0) {
    evidenceItems.push(
      evidence(
        "test_or_error",
        0.78,
        "The Sessions share a test result or error signature.",
        supportingEvents("testOrErrors", testOverlap.intersection, left, right),
      ),
    );
  }
  const semanticOverlap = overlap(left.tokens, right.tokens);
  if (semanticOverlap.jaccard >= 0.25) {
    evidenceItems.push(
      evidence(
        "task_semantics",
        Math.min(0.65, 0.4 + semanticOverlap.jaccard * 0.25),
        `Task-token overlap: ${semanticOverlap.intersection.join(", ")}.`,
        supportingEvents("tokens", semanticOverlap.intersection, left, right),
      ),
    );
  }
  const proximity = temporalWeight(left, right);
  if (proximity > 0) {
    evidenceItems.push(
      evidence(
        "temporal_proximity",
        proximity,
        "The Session time ranges are close.",
        [
          left.events.at(-1)?.event.eventId ?? left.sessionId,
          right.events[0]?.event.eventId ?? right.sessionId,
        ],
      ),
    );
  }
  const ancestryCorroborated = evidenceItems.some((item) =>
    [
      "changed_file",
      "issue",
      "pull_request",
      "task_semantics",
      "temporal_proximity",
      "test_or_error",
    ].includes(item.signal),
  );
  const ancestryRelations: string[] = [];
  const ancestrySources = new Set<string>();
  if (ancestryCorroborated && ancestryRepoId !== undefined && commitAncestry !== undefined) {
    for (const leftCommit of left.commits) {
      for (const rightCommit of right.commits) {
        let relation: string | undefined;
        if (commitAncestry.isAncestor({ ancestorCommit: leftCommit, descendantCommit: rightCommit, repoId: ancestryRepoId })) {
          relation = `${leftCommit} -> ${rightCommit}`;
        } else if (commitAncestry.isAncestor({ ancestorCommit: rightCommit, descendantCommit: leftCommit, repoId: ancestryRepoId })) {
          relation = `${rightCommit} -> ${leftCommit}`;
        }
        if (relation === undefined) continue;
        ancestryRelations.push(relation);
        for (const source of [left.featureSources.commits.get(leftCommit), right.featureSources.commits.get(rightCommit)]) {
          if (source !== undefined) ancestrySources.add(source);
        }
      }
    }
  }
  if (ancestryRelations.length > 0) {
    evidenceItems.push(
      evidence(
        "commit_ancestry",
        0.55,
        `Commit ancestry connects the Sessions: ${ancestryRelations.join(", ")}.`,
        [...ancestrySources],
      ),
    );
  }
  const confidence = combinedConfidence(evidenceItems);
  return episodeAssociationSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    associationId:
      `episode-association-${sha256({
        leftSessionId,
        rightSessionId,
      }).slice(0, 24)}`,
    confidence,
    correctionIds: [],
    createdAt,
    evidence: evidenceItems,
    leftSessionId,
    rightSessionId,
    status:
      confidence >= thresholds.associated
        ? "associated"
        : confidence >= thresholds.candidate
          ? "candidate"
          : "rejected",
  });
};

const completeLinkClusters = (
  sessionIds: readonly string[],
  associations: readonly EpisodeAssociation[],
): readonly ReadonlySet<string>[] => {
  const associationByPair = new Map(
    associations.map((association) => [
      pairKey(
        association.leftSessionId,
        association.rightSessionId,
      ),
      association,
    ]),
  );
  const clusters = new Set(sessionIds.map((sessionId) => new Set([sessionId])));
  const clusterBySession = new Map<string, Set<string>>();
  for (const cluster of clusters) {
    for (const sessionId of cluster) clusterBySession.set(sessionId, cluster);
  }
  const hasSignal = (
    association: EpisodeAssociation,
    signal: EpisodeAssociationSignal,
  ): boolean =>
    association.evidence.some((item) => item.signal === signal);
  const explicitSplits = new Set(
    associations
      .filter((association) =>
        hasSignal(association, "explicit_split"),
      )
      .map((association) =>
        pairKey(
          association.leftSessionId,
          association.rightSessionId,
        ),
      ),
  );
  const mergeClusters = (
    association: EpisodeAssociation,
    requireCompleteLink: boolean,
  ): void => {
    const leftCluster = clusterBySession.get(association.leftSessionId);
    const rightCluster = clusterBySession.get(association.rightSessionId);
    if (leftCluster === undefined || rightCluster === undefined || leftCluster === rightCluster) {
      return;
    }
    const splitConflict = explicitSplits.size > 0 && [...leftCluster].some((leftSessionId) =>
      [...rightCluster].some((rightSessionId) =>
        explicitSplits.has(pairKey(leftSessionId, rightSessionId)),
      ),
    );
    if (splitConflict) {
      return;
    }
    const completeLink =
      !requireCompleteLink ||
      [...leftCluster].every((leftSessionId) =>
        [...rightCluster].every(
          (rightSessionId) =>
            associationByPair.get(
              pairKey(leftSessionId, rightSessionId),
            )?.status === "associated",
        ),
      );
    if (!completeLink) {
      return;
    }
    const [merged, removed] = leftCluster.size >= rightCluster.size
      ? [leftCluster, rightCluster] : [rightCluster, leftCluster];
    for (const sessionId of removed) {
      merged.add(sessionId);
      clusterBySession.set(sessionId, merged);
    }
    clusters.delete(removed);
  };
  const explicitMerges = associations
    .filter(
      (association) =>
        association.status === "associated" &&
        hasSignal(association, "explicit_merge"),
    )
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.associationId.localeCompare(right.associationId),
    );
  for (const association of explicitMerges) {
    mergeClusters(association, false);
  }
  const associated = associations
    .filter(
      (association) =>
        association.status === "associated" &&
        !hasSignal(association, "explicit_merge"),
    )
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.associationId.localeCompare(right.associationId),
    );
  for (const association of associated) {
    mergeClusters(association, true);
  }
  return [...clusters];
};

const outcome = (
  events: readonly CaptureEnvelope[],
  observationWindowMs: number,
): Pick<
  WorkEpisode,
  | "observationWindowEndsAt"
  | "outcome"
  | "outcomeEvidenceIds"
  | "outcomeQualification"
  | "outcomeQualifiedAt"
> => {
  const reverted = events.find(
    (event) =>
      event.event.eventType === "change.reverted" &&
      trustedExecution(event),
  );
  if (reverted !== undefined) {
    return {
      outcome: "reverted",
      outcomeEvidenceIds: [
        reverted.event.eventId,
      ],
      outcomeQualification: "qualified",
      outcomeQualifiedAt: reverted.event.timestamp,
    };
  }
  const resultEvents = events.filter(isVerificationEvent);
  const latest = resultEvents.at(-1);
  if (latest !== undefined && verificationOutcome(latest) === "failed") {
    return {
      outcome: "failure",
      outcomeEvidenceIds: [
        latest.event.eventId,
      ],
      outcomeQualification: "qualified",
      outcomeQualifiedAt: latest.event.timestamp,
    };
  }
  if (latest !== undefined && verificationOutcome(latest) === "succeeded") {
    return {
      observationWindowEndsAt: new Date(
        Date.parse(latest.event.timestamp) + observationWindowMs,
      ).toISOString(),
      outcome: "success",
      outcomeEvidenceIds: [
        latest.event.eventId,
      ],
      outcomeQualification: "censored",
    };
  }
  return {
    outcome: "unknown",
    outcomeEvidenceIds: [],
    outcomeQualification: "open",
  };
};

const episodeFromCluster = (
  cluster: ReadonlySet<string>,
  summaries: ReadonlyMap<string, SessionSummary>,
  internalAssociations: readonly EpisodeAssociation[],
  correctionIds: readonly string[],
  observationWindowMs: number,
): WorkEpisode => {
  const sessionIds = sorted(cluster);
  const events = sessionIds.length === 1
    ? summaries.get(sessionIds[0] ?? "")?.events ?? []
    : sessionIds.flatMap((sessionId) => summaries.get(sessionId)?.events ?? []).sort(byTimestampAndId);
  const repoIds = sorted(
    sessionIds.flatMap((sessionId) => {
      const repoId = summaries.get(sessionId)?.repoId;
      return repoId === undefined ? [] : [repoId];
    }),
  );
  const prompt = events.find(isUserGoal);
  const goalSource = prompt ?? events.find(isSubstantiveWork);
  if (goalSource === undefined) {
    throw new Error("An Episode requires substantive work evidence.");
  }
  const startedAt =
    events[0]?.event.timestamp ??
    "1970-01-01T00:00:00.000Z";
  const lastActivityAt = events.at(-1)?.event.timestamp ?? startedAt;
  const closures = sessionIds.flatMap((sessionId) => {
    const sessionEvents = summaries.get(sessionId)?.events ?? [];
    const closure = sessionEvents.findLast((envelope) =>
      envelope.event.eventType === "session.ended" &&
      ["system", "user"].includes(envelope.event.trust),
    );
    if (closure === undefined || sessionEvents.some((envelope) =>
      Date.parse(envelope.event.timestamp) > Date.parse(closure.event.timestamp) &&
      (isSubstantiveWork(envelope) || envelope.event.eventType === "session.started"),
    )) return [];
    return [closure];
  });
  const finishedAt = closures.length === sessionIds.length
    ? [...closures].sort(byTimestampAndId).at(-1)?.event.timestamp
    : undefined;
  const substantiveEvents = events.filter(isSubstantiveWork);
  const repositoryState = repoIds.length === 1 ? "known_repo"
    : repoIds.length === 0 && substantiveEvents.every((envelope) =>
      envelope.event.repositoryState === "known_outside_repo",
    ) ? "known_outside_repo" : "unknown";
  const outcomeState = outcome(events, observationWindowMs);
  return workEpisodeSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    associationConfidence: internalAssociations.reduce(
      (confidence, association) => Math.min(confidence, association.confidence), 1,
    ),
    associationEvidenceIds: sorted(
      internalAssociations.flatMap((association) =>
        association.evidence.map((item) => item.evidenceId),
      ),
    ),
    branches: sorted(
      events.flatMap((event) =>
        event.event.branch === undefined
          ? []
          : [event.event.branch],
      ),
    ),
    commitIds: sorted(
      events.flatMap((event) =>
        !isCreatedCommitEvent(event) ||
        event.event.commitSha === undefined
          ? []
          : [event.event.commitSha],
      ),
    ),
    closureSourceEventIds: finishedAt === undefined ? [] : closures.map((envelope) => envelope.event.eventId),
    correctionEventIds: sorted([
      ...events
        .filter(
          (event) => event.event.eventType === "user.corrected",
        )
        .map((event) => event.event.eventId),
      ...correctionIds,
    ]),
    episodeId:
      `episode-${sha256({
        sessionIds,
      }).slice(0, 24)}`,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    goal: prompt === undefined
      ? activityGoal(goalSource)
      : compactGoal(prompt.content?.message ?? ""),
    goalSource: prompt === undefined ? "activity_summary" : "user_prompt",
    goalSourceEventIds: [goalSource.event.eventId],
    goalSourceTruncated: sourceWasTruncated(goalSource),
    issueIds: sorted(
      sessionIds.flatMap(
        (sessionId) => [
          ...(summaries.get(sessionId)?.issues ?? []),
        ],
      ),
    ),
    lastActivityAt,
    ...outcomeState,
    pullRequestIds: sorted(
      sessionIds.flatMap(
        (sessionId) => [
          ...(summaries.get(sessionId)?.pullRequests ?? []),
        ],
      ),
    ),
    ...(repoIds.length === 1
      ? {
          repoId: repoIds[0],
        }
      : {}),
    repositoryState,
    sessionIds,
    sourceEventIds: events.map((event) => event.event.eventId),
    startedAt,
    worktrees: sorted(events.flatMap((envelope) =>
      envelope.event.worktree === undefined ? [] : [envelope.event.worktree],
    )),
  });
};

const threshold = (
  value: number | undefined,
  fallback: number,
  name: string,
): number => {
  const resolved = value ?? fallback;
  if (
    !Number.isFinite(resolved) ||
    resolved < 0 ||
    resolved > 1
  ) {
    throw new RangeError(`${name} must be between 0 and 1.`);
  }
  return resolved;
};

export class WorkEpisodeBuilder {
  readonly #associationMode: "all" | "sparse" | "connected";
  readonly #associatedThreshold: number;
  readonly #candidateThreshold: number;
  readonly #commitAncestry: CommitAncestryResolver | undefined;
  readonly #observationWindowMs: number;

  public constructor(options: WorkEpisodeBuilderOptions = {}) {
    this.#associationMode = options.associationMode ?? "all";
    this.#associatedThreshold = threshold(
      options.associatedThreshold,
      DEFAULT_ASSOCIATED_THRESHOLD,
      "associatedThreshold",
    );
    this.#candidateThreshold = threshold(
      options.candidateThreshold,
      DEFAULT_CANDIDATE_THRESHOLD,
      "candidateThreshold",
    );
    this.#commitAncestry = options.commitAncestry;
    if (this.#candidateThreshold >= this.#associatedThreshold) {
      throw new RangeError(
        "candidateThreshold must be lower than associatedThreshold.",
      );
    }
    this.#observationWindowMs =
      options.observationWindowMs ??
      DEFAULT_OBSERVATION_WINDOW_MS;
    if (
      !Number.isInteger(this.#observationWindowMs) ||
      this.#observationWindowMs <= 0
    ) {
      throw new RangeError(
        "observationWindowMs must be a positive integer.",
      );
    }
  }

  public build(
    input: readonly CaptureEnvelope[],
    corrections: readonly EpisodeGroupingCorrection[] = [],
  ): WorkEpisodeBuildResult {
    const envelopes = input.map((envelope) =>
      captureEnvelopeSchema.parse(envelope),
    );
    const parsedCorrections = corrections.map((correction) =>
      episodeGroupingCorrectionSchema.parse(correction),
    );
    const bySession = new Map<string, CaptureEnvelope[]>();
    const ignoredEventIds: string[] = [];
    const excludedSessions: WorkEpisodeBuildResult["excludedSessions"][number][] = [];
    for (const envelope of envelopes) {
      const sessionId = envelope.event.sessionId;
      if (sessionId === undefined) {
        ignoredEventIds.push(envelope.event.eventId);
        continue;
      }
      const events = bySession.get(sessionId) ?? [];
      events.push(envelope);
      bySession.set(sessionId, events);
    }
    for (const [sessionId, events] of bySession) {
      const internalWork = !events.some(isUserMessage) &&
        events.some((envelope) => isInternalWorkSource(envelope.event));
      if (internalWork || !events.some(isSubstantiveWork)) {
        const sourceEventIds = sorted(events.map((envelope) => envelope.event.eventId));
        excludedSessions.push({
          reason: internalWork ? "internal_work" : "no_substantive_work",
          sessionId,
          sourceEventIds,
        });
        for (const eventId of sourceEventIds) ignoredEventIds.push(eventId);
        bySession.delete(sessionId);
      } else {
        bySession.set(sessionId, events.filter((envelope) => {
          if (!isInternalWorkSource(envelope.event)) return true;
          ignoredEventIds.push(envelope.event.eventId);
          return false;
        }));
      }
    }
    const summaries = new Map(
      [...bySession.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sessionId, events]) => [
          sessionId,
          sessionSummary(sessionId, events),
        ]),
    );
    const pairCorrections = correctionMap(parsedCorrections);
    const sessionIds = [...summaries.keys()];
    const associations: EpisodeAssociation[] = [];
    // At a zero threshold a no-signal pair can be a candidate; preserve that public option.
    const indexed = this.#associationMode === "sparse" && this.#candidateThreshold > 0;
    const pairs = this.#associationMode === "connected"
      ? connectedAssociationPairs([...summaries.values()], parsedCorrections, this.#associatedThreshold, this.#commitAncestry !== undefined)
      : associationPairs([...summaries.values()], parsedCorrections, indexed);
    for (const [left, right] of pairs) {
      const correction = pairCorrections.get(pairKey(left.sessionId, right.sessionId));
      const association = pairAssociation(left, right, correction, this.#commitAncestry, {
        associated: this.#associatedThreshold,
        candidate: this.#candidateThreshold,
      });
      if (this.#associationMode === "all" || association.status === "associated" || correction !== undefined ||
        (this.#associationMode === "sparse" && association.status === "candidate")) {
        associations.push(association);
      }
    }
    const clusters = completeLinkClusters(
      sessionIds,
      associations,
    );
    const clusterBySession = new Map<string, ReadonlySet<string>>();
    for (const cluster of clusters) {
      for (const sessionId of cluster) clusterBySession.set(sessionId, cluster);
    }
    const associationsByCluster = new Map<ReadonlySet<string>, EpisodeAssociation[]>();
    for (const association of associations) {
      if (association.status !== "associated") continue;
      const cluster = clusterBySession.get(association.leftSessionId);
      if (cluster === undefined || cluster !== clusterBySession.get(association.rightSessionId)) continue;
      const internal = associationsByCluster.get(cluster) ?? [];
      internal.push(association);
      associationsByCluster.set(cluster, internal);
    }
    const correctionsByCluster = new Map<ReadonlySet<string>, Set<string>>();
    for (const correction of parsedCorrections) {
      for (const sessionId of correction.sessionIds) {
        const cluster = clusterBySession.get(sessionId);
        if (cluster === undefined) continue;
        const ids = correctionsByCluster.get(cluster) ?? new Set<string>();
        ids.add(correction.correctionId);
        correctionsByCluster.set(cluster, ids);
      }
    }
    const episodes = clusters
      .map((cluster) =>
        episodeFromCluster(
          cluster,
          summaries,
          associationsByCluster.get(cluster) ?? [],
          sorted(correctionsByCluster.get(cluster) ?? []),
          this.#observationWindowMs,
        ),
      )
      .sort(
        (left, right) =>
          Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
          left.episodeId.localeCompare(right.episodeId),
      );
    return {
      associations,
      episodes,
      excludedSessions: excludedSessions.sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
      ignoredEventIds: sorted(ignoredEventIds),
    };
  }
}
