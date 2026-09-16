import { describe, expect, it } from "vitest";

import {
  captureEnvelopeSchema,
  captureQueueItemSchema,
} from "@provenloop/contracts";
import {
  createCaptureEnvelope,
  InternalCaptureEventError,
  isProvenLoopInternalEnvironment,
  redactCaptureEnvelopeForPersistence,
  sha256,
} from "@provenloop/domain";

const timestamp = "2026-08-29T00:00:00.000Z";

const createInput = () => ({
  adapter: "copilot-cli",
  adapterVersion: "1.0.82-0",
  branch: "feat/batch3-event-capture",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  eventType: "tool.completed",
  operationId: "call-1",
  repoId: "repo-1",
  requestedModel: "gpt-5.6-sol",
  requestedProvider: "github",
  resolvedModel: "gpt-5.6-sol",
  resolvedProvider: "github",
  sessionId: "session-1",
  sourceEventId: "source-event-1",
  timestamp,
  toolName: "powershell",
  trust: "tool" as const,
  worktree: "worktree-1",
});

describe("capture envelope identity", () => {
  it("preserves explicit verification bindings through persistence redaction", () => {
    const verificationBinding = {
      correctionEventId: "event-correction",
      operationEventId: "event-operation",
    };
    const envelope = createCaptureEnvelope({
      ...createInput(),
      eventType: "verification.completed",
      verificationBinding,
    });
    expect(envelope.event).toHaveProperty("verificationBinding", verificationBinding);
    expect(redactCaptureEnvelopeForPersistence(envelope).envelope.event)
      .toHaveProperty("verificationBinding", verificationBinding);
  });

  it("generates stable event and deduplication identities", () => {
    const first = createCaptureEnvelope(createInput(), {
      capturedAt: timestamp,
    });
    const second = createCaptureEnvelope(
      {
        ...createInput(),
        content: {
          message: "A retransmitted body may differ.",
        },
      },
      {
        capturedAt: timestamp,
      },
    );

    expect(first.deduplicationKey).toBe(second.deduplicationKey);
    expect(first.event.eventId).toBe(second.event.eventId);
    expect(first.event.requestedModel).toBe("gpt-5.6-sol");
    expect(first.event.resolvedModel).toBe("gpt-5.6-sol");
    expect(captureEnvelopeSchema.parse(first)).toEqual(first);
  });

  it("changes identity when a source identity component changes", () => {
    const first = createCaptureEnvelope(createInput(), {
      capturedAt: timestamp,
    });
    const second = createCaptureEnvelope(
      {
        ...createInput(),
        sourceEventId: "source-event-2",
      },
      {
        capturedAt: timestamp,
      },
    );

    expect(first.deduplicationKey).not.toBe(second.deduplicationKey);
    expect(first.event.eventId).not.toBe(second.event.eventId);
  });

  it("normalizes identity fields before hashing them", () => {
    const normalized = createCaptureEnvelope(createInput(), {
      capturedAt: timestamp,
    });
    const padded = createCaptureEnvelope(
      {
        ...createInput(),
        adapter: " copilot-cli ",
        eventType: " tool.completed ",
        sessionId: " session-1 ",
        sourceEventId: " source-event-1 ",
      },
      {
        capturedAt: timestamp,
      },
    );

    expect(padded.deduplicationKey).toBe(
      normalized.deduplicationKey,
    );
    expect(padded.event.sessionId).toBe("session-1");
    expect(padded.sourceEventId).toBe("source-event-1");
  });

  it("rejects internal ProvenLoop sessions", () => {
    expect(() =>
      createCaptureEnvelope({
        ...createInput(),
        internalSession: true,
      }),
    ).toThrow(InternalCaptureEventError);
    expect(
      isProvenLoopInternalEnvironment({
        PROVENLOOP_INTERNAL: "1",
      }),
    ).toBe(true);
  });
});

describe("capture redaction", () => {
  it("removes known, entropy, environment, and stack secrets", () => {
    const knownSecret = "ghp_1234567890abcdefghijklmnopqrst";
    const entropySecret = "9wM3QfT7xL2nV8pR4sK6dH1cB5yJ0uZa";
    const error = new Error(`failure ${knownSecret}`);
    error.stack = `stack ${entropySecret}`;
    const envelope = createCaptureEnvelope(
      {
        ...createInput(),
        content: {
          error,
          message:
            `token=${knownSecret} ` +
            "{\"password\":\"plain-password\"}",
          toolArguments: {
            db_password: "plain-password",
            env: {
              API_TOKEN: entropySecret,
            },
            nested: {
              clientSecretValue: "another-plain-secret",
              password: "plain-password",
              secretKey: "third-plain-secret",
              userToken: "another-plain-secret",
              value: entropySecret,
            },
          },
          toolResult: {
            authorization: `Bearer ${entropySecret}`,
            output: entropySecret,
          },
        },
      },
      {
        capturedAt: timestamp,
      },
    );
    const persisted = JSON.stringify(envelope);

    expect(persisted).not.toContain(knownSecret);
    expect(persisted).not.toContain(entropySecret);
    expect(persisted).not.toContain("plain-password");
    expect(persisted).not.toContain("another-plain-secret");
    expect(persisted).not.toContain("third-plain-secret");
    expect(persisted).not.toContain("stack ");
    expect(envelope.redaction.appliedRules).toEqual(
      expect.arrayContaining([
        "environment-omission",
        "high-entropy",
        "known-secret",
        "sensitive-key",
      ]),
    );
    expect(envelope.redaction.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(envelope.event.resultDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("redacts secret-bearing event metadata before persistence", () => {
    const secret = "ghp_1234567890abcdefghijklmnopqrst";
    const envelope = createCaptureEnvelope(
      {
        ...createInput(),
        branch: `feature/${secret}`,
      },
      {
        capturedAt: timestamp,
      },
    );

    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(envelope.event.branch).toBe("feature/[REDACTED]");
    expect(envelope.redaction.redactedPaths).toContain("event.branch");
  });

  it("limits large argument and result bodies while preserving digests", () => {
    const envelope = createCaptureEnvelope(
      {
        ...createInput(),
        content: {
          message: "m".repeat(40),
          toolArguments: {
            input: "a".repeat(100),
          },
          toolResult: {
            output: "b".repeat(100),
          },
        },
      },
      {
        capturedAt: timestamp,
        redactionLimits: {
          messageChars: 16,
          toolArgumentsChars: 32,
          toolResultChars: 32,
        },
      },
    );

    expect(envelope.content?.message).toBe(
      `${"m".repeat(16)}[TRUNCATED]`,
    );
    expect(envelope.event.redactedArguments).toMatchObject({
      status: "truncated",
    });
    expect(envelope.content?.toolResult).toMatchObject({
      status: "truncated",
    });
    expect(envelope.redaction.truncatedPaths).toEqual(
      expect.arrayContaining([
        "content.message",
        "content.toolResult",
        "event.redactedArguments",
      ]),
    );
  });

  it("preserves common structured identifiers and ordinary text", () => {
    const sha =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const envelope = createCaptureEnvelope(
      {
        ...createInput(),
        content: {
          message:
            "Use claude-3-5-sonnet-20241022 with request 123e4567-e89b-42d3-a456-426614174000.",
          toolResult: {
            digest: sha,
          },
        },
      },
      {
        capturedAt: timestamp,
      },
    );

    expect(envelope.content?.message).toContain(
      "claude-3-5-sonnet-20241022",
    );
    expect(envelope.content?.message).toContain(
      "123e4567-e89b-42d3-a456-426614174000",
    );
    expect(envelope.content?.toolResult).toEqual({
      digest: sha,
    });
    expect(envelope.redaction.redactedPaths).toEqual([]);
  });

  it("preserves parent commit SHAs inside structured arrays", () => {
      const parentSha = "0123456789abcdef0123456789abcdef01234567";
      const unrelated =
        "9wM3QfT7xL2nV8pR4sK6dH1cB5yJ0uZa";
      const nonShaIdentifier =
        "client_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      const envelope = createCaptureEnvelope(
        {
          ...createInput(),
          content: {
            toolArguments: {
              changedFiles: [
                unrelated,
              ],
              parents: [
                parentSha,
                nonShaIdentifier,
              ],
            },
          },
        },
        {
          capturedAt: timestamp,
        },
      );

      expect(envelope.event.redactedArguments).toMatchObject({
        changedFiles: [
          "[REDACTED]",
        ],
        parents: [
          parentSha,
          "[REDACTED]",
        ],
      });
  });

  it("does not treat colon-delimited evidence IDs as assignments", () => {
    const envelope = createCaptureEnvelope(
      {
        ...createInput(),
        content: {
          message: "seeded-secret:secret-persistence:0",
        },
      },
      {
        capturedAt: timestamp,
      },
    );

    expect(envelope.content?.message).toBe(
      "seeded-secret:secret-persistence:0",
    );
    expect(envelope.redaction.redactedPaths).toEqual([]);
  });

  it("registers capture queue items as versioned contracts", () => {
    const envelope = createCaptureEnvelope(createInput(), {
      capturedAt: timestamp,
    });
    expect(
      captureQueueItemSchema.safeParse({
        schemaVersion: 1,
        attemptCount: 0,
        createdAt: timestamp,
        envelope,
        failureCount: 0,
        queueItemId: "queue-1",
        state: "pending",
        updatedAt: timestamp,
      }).success,
    ).toBe(true);
  });

  it("hashes binary content by bytes rather than only length", () => {
    expect(sha256(Buffer.from([1, 2]))).not.toBe(
      sha256(Buffer.from([3, 4])),
    );
  });
});
