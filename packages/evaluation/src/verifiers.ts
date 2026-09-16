import {
  classifyRawEvent,
  CURRENT_SCHEMA_VERSION,
  gateResultSchema,
  type EvidenceLedgerEntry,
  type GateResult,
} from "@provenloop/contracts";

import { sha256, stableJson } from "./digest.js";
import {
  containsPotentialSecret,
  ledgerEntryContainsSecret,
} from "./secret-detection.js";
import type {
  VerifierContext,
  VerifierOutcome,
} from "./types.js";

export const VERIFIER_IDS = [
  "event-schema-source-version",
  "event-idempotency",
  "process-claim-execution-consistency",
  "participant-resolved-model-identity",
  "command-completion-exit-code",
  "secret-persistence",
  "repository-scope-isolation",
  "deletion-propagation",
  "queue-recovery",
] as const;

export type VerifierId = (typeof VERIFIER_IDS)[number];

type Verifier = (context: VerifierContext) => VerifierOutcome;

const gate = (
  context: VerifierContext,
  verifierId: string,
  status: GateResult["status"],
  evidenceIds: readonly string[],
  message: string,
): GateResult =>
  gateResultSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    gateId: `${context.replaySpec.specId}:${verifierId}`,
    status,
    evidenceIds,
    message,
  });

const evidence = (
  context: VerifierContext,
  verifierId: string,
  status: string,
  sequence: number,
  fields: Partial<EvidenceLedgerEntry> = {},
): EvidenceLedgerEntry => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  ledgerEntryId: `${context.fixture.fixtureId}:${verifierId}:${sequence}`,
  runId: context.runId,
  status,
  timestamp: context.generatedAt,
  ...fields,
});

const ledgerEntry = (
  context: VerifierContext,
  ledgerEntryId: string,
): EvidenceLedgerEntry | undefined =>
  context.ledgerEntries.find(
    (entry) => entry.ledgerEntryId === ledgerEntryId,
  );

const missingEvidenceIds = (
  context: VerifierContext,
  evidenceIds: readonly string[],
): readonly string[] =>
  evidenceIds.filter((evidenceId) => ledgerEntry(context, evidenceId) === undefined);

const statusRequiresInvocation = (status: string): boolean =>
  status.startsWith("command.") || status.startsWith("invocation.");

const belongsToClaim = (
  entry: EvidenceLedgerEntry,
  claim: VerifierContext["fixture"]["processClaims"][number],
): boolean => {
  const hasAssociation =
    entry.claimId !== undefined ||
    entry.episodeId !== undefined ||
    entry.invocationId !== undefined;
  const claimMatches =
    entry.claimId === undefined || entry.claimId === claim.claimId;
  const episodeMatches =
    entry.episodeId === undefined || entry.episodeId === claim.episodeId;
  const invocationMatches =
    entry.invocationId === undefined ||
    claim.invocationIds.includes(entry.invocationId);
  return (
    hasAssociation &&
    claimMatches &&
    episodeMatches &&
    invocationMatches
  );
};

const eventSchemaVerifier: Verifier = (context) => {
  const ledgerEntries: EvidenceLedgerEntry[] = [];
  const failures: string[] = [];
  let invalidInput = false;

  context.fixture.events.forEach((event, index) => {
    const result = classifyRawEvent(event);
    const ledgerEntryId = `${context.fixture.fixtureId}:event:${index}`;
    const common = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      ledgerEntryId,
      runId: context.runId,
      inputDigest: sha256(event),
      timestamp: context.generatedAt,
    } as const;

    if (result.status === "supported") {
      ledgerEntries.push({
        ...common,
        eventId: result.value.eventId,
        status: "event.supported",
        timestamp: result.value.timestamp,
      });
      return;
    }
    if (result.status === "unsupported_event_type") {
      ledgerEntries.push({
        ...common,
        eventId: result.value.eventId,
        status: "event.unsupported_type",
        timestamp: result.value.timestamp,
      });
      failures.push(`Unsupported event type: ${result.eventType}.`);
      return;
    }
    if (result.status === "unsupported_adapter_version") {
      ledgerEntries.push({
        ...common,
        eventId: result.value.eventId,
        status: "event.unsupported_adapter_version",
        timestamp: result.value.timestamp,
      });
      failures.push(
        `Unsupported adapter version: ${result.adapter}@${result.adapterVersion}.`,
      );
      return;
    }
    if (result.status === "unsupported_version") {
      ledgerEntries.push({
        ...common,
        status: "event.unsupported_schema_version",
      });
      failures.push(
        `Unsupported RawEvent schema version: ${result.receivedVersion}.`,
      );
      return;
    }

    invalidInput = true;
    ledgerEntries.push({
      ...common,
      status: "event.invalid",
    });
    failures.push(`Malformed RawEvent at index ${index}.`);
  });

  return {
    gate: gate(
      context,
      "event-schema-source-version",
      failures.length === 0 ? "pass" : "fail",
      ledgerEntries.map((entry) => entry.ledgerEntryId),
      failures.length === 0
        ? `${context.fixture.events.length} event(s) are supported.`
        : failures.join(" "),
    ),
    invalidInput,
    ledgerEntries,
  };
};

const eventIdempotencyVerifier: Verifier = (context) => {
  const check = evidence(
    context,
    "event-idempotency",
    "event.idempotency.checked",
    0,
  );
  const supportedEvents = context.fixture.events
    .map((event) => classifyRawEvent(event))
    .filter((result) => result.status === "supported")
    .map((result) => result.value);
  const byId = new Map<string, string>();
  const conflicts: string[] = [];

  for (const event of supportedEvents) {
    const canonical = stableJson(event);
    const existing = byId.get(event.eventId);
    if (existing !== undefined && existing !== canonical) {
      conflicts.push(event.eventId);
    } else {
      byId.set(event.eventId, canonical);
    }
  }

  const expected = context.fixture.expectedCanonicalEventCount;
  if (expected === undefined) {
    return {
      gate: gate(
        context,
        "event-idempotency",
        "inconclusive",
        [
          check.ledgerEntryId,
        ],
        "Fixture does not declare expectedCanonicalEventCount.",
      ),
      ledgerEntries: [
        check,
      ],
    };
  }

  const passed = conflicts.length === 0 && byId.size === expected;
  return {
    gate: gate(
      context,
      "event-idempotency",
      passed ? "pass" : "fail",
      [
        check.ledgerEntryId,
      ],
      passed
        ? `${supportedEvents.length} event delivery record(s) produce ${expected} canonical fact(s).`
        : `Expected ${expected} canonical event(s), observed ${byId.size}; conflicting IDs: ${conflicts.join(", ") || "none"}.`,
    ),
    ledgerEntries: [
      check,
    ],
  };
};

const processClaimVerifier: Verifier = (context) => {
  const failures: string[] = [];
  const evidenceIds = new Set<string>();
  const checked = evidence(
    context,
    "process-claim-execution-consistency",
    "claim.execution.checked",
    0,
  );
  const generated: EvidenceLedgerEntry[] = [
    checked,
  ];
  evidenceIds.add(checked.ledgerEntryId);

  for (const claim of context.fixture.processClaims) {
    const missingClaimEvidence = missingEvidenceIds(
      context,
      claim.evidenceIds,
    );
    if (missingClaimEvidence.length > 0) {
      failures.push(
        `Claim ${claim.claimId} references missing evidence: ${missingClaimEvidence.join(", ")}.`,
      );
    }
    const explicitClaimEvidence = claim.evidenceIds
      .map((id) => ledgerEntry(context, id))
      .filter((entry): entry is EvidenceLedgerEntry => entry !== undefined);
    const unrelatedClaimEvidence = explicitClaimEvidence.filter(
      (entry) => !belongsToClaim(entry, claim),
    );
    if (unrelatedClaimEvidence.length > 0) {
      failures.push(
        `Claim ${claim.claimId} references evidence outside its claim, episode, or invocation boundary: ${unrelatedClaimEvidence.map((entry) => entry.ledgerEntryId).join(", ")}.`,
      );
    }
    explicitClaimEvidence.forEach((entry) =>
      evidenceIds.add(entry.ledgerEntryId),
    );
    const relatedEntries = context.ledgerEntries.filter(
      (entry) =>
        belongsToClaim(entry, claim) &&
        (claim.evidenceIds.includes(entry.ledgerEntryId) ||
          (entry.invocationId !== undefined &&
            claim.invocationIds.includes(entry.invocationId)) ||
          entry.claimId === claim.claimId),
    );
    const missingRequiredStatuses = claim.requiredEvidence.filter(
      (status) =>
        !relatedEntries.some(
          (entry) =>
            entry.status === status &&
            (!statusRequiresInvocation(status) ||
              (entry.invocationId !== undefined &&
                claim.invocationIds.includes(entry.invocationId))),
        ),
    );
    if (missingRequiredStatuses.length > 0) {
      failures.push(
        `Claim ${claim.claimId} lacks required evidence status: ${missingRequiredStatuses.join(", ")}.`,
      );
      const missing = evidence(
        context,
        "process-claim-execution-consistency",
        "claim.required_evidence_missing",
        generated.length,
        {
          claimId: claim.claimId,
          episodeId: claim.episodeId,
        },
      );
      generated.push(missing);
      evidenceIds.add(missing.ledgerEntryId);
    }

    if (claim.status !== "verified") {
      continue;
    }
    if (claim.invocationIds.length === 0) {
      failures.push(
        `Verified claim ${claim.claimId} has no invocation evidence.`,
      );
      const missing = evidence(
        context,
        "process-claim-execution-consistency",
        "invocation.missing",
        generated.length,
        {
          claimId: claim.claimId,
          episodeId: claim.episodeId,
        },
      );
      generated.push(missing);
      evidenceIds.add(missing.ledgerEntryId);
    }

    for (const invocationId of claim.invocationIds) {
      const succeeded = context.ledgerEntries.find(
        (entry) =>
          entry.invocationId === invocationId &&
          entry.status === "invocation.succeeded" &&
          (entry.claimId === undefined || entry.claimId === claim.claimId) &&
          (entry.episodeId === undefined ||
            entry.episodeId === claim.episodeId),
      );
      if (succeeded === undefined) {
        failures.push(
          `Claim ${claim.claimId} lacks successful invocation ${invocationId}.`,
        );
        const missing = evidence(
          context,
          "process-claim-execution-consistency",
          "invocation.missing",
          generated.length,
          {
            claimId: claim.claimId,
            episodeId: claim.episodeId,
            invocationId,
          },
        );
        generated.push(missing);
        evidenceIds.add(missing.ledgerEntryId);
      } else {
        evidenceIds.add(succeeded.ledgerEntryId);
      }
    }
  }

  return {
    gate: gate(
      context,
      "process-claim-execution-consistency",
      failures.length === 0 ? "pass" : "fail",
      [...evidenceIds],
      failures.length === 0
        ? "Verified process claims have successful invocation evidence."
        : failures.join(" "),
    ),
    ledgerEntries: generated,
  };
};

const participantIdentityVerifier: Verifier = (context) => {
  const failures: string[] = [];
  const evidenceIds = new Set<string>();
  const checked = evidence(
    context,
    "participant-resolved-model-identity",
    "participant.identity.checked",
    0,
  );
  const generated: EvidenceLedgerEntry[] = [
    checked,
  ];
  evidenceIds.add(checked.ledgerEntryId);

  for (const claim of context.fixture.processClaims) {
    for (const participantId of claim.requiredParticipantIds) {
      const entry = context.ledgerEntries.find(
        (candidate) =>
          candidate.invocationId !== undefined &&
          claim.invocationIds.includes(candidate.invocationId) &&
          candidate.participantId === participantId &&
          candidate.status === "invocation.succeeded" &&
          candidate.resolvedProvider !== undefined &&
          candidate.resolvedModel !== undefined &&
          (candidate.claimId === undefined ||
            candidate.claimId === claim.claimId) &&
          (candidate.episodeId === undefined ||
            candidate.episodeId === claim.episodeId),
      );
      if (entry === undefined) {
        failures.push(
          `Required participant ${participantId} was not successfully invoked for claim ${claim.claimId}.`,
        );
        const notInvoked = evidence(
          context,
          "participant-resolved-model-identity",
          "participant.not_invoked",
          generated.length,
          {
            claimId: claim.claimId,
            episodeId: claim.episodeId,
            participantId,
          },
        );
        generated.push(notInvoked);
        evidenceIds.add(notInvoked.ledgerEntryId);
      } else {
        evidenceIds.add(entry.ledgerEntryId);
      }
    }
  }

  for (const assertion of context.fixture.identityAssertions) {
    const entries = context.ledgerEntries.filter(
      (candidate) =>
        candidate.invocationId === assertion.invocationId &&
        candidate.status === "invocation.succeeded",
    );
    if (entries.length !== 1) {
      failures.push(
        `Invocation ${assertion.invocationId} has ${entries.length} successful identity records, expected 1.`,
      );
      const mismatch = evidence(
        context,
        "participant-resolved-model-identity",
        "identity.mismatch",
        generated.length,
        {
          invocationId: assertion.invocationId,
        },
      );
      generated.push(mismatch);
      evidenceIds.add(mismatch.ledgerEntryId);
      continue;
    }

    const entry = entries[0];
    if (entry === undefined) {
      continue;
    }
    evidenceIds.add(entry.ledgerEntryId);
    const mismatch =
      (assertion.expectedParticipantId !== undefined &&
        entry.participantId !== assertion.expectedParticipantId) ||
      (assertion.expectedResolvedProvider !== undefined &&
        entry.resolvedProvider !== assertion.expectedResolvedProvider) ||
      (assertion.expectedResolvedModel !== undefined &&
        entry.resolvedModel !== assertion.expectedResolvedModel);
    if (mismatch) {
      failures.push(
        `Invocation ${assertion.invocationId} resolved ${entry.participantId ?? "unknown"}/${entry.resolvedProvider ?? "unknown"}/${entry.resolvedModel ?? "unknown"}, expected ${assertion.expectedParticipantId ?? "*"}/${assertion.expectedResolvedProvider ?? "*"}/${assertion.expectedResolvedModel ?? "*"}.`,
      );
      const mismatchFields: Partial<EvidenceLedgerEntry> = {
        invocationId: assertion.invocationId,
      };
      if (entry.participantId !== undefined) {
        mismatchFields.participantId = entry.participantId;
      }
      if (entry.resolvedModel !== undefined) {
        mismatchFields.resolvedModel = entry.resolvedModel;
      }
      if (entry.resolvedProvider !== undefined) {
        mismatchFields.resolvedProvider = entry.resolvedProvider;
      }
      const mismatchEvidence = evidence(
        context,
        "participant-resolved-model-identity",
        "identity.mismatch",
        generated.length,
        mismatchFields,
      );
      generated.push(mismatchEvidence);
      evidenceIds.add(mismatchEvidence.ledgerEntryId);
    }
  }

  return {
    gate: gate(
      context,
      "participant-resolved-model-identity",
      failures.length === 0 ? "pass" : "fail",
      [...evidenceIds],
      failures.length === 0
        ? "Participant and resolved-model identity requirements are satisfied."
        : failures.join(" "),
    ),
    ledgerEntries: generated,
  };
};

const commandCompletionVerifier: Verifier = (context) => {
  const failures: string[] = [];
  const evidenceIds = new Set<string>();
  const checked = evidence(
    context,
    "command-completion-exit-code",
    "command.completion.checked",
    0,
  );
  const generated: EvidenceLedgerEntry[] = [
    checked,
  ];
  evidenceIds.add(checked.ledgerEntryId);

  for (const assertion of context.fixture.commandAssertions) {
    let assertionClaim:
      | VerifierContext["fixture"]["processClaims"][number]
      | undefined;
    if (assertion.claimId !== undefined) {
      assertionClaim = context.fixture.processClaims.find(
        (candidate) => candidate.claimId === assertion.claimId,
      );
      if (
        assertionClaim === undefined ||
        !assertionClaim.invocationIds.includes(assertion.invocationId) ||
        (assertion.episodeId !== undefined &&
          assertionClaim.episodeId !== assertion.episodeId)
      ) {
        failures.push(
          `Command assertion ${assertion.assertionId} is not bound to the declared claim invocation.`,
        );
        continue;
      }
    }

    const terminalEntries = context.ledgerEntries.filter(
      (candidate) =>
        candidate.invocationId === assertion.invocationId &&
        (assertion.claimId === undefined ||
          candidate.claimId === assertion.claimId) &&
        (assertion.episodeId === undefined
          ? assertionClaim === undefined ||
            candidate.episodeId === assertionClaim.episodeId
          : candidate.episodeId === assertion.episodeId) &&
        [
          "command.succeeded",
          "command.failed",
        ].includes(candidate.status),
    );
    if (terminalEntries.length === 0) {
      failures.push(
        `Command invocation ${assertion.invocationId} has no terminal completion evidence.`,
      );
      const missing = evidence(
        context,
        "command-completion-exit-code",
        "command.completion_missing",
        generated.length,
        {
          invocationId: assertion.invocationId,
        },
      );
      generated.push(missing);
      evidenceIds.add(missing.ledgerEntryId);
      continue;
    }

    terminalEntries.forEach((entry) => evidenceIds.add(entry.ledgerEntryId));
    const terminalStates = new Set(
      terminalEntries.map((entry) => `${entry.status}:${entry.exitCode}`),
    );
    const expectedLedgerStatus = `command.${assertion.expectedStatus}`;
    const matches = terminalEntries.some(
      (entry) =>
        entry.status === expectedLedgerStatus &&
        entry.exitCode === assertion.expectedExitCode,
    );
    if (terminalStates.size > 1 || !matches) {
      failures.push(
        `Command ${assertion.invocationId} terminal evidence is ${[...terminalStates].join(", ")}, expected ${expectedLedgerStatus}:${assertion.expectedExitCode}.`,
      );
    }
  }

  return {
    gate: gate(
      context,
      "command-completion-exit-code",
      failures.length === 0 ? "pass" : "fail",
      [...evidenceIds],
      failures.length === 0
        ? "Command completion and exit codes are consistent."
        : failures.join(" "),
    ),
    ledgerEntries: generated,
  };
};

const secretPersistenceVerifier: Verifier = (context) => {
  const failures: string[] = [];
  const evidenceIds = new Set<string>();
  const checked = evidence(
    context,
    "secret-persistence",
    "secret.scan.completed",
    0,
  );
  const generated: EvidenceLedgerEntry[] = [
    checked,
  ];
  evidenceIds.add(checked.ledgerEntryId);

  for (const content of context.fixture.persistedContents) {
    const entry = ledgerEntry(context, content.evidenceId);
    if (entry === undefined) {
      failures.push(
        `Persisted content ${content.evidenceId} has no Ledger evidence.`,
      );
      continue;
    }
    evidenceIds.add(entry.ledgerEntryId);
    const contentDigestMatches =
      entry.status === "persisted.content" &&
      entry.inputDigest === sha256(content.value);
    if (!contentDigestMatches) {
      failures.push(
        `Persisted content ${content.evidenceId} is not bound to its Ledger digest.`,
      );
    }
    if (containsPotentialSecret(content.value)) {
      failures.push(
        `Secret-like content persisted in ${content.evidenceId}.`,
      );
      const detected = evidence(
        context,
        "secret-persistence",
        "secret.detected",
        generated.length,
        {
          inputDigest: sha256(content.value),
        },
      );
      generated.push(detected);
      evidenceIds.add(detected.ledgerEntryId);
    }
  }

  for (const entry of context.ledgerEntries) {
    if (
      entry.status === "secret.redacted_before_ledger" ||
      ledgerEntryContainsSecret(entry)
    ) {
      failures.push(
        `Secret-like content was detected for Ledger entry ${entry.ledgerEntryId}.`,
      );
      evidenceIds.add(entry.ledgerEntryId);
      const detected = evidence(
        context,
        "secret-persistence",
        "secret.detected",
        generated.length,
        {
          inputDigest: sha256(entry),
        },
      );
      generated.push(detected);
      evidenceIds.add(detected.ledgerEntryId);
    }
  }

  return {
    gate: gate(
      context,
      "secret-persistence",
      failures.length === 0 ? "pass" : "fail",
      [...evidenceIds],
      failures.length === 0
        ? "No known or high-entropy secret remains in persisted content."
        : failures.join(" "),
    ),
    ledgerEntries: generated,
  };
};

const repositoryScopeVerifier: Verifier = (context) => {
  const failures: string[] = [];
  const evidenceIds = new Set<string>();
  const checked = evidence(
    context,
    "repository-scope-isolation",
    "scope.isolation.checked",
    0,
  );
  const generated: EvidenceLedgerEntry[] = [
    checked,
  ];
  evidenceIds.add(checked.ledgerEntryId);

  for (const assertion of context.fixture.repositoryScopeAssertions) {
    const entry = ledgerEntry(context, assertion.evidenceId);
    if (entry === undefined) {
      failures.push(
        `Repository scope assertion ${assertion.evidenceId} has no Ledger evidence.`,
      );
      continue;
    }
    evidenceIds.add(entry.ledgerEntryId);
    const expectedDigest = sha256({
      scope: assertion.scope,
      sourceRepoId: assertion.sourceRepoId,
      targetRepoId: assertion.targetRepoId,
    });
    if (
      entry.status !== "scope.observed" ||
      entry.outputDigest !== expectedDigest
    ) {
      failures.push(
        `Repository scope assertion ${assertion.evidenceId} is not bound to its Ledger fact.`,
      );
      continue;
    }
    if (assertion.sourceRepoId !== assertion.targetRepoId) {
      failures.push(
        `Repository scope leakage detected for ${assertion.evidenceId}.`,
      );
      const leakage = evidence(
        context,
        "repository-scope-isolation",
        "scope.leakage",
        generated.length,
      );
      generated.push(leakage);
      evidenceIds.add(leakage.ledgerEntryId);
    }
  }

  return {
    gate: gate(
      context,
      "repository-scope-isolation",
      failures.length === 0 ? "pass" : "fail",
      [...evidenceIds],
      failures.length === 0
        ? "Repository-scoped records remain in their source repository."
        : failures.join(" "),
    ),
    ledgerEntries: generated,
  };
};

const deletionPropagationVerifier: Verifier = (context) => {
  const failures: string[] = [];
  let unsupported = context.fixture.deletionAssertions.length === 0;
  const evidenceIds = new Set<string>();
  const checked = evidence(
    context,
    "deletion-propagation",
    "deletion.propagation.checked",
    0,
  );
  const generated: EvidenceLedgerEntry[] = [
    checked,
  ];
  evidenceIds.add(checked.ledgerEntryId);

  for (const assertion of context.fixture.deletionAssertions) {
    const entry = ledgerEntry(context, assertion.evidenceId);
    if (entry === undefined) {
      failures.push(
        `Deletion assertion ${assertion.evidenceId} has no Ledger evidence.`,
      );
      continue;
    }
    evidenceIds.add(entry.ledgerEntryId);
    const expectedStatus = assertion.supported
      ? "deletion.completed"
      : "deletion.unsupported";
    const expectedDigest = sha256({
      dependentIds: assertion.dependentIds,
      remainingIds: assertion.remainingIds,
      sourceIds: assertion.sourceIds,
      supported: assertion.supported,
    });
    if (
      entry.status !== expectedStatus ||
      entry.outputDigest !== expectedDigest
    ) {
      failures.push(
        `Deletion assertion ${assertion.evidenceId} is not bound to its Ledger fact.`,
      );
      continue;
    }
    if (!assertion.supported) {
      unsupported = true;
      continue;
    }

    const prohibited = new Set([
      ...assertion.sourceIds,
      ...assertion.dependentIds,
    ]);
    if (assertion.remainingIds.some((id) => prohibited.has(id))) {
      failures.push(
        `Deleted source or dependent data remains for ${assertion.evidenceId}.`,
      );
      const leakage = evidence(
        context,
        "deletion-propagation",
        "deletion.leakage",
        generated.length,
      );
      generated.push(leakage);
      evidenceIds.add(leakage.ledgerEntryId);
    }
  }

  const status: GateResult["status"] =
    failures.length > 0
      ? "fail"
      : unsupported
        ? "inconclusive"
        : "pass";
  return {
    gate: gate(
      context,
      "deletion-propagation",
      status,
      [...evidenceIds],
      failures.length > 0
        ? failures.join(" ")
        : unsupported
          ? "Deletion propagation is not implemented for this fixture."
          : "Deleted sources and dependent records are absent.",
    ),
    ledgerEntries: generated,
  };
};

const queueRecoveryVerifier: Verifier = (context) => {
  const failures: string[] = [];
  const evidenceIds = new Set<string>();
  const checked = evidence(
    context,
    "queue-recovery",
    "queue.recovery.checked",
    0,
  );
  const generated: EvidenceLedgerEntry[] = [
    checked,
  ];
  evidenceIds.add(checked.ledgerEntryId);

  for (const assertion of context.fixture.queueAssertions) {
    const entry = ledgerEntry(context, assertion.evidenceId);
    if (entry === undefined) {
      failures.push(
        `Queue assertion ${assertion.evidenceId} has no Ledger evidence.`,
      );
      continue;
    }
    evidenceIds.add(entry.ledgerEntryId);
    const expectedDigest = sha256({
      interruptedState: assertion.interruptedState,
      itemId: assertion.itemId,
      lost: assertion.lost,
      recoveredState: assertion.recoveredState,
    });
    if (
      entry.status !== "queue.recovered" ||
      entry.outputDigest !== expectedDigest
    ) {
      failures.push(
        `Queue assertion ${assertion.evidenceId} is not bound to its Ledger fact.`,
      );
      continue;
    }
    if (
      assertion.lost ||
      assertion.interruptedState !== "claimed" ||
      ![
        "pending",
        "retry",
      ].includes(assertion.recoveredState)
    ) {
      failures.push(
        `Queue item ${assertion.itemId} was lost or left unrecoverable.`,
      );
    }
  }

  return {
    gate: gate(
      context,
      "queue-recovery",
      failures.length === 0 ? "pass" : "fail",
      [...evidenceIds],
      failures.length === 0
        ? "Interrupted claimed queue items returned to a recoverable state."
        : failures.join(" "),
    ),
    ledgerEntries: generated,
  };
};

const verifiers: Readonly<Record<VerifierId, Verifier>> = {
  "command-completion-exit-code": commandCompletionVerifier,
  "deletion-propagation": deletionPropagationVerifier,
  "event-idempotency": eventIdempotencyVerifier,
  "event-schema-source-version": eventSchemaVerifier,
  "participant-resolved-model-identity": participantIdentityVerifier,
  "process-claim-execution-consistency": processClaimVerifier,
  "queue-recovery": queueRecoveryVerifier,
  "repository-scope-isolation": repositoryScopeVerifier,
  "secret-persistence": secretPersistenceVerifier,
};

export const runVerifier = (
  verifierId: string,
  context: VerifierContext,
): VerifierOutcome => {
  if (!VERIFIER_IDS.includes(verifierId as VerifierId)) {
    return {
      gate: gate(
        context,
        verifierId,
        "fail",
        [],
        `Unknown verifier: ${verifierId}.`,
      ),
      invalidInput: true,
    };
  }
  return verifiers[verifierId as VerifierId](context);
};
