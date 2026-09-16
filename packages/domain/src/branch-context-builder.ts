import {
  branchContextSchema,
  captureEnvelopeSchema,
  CURRENT_SCHEMA_VERSION,
  workEpisodeSchema,
  type BranchContext,
  type CaptureEnvelope,
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

export interface BranchContextBuilderOptions {
  readonly ttlMs?: number;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const isMaterialEvent = (envelope: CaptureEnvelope): boolean =>
  isCreatedCommitEvent(envelope) ||
  verificationOutcome(envelope) !== "unknown" ||
  (
    trustedExecution(envelope) &&
    ["file.changed", "session.error", "tool.failed"].includes(envelope.event.eventType)
  );

const sortedUnique = (values: Iterable<string>): string[] =>
  [...new Set(
    [...values]
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  )].sort();

const labeledValues = (
  message: string | undefined,
  labels: readonly string[],
): string[] => {
  if (message === undefined) {
    return [];
  }
  const labelPattern = labels
    .map((label) => label.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const pattern = new RegExp(
    `^\\s*(?:${labelPattern})\\s*:\\s*(.+?)\\s*$`,
    "gimu",
  );
  return [...message.matchAll(pattern)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) => value.length > 0);
};

const goalFromMessage = (
  message: string | undefined,
): string | undefined => {
  if (message === undefined) {
    return undefined;
  }
  return message
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        !/^(?:accepted decision|constraint|constraints|decision|next|todo|unfinished)\s*:/iu.test(
          line,
        ),
    );
};

const eventState = (envelope: CaptureEnvelope): string | undefined => {
  if (!isMaterialEvent(envelope) && !isVerificationEvent(envelope)) {
    return undefined;
  }
  const event = envelope.event;
  if (isCreatedCommitEvent(envelope) && event.commitSha !== undefined) {
    return `Commit ${event.commitSha}`;
  }
  if (event.eventType === "file.changed") {
    const detail = envelope.content?.message?.trim();
    return detail
      ? `Files changed: ${detail}`
      : `Files changed (${event.eventId})`;
  }
  if (
    event.eventType === "build.completed" ||
    event.eventType === "test.completed" ||
    event.eventType === "verification.completed"
  ) {
    return `${event.eventType}: ${verificationOutcome(envelope)}`;
  }
  if (
    event.eventType === "tool.failed" ||
    event.eventType === "session.error"
  ) {
    const detail =
      envelope.content?.safeError?.trim() ??
      envelope.content?.message?.trim();
    return detail
      ? `${event.eventType}: ${detail}`
      : `${event.eventType}: observed`;
  }
  return undefined;
};

const latestTimestamp = (
  envelopes: readonly CaptureEnvelope[],
): string => {
  let latest: CaptureEnvelope | undefined;
  for (const envelope of envelopes) {
    if (latest === undefined || Date.parse(envelope.event.timestamp) > Date.parse(latest.event.timestamp) ||
      (Date.parse(envelope.event.timestamp) === Date.parse(latest.event.timestamp) &&
        envelope.event.eventId.localeCompare(latest.event.eventId) > 0)) latest = envelope;
  }
  return latest?.event.timestamp ?? new Date(0).toISOString();
};

const hasExplicitContinuationMarker = (
  envelope: CaptureEnvelope,
): boolean =>
  envelope.event.trust === "user" &&
  labeledValues(envelope.content?.message, [
    "accepted decision",
    "constraint",
    "constraints",
    "decision",
    "next",
    "todo",
    "unfinished",
  ]).length > 0;

const isUserMessage = (envelope: CaptureEnvelope): boolean =>
  envelope.event.trust === "user" &&
  ["prompt.submitted", "user.corrected"].includes(envelope.event.eventType);

const taskGoal = (envelope: CaptureEnvelope): string | undefined => {
  if (!isUserMessage(envelope)) return undefined;
  const goal = goalFromMessage(envelope.content?.message);
  return goal !== undefined && /[\p{L}\p{N}]/u.test(goal) &&
    !/^(?:ok(?:ay)?|yes|no|thanks?(?: you)?|done|continue|do it|嗯|好(?:的)?|谢谢|是的|继续)[.!。！\s]*$/iu.test(goal)
    ? goal : undefined;
};

export class BranchContextBuilder {
  readonly #ttlMs: number;

  public constructor(options: BranchContextBuilderOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new RangeError("Branch Context ttlMs must be positive.");
    }
  }

  public build(
    inputEnvelopes: readonly CaptureEnvelope[],
    inputEpisodes: readonly WorkEpisode[],
  ): readonly BranchContext[] {
    const envelopesBySession = new Map<string, CaptureEnvelope[]>();
    for (const input of inputEnvelopes) {
      const envelope = captureEnvelopeSchema.parse(input);
      if (envelope.event.sessionId === undefined || isInternalWorkSource(envelope.event)) continue;
      const events = envelopesBySession.get(envelope.event.sessionId) ?? [];
      events.push(envelope);
      envelopesBySession.set(envelope.event.sessionId, events);
    }
    const episodes = inputEpisodes.map((episode) =>
      workEpisodeSchema.parse(episode),
    );
    const groups = new Map<
      string,
      {
        readonly branch: string;
        readonly episodes: WorkEpisode[];
        readonly repoId: string;
      }
    >();
    for (const episode of episodes) {
      if (episode.repoId === undefined) {
        continue;
      }
      for (const branch of episode.branches) {
        const key = `${episode.repoId}\u0000${branch}`;
        const group = groups.get(key) ?? {
          branch,
          episodes: [],
          repoId: episode.repoId,
        };
        group.episodes.push(episode);
        groups.set(key, group);
      }
    }

    const contexts: BranchContext[] = [];
    for (const group of groups.values()) {
      const candidateSessionIds = new Set(
        group.episodes.flatMap((episode) => episode.sessionIds),
      );
      const candidateEnvelopes = [...candidateSessionIds]
        .flatMap((sessionId) => envelopesBySession.get(sessionId) ?? [])
        .filter(
          (envelope) =>
            envelope.event.repoId === group.repoId &&
            (
              envelope.event.branch === undefined ||
              envelope.event.branch === group.branch
            ),
        )
        .sort(
          (left, right) =>
            Date.parse(left.event.timestamp) -
              Date.parse(right.event.timestamp) ||
            left.event.eventId.localeCompare(right.event.eventId),
        );
      // A branch snapshot belongs to one captured task. Sharing a branch or
      // commit does not carry temporary constraints into another session.
      const sourceSessionId = candidateEnvelopes.findLast((envelope) =>
        taskGoal(envelope) !== undefined || hasExplicitContinuationMarker(envelope) || isMaterialEvent(envelope),
      )?.event.sessionId;
      if (sourceSessionId === undefined) continue;
      const relevant = candidateEnvelopes.filter((envelope) => envelope.event.sessionId === sourceSessionId);
      const headSha = relevant
        .findLast((envelope) => envelope.event.commitSha !== undefined)
        ?.event.commitSha;
      if (headSha === undefined) {
        continue;
      }
      const activeEpisodes = group.episodes.filter((episode) =>
        episode.sessionIds.includes(sourceSessionId),
      );
      if (activeEpisodes.length === 0) {
        continue;
      }
      const initialMaterialEvents = relevant.filter(
        (envelope) =>
          isMaterialEvent(envelope) ||
          hasExplicitContinuationMarker(envelope),
      );
      if (initialMaterialEvents.length === 0) {
        continue;
      }
      const updatedAt = latestTimestamp(initialMaterialEvents);
      const taskAnchor = relevant.findLast((envelope) =>
        taskGoal(envelope) !== undefined && Date.parse(envelope.event.timestamp) <= Date.parse(updatedAt),
      );
      const windowStart =
        Math.max(Date.parse(updatedAt) - this.#ttlMs,
          taskAnchor === undefined ? Number.NEGATIVE_INFINITY : Date.parse(taskAnchor.event.timestamp));
      const windowedRelevant = relevant.filter(
        (envelope) =>
          Date.parse(envelope.event.timestamp) >= windowStart,
      );
      const userMessages = windowedRelevant.filter(
        isUserMessage,
      );
      const acceptedDecisions = sortedUnique(
        userMessages.flatMap((envelope) =>
          labeledValues(envelope.content?.message, [
            "accepted decision",
            "decision",
          ]),
        ),
      );
      const explicitConstraints = sortedUnique(
        userMessages.flatMap((envelope) =>
          labeledValues(envelope.content?.message, [
            "constraint",
            "constraints",
          ]),
        ),
      );
      const unfinishedItems = sortedUnique(
        userMessages.flatMap((envelope) =>
          labeledValues(envelope.content?.message, [
            "next",
            "todo",
            "unfinished",
          ]),
        ),
      );
      const implementationState = sortedUnique(
        windowedRelevant.flatMap((envelope) => {
          const state = eventState(envelope);
          return state === undefined ? [] : [state];
        }),
      );
      const verificationEvents = windowedRelevant.filter((envelope) =>
        isVerificationEvent(envelope) ||
        (trustedExecution(envelope) &&
          ["session.error", "tool.failed"].includes(envelope.event.eventType)),
      );
      const materialEvents = windowedRelevant.filter(
        (envelope) =>
          isMaterialEvent(envelope) ||
          hasExplicitContinuationMarker(envelope),
      );
      const associatedGoalMessages = new Map<
        string,
        CaptureEnvelope
      >();
      let userIndex = 0;
      let preceding: CaptureEnvelope | undefined;
      for (const materialEvent of materialEvents) {
        while (userIndex < userMessages.length) {
          const message = userMessages[userIndex];
          if (message === undefined || Date.parse(message.event.timestamp) > Date.parse(materialEvent.event.timestamp)) break;
          preceding = message;
          userIndex += 1;
        }
        if (hasExplicitContinuationMarker(materialEvent)) {
          associatedGoalMessages.set(
            materialEvent.event.eventId,
            materialEvent,
          );
          continue;
        }
        if (preceding !== undefined) {
          associatedGoalMessages.set(
            preceding.event.eventId,
            preceding,
          );
        }
      }
      const goalSource = [...associatedGoalMessages.values()]
        .sort(
          (left, right) =>
            Date.parse(right.event.timestamp) -
              Date.parse(left.event.timestamp) ||
            right.event.eventId.localeCompare(left.event.eventId),
        )
        .find((envelope) => taskGoal(envelope) !== undefined) ?? taskAnchor;
      const goal = goalSource === undefined ? undefined : taskGoal(goalSource);
      const superseding = relevant.find((envelope) =>
        taskGoal(envelope) !== undefined && Date.parse(envelope.event.timestamp) > Date.parse(updatedAt),
      );
      const closure = relevant.findLast((envelope) =>
        envelope.event.eventType === "session.ended" && ["user", "system"].includes(envelope.event.trust),
      );
      const closed = closure !== undefined && !relevant.some((envelope) =>
        Date.parse(envelope.event.timestamp) > Date.parse(closure.event.timestamp) &&
        (isUserMessage(envelope) || isMaterialEvent(envelope) ||
          ["session.started", "agent.message", "tool.started", "tool.completed"].includes(envelope.event.eventType)),
      );
      const activeWindowSessionIds = new Set(
        windowedRelevant.flatMap((envelope) =>
          envelope.event.sessionId === undefined
            ? []
            : [envelope.event.sessionId],
        ),
      );
      const contextEpisodes = activeEpisodes.filter((episode) =>
        episode.sessionIds.some((sessionId) =>
          activeWindowSessionIds.has(sessionId),
        ),
      );
      const context = branchContextSchema.parse({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        acceptedDecisions,
        branch: group.branch,
        branchContextId:
          `branch-context-${sha256({
            branch: group.branch,
            headSha,
            repoId: group.repoId,
            sourceSessionId,
            goalSourceEventId: goalSource?.event.eventId,
          }).slice(0, 24)}`,
        expiresAt: new Date(
          Date.parse(updatedAt) + this.#ttlMs,
        ).toISOString(),
        explicitConstraints,
        ...(closed && closure !== undefined ? { closedAt: closure.event.timestamp, closureSourceEventIds: [closure.event.eventId] } : {}),
        ...(goal === undefined
          ? {}
          : {
              goal,
            }),
        ...(goalSource === undefined ? {} : { goalSourceEventId: goalSource.event.eventId }),
        headSha,
        implementationState,
        recentVerificationEvidenceIds: sortedUnique(
          verificationEvents.map(
            (envelope) => envelope.event.eventId,
          ),
        ),
        repoId: group.repoId,
        sourceEpisodeIds: sortedUnique(
          contextEpisodes.map((episode) => episode.episodeId),
        ),
        sourceEventIds: sortedUnique(
          windowedRelevant.map(
            (envelope) => envelope.event.eventId,
          ),
        ),
        sourceSessionIds: [sourceSessionId],
        ...(superseding === undefined ? {} : { supersededAt: superseding.event.timestamp, supersedingSourceEventId: superseding.event.eventId }),
        unfinishedItems,
        updatedAt,
      });
      contexts.push(context);
    }
    return contexts.sort(
      (left, right) =>
        left.repoId.localeCompare(right.repoId) ||
        left.branch.localeCompare(right.branch) ||
        left.headSha.localeCompare(right.headSha),
    );
  }
}
