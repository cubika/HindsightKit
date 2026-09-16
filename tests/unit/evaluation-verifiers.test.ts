import { describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  replaySpecSchema,
  requirementManifestSchema,
} from "@provenloop/contracts";
import {
  evaluationFixtureSchema,
  runVerifier,
  VERIFIER_IDS,
  type VerifierContext,
} from "@provenloop/evaluation";

const timestamp = "2026-08-29T00:00:00.000Z";

const context: VerifierContext = {
  fixture: evaluationFixtureSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    fixtureId: "complete-evidence",
    fixtureVersion: 1,
    events: [
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        eventId: "event-1",
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        eventType: "tool.completed",
        timestamp,
        trust: "tool",
      },
    ],
    expectedCanonicalEventCount: 1,
    processClaims: [
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        claimId: "claim-1",
        episodeId: "episode-1",
        kind: "reviewed",
        requiredParticipantIds: [
          "reviewer-1",
        ],
        availabilityEvidenceIds: [
          "availability-1",
        ],
        invocationIds: [
          "participant-invocation-1",
        ],
        requiredEvidence: [
          "invocation.succeeded",
        ],
        evidenceIds: [
          "participant-invocation-evidence-1",
        ],
        status: "verified",
        createdAt: timestamp,
        verifiedAt: timestamp,
      },
    ],
    evidence: [
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        ledgerEntryId: "participant-invocation-evidence-1",
        runId: "run-1",
        participantId: "reviewer-1",
        invocationId: "participant-invocation-1",
        resolvedProvider: "github-copilot",
        resolvedModel: "gpt-5.6-sol",
        status: "invocation.succeeded",
        timestamp,
      },
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        ledgerEntryId: "command-evidence-1",
        runId: "run-1",
        invocationId: "command-invocation-1",
        exitCode: 0,
        status: "command.succeeded",
        timestamp,
      },
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        ledgerEntryId: "content-evidence-1",
        runId: "run-1",
        inputDigest: "5595ef08cccda1555f4c36ce43945b044dc3923f38df0caeca331d584e229a21",
        status: "persisted.content",
        timestamp,
      },
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        ledgerEntryId: "scope-evidence-1",
        runId: "run-1",
        outputDigest: "0667d055a4bc50d32cf6ec45fc454fe78a714896d25a27dea93cd23f8fe5826f",
        status: "scope.observed",
        timestamp,
      },
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        ledgerEntryId: "deletion-evidence-1",
        runId: "run-1",
        outputDigest: "d6a1f61a8e736e08f66a6eef448534a96edfa7b68d75abdcd27c8b62aadb57e4",
        status: "deletion.completed",
        timestamp,
      },
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        ledgerEntryId: "queue-evidence-1",
        runId: "run-1",
        outputDigest: "de65ff16a96a8cc7bbf827a308bd086ba456a40c29f8b60a3c6cd89aacac8b66",
        status: "queue.recovered",
        timestamp,
      },
    ],
    identityAssertions: [
      {
        assertionId: "identity-1",
        invocationId: "participant-invocation-1",
        expectedParticipantId: "reviewer-1",
        expectedResolvedProvider: "github-copilot",
        expectedResolvedModel: "gpt-5.6-sol",
      },
    ],
    commandAssertions: [
      {
        assertionId: "command-1",
        invocationId: "command-invocation-1",
        expectedStatus: "succeeded",
        expectedExitCode: 0,
      },
    ],
    persistedContents: [
      {
        evidenceId: "content-evidence-1",
        value: "The command completed successfully.",
      },
    ],
    repositoryScopeAssertions: [
      {
        evidenceId: "scope-evidence-1",
        scope: "repository",
        sourceRepoId: "repo-1",
        targetRepoId: "repo-1",
      },
    ],
    deletionAssertions: [
      {
        evidenceId: "deletion-evidence-1",
        supported: true,
        sourceIds: [
          "source-1",
        ],
        dependentIds: [
          "derived-1",
        ],
        remainingIds: [
          "unrelated-1",
        ],
      },
    ],
    queueAssertions: [
      {
        evidenceId: "queue-evidence-1",
        itemId: "queue-item-1",
        interruptedState: "claimed",
        recoveredState: "retry",
        lost: false,
      },
    ],
  }),
  generatedAt: timestamp,
  ledgerEntries: [],
  manifest: requirementManifestSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    requirementId: "COMPLETE-EVIDENCE-001",
    milestone: "M0",
    statement: "Complete evidence passes deterministic verification.",
    scope: "workflow",
    replaySpecIds: [
      "complete-evidence",
    ],
    verifierIds: [...VERIFIER_IDS],
    requiredEvidence: [],
    releaseGate: "hard",
  }),
  replaySpec: replaySpecSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    specId: "complete-evidence",
    requirementId: "COMPLETE-EVIDENCE-001",
    inputRef: "inline://fixture",
    frozenEnvironment: "local-fixture-v1",
    expectedGate: "pass",
    expectedEvidence: [],
  }),
  runId: "run-1",
};

const verifierContext: VerifierContext = {
  ...context,
  ledgerEntries: context.fixture.evidence,
};

describe.each(VERIFIER_IDS)("%s verifier", (verifierId) => {
  it("passes complete evidence", () => {
    const outcome = runVerifier(verifierId, verifierContext);

    expect(outcome.gate.status).toBe("pass");
  });
});

describe("verifier evidence binding", () => {
  it("does not use an unrelated participant invocation for a claim", () => {
    const fixture = evaluationFixtureSchema.parse({
      schemaVersion: 1,
      fixtureId: "unrelated-participant",
      fixtureVersion: 1,
      processClaims: [
        {
          schemaVersion: 1,
          claimId: "claim-1",
          episodeId: "episode-1",
          kind: "consensus",
          requiredParticipantIds: [
            "external",
          ],
          availabilityEvidenceIds: [],
          invocationIds: [
            "internal-invocation",
          ],
          requiredEvidence: [],
          evidenceIds: [],
          status: "verified",
          createdAt: timestamp,
        },
      ],
      evidence: [
        {
          schemaVersion: 1,
          ledgerEntryId: "internal",
          runId: "run-1",
          participantId: "internal",
          invocationId: "internal-invocation",
          status: "invocation.succeeded",
          timestamp,
        },
        {
          schemaVersion: 1,
          ledgerEntryId: "unrelated-external",
          runId: "run-1",
          participantId: "external",
          invocationId: "unrelated-invocation",
          status: "invocation.succeeded",
          timestamp,
        },
      ],
    });

    const outcome = runVerifier(
      "participant-resolved-model-identity",
      {
        ...verifierContext,
        fixture,
        ledgerEntries: fixture.evidence,
      },
    );

    expect(outcome.gate.status).toBe("fail");
    expect(outcome.ledgerEntries).toContainEqual(
      expect.objectContaining({
        status: "participant.not_invoked",
      }),
    );
  });

  it("selects terminal command evidence after command.started", () => {
    const fixture = evaluationFixtureSchema.parse({
      schemaVersion: 1,
      fixtureId: "command-terminal",
      fixtureVersion: 1,
      commandAssertions: [
        {
          assertionId: "command-1",
          invocationId: "invocation-1",
          expectedStatus: "succeeded",
          expectedExitCode: 0,
        },
      ],
      evidence: [
        {
          schemaVersion: 1,
          ledgerEntryId: "command-started",
          runId: "run-1",
          invocationId: "invocation-1",
          status: "command.started",
          timestamp,
        },
        {
          schemaVersion: 1,
          ledgerEntryId: "command-succeeded",
          runId: "run-1",
          invocationId: "invocation-1",
          exitCode: 0,
          status: "command.succeeded",
          timestamp,
        },
      ],
    });

    const outcome = runVerifier("command-completion-exit-code", {
      ...verifierContext,
      fixture,
      ledgerEntries: fixture.evidence,
    });

    expect(outcome.gate.status).toBe("pass");
  });

  it("does not satisfy a claim with command evidence from another invocation", () => {
    const fixture = evaluationFixtureSchema.parse({
      schemaVersion: 1,
      fixtureId: "unrelated-command",
      fixtureVersion: 1,
      processClaims: [
        {
          schemaVersion: 1,
          claimId: "claim-1",
          episodeId: "episode-1",
          kind: "tested",
          requiredParticipantIds: [],
          availabilityEvidenceIds: [],
          invocationIds: [
            "invocation-a",
          ],
          requiredEvidence: [
            "command.succeeded",
          ],
          evidenceIds: [],
          status: "verified",
          createdAt: timestamp,
        },
      ],
      evidence: [
        {
          schemaVersion: 1,
          ledgerEntryId: "unrelated-command-success",
          runId: "run-1",
          claimId: "claim-other",
          episodeId: "episode-other",
          invocationId: "invocation-b",
          exitCode: 0,
          status: "command.succeeded",
          timestamp,
        },
      ],
      commandAssertions: [
        {
          assertionId: "command-1",
          claimId: "claim-1",
          episodeId: "episode-1",
          invocationId: "invocation-b",
          expectedStatus: "succeeded",
          expectedExitCode: 0,
        },
      ],
    });
    const boundContext = {
      ...verifierContext,
      fixture,
      ledgerEntries: fixture.evidence,
    };

    expect(
      runVerifier(
        "process-claim-execution-consistency",
        boundContext,
      ).gate.status,
    ).toBe("fail");
    expect(
      runVerifier(
        "command-completion-exit-code",
        boundContext,
      ).gate.status,
    ).toBe("fail");
  });

  it("rejects explicit evidence with any conflicting claim boundary", () => {
    const fixture = evaluationFixtureSchema.parse({
      schemaVersion: 1,
      fixtureId: "conflicting-claim-boundary",
      fixtureVersion: 1,
      processClaims: [
        {
          schemaVersion: 1,
          claimId: "claim-1",
          episodeId: "episode-1",
          kind: "tested",
          requiredParticipantIds: [],
          availabilityEvidenceIds: [],
          invocationIds: [
            "invocation-1",
          ],
          requiredEvidence: [
            "command.succeeded",
          ],
          evidenceIds: [
            "conflicting-evidence",
          ],
          status: "declared",
          createdAt: timestamp,
        },
      ],
      evidence: [
        {
          schemaVersion: 1,
          ledgerEntryId: "conflicting-evidence",
          runId: "run-1",
          claimId: "claim-other",
          episodeId: "episode-1",
          invocationId: "invocation-other",
          exitCode: 0,
          status: "command.succeeded",
          timestamp,
        },
      ],
    });

    const outcome = runVerifier(
      "process-claim-execution-consistency",
      {
        ...verifierContext,
        fixture,
        ledgerEntries: fixture.evidence,
      },
    );

    expect(outcome.gate.status).toBe("fail");
    expect(outcome.gate.message).toContain("outside its claim");
  });

  it("requires command evidence to bind to a declared claim invocation", () => {
    const fixture = evaluationFixtureSchema.parse({
      schemaVersion: 1,
      fixtureId: "unbound-command-evidence",
      fixtureVersion: 1,
      processClaims: [
        {
          schemaVersion: 1,
          claimId: "claim-1",
          episodeId: "episode-1",
          kind: "tested",
          requiredParticipantIds: [],
          availabilityEvidenceIds: [],
          invocationIds: [
            "invocation-1",
          ],
          requiredEvidence: [
            "command.succeeded",
          ],
          evidenceIds: [
            "unbound-command",
          ],
          status: "verified",
          createdAt: timestamp,
        },
      ],
      evidence: [
        {
          schemaVersion: 1,
          ledgerEntryId: "unbound-command",
          runId: "run-1",
          claimId: "claim-1",
          exitCode: 0,
          status: "command.succeeded",
          timestamp,
        },
        {
          schemaVersion: 1,
          ledgerEntryId: "invocation-success",
          runId: "run-1",
          claimId: "claim-1",
          episodeId: "episode-1",
          invocationId: "invocation-1",
          status: "invocation.succeeded",
          timestamp,
        },
      ],
    });

    const outcome = runVerifier(
      "process-claim-execution-consistency",
      {
        ...verifierContext,
        fixture,
        ledgerEntries: fixture.evidence,
      },
    );

    expect(outcome.gate.status).toBe("fail");
    expect(outcome.gate.message).toContain(
      "lacks required evidence status",
    );
  });

  it("requires resolved provider and model for required participants", () => {
    const fixture = evaluationFixtureSchema.parse({
      schemaVersion: 1,
      fixtureId: "participant-without-resolved-identity",
      fixtureVersion: 1,
      processClaims: [
        {
          schemaVersion: 1,
          claimId: "claim-1",
          episodeId: "episode-1",
          kind: "consensus",
          requiredParticipantIds: [
            "reviewer-1",
          ],
          availabilityEvidenceIds: [],
          invocationIds: [
            "invocation-1",
          ],
          requiredEvidence: [
            "invocation.succeeded",
          ],
          evidenceIds: [
            "invocation-1",
          ],
          status: "verified",
          createdAt: timestamp,
        },
      ],
      evidence: [
        {
          schemaVersion: 1,
          ledgerEntryId: "invocation-1",
          runId: "run-1",
          claimId: "claim-1",
          episodeId: "episode-1",
          participantId: "reviewer-1",
          invocationId: "invocation-1",
          status: "invocation.succeeded",
          timestamp,
        },
      ],
    });

    const outcome = runVerifier(
      "participant-resolved-model-identity",
      {
        ...verifierContext,
        fixture,
        ledgerEntries: fixture.evidence,
      },
    );

    expect(outcome.gate.status).toBe("fail");
  });

  it("fails assertion-based verifiers when Ledger evidence is absent", () => {
    const fixture = evaluationFixtureSchema.parse({
      schemaVersion: 1,
      fixtureId: "phantom-evidence",
      fixtureVersion: 1,
      queueAssertions: [
        {
          evidenceId: "missing",
          itemId: "queue-1",
          interruptedState: "claimed",
          recoveredState: "pending",
          lost: false,
        },
      ],
    });

    const outcome = runVerifier("queue-recovery", {
      ...verifierContext,
      fixture,
      ledgerEntries: fixture.evidence,
    });

    expect(outcome.gate.status).toBe("fail");
    expect(outcome.gate.message).toContain("no Ledger evidence");
  });

  it("fails queue assertions bound to the wrong Ledger fact", () => {
    const fixture = evaluationFixtureSchema.parse({
      schemaVersion: 1,
      fixtureId: "wrong-queue-evidence",
      fixtureVersion: 1,
      evidence: [
        {
          schemaVersion: 1,
          ledgerEntryId: "queue-evidence",
          runId: "run-1",
          status: "persisted.content",
          outputDigest: "7cdcebf7c0e5e78a4022717540dfabbb7d635ff88d3908bce0303b3b65a09ef6",
          timestamp,
        },
      ],
      queueAssertions: [
        {
          evidenceId: "queue-evidence",
          itemId: "queue-item-1",
          interruptedState: "claimed",
          recoveredState: "pending",
          lost: false,
        },
      ],
    });

    const outcome = runVerifier("queue-recovery", {
      ...verifierContext,
      fixture,
      ledgerEntries: fixture.evidence,
    });

    expect(outcome.gate.status).toBe("fail");
    expect(outcome.gate.message).toContain("not bound");
  });

  it("detects a high-entropy secret stored directly in the Ledger", () => {
    const fixture = evaluationFixtureSchema.parse({
      schemaVersion: 1,
      fixtureId: "ledger-secret",
      fixtureVersion: 1,
      evidence: [
        {
          schemaVersion: 1,
          ledgerEntryId: "ledger-secret-1",
          runId: "run-1",
          requestedModel: "9wM3QfT7xL2nV8pR4sK6dH1cB5yJ0uZa",
          status: "model.requested",
          timestamp,
        },
      ],
    });

    const outcome = runVerifier("secret-persistence", {
      ...verifierContext,
      fixture,
      ledgerEntries: fixture.evidence,
    });

    expect(outcome.gate.status).toBe("fail");
  });

  it("does not let unsupported deletion checks mask a confirmed leak", () => {
    const fixture = evaluationFixtureSchema.parse({
      schemaVersion: 1,
      fixtureId: "mixed-deletion",
      fixtureVersion: 1,
      evidence: [
        {
          schemaVersion: 1,
          ledgerEntryId: "supported-deletion",
          runId: "run-1",
          outputDigest: "1fd2cf6abcab91746299083e896482fbdd83bf99f35bd9a63d1075f40f295faf",
          status: "deletion.completed",
          timestamp,
        },
        {
          schemaVersion: 1,
          ledgerEntryId: "unsupported-deletion",
          runId: "run-1",
          outputDigest: "4587918980be303a199bb77fd5b9725608568a2394e293ae981975c20632d055",
          status: "deletion.unsupported",
          timestamp,
        },
      ],
      deletionAssertions: [
        {
          evidenceId: "supported-deletion",
          supported: true,
          sourceIds: [
            "source-1",
          ],
          dependentIds: [],
          remainingIds: [
            "source-1",
          ],
        },
        {
          evidenceId: "unsupported-deletion",
          supported: false,
          sourceIds: [],
          dependentIds: [],
          remainingIds: [],
        },
      ],
    });

    const outcome = runVerifier("deletion-propagation", {
      ...verifierContext,
      fixture,
      ledgerEntries: fixture.evidence,
    });

    expect(outcome.gate.status).toBe("fail");
    expect(outcome.gate.message).toContain("remains");
  });
});
