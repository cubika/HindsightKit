import { describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  type CaptureEnvelope,
  type EpisodeGroupingCorrection,
} from "@provenloop/contracts";
import {
  CommitAncestryIndex,
  commitAncestryEdgesFromEnvelopes,
  createCaptureEnvelope,
  WorkEpisodeBuilder,
} from "@provenloop/domain";

const event = (
  sessionId: string | undefined,
  sourceEventId: string,
  timestamp: string,
  options: {
    readonly branch?: string;
    readonly commitSha?: string;
    readonly completionStatus?: "failed" | "succeeded";
    readonly eventType?: string;
    readonly message?: string;
    readonly repoId?: string;
  } = {},
): CaptureEnvelope => {
  const message = options.message ??
    (options.eventType === undefined || options.eventType === "prompt.submitted"
      ? `Investigate-${sourceEventId}` : undefined);
  const input = {
    adapter: "copilot-cli",
    adapterVersion: "1.0.82-0",
    ...(options.branch === undefined
      ? {}
      : {
          branch: options.branch,
        }),
    ...(options.commitSha === undefined
      ? {}
      : {
          commitSha: options.commitSha,
        }),
    ...(options.completionStatus === undefined
      ? {}
      : {
          completionStatus: options.completionStatus,
        }),
    ...(message === undefined
      ? {}
      : {
          content: {
            message,
          },
        }),
    eventType: options.eventType ?? "prompt.submitted",
    ...(options.repoId === undefined
      ? {}
      : {
          repoId: options.repoId,
        }),
    sourceEventId,
    timestamp,
    trust: (options.eventType === undefined || options.eventType === "prompt.submitted")
      ? "user" as const
      : "tool" as const,
  };
  if (sessionId === undefined) {
    return createCaptureEnvelope({
      ...input,
      sessionId: "temporary-session",
    });
  }
  return createCaptureEnvelope({
    ...input,
    sessionId,
  });
};

const withoutSession = (
  envelope: CaptureEnvelope,
): CaptureEnvelope => ({
  ...envelope,
  event: {
    ...envelope.event,
    sessionId: undefined,
  },
});

const correction = (
  action: "merge" | "split",
  sessionIds: readonly string[],
): EpisodeGroupingCorrection => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  action,
  correctionId: `${action}-correction`,
  sessionIds: [...sessionIds],
  timestamp: "2026-08-30T02:00:00.000Z",
});

describe("WorkEpisodeBuilder", () => {
  it("associates close Sessions on the same repository and branch", () => {
    const result = new WorkEpisodeBuilder().build([
      event(
        "session-1",
        "event-1",
        "2026-08-30T00:00:00.000Z",
        {
          branch: "feat/episodes",
          message: "Implement deterministic episode grouping",
          repoId: "repo-1",
        },
      ),
      event(
        "session-2",
        "event-2",
        "2026-08-30T00:20:00.000Z",
        {
          branch: "feat/episodes",
          message: "Continue deterministic episode grouping",
          repoId: "repo-1",
        },
      ),
      event(
        "session-2",
        "event-3",
        "2026-08-30T00:30:00.000Z",
        {
          branch: "feat/episodes",
          completionStatus: "succeeded",
          eventType: "test.completed",
          repoId: "repo-1",
        },
      ),
    ]);

    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]).toMatchObject({
      outcome: "success",
      outcomeQualification: "censored",
      repoId: "repo-1",
      sessionIds: [
        "session-1",
        "session-2",
      ],
    });
    expect(result.associations[0]).toMatchObject({
      leftSessionId: "session-1",
      rightSessionId: "session-2",
      status: "associated",
    });
    expect(
      result.associations[0]?.evidence.map((item) => item.signal),
    ).toEqual(
      expect.arrayContaining([
        "repository",
        "branch",
        "task_semantics",
        "temporal_proximity",
      ]),
    );
  });

  it("keeps weak same-branch relations as candidates", () => {
    const result = new WorkEpisodeBuilder().build([
      event(
        "session-1",
        "event-1",
        "2026-08-28T00:00:00.000Z",
        {
          branch: "main",
          message: "Investigate authentication timeout",
          repoId: "repo-1",
        },
      ),
      event(
        "session-2",
        "event-2",
        "2026-08-30T00:00:00.000Z",
        {
          branch: "main",
          message: "Update unrelated documentation",
          repoId: "repo-1",
        },
      ),
    ]);

    expect(result.episodes).toHaveLength(2);
    expect(result.associations[0]).toMatchObject({
      status: "candidate",
    });
  });

  it("does not merge on task semantics without corroboration", () => {
      const result = new WorkEpisodeBuilder().build([
        event(
          "session-1",
          "event-1",
          "2026-01-01T00:00:00.000Z",
          {
            branch: "feat/one",
            message: "fix bug",
            repoId: "repo-1",
          },
        ),
        event(
          "session-2",
          "event-2",
          "2026-08-30T00:00:00.000Z",
          {
            branch: "feat/two",
            message: "fix bug",
            repoId: "repo-1",
          },
        ),
      ]);

      expect(result.episodes).toHaveLength(2);
      expect(result.associations[0]).toMatchObject({
        status: "candidate",
    });
  });

  it("rejects cross-repository grouping before weaker signals", () => {
    const result = new WorkEpisodeBuilder().build([
      event(
        "session-1",
        "event-1",
        "2026-08-30T00:00:00.000Z",
        {
          branch: "main",
          message: "Fix the same timeout",
          repoId: "repo-1",
        },
      ),
      event(
        "session-2",
        "event-2",
        "2026-08-30T00:01:00.000Z",
        {
          branch: "main",
          message: "Fix the same timeout",
          repoId: "repo-2",
        },
      ),
    ]);

    expect(result.episodes).toHaveLength(2);
    expect(result.associations[0]).toMatchObject({
      confidence: 0,
      status: "rejected",
    });
  });

  it("does not use ambient HEAD equality as commit evidence", () => {
      const result = new WorkEpisodeBuilder().build([
        event(
          "session-1",
          "event-1",
          "2026-08-20T00:00:00.000Z",
          {
            branch: "feat/one",
            commitSha: "shared-head",
            message: "Implement authentication retry",
            repoId: "repo-1",
          },
        ),
        event(
          "session-2",
          "event-2",
          "2026-08-30T00:00:00.000Z",
          {
            branch: "feat/two",
            commitSha: "shared-head",
            message: "Update release documentation",
            repoId: "repo-1",
          },
        ),
      ]);

      expect(result.episodes).toHaveLength(2);
      expect(
        result.associations[0]?.evidence.map((item) => item.signal),
      ).not.toContain("commit");
  });

  it("does not treat read-only file arguments as changed-file evidence", () => {
      const result = new WorkEpisodeBuilder().build([
        createCaptureEnvelope({
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          content: {
            toolArguments: {
              path: "README.md",
            },
          },
          eventType: "tool.started",
          repoId: "repo-1",
          sessionId: "session-1",
          sourceEventId: "read-1",
          timestamp: "2026-08-20T00:00:00.000Z",
          trust: "tool",
        }),
        createCaptureEnvelope({
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          content: {
            toolArguments: {
              path: "README.md",
            },
          },
          eventType: "tool.started",
          repoId: "repo-1",
          sessionId: "session-2",
          sourceEventId: "read-2",
          timestamp: "2026-08-30T00:00:00.000Z",
          trust: "tool",
        }),
      ]);

      expect(result.episodes).toHaveLength(2);
      expect(
        result.associations[0]?.evidence.map((item) => item.signal),
      ).not.toContain("changed_file");
  });

  it("keeps changed-file overlap as a candidate without corroboration", () => {
    const changed = (
      sessionId: string,
      sourceEventId: string,
      timestamp: string,
    ): CaptureEnvelope =>
      createCaptureEnvelope({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        content: {
          message: "src/shared.ts",
        },
        eventType: "file.changed",
        repoId: "repo-1",
        sessionId,
        sourceEventId,
        timestamp,
        trust: "system",
      });
    const result = new WorkEpisodeBuilder().build([
      changed(
        "session-1",
        "change-1",
        "2026-01-01T00:00:00.000Z",
      ),
      changed(
        "session-2",
        "change-2",
        "2026-08-30T00:00:00.000Z",
      ),
    ]);

    expect(result.episodes).toHaveLength(2);
    expect(result.associations[0]).toMatchObject({
      status: "candidate",
    });
  });

  it("uses complete-link clustering to prevent bridge merges", () => {
    const builder = new WorkEpisodeBuilder({
      associatedThreshold: 0.9,
    });
    const result = builder.build([
      event(
        "session-a",
        "event-a",
        "2026-08-30T00:00:00.000Z",
        {
          branch: "main",
          repoId: "repo-1",
        },
      ),
      event(
        "session-b",
        "event-b",
        "2026-08-30T00:30:00.000Z",
        {
          branch: "main",
          repoId: "repo-1",
        },
      ),
      event(
        "session-c",
        "event-c",
        "2026-08-30T01:00:00.000Z",
        {
          branch: "main",
          repoId: "repo-1",
        },
      ),
    ]);

    expect(
      result.associations.filter(
        (association) => association.status === "associated",
      ),
    ).toHaveLength(2);
    expect(result.episodes).toHaveLength(2);
  });

  it("applies explicit merge and split corrections deterministically", () => {
    const inputs = [
      event(
        "session-1",
        "event-1",
        "2026-08-30T00:00:00.000Z",
        {
          branch: "main",
          repoId: "repo-1",
        },
      ),
      event(
        "session-2",
        "event-2",
        "2026-08-30T00:01:00.000Z",
        {
          branch: "main",
          repoId: "repo-2",
        },
      ),
    ];
    const merged = new WorkEpisodeBuilder().build(
      inputs,
      [
        correction("merge", [
          "session-1",
          "session-2",
        ]),
      ],
    );
    const split = new WorkEpisodeBuilder().build(
      inputs.map((item) => ({
        ...item,
        event: {
          ...item.event,
          repoId: "repo-1",
        },
      })),
      [
        correction("split", [
          "session-1",
          "session-2",
        ]),
      ],
    );

    expect(merged.episodes).toHaveLength(1);
    expect(merged.associations[0]).toMatchObject({
      confidence: 1,
      correctionIds: [
        "merge-correction",
      ],
      status: "associated",
    });
    expect(split.episodes).toHaveLength(2);
    expect(split.associations[0]).toMatchObject({
      confidence: 1,
      correctionIds: [
        "split-correction",
      ],
      status: "rejected",
    });
  });

  it("applies chained explicit merges transitively", () => {
    const inputs = [
      event(
        "session-a",
        "event-a",
        "2026-08-30T00:00:00.000Z",
        {
          repoId: "repo-a",
        },
      ),
      event(
        "session-b",
        "event-b",
        "2026-08-30T00:01:00.000Z",
        {
          repoId: "repo-b",
        },
      ),
      event(
        "session-c",
        "event-c",
        "2026-08-30T00:02:00.000Z",
        {
          repoId: "repo-c",
        },
      ),
    ];
    const result = new WorkEpisodeBuilder().build(
      inputs,
      [
        {
          ...correction("merge", [
            "session-a",
            "session-b",
          ]),
          correctionId: "merge-ab",
        },
        {
          ...correction("merge", [
            "session-b",
            "session-c",
          ]),
          correctionId: "merge-bc",
          timestamp: "2026-08-30T02:01:00.000Z",
        },
      ],
    );

    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.sessionIds).toEqual([
      "session-a",
      "session-b",
      "session-c",
    ]);
  });

  it("gives explicit split precedence over a conflicting merge chain", () => {
    const inputs = [
      event(
        "session-a",
        "event-a",
        "2026-08-30T00:00:00.000Z",
        {
          repoId: "repo-a",
        },
      ),
      event(
        "session-b",
        "event-b",
        "2026-08-30T00:01:00.000Z",
        {
          repoId: "repo-b",
        },
      ),
      event(
        "session-c",
        "event-c",
        "2026-08-30T00:02:00.000Z",
        {
          repoId: "repo-c",
        },
      ),
    ];
    const result = new WorkEpisodeBuilder().build(
      inputs,
      [
        {
          ...correction("merge", [
            "session-a",
            "session-b",
          ]),
          correctionId: "merge-ab",
        },
        {
          ...correction("merge", [
            "session-b",
            "session-c",
          ]),
          correctionId: "merge-bc",
          timestamp: "2026-08-30T02:01:00.000Z",
        },
        {
          ...correction("split", [
            "session-a",
            "session-c",
          ]),
          correctionId: "split-ac",
          timestamp: "2026-08-30T02:02:00.000Z",
        },
      ],
    );

    expect(result.episodes).toHaveLength(2);
    expect(
      result.episodes.map((episode) => episode.sessionIds),
    ).toEqual(
      expect.arrayContaining([
        [
          "session-a",
          "session-b",
        ],
        [
          "session-c",
        ],
      ]),
    );
  });

  it("reports events without Session identity instead of fabricating Episodes", () => {
    const input = withoutSession(
      event(
        undefined,
        "event-without-session",
        "2026-08-30T00:00:00.000Z",
      ),
    );
    const result = new WorkEpisodeBuilder().build([
      input,
    ]);

    expect(result.episodes).toEqual([]);
    expect(result.ignoredEventIds).toEqual([
      input.event.eventId,
    ]);
  });

  it("keeps an Episode ID stable when evidence is added", () => {
    const builder = new WorkEpisodeBuilder();
    const initial = [
      event(
        "session-1",
        "event-1",
        "2026-08-30T00:00:00.000Z",
        {
          repoId: "repo-1",
        },
      ),
    ];
    const before = builder.build(initial);
    const after = builder.build([
      ...initial,
      event(
        "session-1",
        "event-2",
        "2026-08-30T01:00:00.000Z",
        {
          completionStatus: "succeeded",
          eventType: "test.completed",
          repoId: "repo-1",
        },
      ),
    ]);

    expect(after.episodes[0]?.episodeId).toBe(
      before.episodes[0]?.episodeId,
    );
  });

  it("keeps an Episode ID stable when repository evidence arrives", () => {
    const builder = new WorkEpisodeBuilder();
    const before = builder.build([
      event(
        "session-1",
        "event-1",
        "2026-08-30T00:00:00.000Z",
      ),
    ]);
    const after = builder.build([
      event(
        "session-1",
        "event-1",
        "2026-08-30T00:00:00.000Z",
      ),
      event(
        "session-1",
        "event-2",
        "2026-08-30T00:01:00.000Z",
        {
          repoId: "repo-1",
        },
      ),
    ]);

    expect(after.episodes[0]?.episodeId).toBe(
      before.episodes[0]?.episodeId,
    );
  });

  it("records only attributable git.commit events as Episode commits", () => {
    const result = new WorkEpisodeBuilder().build([
      event(
        "session-1",
        "prompt",
        "2026-08-30T00:00:00.000Z",
        {
          commitSha: "ambient-head",
          repoId: "repo-1",
        },
      ),
      event(
        "session-1",
        "commit",
        "2026-08-30T00:05:00.000Z",
        {
          commitSha: "created-commit",
          eventType: "git.commit",
          repoId: "repo-1",
        },
      ),
    ]);

    expect(result.episodes[0]?.commitIds).toEqual([
      "created-commit",
    ]);
  });

  it("uses commit ancestry only when corroborated by another signal", () => {
    const ancestry = new CommitAncestryIndex([
      {
        childCommit: "commit-b",
        parentCommit: "commit-a",
        repoId: "repo-1",
      },
    ]);
    const commitEvent = (
      sessionId: string,
      sourceEventId: string,
      commitSha: string,
      timestamp: string,
      branch: string,
    ): CaptureEnvelope =>
      event(sessionId, sourceEventId, timestamp, {
        branch,
        commitSha,
        eventType: "git.commit",
        repoId: "repo-1",
      });
    const corroborated = new WorkEpisodeBuilder({
      commitAncestry: ancestry,
    }).build([
      commitEvent(
        "session-1",
        "commit-event-a",
        "commit-a",
        "2026-08-30T00:00:00.000Z",
        "feat/episodes",
      ),
      commitEvent(
        "session-2",
        "commit-event-b",
        "commit-b",
        "2026-08-31T00:00:00.000Z",
        "feat/episodes",
      ),
    ]);
    const ancestryOnly = new WorkEpisodeBuilder({
      commitAncestry: ancestry,
    }).build([
      commitEvent(
        "session-1",
        "commit-event-a",
        "commit-a",
        "2026-01-01T00:00:00.000Z",
        "feat/one",
      ),
      commitEvent(
        "session-2",
        "commit-event-b",
        "commit-b",
        "2026-08-30T00:00:00.000Z",
        "feat/two",
      ),
    ]);

    expect(corroborated.episodes).toHaveLength(1);
    expect(corroborated.associations[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signal: "commit_ancestry",
        }),
      ]),
    );
    expect(ancestryOnly.episodes).toHaveLength(2);
    expect(ancestryOnly.associations[0]).toMatchObject({
      status: "rejected",
    });
    expect(
      ancestryOnly.associations[0]?.evidence.map(
        (item) => item.signal,
      ),
    ).not.toContain("commit_ancestry");
  });

  it("does not merge long-lived branch Sessions on ancestry alone", () => {
    const ancestry = new CommitAncestryIndex([
      {
        childCommit: "commit-b",
        parentCommit: "commit-a",
        repoId: "repo-1",
      },
    ]);
    const result = new WorkEpisodeBuilder({
      commitAncestry: ancestry,
    }).build([
      event(
        "session-1",
        "commit-event-a",
        "2026-01-01T00:00:00.000Z",
        {
          branch: "main",
          commitSha: "commit-a",
          eventType: "git.commit",
          repoId: "repo-1",
        },
      ),
      event(
        "session-2",
        "commit-event-b",
        "2026-08-30T00:00:00.000Z",
        {
          branch: "main",
          commitSha: "commit-b",
          eventType: "git.commit",
          repoId: "repo-1",
        },
      ),
    ]);

    expect(result.episodes).toHaveLength(2);
    expect(result.associations[0]).toMatchObject({
      status: "candidate",
    });
    expect(
      result.associations[0]?.evidence.map((item) => item.signal),
    ).not.toContain("commit_ancestry");
  });

  it("resolves transitive commit ancestry", () => {
    const ancestry = new CommitAncestryIndex([
      {
        childCommit: "commit-b",
        parentCommit: "commit-a",
        repoId: "repo-1",
      },
      {
        childCommit: "commit-c",
        parentCommit: "commit-b",
        repoId: "repo-1",
      },
    ]);

    expect(
      ancestry.isAncestor({
        ancestorCommit: "commit-a",
        descendantCommit: "commit-c",
        repoId: "repo-1",
      }),
    ).toBe(true);
    expect(
      ancestry.isAncestor({
        ancestorCommit: "commit-c",
        descendantCommit: "commit-a",
        repoId: "repo-1",
      }),
    ).toBe(false);
  });

  it("normalizes parent_sha keys and commit hash casing", () => {
    const parent =
      "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    const child =
      "1234567890ABCDEF1234567890ABCDEF12345678";
    const envelope = createCaptureEnvelope({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      commitSha: child,
      content: {
        toolArguments: {
          parent_sha: parent,
        },
      },
      eventType: "git.commit",
      repoId: "repo-1",
      sessionId: "session-1",
      sourceEventId: "commit-event",
      timestamp: "2026-08-30T00:00:00.000Z",
      trust: "system",
    });
    const index = new CommitAncestryIndex(
      commitAncestryEdgesFromEnvelopes([
        envelope,
      ]),
    );

    expect(
      index.isAncestor({
        ancestorCommit: parent.toLowerCase(),
        descendantCommit: child.toLowerCase(),
        repoId: "repo-1",
      }),
    ).toBe(true);
  });

  it("orders offset timestamps chronologically", () => {
    const result = new WorkEpisodeBuilder().build([
      event(
        "session-1",
        "success",
        "2026-08-30T02:30:00.000+02:00",
        {
          completionStatus: "succeeded",
          eventType: "test.completed",
          repoId: "repo-1",
        },
      ),
      event(
        "session-1",
        "failure",
        "2026-08-30T01:00:00.000Z",
        {
          completionStatus: "failed",
          eventType: "test.completed",
          repoId: "repo-1",
        },
      ),
    ]);

    expect(result.episodes[0]).toMatchObject({
      lastActivityAt: "2026-08-30T01:00:00.000Z",
      outcome: "failure",
    });
  });

  it("uses the documented fourteen-day observation window by default", () => {
    const result = new WorkEpisodeBuilder().build([
      event(
        "session-1",
        "success",
        "2026-08-30T00:00:00.000Z",
        {
          completionStatus: "succeeded",
          eventType: "test.completed",
          repoId: "repo-1",
        },
      ),
    ]);

    expect(result.episodes[0]).toMatchObject({
      observationWindowEndsAt: "2026-09-13T00:00:00.000Z",
      outcomeQualification: "censored",
    });
  });
});
