import { describe, expect, it } from "vitest";
import {
  BranchContextBuilder,
  createCaptureEnvelope,
  WorkEpisodeBuilder,
  type CaptureEventInput,
} from "@provenloop/domain";

const event = (
  sourceEventId: string,
  eventType: string,
  extra: Partial<CaptureEventInput> = {},
) => createCaptureEnvelope({
  adapter: "copilot-cli",
  adapterVersion: "1.0.82-0",
  branch: "main",
  commitSha: "a".repeat(40),
  eventType,
  repoId: "repo-1",
  sessionId: "session-1",
  sourceEventId,
  timestamp: "2026-09-01T00:00:00.000Z",
  trust: "tool",
  worktree: "C:\\repo",
  ...extra,
});

const project = (events: ReturnType<typeof event>[]) =>
  new BranchContextBuilder().build(
    events,
    new WorkEpisodeBuilder().build(events).episodes,
  );

describe("BranchContextBuilder material evidence", () => {
  it("does not turn HEAD observations or legacy workspace snapshots into work", () => {
    const observations = [
      event("head", "git.head_changed"),
      event("workspace-commit-legacy", "git.commit"),
    ];
    expect(project(observations)).toEqual([]);
    expect(new WorkEpisodeBuilder().build(observations).episodes).toEqual([]);
  });

  it("ignores model-authored changes and verification claims", () => {
    expect(project([
      event("model-change", "file.changed", {
        content: { message: "src\\account.ts" },
        trust: "model",
      }),
      event("model-test", "verification.completed", {
        completionStatus: "succeeded",
        trust: "model",
      }),
    ])).toEqual([]);
  });

  it("shows actual changed files and failed verification without inventing success", () => {
    const prompt = event("prompt", "prompt.submitted", {
      content: { message: "修复账号日志\nNext: 检查回归结果" },
      trust: "user",
    });
    const changed = event("change", "file.changed", {
      content: { message: "src\\account.ts" },
      timestamp: "2026-09-01T00:01:00.000Z",
    });
    const verification = event("verification", "verification.completed", {
      completionStatus: "succeeded",
      exitCode: 1,
      timestamp: "2026-09-01T00:02:00.000Z",
    });
    const [context] = project([prompt, changed, verification]);
    expect(context).toMatchObject({
      goal: "修复账号日志",
      implementationState: [
        "Files changed: src\\account.ts",
        "verification.completed: failed",
      ],
      recentVerificationEvidenceIds: [verification.event.eventId],
      unfinishedItems: ["检查回归结果"],
    });
    expect(new WorkEpisodeBuilder().build([prompt, changed, verification]).episodes[0])
      .toMatchObject({ outcome: "failure", outcomeQualification: "qualified" });
  });

  it("does not call ordinary tool completion a successful outcome", () => {
    const input = [event("tool", "tool.completed", {
      completionStatus: "succeeded",
      toolName: "read_file",
      content: { toolResult: { text: "The implementation uses a timeout of 30 seconds." } },
    })];
    expect(project(input)).toEqual([]);
    expect(new WorkEpisodeBuilder().build(input).episodes[0])
      .toMatchObject({ outcome: "unknown", outcomeQualification: "open" });
  });

  it("keeps a cancelled latest verification unknown rather than reusing an older success", () => {
    const input = [
      event("success", "test.completed", { completionStatus: "succeeded" }),
      event("cancelled", "test.completed", {
        completionStatus: "cancelled",
        exitCode: 1,
        timestamp: "2026-09-01T00:01:00.000Z",
      }),
    ];
    expect(new WorkEpisodeBuilder().build(input).episodes[0])
      .toMatchObject({ outcome: "unknown", outcomeQualification: "open" });
    expect(project(input)[0]?.implementationState).toContain("test.completed: unknown");
  });

  it("isolates temporary constraints between sessions sharing branch and HEAD", () => {
    const oldTask = event("old-task", "prompt.submitted", {
      sessionId: "task-old", trust: "user", content: { message: "Inspect the managed identity.\nConstraint: Use resource A only." },
    });
    const newTask = event("new-task", "prompt.submitted", {
      sessionId: "task-new", trust: "user", timestamp: "2026-09-01T00:05:00.000Z",
      content: { message: "Inspect the deployment.\nConstraint: Use resource B for this deployment." },
    });
    const [context] = project([oldTask, newTask]);

    expect(context).toMatchObject({
      sourceSessionIds: ["task-new"], goalSourceEventId: newTask.event.eventId,
      goal: "Inspect the deployment.", explicitConstraints: ["Use resource B for this deployment."],
    });
    expect(context?.sourceEventIds).not.toContain(oldTask.event.eventId);
  });

  it("does not keep earlier constraints after a new material task in one session", () => {
    const oldTask = event("old", "prompt.submitted", {
      trust: "user", content: { message: "Inspect resource A.\nConstraint: Do not change files." },
    });
    const newTask = event("new", "prompt.submitted", {
      trust: "user", timestamp: "2026-09-01T00:05:00.000Z",
      content: { message: "Implement the configuration update.\nConstraint: Keep existing keys." },
    });
    const [context] = project([oldTask, newTask]);

    expect(context?.goalSourceEventId).toBe(newTask.event.eventId);
    expect(context?.branchContextId).not.toBe(project([oldTask])[0]?.branchContextId);
    expect(context?.explicitConstraints).toEqual(["Keep existing keys."]);
    expect(context?.sourceEventIds).not.toContain(oldTask.event.eventId);
  });

  it("keeps label-only follow-ups with their latest real task anchor", () => {
    const task = event("task", "prompt.submitted", {
      trust: "user", content: { message: "Inspect the deployment.\nConstraint: Read-only inspection." },
    });
    const followup = event("next", "prompt.submitted", {
      trust: "user", timestamp: "2026-09-01T00:05:00.000Z", content: { message: "Next: Check tenant permissions." },
    });
    expect(project([task, followup])[0]).toMatchObject({
      goalSourceEventId: task.event.eventId,
      explicitConstraints: ["Read-only inspection."], unfinishedItems: ["Check tenant permissions."],
    });
  });

  it("records explicit closure and removes it when work resumes", () => {
    const task = event("task", "prompt.submitted", {
      trust: "user", content: { message: "Inspect the deployment.\nNext: Check tenant permissions." },
    });
    const ended = event("end", "session.ended", { trust: "system", timestamp: "2026-09-01T00:05:00.000Z" });
    expect(project([task, ended])[0]).toMatchObject({
      closedAt: ended.event.timestamp, closureSourceEventIds: [ended.event.eventId], sourceSessionIds: ["session-1"],
    });
    const resumed = event("resume", "prompt.submitted", {
      trust: "user", timestamp: "2026-09-01T00:10:00.000Z", content: { message: "Continue" },
    });
    expect(project([task, ended, resumed])[0]?.closedAt).toBeUndefined();
  });

  it("marks a stored task snapshot superseded when a new question starts", () => {
    const task = event("task", "prompt.submitted", {
      trust: "user", content: { message: "Inspect the deployment.\nConstraint: Read-only inspection." },
    });
    const newTask = event("new", "prompt.submitted", {
      trust: "user", timestamp: "2026-09-01T00:05:00.000Z", content: { message: "Explain the caching architecture." },
    });
    expect(project([task, newTask])[0]).toMatchObject({
      goalSourceEventId: task.event.eventId, supersededAt: newTask.event.timestamp,
      supersedingSourceEventId: newTask.event.eventId,
    });
  });
});
