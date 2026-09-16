import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, type CaptureEnvelope, type EpisodeGroupingCorrection } from "@provenloop/contracts";
import {
  BranchContextBuilder, CommitAncestryIndex, WorkEpisodeBuilder, createCaptureEnvelope,
  type CaptureEventInput, type WorkEpisodeBuilderOptions,
} from "@provenloop/domain";

const base = Date.parse("2026-01-01T00:00:00.000Z");
const event = (
  sessionId: string, sourceEventId: string, offset: number, extra: Partial<CaptureEventInput> = {},
): CaptureEnvelope => createCaptureEnvelope({
  adapter: "copilot-cli", adapterVersion: "1.0.82-0", sessionId, sourceEventId,
  timestamp: new Date(base + offset).toISOString(), eventType: "prompt.submitted", trust: "user",
  repoId: "repo-1", content: { message: `Investigate ${sourceEventId}` }, ...extra,
});

const correction = (
  correctionId: string, action: "merge" | "split", sessionIds: string[],
): EpisodeGroupingCorrection => ({
  schemaVersion: CURRENT_SCHEMA_VERSION, correctionId, action, sessionIds,
  timestamp: new Date(base).toISOString(),
});

const expectSparseEquivalent = (
  events: readonly CaptureEnvelope[], corrections: readonly EpisodeGroupingCorrection[] = [],
  options: WorkEpisodeBuilderOptions = {},
) => {
  const dense = new WorkEpisodeBuilder(options).build(events, corrections);
  const sparse = new WorkEpisodeBuilder({ ...options, associationMode: "sparse" }).build(events, corrections);
  expect(sparse.episodes).toEqual(dense.episodes);
  expect(sparse.ignoredEventIds).toEqual(dense.ignoredEventIds);
  expect(sparse.excludedSessions).toEqual(dense.excludedSessions);
  expect(sparse.associations).toEqual(dense.associations.filter((association) =>
    association.status !== "rejected" || association.correctionIds.length > 0,
  ));
  const connected = new WorkEpisodeBuilder({ ...options, associationMode: "connected" }).build(events, corrections);
  expect(connected.episodes).toEqual(dense.episodes);
  expect(connected.associations).toEqual(dense.associations.filter((association) =>
    association.status === "associated" || association.correctionIds.length > 0,
  ));
  return sparse;
};

describe("Episode projection scale", () => {
  it("preserves continuation months later and explicit cross-repository corrections", () => {
    const day = 24 * 60 * 60 * 1_000;
    const events = [
      event("old", "old-goal", 0, { content: { message: "Investigate issue #42" } }),
      event("continued", "new-goal", 200 * day, { content: { message: "Finish issue #42" } }),
      event("foreign", "foreign-goal", 400 * day, { repoId: "repo-2" }),
      event("split", "split-goal", 0),
      event("independent", "independent-goal", 600 * day, { repoId: "repo-3" }),
    ];
    const result = expectSparseEquivalent(events, [
      correction("merge-cross-repo", "merge", ["old", "foreign"]),
      correction("split-cross-repo", "split", ["foreign", "split"]),
    ]);
    expect(result.associations.find((association) =>
      association.leftSessionId === "continued" && association.rightSessionId === "old",
    )?.status).toBe("associated");
    expect(result.associations.some((association) => association.correctionIds.includes("split-cross-repo"))).toBe(true);
    expect(result.associations.every((association) =>
      association.leftSessionId !== "independent" && association.rightSessionId !== "independent",
    )).toBe(true);
  });

  it("retains every automatic signal and complete-link result across mixed session histories", () => {
    let state = 731;
    const random = (max: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % max;
    };
    const events: CaptureEnvelope[] = [];
    const firstCommit = "a".repeat(40);
    const secondCommit = "b".repeat(40);
    for (let index = 0; index < 72; index += 1) {
      const session = `session-${String(index).padStart(3, "0")}`;
      const offset = random(180) * 60 * 60 * 1_000;
      const common = { branch: `branch-${random(7)}`, repoId: `repo-${random(3)}` };
      events.push(event(session, `goal-${index}`, offset, {
        ...common, content: { message: `Inspect issue #${random(8)} and PR #${random(9)} with token-${random(5)}` },
      }));
      events.push(event(session, `file-${index}`, offset + 1_000, {
        ...common, eventType: "file.changed", trust: "tool", content: { message: `src/file-${random(11)}.ts` },
      }));
      events.push(event(session, `test-${index}`, offset + 2_000, {
        ...common, eventType: "test.completed", trust: "tool",
        completionStatus: random(2) === 0 ? "failed" : "succeeded", content: { message: `test-signature-${random(7)}` },
      }));
      events.push(event(session, `commit-${index}`, offset + 3_000, {
        ...common, eventType: "git.commit", trust: "tool", commitSha: random(2) === 0 ? firstCommit : secondCommit,
      }));
    }
    const options = { commitAncestry: new CommitAncestryIndex([
      { repoId: "repo-0", parentCommit: firstCommit, childCommit: secondCommit },
      { repoId: "repo-1", parentCommit: firstCommit, childCommit: secondCommit },
    ]) };
    const corrections = [
      correction("merge-chain", "merge", ["session-000", "session-001", "session-002"]),
      correction("split-chain", "split", ["session-000", "session-002"]),
    ];
    const result = expectSparseEquivalent(events, corrections, options);
    expect(new WorkEpisodeBuilder({ ...options, associationMode: "sparse" }).build([...events].reverse(), corrections))
      .toEqual(result);
  });

  it("retains overlapping long sessions, custom low thresholds and zero-confidence candidates", () => {
    const hour = 60 * 60 * 1_000;
    const events = [
      event("long", "long-start", 0), event("long", "long-end", 1_000 * hour),
      event("near-end", "near", 1_024 * hour), event("overlap", "inside", 500 * hour),
      event("outside", "outside", 2_000 * hour, { content: { message: "Independent cleanup" } }),
      event("foreign", "foreign", 0, { repoId: "foreign" }),
    ];
    expectSparseEquivalent(events, [], { candidateThreshold: 0.1 });
    const zero = expectSparseEquivalent(events, [], { candidateThreshold: 0 });
    expect(zero.associations.some((association) => association.confidence === 0)).toBe(true);
  });

  it("records bounded witnesses for shared features without copying unrelated session events", () => {
    const events: CaptureEnvelope[] = [];
    for (const session of ["a", "b"]) {
      const offset = session === "a" ? 0 : 30 * 24 * 60 * 60 * 1_000;
      events.push(event(session, `${session}-goal`, offset, {
        branch: "main", content: { message: "Repair issue #42 using PR #99" },
      }));
      events.push(event(session, `${session}-file`, offset + 1_000, {
        branch: "main", eventType: "file.changed", trust: "tool", content: { message: "src/cache.ts" },
      }));
      events.push(event(session, `${session}-test`, offset + 2_000, {
        branch: "main", eventType: "test.completed", trust: "tool", content: { message: "Cache assertion failed" },
      }));
      for (let index = 0; index < 1_000; index += 1) {
        events.push(event(session, `${session}-noise-${index}`, offset + 3_000 + index, {
          branch: "main", eventType: "agent.message", trust: "model", content: { message: "Captured progress update" },
        }));
      }
    }
    const result = expectSparseEquivalent(events);
    const association = result.associations[0];
    expect(association).toBeDefined();
    const idsFor = (suffix: string) => events.filter((entry) => entry.sourceEventId.endsWith(suffix))
      .map((entry) => entry.event.eventId).sort();
    for (const [signal, suffix] of [
      ["branch", "-goal"], ["issue", "-goal"], ["pull_request", "-goal"],
      ["changed_file", "-file"], ["test_or_error", "-test"], ["task_semantics", "-goal"],
    ] as const) {
      expect(association?.evidence.find((entry) => entry.signal === signal)?.sourceEventIds).toEqual(idsFor(suffix));
    }
    expect(association?.evidence.flatMap((entry) => entry.sourceEventIds).length).toBeLessThan(20);
    expect(result.episodes.flatMap((episode) => episode.sourceEventIds)).toHaveLength(events.length);
  });

  it("builds thousands of unrelated sessions without materializing rejected pairs", () => {
    const events = Array.from({ length: 1_500 }, (_, index) => event(`session-${index}`, `goal-${index}`, index, {
      repoId: `repo-${index}`,
    }));
    const result = new WorkEpisodeBuilder({ associationMode: "sparse" }).build(events);
    expect(result.episodes).toHaveLength(events.length);
    expect(result.associations).toEqual([]);
  });

  it("omits weak shared-language suggestions while keeping their sessions in connected output", () => {
    const events = Array.from({ length: 800 }, (_, index) => event(
      `session-${index}`, `source-${index}`, index * 48 * 60 * 60 * 1_000,
      { content: { message: `Investigate independent issue ${index}` } },
    ));
    const result = new WorkEpisodeBuilder({ associationMode: "connected" }).build(events);
    expect(result.episodes).toHaveLength(events.length);
    expect(result.associations).toEqual([]);
    const small = expectSparseEquivalent(events.slice(0, 24));
    expect(small.associations).toHaveLength(24 * 23 / 2);
    expect(small.associations.every((association) => association.status === "candidate")).toBe(true);
  });

  it("retains combinations of weak signals and ancestry near the association threshold", () => {
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    const day = 24 * 60 * 60 * 1_000;
    const events = [
      event("a", "a-goal", 0, { branch: "main", content: { message: "Investigate branch continuation" } }),
      event("b", "b-goal", 30 * day, { branch: "main", content: { message: "Investigate branch continuation" } }),
      event("c", "c-goal", 60 * day, { content: { message: "Repair parser buffers" } }),
      event("c", "c-file", 60 * day + 1, { eventType: "file.changed", trust: "tool", content: { message: "src/shared.ts" } }),
      event("c", "c-commit", 60 * day + 2, { eventType: "git.commit", trust: "tool", commitSha: first }),
      event("d", "d-goal", 90 * day, { content: { message: "Validate settings compatibility" } }),
      event("d", "d-file", 90 * day + 1, { eventType: "file.changed", trust: "tool", content: { message: "src/shared.ts" } }),
      event("d", "d-commit", 90 * day + 2, { eventType: "git.commit", trust: "tool", commitSha: second }),
    ];
    const options = { commitAncestry: new CommitAncestryIndex([{ repoId: "repo-1", parentCommit: first, childCommit: second }]) };
    const result = expectSparseEquivalent(events, [], options);
    expect(result.associations.find((association) => association.leftSessionId === "a" && association.rightSessionId === "b")?.status)
      .toBe("associated");
    expect(result.associations.find((association) => association.leftSessionId === "c" && association.rightSessionId === "d")?.status)
      .toBe("associated");
    for (const associatedThreshold of [0.3, 0.55, 0.65, 0.72, 0.8, 0.85, 0.95, 1]) {
      expectSparseEquivalent(events, [], { ...options, associatedThreshold, candidateThreshold: 0.1 });
    }
  });

  it("does not prune an association for any shared-feature combination at its exact confidence", () => {
    for (let mask = 0; mask < 128; mask += 1) {
      const events: CaptureEnvelope[] = [];
      for (const [side, session] of ["left", "right"].entries()) {
        const offset = side * 3 * 24 * 60 * 60 * 1_000;
        events.push(event(session, `${session}-goal`, offset, {
          branch: (mask & 1) !== 0 ? "shared" : session,
          content: { message: (mask & 64) !== 0 ? "Shared semantic signature" : `${session}objective` },
        }));
        events.push(event(session, `${session}-commit`, offset + 1, {
          eventType: "git.commit", trust: "tool", commitSha: (mask & 2) !== 0 ? "a".repeat(40) : (side === 0 ? "b" : "c").repeat(40),
        }));
        events.push(event(session, `${session}-file`, offset + 2, {
          eventType: "file.changed", trust: "tool", content: { message: (mask & 4) !== 0 ? "src/shared.ts" : `src/${session}.ts` },
        }));
        events.push(event(session, `${session}-issue`, offset + 3, {
          eventType: "issue.linked", trust: "tool", content: { message: `issue #${(mask & 8) !== 0 ? 42 : side + 1}` },
        }));
        events.push(event(session, `${session}-pr`, offset + 4, {
          eventType: "pull_request.updated", trust: "tool", content: { message: `PR #${(mask & 16) !== 0 ? 42 : side + 1}` },
        }));
        events.push(event(session, `${session}-test`, offset + 5, {
          eventType: "test.completed", trust: "tool", content: { message: (mask & 32) !== 0 ? "shared test signature" : session },
        }));
      }
      for (const hasAncestry of [false, true]) {
        const options: WorkEpisodeBuilderOptions = hasAncestry ? { commitAncestry: { isAncestor: () => true } } : {};
        const dense = new WorkEpisodeBuilder(options).build(events);
        const confidence = dense.associations[0]?.confidence ?? 0;
        if (confidence === 0) continue;
        expectSparseEquivalent(events, [], { ...options, associatedThreshold: confidence, candidateThreshold: 0 });
      }
    }
  });

  it("uses attributable commit witnesses and resolves ancestry only with corroboration", () => {
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    const unrelated = "c".repeat(40);
    const events = [
      event("a", "task-a", 0, { content: { message: "Inspect issue #42" } }),
      event("a", "commit-a", 1, { eventType: "git.commit", trust: "tool", commitSha: first }),
      event("a", "unrelated-a", 2, { eventType: "git.commit", trust: "tool", commitSha: unrelated }),
      event("a", "workspace-commit-forged", 3, { eventType: "git.commit", trust: "tool", commitSha: second }),
      event("b", "task-b", 1_000, { content: { message: "Resolve issue #42" } }),
      event("b", "commit-b", 1_001, { eventType: "git.commit", trust: "tool", commitSha: second }),
    ];
    const result = expectSparseEquivalent(events, [], { commitAncestry: new CommitAncestryIndex([
      { repoId: "repo-1", parentCommit: first, childCommit: second },
    ]) });
    expect(result.associations[0]?.evidence.find((item) => item.signal === "commit_ancestry")?.sourceEventIds)
      .toEqual(events.filter((item) => ["commit-a", "commit-b"].includes(item.sourceEventId)).map((item) => item.event.eventId).sort());
    expect(result.associations[0]?.evidence.some((item) => item.signal === "commit")).toBe(false);
    let queries = 0;
    new WorkEpisodeBuilder({ commitAncestry: { isAncestor: () => { queries += 1; return true; } } }).build([
      events[1] as CaptureEnvelope,
      event("b", "distant-commit", 100 * 24 * 60 * 60 * 1_000, {
        eventType: "git.commit", trust: "tool", commitSha: second,
      }),
    ]);
    expect(queries).toBe(0);
  });

  it("preserves branch task boundaries when material events share a timestamp", () => {
    const events = [
      event("session", "goal-a", 0, { content: { message: "Repair the cache" } }),
      event("session", "goal-b", 0, { content: { message: "Constraint: Keep stable keys" } }),
      ...Array.from({ length: 1_000 }, (_, index) => event("session", `file-${index}`, index, {
        eventType: "file.changed", trust: "tool", content: { message: "src/cache.ts" },
      })),
    ].map((entry) => ({ ...entry, event: { ...entry.event, branch: "main", commitSha: "a".repeat(40) } }));
    const episodes = new WorkEpisodeBuilder().build(events).episodes;
    const builder = new BranchContextBuilder();
    const contexts = builder.build(events, episodes);
    expect(builder.build([...events].reverse(), episodes)).toEqual(contexts);
    expect(contexts[0]?.explicitConstraints).toEqual(["Keep stable keys"]);
    expect(contexts[0]?.sourceEventIds).toHaveLength(events.length);
  });
});
