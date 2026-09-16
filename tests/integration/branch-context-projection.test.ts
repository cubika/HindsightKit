import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BranchContextProjector,
  DeletionService,
  WorkEpisodeProjector,
} from "@provenloop/host";
import { WindowsCaptureQueue } from "@provenloop/platform-windows";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-branch-context-"),
  );
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("Branch Context projection", () => {
  it("replaces the current branch snapshot without merging two tasks at one HEAD", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), { idGenerator: () => String(++sequence) });
    await queue.initialize();
    const store = new CanonicalSqliteStore(join(root, "canonical.db"));
    try {
      const common = { adapter: "copilot-cli", adapterVersion: "1.0.82-0", branch: "main", commitSha: "a".repeat(40), repoId: "repo-1" };
      const first = await queue.enqueue({
        ...common, sourceEventId: "first-task", sessionId: "task-first", eventType: "prompt.submitted", trust: "user",
        timestamp: "2026-09-10T00:00:00.000Z", content: { message: "Inspect the identity.\nConstraint: Select resource A." },
      });
      store.ingestQueueItem(first);
      new WorkEpisodeProjector({ store }).rebuild();
      const previous = new BranchContextProjector({ store }).rebuild().contexts[0];
      const second = await queue.enqueue({
        ...common, sourceEventId: "second-task", sessionId: "task-second", eventType: "prompt.submitted", trust: "user",
        timestamp: "2026-09-10T00:05:00.000Z", content: { message: "Inspect the deployment.\nConstraint: Select resource B." },
      });
      store.ingestQueueItem(second);
      new WorkEpisodeProjector({ store }).rebuild();
      const current = new BranchContextProjector({ store }).rebuild().contexts[0];

      expect(store.branchContexts()).toHaveLength(1);
      expect(current).toMatchObject({ sourceSessionIds: ["task-second"], goalSourceEventId: second.envelope.event.eventId, explicitConstraints: ["Select resource B."] });
      expect(current?.branchContextId).not.toBe(previous?.branchContextId);
      expect(current?.sourceEventIds).not.toContain(first.envelope.event.eventId);
      expect(store.episodeSourceEnvelopes()).toHaveLength(2);

      const ended = await queue.enqueue({
        ...common, sourceEventId: "task-ended", sessionId: "task-second", eventType: "session.ended", trust: "system",
        timestamp: "2026-09-10T00:10:00.000Z",
      });
      store.ingestQueueItem(ended);
      new WorkEpisodeProjector({ store }).rebuild();
      new BranchContextProjector({ store }).rebuild();
      expect(store.branchContexts()[0]).toMatchObject({ closedAt: ended.envelope.event.timestamp, closureSourceEventIds: [ended.envelope.event.eventId] });
    } finally {
      store.close();
    }
  });

  it("builds explicit continuation state and validates retrieval scope", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => `queue-${sequence += 1}`,
    });
    await queue.initialize();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const headSha =
      "0123456789abcdef0123456789abcdef01234567";
    try {
      const items = [];
      for (const input of [
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/branch-context",
          commitSha: headSha,
          content: {
            message: [
              "Implement Branch Context projection.",
              "Decision: Persist a rebuildable projection.",
              "Constraint: Require exact repository, branch, and HEAD.",
              "Next: Wire MCP retrieval.",
            ].join("\n"),
          },
          eventType: "prompt.submitted",
          repoId: "repo-1",
          sessionId: "session-1",
          sourceEventId: "prompt-1",
          timestamp: "2026-08-30T00:00:00.000Z",
          trust: "user" as const,
        },
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/branch-context",
          commitSha: headSha,
          content: {
            message: "packages/host/src/context-projector.ts",
          },
          eventType: "file.changed",
          repoId: "repo-1",
          sessionId: "session-1",
          sourceEventId: "file-1",
          timestamp: "2026-08-30T00:05:00.000Z",
          trust: "tool" as const,
        },
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/branch-context",
          commitSha: headSha,
          completionStatus: "succeeded" as const,
          eventType: "test.completed",
          repoId: "repo-1",
          sessionId: "session-1",
          sourceEventId: "test-1",
          timestamp: "2026-08-30T00:10:00.000Z",
          trust: "tool" as const,
        },
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/branch-context",
          commitSha: headSha,
          content: {
            message: "Explain an unrelated architecture topic.",
          },
          eventType: "prompt.submitted",
          repoId: "repo-1",
          sessionId: "session-1",
          sourceEventId: "browse-after-material",
          timestamp: "2026-08-30T00:11:00.000Z",
          trust: "user" as const,
        },
      ]) {
        const item = await queue.enqueue(input);
        items.push(item);
        expect(store.ingestQueueItem(item).status).toBe("stored");
      }
      new WorkEpisodeProjector({
        store,
      }).rebuild();
      const projection = new BranchContextProjector({
        store,
      }).rebuild();

      expect(projection.persistedContexts).toBe(1);
      const context = projection.contexts[0];
      expect(context).toMatchObject({
        acceptedDecisions: [
          "Persist a rebuildable projection.",
        ],
        branch: "feat/branch-context",
        explicitConstraints: [
          "Require exact repository, branch, and HEAD.",
        ],
        goal: "Implement Branch Context projection.",
        headSha,
        recentVerificationEvidenceIds: [
          items[2]?.envelope.event.eventId,
        ],
        repoId: "repo-1",
        unfinishedItems: [
          "Wire MCP retrieval.",
        ],
        updatedAt: "2026-08-30T00:10:00.000Z",
      });
      expect(context?.implementationState).toContain(
        "test.completed: succeeded",
      );
      expect(
        context?.implementationState.some((item) =>
          item.startsWith("Files changed: "),
        ),
      ).toBe(true);
      expect(
        store.branchContextFor({
          branch: "feat/branch-context",
          headSha,
          now: new Date("2026-08-31T00:00:00.000Z"),
          repoId: "repo-1",
        }),
      ).toEqual(context);
      expect(
        store.branchContextFor({
          branch: "feat/branch-context",
          headSha: "different-head",
          repoId: "repo-1",
        }),
      ).toBeUndefined();
      expect(
        store.branchContextFor({
          branch: "feat/branch-context",
          headSha,
          now: new Date("2026-10-01T00:00:00.000Z"),
          repoId: "repo-1",
        }),
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("does not create context for a browsing-only Session", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => `queue-browse-${sequence += 1}`,
    });
    await queue.initialize();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      const item = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/browse",
        commitSha:
          "89abcdef0123456789abcdef0123456789abcdef",
        content: {
          message: "Explain the current architecture.",
        },
        eventType: "prompt.submitted",
        repoId: "repo-1",
        sessionId: "session-browse",
        sourceEventId: "browse-1",
        timestamp: "2026-08-30T00:00:00.000Z",
        trust: "user",
      });
      expect(store.ingestQueueItem(item).status).toBe("stored");
      const assistant = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/browse",
        commitSha:
          "89abcdef0123456789abcdef0123456789abcdef",
        content: {
          message: "Next: consider documenting this architecture.",
        },
        eventType: "agent.message",
        repoId: "repo-1",
        sessionId: "session-browse",
        sourceEventId: "browse-assistant",
        timestamp: "2026-08-30T00:01:00.000Z",
        trust: "model",
      });
      expect(store.ingestQueueItem(assistant).status).toBe("stored");
      new WorkEpisodeProjector({
        store,
      }).rebuild();

      expect(
        new BranchContextProjector({
          store,
        }).rebuild(),
      ).toMatchObject({
        contexts: [],
        persistedContexts: 0,
      });
      expect(store.branchContexts()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("excludes obsolete history when a branch name is reused", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => `queue-reused-${sequence += 1}`,
    });

    await queue.initialize();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const oldHead =
      "0123456789abcdef0123456789abcdef01234567";
    const newHead =
      "89abcdef0123456789abcdef0123456789abcdef";
    try {
      for (const input of [
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/reused",
          commitSha: oldHead,
          content: {
            message: "Decision: Keep the obsolete implementation.",
          },
          eventType: "prompt.submitted",
          repoId: "repo-1",
          sessionId: "session-old",
          sourceEventId: "old-prompt",
          timestamp: "2026-06-01T00:00:00.000Z",
          trust: "user" as const,
        },
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/reused",
          commitSha: oldHead,
          eventType: "file.changed",
          repoId: "repo-1",
          sessionId: "session-old",
          sourceEventId: "old-file",
          timestamp: "2026-06-01T00:01:00.000Z",
          trust: "tool" as const,
        },
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/reused",
          commitSha: newHead,
          content: {
            message: "Decision: Use the new branch implementation.",
          },
          eventType: "prompt.submitted",
          repoId: "repo-1",
          sessionId: "session-new",
          sourceEventId: "new-prompt",
          timestamp: "2026-08-30T00:00:00.000Z",
          trust: "user" as const,
        },
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/reused",
          commitSha: newHead,
          eventType: "file.changed",
          repoId: "repo-1",
          sessionId: "session-new",
          sourceEventId: "new-file",
          timestamp: "2026-08-30T00:01:00.000Z",
          trust: "tool" as const,
        },
      ]) {
        const item = await queue.enqueue(input);
        expect(store.ingestQueueItem(item).status).toBe("stored");
      }
      new WorkEpisodeProjector({
        store,
      }).rebuild();
      const contexts = new BranchContextProjector({
        store,
      }).rebuild().contexts;

      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({
        acceptedDecisions: [
          "Use the new branch implementation.",
        ],
        headSha: newHead,
      });
      expect(contexts[0]?.acceptedDecisions).not.toContain(
        "Keep the obsolete implementation.",
      );
    } finally {
      store.close();
    }
  });

  it("does not refresh expired history at the same HEAD", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => `queue-expiry-${sequence += 1}`,
    });
    await queue.initialize();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const headSha =
      "23456789abcdef0123456789abcdef0123456789";
    try {
      for (const input of [
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/long-lived",
          commitSha: headSha,
          content: {
            message: "Decision: Retain the expired decision.",
          },
          eventType: "prompt.submitted",
          repoId: "repo-1",
          sessionId: "session-expired",
          sourceEventId: "expired-prompt",
          timestamp: "2026-05-01T00:00:00.000Z",
          trust: "user" as const,
        },
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/long-lived",
          commitSha: headSha,
          eventType: "file.changed",
          repoId: "repo-1",
          sessionId: "session-expired",
          sourceEventId: "expired-file",
          timestamp: "2026-05-01T00:01:00.000Z",
          trust: "tool" as const,
        },
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/long-lived",
          commitSha: headSha,
          content: {
            message: "Decision: Keep only current context.",
          },
          eventType: "prompt.submitted",
          repoId: "repo-1",
          sessionId: "session-current",
          sourceEventId: "current-prompt",
          timestamp: "2026-08-30T00:00:00.000Z",
          trust: "user" as const,
        },
        {
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/long-lived",
          commitSha: headSha,
          eventType: "file.changed",
          repoId: "repo-1",
          sessionId: "session-current",
          sourceEventId: "current-file",
          timestamp: "2026-08-30T00:01:00.000Z",
          trust: "tool" as const,
        },
      ]) {
        const item = await queue.enqueue(input);
        expect(store.ingestQueueItem(item).status).toBe("stored");
      }
      new WorkEpisodeProjector({
        store,
      }).rebuild();
      const context = new BranchContextProjector({
        store,
      }).rebuild().contexts[0];

      expect(context?.acceptedDecisions).toEqual([
        "Keep only current context.",
      ]);
      expect(context?.acceptedDecisions).not.toContain(
        "Retain the expired decision.",
      );
    } finally {
      store.close();
    }
  });

  it("allows a rebuilt context to reuse its projection ID after source deletion", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => `queue-delete-${sequence += 1}`,
    });
    await queue.initialize();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const headSha =
      "abcdef0123456789abcdef0123456789abcdef01";
    try {
      const prompt = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/delete-context-source",
        commitSha: headSha,
        content: {
          message: "Decision: Keep a short-lived Branch Context.",
        },
        eventType: "prompt.submitted",
        repoId: "repo-1",
        sessionId: "session-delete-context",
        sourceEventId: "delete-context-prompt",
        timestamp: "2026-08-30T00:00:00.000Z",
        trust: "user",
      });
      const changed = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/delete-context-source",
        commitSha: headSha,
        eventType: "file.changed",
        repoId: "repo-1",
        sessionId: "session-delete-context",
        sourceEventId: "delete-context-file",
        timestamp: "2026-08-30T00:01:00.000Z",
        trust: "tool",
      });
      for (const item of [
        prompt,
        changed,
      ]) {
        expect(store.ingestQueueItem(item).status).toBe("stored");
      }
      new WorkEpisodeProjector({
        store,
      }).rebuild();
      const original = new BranchContextProjector({
        store,
      }).rebuild().contexts[0];
      if (original === undefined) {
        throw new Error("Expected a Branch Context.");
      }

      const result = await new DeletionService({
        queue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-context-source",
        targetId: changed.envelope.event.eventId,
        targetType: "source",
      });

      expect(result.gate.status).toBe("pass");
      expect(store.branchContexts()[0]?.branchContextId).toBe(
        original.branchContextId,
      );
      expect(() =>
        store.replaceBranchContextProjection({
          contexts: [
            original,
          ],
        }),
      ).toThrow("contains a deleted identity");
    } finally {
      store.close();
    }
  });
});
