import type { CaptureEnvelope } from "@provenloop/contracts";
import { createCaptureEnvelope } from "@provenloop/domain";

export const verificationFixture = (
  correction: CaptureEnvelope,
  verification: CaptureEnvelope,
) => {
  const operationId = `operation-${verification.event.eventId}`;
  const operation = createCaptureEnvelope({
    adapter: "copilot-cli",
    adapterVersion: "1.0.82-0",
    branch: correction.event.branch,
    content: {
      toolArguments: { command: "npm test -- --run tests\\logging.test.ts" },
    },
    eventType: "tool.started",
    operationId,
    parentEventId: correction.event.eventId,
    repoId: correction.event.repoId,
    sessionId: correction.event.sessionId ?? "missing-session",
    sourceEventId: `start-${verification.sourceEventId}`,
    timestamp: new Date(
      Math.floor(
        (Date.parse(correction.event.timestamp) + Date.parse(verification.event.timestamp)) / 2,
      ),
    ).toISOString(),
    toolName: "powershell",
    trust: "tool",
    worktree: correction.event.worktree,
  });
  return {
    operation,
    verification: {
      ...verification,
      event: {
        ...verification.event,
        operationId,
        parentEventId: operation.event.eventId,
        verificationBinding: {
          correctionEventId: correction.event.eventId,
          operationEventId: operation.event.eventId,
        },
      },
    },
  };
};

export const proofEnvelopes = (
  envelopes: readonly CaptureEnvelope[],
  pairs: readonly (readonly [CaptureEnvelope, CaptureEnvelope])[],
): CaptureEnvelope[] => {
  const proved = pairs.map(([correction, verification]) =>
    verificationFixture(correction, verification),
  );
  const replacements = new Map(
    proved.map((item) => [item.verification.event.eventId, item.verification]),
  );
  return [
    ...envelopes.map((item) => replacements.get(item.event.eventId) ?? item),
    ...proved.map((item) => item.operation),
  ];
};
