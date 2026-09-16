import {
  correctionKeySchema,
  correctionOpportunitySchema,
  CURRENT_SCHEMA_VERSION,
  type CaptureEnvelope,
  type ContextUseRecord,
  type CorrectionKey,
  type CorrectionOpportunity,
  type KnowledgeCandidate,
  type Scope,
  type WorkEpisode,
} from "@provenloop/contracts";

import { sha256 } from "./digest.js";
import {
  boundVerificationOperation,
  verificationOutcome,
} from "./verification-proof.js";

export type CorrectionCaptureIssueCode =
  | "ambiguous_field"
  | "invalid_scope"
  | "missing_field"
  | "missing_scope_identity"
  | "untrusted_correction";

export interface CorrectionCaptureIssue {
  readonly code: CorrectionCaptureIssueCode;
  readonly eventId: string;
  readonly message: string;
}

export interface CorrectionCaptureBuildInput {
  readonly contextUseRecords?: readonly ContextUseRecord[];
  readonly envelopes: readonly CaptureEnvelope[];
  readonly knowledgeCandidates?: readonly KnowledgeCandidate[];
  readonly workEpisodes: readonly WorkEpisode[];
}

export interface CorrectionCaptureBuildResult {
  readonly correctionKeys: readonly CorrectionKey[];
  readonly issues: readonly CorrectionCaptureIssue[];
  readonly opportunities: readonly CorrectionOpportunity[];
}

interface ParsedCorrection {
  readonly correctionKeyId: string;
  readonly event: CaptureEnvelope;
  readonly expectedBehavior: string;
  readonly scope: Scope;
  readonly scopeId?: string;
  readonly subsystem?: string;
  readonly taskFamily?: string;
  readonly trigger: string;
  readonly violatedConstraint: string;
}

interface CorrectionOccurrence extends ParsedCorrection {
  readonly episodeId?: string;
  readonly verification: readonly CaptureEnvelope[];
}

const byTimestampAndId = (
  left: CaptureEnvelope,
  right: CaptureEnvelope,
): number =>
  Date.parse(left.event.timestamp) -
    Date.parse(right.event.timestamp) ||
  left.event.eventId.localeCompare(right.event.eventId);

const normalizeDisplay = (value: string): string =>
  value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();

const normalizeIdentity = (value: string): string =>
  normalizeDisplay(value).toLocaleLowerCase("en-US");

export interface ExplicitCorrectionFields {
  readonly expectedBehavior: string;
  readonly scope: Scope;
  readonly scopeId?: string;
  readonly subsystem?: string;
  readonly taskFamily?: string;
  readonly trigger: string;
  readonly violatedConstraint: string;
}

export const formatExplicitCorrectionMessage = (
  input: ExplicitCorrectionFields,
): string => {
  const field = (label: string, value: string): string => {
    const normalized = normalizeDisplay(value);
    if (normalized.length === 0) {
      throw new Error(`Correction field ${label} must be non-empty.`);
    }
    return `${label}: ${normalized}`;
  };
  if (!["personal", "workflow", "repository", "branch"].includes(input.scope)) {
    throw new Error("Correction scope is unsupported.");
  }
  if (input.scope === "workflow" && input.scopeId === undefined) {
    throw new Error("Workflow corrections require a scope identity.");
  }
  if (input.scope === "personal" && input.scopeId !== undefined) {
    throw new Error("Personal corrections cannot carry a scope identity.");
  }
  return [
    field("Violated Constraint", input.violatedConstraint),
    field("Expected Behavior", input.expectedBehavior),
    field("Trigger", input.trigger),
    field("Scope", input.scope),
    ...(input.scopeId === undefined ? [] : [field("Scope Id", input.scopeId)]),
    ...(input.taskFamily === undefined ? [] : [field("Task Family", input.taskFamily)]),
    ...(input.subsystem === undefined ? [] : [field("Subsystem", input.subsystem)]),
  ].join("\n");
};

const sortedUnique = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort();

const fieldAliases = {
  expectedBehavior: [
    "expected",
    "expected behavior",
  ],
  scope: [
    "scope",
  ],
  scopeId: [
    "scope id",
    "workflow",
    "workflow id",
  ],
  subsystem: [
    "area",
    "subsystem",
  ],
  taskFamily: [
    "task",
    "task family",
  ],
  trigger: [
    "trigger",
    "when",
  ],
  violatedConstraint: [
    "violated",
    "violated constraint",
  ],
} as const;

type CorrectionField = keyof typeof fieldAliases;

const parsedFields = (
  message: string | undefined,
): ReadonlyMap<string, readonly string[]> => {
  const fields = new Map<string, string[]>();
  for (const line of message?.split(/\r?\n/gu) ?? []) {
    const match = /^\s*([^:]+?)\s*:\s*(.+?)\s*$/u.exec(line);
    if (match === null) {
      continue;
    }
    const label = normalizeIdentity(match[1] ?? "");
    const value = normalizeDisplay(match[2] ?? "");
    if (label.length === 0 || value.length === 0) {
      continue;
    }
    const existing = fields.get(label) ?? [];
    existing.push(value);
    fields.set(label, existing);
  }
  return fields;
};

const fieldValue = (
  fields: ReadonlyMap<string, readonly string[]>,
  field: CorrectionField,
): {
  readonly ambiguous: boolean;
  readonly value?: string;
} => {
  const values = sortedUnique(
    fieldAliases[field].flatMap((alias) =>
      fields.get(alias) ?? [],
    ),
  );
  return {
    ambiguous: values.length > 1,
    ...(values[0] === undefined
      ? {}
      : {
          value: values[0],
        }),
  };
};

export const isExplicitCorrectionMessage = (
  message: string | undefined,
): boolean => {
  const fields = parsedFields(message);
  return (
    [
      "violatedConstraint",
      "expectedBehavior",
      "trigger",
    ] as const
  ).every((field) => {
    const value = fieldValue(fields, field);
    return !value.ambiguous && value.value !== undefined;
  });
};

const issue = (
  code: CorrectionCaptureIssueCode,
  eventId: string,
  message: string,
): CorrectionCaptureIssue => ({
  code,
  eventId,
  message,
});

const branchScopeId = (
  repoId: string,
  branch: string,
): string => JSON.stringify([
  repoId,
  branch,
]);

const parseCorrection = (
  envelope: CaptureEnvelope,
): {
  readonly issue?: CorrectionCaptureIssue;
  readonly parsed?: ParsedCorrection;
} => {
  const event = envelope.event;
  if (event.trust !== "user") {
    return {
      issue: issue(
        "untrusted_correction",
        event.eventId,
        "Correction events must be user-trusted.",
      ),
    };
  }
  const fields = parsedFields(envelope.content?.message);
  for (const field of Object.keys(fieldAliases) as CorrectionField[]) {
    const value = fieldValue(fields, field);
    if (value.ambiguous) {
      return {
        issue: issue(
          "ambiguous_field",
          event.eventId,
          `Correction field ${field} has conflicting values.`,
        ),
      };
    }
  }
  const violatedConstraint = fieldValue(
    fields,
    "violatedConstraint",
  ).value;
  const expectedBehavior = fieldValue(
    fields,
    "expectedBehavior",
  ).value;
  const trigger = fieldValue(fields, "trigger").value;
  const missing = [
    violatedConstraint === undefined ? "violatedConstraint" : undefined,
    expectedBehavior === undefined ? "expectedBehavior" : undefined,
    trigger === undefined ? "trigger" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (missing.length > 0) {
    return {
      issue: issue(
        "missing_field",
        event.eventId,
        `Correction event is missing required fields: ${missing.join(", ")}.`,
      ),
    };
  }
  if (
    violatedConstraint === undefined ||
    expectedBehavior === undefined ||
    trigger === undefined
  ) {
    throw new Error("Required correction fields were not resolved.");
  }
  const scopeInput = fieldValue(fields, "scope").value;
  const resolvedScope =
    scopeInput === undefined
      ? "repository"
      : scopeInput.toLocaleLowerCase("en-US");
  if (
    resolvedScope !== "personal" &&
    resolvedScope !== "workflow" &&
    resolvedScope !== "repository" &&
    resolvedScope !== "branch"
  ) {
    return {
      issue: issue(
        "invalid_scope",
        event.eventId,
        `Correction scope ${scopeInput ?? ""} is unsupported.`,
      ),
    };
  }
  const scope: Scope = resolvedScope;
  let scopeId: string | undefined;
  if (scope === "repository") {
    scopeId = event.repoId;
  } else if (scope === "branch") {
    scopeId =
      event.repoId === undefined || event.branch === undefined
        ? undefined
        : branchScopeId(event.repoId, event.branch);
  } else if (scope === "workflow") {
    scopeId = fieldValue(fields, "scopeId").value;
  }
  if (scope !== "personal" && scopeId === undefined) {
    return {
      issue: issue(
        "missing_scope_identity",
        event.eventId,
        `Correction scope ${scope} requires trusted scope identity.`,
      ),
    };
  }
  const taskFamily = fieldValue(fields, "taskFamily").value;
  const subsystem = fieldValue(fields, "subsystem").value;
  const identity = {
    expectedBehavior: normalizeIdentity(expectedBehavior),
    scope,
    ...(scopeId === undefined
      ? {}
      : {
          scopeId: normalizeIdentity(scopeId),
        }),
    ...(subsystem === undefined
      ? {}
      : {
          subsystem: normalizeIdentity(subsystem),
        }),
    ...(taskFamily === undefined
      ? {}
      : {
          taskFamily: normalizeIdentity(taskFamily),
        }),
    trigger: normalizeIdentity(trigger),
    violatedConstraint: normalizeIdentity(violatedConstraint),
  };
  return {
    parsed: {
      correctionKeyId:
        `correction-${sha256(identity).slice(0, 24)}`,
      event: envelope,
      expectedBehavior,
      scope,
      ...(scopeId === undefined
        ? {}
        : {
            scopeId,
          }),
      ...(subsystem === undefined
        ? {}
        : {
            subsystem,
          }),
      ...(taskFamily === undefined
        ? {}
        : {
            taskFamily,
          }),
      trigger,
      violatedConstraint,
    },
  };
};

const isVerificationSuccess = (
  envelope: CaptureEnvelope,
): boolean => verificationOutcome(envelope) === "succeeded";

const episodeEvents = (
  episode: WorkEpisode,
  eventsById: ReadonlyMap<string, CaptureEnvelope>,
): readonly CaptureEnvelope[] =>
  episode.sourceEventIds
    .flatMap((eventId) => {
      const envelope = eventsById.get(eventId);
      return envelope === undefined ? [] : [envelope];
    })
    .sort(byTimestampAndId);

const occurrenceFor = (
  parsed: ParsedCorrection,
  episodes: readonly WorkEpisode[],
  eventsById: ReadonlyMap<string, CaptureEnvelope>,
): CorrectionOccurrence => {
  const episode = episodes.find((candidate) =>
    candidate.sourceEventIds.includes(parsed.event.event.eventId),
  );
  if (episode === undefined) {
    return {
      ...parsed,
      verification: [],
    };
  }
  return {
    ...parsed,
    episodeId: episode.episodeId,
    verification: episodeEvents(episode, eventsById).filter(
      (envelope) =>
        Date.parse(envelope.event.timestamp) >
          Date.parse(parsed.event.event.timestamp) &&
        isVerificationSuccess(envelope) &&
        boundVerificationOperation(parsed.event, envelope, eventsById) !== undefined,
    ),
  };
};

const initialEpisodeText = (
  episode: WorkEpisode,
  eventsById: ReadonlyMap<string, CaptureEnvelope>,
): string => {
  const prompt = episodeEvents(episode, eventsById).find(
    (envelope) => envelope.event.eventType === "prompt.submitted",
  );
  return (
    prompt?.content?.message ?? episode.goal
  ).normalize("NFKC").trim();
};

const tokens = (value: string): readonly string[] =>
  normalizeIdentity(value).match(/[\p{L}\p{N}_-]+/gu) ?? [];

const triggerRelevance = (
  trigger: string,
  text: string,
): {
  readonly candidate: boolean;
  readonly matches: boolean;
} => {
  const normalizedTrigger = normalizeIdentity(trigger);
  const normalizedText = normalizeIdentity(text);
  if (normalizedText.includes(normalizedTrigger)) {
    return {
      candidate: true,
      matches: true,
    };
  }
  const triggerTokens = new Set(tokens(normalizedTrigger));
  const textTokens = new Set(tokens(normalizedText));
  if (triggerTokens.size === 0) {
    return {
      candidate: false,
      matches: false,
    };
  }
  let overlap = 0;
  for (const token of triggerTokens) {
    if (textTokens.has(token)) {
      overlap += 1;
    }
  }
  const ratio = overlap / triggerTokens.size;
  return {
    candidate: ratio >= 0.5,
    matches: ratio === 1,
  };
};

const scopeMatchesEpisode = (
  key: CorrectionKey,
  episode: WorkEpisode,
  fields: ReadonlyMap<string, readonly string[]>,
): boolean => {
  switch (key.scope) {
    case "personal":
      return true;
    case "repository":
      return key.scopeId !== undefined &&
        episode.repoId === key.scopeId;
    case "branch":
      return key.scopeId !== undefined &&
        episode.repoId !== undefined &&
        episode.branches.some(
          (branch) =>
            branchScopeId(episode.repoId ?? "", branch) === key.scopeId,
        );
    case "workflow":
      return key.scopeId !== undefined &&
        fieldValue(fields, "scopeId").value === key.scopeId;
  }
};

const normalizeKnowledgeReference = (value: string): string =>
  value.startsWith("knowledge:")
    ? value.slice("knowledge:".length)
    : value;

const knowledgeCandidatesForKey = (
  key: CorrectionKey,
  candidates: readonly KnowledgeCandidate[],
  episodeStartedAt: string,
): readonly KnowledgeCandidate[] => {
  const sourceIds = new Set([
    ...key.sourceCorrectionEventIds,
    ...key.verificationEvidenceIds,
  ]);
  return candidates.filter(
    (candidate) =>
      Date.parse(candidate.createdAt) <= Date.parse(episodeStartedAt) &&
      candidate.sourceEvidenceIds.some((id) => sourceIds.has(id)),
  );
};

export const correctionKeyActivationEligible = (
  key: CorrectionKey,
): boolean =>
  correctionKeySchema.parse(key).verificationEvidenceIds.length > 0;

export class CorrectionCaptureBuilder {
  public build(
    input: CorrectionCaptureBuildInput,
  ): CorrectionCaptureBuildResult {
    const envelopes = [...input.envelopes].sort(byTimestampAndId);
    const workEpisodes = [...input.workEpisodes].sort(
      (left, right) =>
        Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
        left.episodeId.localeCompare(right.episodeId),
    );
    const eventsById = new Map(
      envelopes.map((envelope) => [
        envelope.event.eventId,
        envelope,
      ]),
    );
    const issues: CorrectionCaptureIssue[] = [];
    const occurrences = envelopes
      .filter(
        (envelope) =>
          envelope.event.eventType === "user.corrected",
      )
      .flatMap((envelope) => {
        const result = parseCorrection(envelope);
        if (result.issue !== undefined) {
          issues.push(result.issue);
          return [];
        }
        return result.parsed === undefined
          ? []
          : [
              occurrenceFor(
                result.parsed,
                workEpisodes,
                eventsById,
              ),
            ];
      });
    const grouped = new Map<string, CorrectionOccurrence[]>();
    for (const occurrence of occurrences) {
      const group = grouped.get(occurrence.correctionKeyId) ?? [];
      group.push(occurrence);
      grouped.set(occurrence.correctionKeyId, group);
    }
    const correctionKeys = [...grouped.entries()]
      .map(([correctionKeyId, group]) => {
        group.sort(
          (left, right) =>
            byTimestampAndId(left.event, right.event),
        );
        const first = group[0];
        if (first === undefined) {
          throw new Error(
            `Correction group ${correctionKeyId} is empty.`,
          );
        }
        return correctionKeySchema.parse({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          correctionKeyId,
          createdAt: first.event.event.timestamp,
          expectedBehavior: first.expectedBehavior,
          scope: first.scope,
          ...(first.scopeId === undefined
            ? {}
            : {
                scopeId: first.scopeId,
              }),
          sourceCorrectionEventIds: sortedUnique(
            group.map(
              (occurrence) => occurrence.event.event.eventId,
            ),
          ),
          ...(first.subsystem === undefined
            ? {}
            : {
                subsystem: first.subsystem,
              }),
          ...(first.taskFamily === undefined
            ? {}
            : {
                taskFamily: first.taskFamily,
              }),
          trigger: first.trigger,
          verificationEvidenceIds: sortedUnique(
            group.flatMap((occurrence) =>
              occurrence.verification.map(
                (envelope) => envelope.event.eventId,
              ),
            ),
          ),
          violatedConstraint: first.violatedConstraint,
        });
      })
      .sort((left, right) =>
        left.correctionKeyId.localeCompare(right.correctionKeyId),
      );
    const occurrencesByKey = new Map(
      [...grouped.entries()].map(([keyId, group]) => [
        keyId,
        group,
      ]),
    );
    const contextUseRecords = input.contextUseRecords ?? [];
    const knowledgeCandidates = input.knowledgeCandidates ?? [];
    const opportunities: CorrectionOpportunity[] = [];
    for (const key of correctionKeys) {
      const keyOccurrences =
        occurrencesByKey.get(key.correctionKeyId) ?? [];
      const verifiedAt = keyOccurrences
        .flatMap((occurrence) => occurrence.verification)
        .sort(byTimestampAndId)[0]?.event.timestamp;
      if (verifiedAt === undefined) {
        continue;
      }
      for (const episode of workEpisodes) {
        if (
          Date.parse(episode.startedAt) <= Date.parse(verifiedAt)
        ) {
          continue;
        }
        const initialText = initialEpisodeText(
          episode,
          eventsById,
        );
        const fields = parsedFields(initialText);
        if (!scopeMatchesEpisode(key, episode, fields)) {
          continue;
        }
        const trigger = triggerRelevance(key.trigger, initialText);
        const taskFamily = fieldValue(fields, "taskFamily").value;
        const subsystem = fieldValue(fields, "subsystem").value;
        const taskFamilyMatches =
          key.taskFamily === undefined ||
          (
            taskFamily !== undefined &&
            normalizeIdentity(taskFamily) ===
              normalizeIdentity(key.taskFamily)
          );
        const subsystemMatches =
          key.subsystem === undefined ||
          (
            subsystem !== undefined &&
            normalizeIdentity(subsystem) ===
              normalizeIdentity(key.subsystem)
          );
        const dimensionCandidate =
          (
            key.taskFamily !== undefined &&
            taskFamily !== undefined &&
            normalizeIdentity(taskFamily) ===
              normalizeIdentity(key.taskFamily)
          ) ||
          (
            key.subsystem !== undefined &&
            subsystem !== undefined &&
            normalizeIdentity(subsystem) ===
              normalizeIdentity(key.subsystem)
          );
        if (!trigger.candidate && !dimensionCandidate) {
          continue;
        }
        const relatedKnowledge = knowledgeCandidatesForKey(
          key,
          knowledgeCandidates,
          episode.startedAt,
        );
        const availableKnowledgeIds = new Set(
          relatedKnowledge
            .filter((candidate) => candidate.state === "active")
            .map((candidate) => candidate.knowledgeId),
        );
        const relatedKnowledgeIds = new Set(
          relatedKnowledge.map(
            (candidate) => candidate.knowledgeId,
          ),
        );
        const repeatedAt = keyOccurrences
          .filter(
            (occurrence) =>
              occurrence.episodeId === episode.episodeId,
          )
          .map((occurrence) => occurrence.event)
          .sort(byTimestampAndId)[0]?.event.timestamp;
        const applicationDeadline =
          repeatedAt ?? episode.finishedAt;
        const applicableContextUseRecords = contextUseRecords.filter(
          (record) =>
            record.episodeId === episode.episodeId &&
            Date.parse(record.createdAt) >=
              Date.parse(episode.startedAt) &&
            (
              applicationDeadline === undefined ||
              Date.parse(record.createdAt) <=
                Date.parse(applicationDeadline)
            ),
        );
        for (const record of applicableContextUseRecords) {
          for (const reference of record.returnedKnowledgeIds) {
            const knowledgeId =
              normalizeKnowledgeReference(reference);
            if (relatedKnowledgeIds.has(knowledgeId)) {
              availableKnowledgeIds.add(knowledgeId);
            }
          }
        }
        const appliedBeforeCorrection =
          applicableContextUseRecords.some((record) =>
            record.appliedKnowledgeIds.some((reference) =>
              availableKnowledgeIds.has(
                normalizeKnowledgeReference(reference),
              ),
            ),
          );
        opportunities.push(
          correctionOpportunitySchema.parse({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            applicable:
              trigger.matches &&
              taskFamilyMatches &&
              subsystemMatches,
            correctionKeyId: key.correctionKeyId,
            correctionRepeated: keyOccurrences.some(
              (occurrence) =>
                occurrence.episodeId === episode.episodeId,
            ),
            createdAt: episode.startedAt,
            episodeId: episode.episodeId,
            knowledgeAppliedBeforeCorrection:
              appliedBeforeCorrection,
            knowledgeAvailableBeforeCorrection:
              availableKnowledgeIds.size > 0,
            opportunityId:
              `opportunity-${sha256({
                correctionKeyId: key.correctionKeyId,
                episodeId: episode.episodeId,
              }).slice(0, 24)}`,
            outcomeKnown:
              episode.outcomeQualification === "qualified",
          }),
        );
      }
    }
    return {
      correctionKeys,
      issues: issues.sort(
        (left, right) =>
          left.eventId.localeCompare(right.eventId) ||
          left.code.localeCompare(right.code),
      ),
      opportunities: opportunities.sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.opportunityId.localeCompare(right.opportunityId),
      ),
    };
  }
}
