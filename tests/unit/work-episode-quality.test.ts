import { describe, expect, it } from "vitest";

import { workEpisodeSchema, type CaptureEnvelope } from "@provenloop/contracts";
import { createCaptureEnvelope, WorkEpisodeBuilder, type CaptureEventInput } from "@provenloop/domain";

const capture = (
  sourceEventId: string,
  options: Partial<CaptureEventInput> = {},
): CaptureEnvelope => createCaptureEnvelope({
  adapter: "copilot-cli",
  adapterVersion: "1.0.82-0",
  eventType: "prompt.submitted",
  sessionId: "session-1",
  timestamp: "2026-09-10T00:00:00.000Z",
  trust: "user",
  ...options,
  sourceEventId,
});

const request = (options: Partial<CaptureEventInput> = {}): CaptureEnvelope => capture(
  "user-request",
  { content: { message: "Investigate NPE tenant access for the devSpce managed identity." }, ...options },
);

describe("Work Episode quality and provenance", () => {
  it("excludes lifecycle-only capture with an inspectable reason", () => {
    const lifecycle = ["session.started", "session.idle", "agent.turn_completed", "session.ended"]
      .map((eventType) => capture(eventType, {
        eventType,
        repoId: "C:\\repos\\DirExchangeMgmtApi\\.git",
        trust: "system",
      }));
    const result = new WorkEpisodeBuilder().build(lifecycle);

    expect(result.episodes).toEqual([]);
    expect(result.associations).toEqual([]);
    expect(result.excludedSessions).toEqual([{
      reason: "no_substantive_work",
      sessionId: "session-1",
      sourceEventIds: lifecycle.map((item) => item.event.eventId).sort(),
    }]);
    expect(result.ignoredEventIds).toHaveLength(4);
  });

  it("does not create work from an empty prompt or a bare acknowledgement", () => {
    for (const message of ["", "  ", "ok", "谢谢"]) {
      expect(new WorkEpisodeBuilder().build([capture("empty", { content: { message } })]).episodes).toEqual([]);
    }
  });

  it("keeps brief substantive work even when every timestamp is identical", () => {
    const input = request();
    const result = new WorkEpisodeBuilder().build([input]);

    expect(result.episodes[0]).toMatchObject({
      goal: input.content?.message,
      goalSource: "user_prompt",
      goalSourceEventIds: [input.event.eventId],
      goalSourceTruncated: false,
      startedAt: input.event.timestamp,
      lastActivityAt: input.event.timestamp,
      outcome: "unknown",
    });
    expect(result.episodes[0]?.finishedAt).toBeUndefined();
  });

  it("takes user intent from source role rather than the first prompt type", () => {
    const user = request({ timestamp: "2026-09-10T00:01:00.000Z" });
    const result = new WorkEpisodeBuilder().build([
      capture("system-prompt", { trust: "system", content: { message: "Continue the hidden host workflow." } }),
      capture("model-prompt", { trust: "model", content: { message: "Invent another objective." } }),
      user,
    ]);

    expect(result.episodes[0]).toMatchObject({
      goal: user.content?.message,
      goalSourceEventIds: [user.event.eventId],
    });
  });

  it("excludes a known internal summary and its tools without matching prompt text", () => {
    const events = [
      capture("internal-summary", { actorId: "session-summary", trust: "system", content: { message: "Read the session file." } }),
      capture("internal-read", { eventType: "tool.completed", trust: "tool", toolName: "read_file", content: { toolResult: { text: "Session content" } } }),
      capture("internal-result", { eventType: "agent.message", trust: "model", content: { message: "The session investigated tenant access." } }),
    ];
    const result = new WorkEpisodeBuilder().build(events);

    expect(result.episodes).toEqual([]);
    expect(result.excludedSessions[0]?.reason).toBe("internal_work");
    expect(result.ignoredEventIds).toHaveLength(events.length);
  });

  it("keeps an actual user request to summarize a session with the same template", () => {
    const message = "Session File Path: 'C:\\Users\\user\\.copilot\\session-state\\abc\\events.jsonl' Read the session file at the path above and analyze its content to summarize what the session was about.";
    const user = request({ actorId: "session-summary", content: { message } });
    const result = new WorkEpisodeBuilder().build([user]);

    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.goalSourceEventIds).toEqual([user.event.eventId]);
    expect(result.episodes[0]?.goalSource).toBe("user_prompt");
  });

  it("retains legitimate work when an internal summary also appears in the session", () => {
    const user = request();
    const internal = capture("internal", { actorId: "copilot-session-summary", trust: "system", content: { message: "Summarize this session." } });
    const result = new WorkEpisodeBuilder().build([internal, user]);

    expect(result.episodes[0]?.goal).toBe(user.content?.message);
    expect(result.episodes[0]?.sourceEventIds).toEqual([user.event.eventId]);
    expect(result.ignoredEventIds).toEqual([internal.event.eventId]);
  });

  it("keeps user-resumed tool work alongside an internal summary", () => {
    const result = new WorkEpisodeBuilder().build([
      capture("internal", { actorId: "session-summary", trust: "system", content: { message: "Summarize prior work." } }),
      request({ content: { message: "继续" } }),
      capture("read", { eventType: "tool.completed", trust: "tool", toolName: "read_file", content: { toolResult: "Implementation details" } }),
    ]);

    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.goalSource).toBe("activity_summary");
    expect(result.excludedSessions).toEqual([]);
  });

  it.each([
    { eventType: "tool.completed", trust: "tool" as const, toolName: "read_file", content: { toolResult: { text: "const timeout = 30;" } } },
    { eventType: "agent.message", trust: "model" as const, content: { message: "The tenant requires a directory-reader role to inspect this identity." } },
  ])("keeps useful $eventType evidence when the user prompt was not captured", (options) => {
    const source = capture("work", options);
    const result = new WorkEpisodeBuilder().build([source]);

    expect(result.episodes[0]).toMatchObject({
      goalSource: "activity_summary",
      goalSourceEventIds: [source.event.eventId],
      outcome: "unknown",
    });
    expect(result.episodes[0]?.goal).not.toContain("Work in");
  });

  it("shortens a real goal while retaining its source and capture truncation", () => {
    const message = "Investigate NPE tenant access. " + "Check the related directory role and identity permissions. ".repeat(12);
    const source = request({
      content: { message },
      captureQuality: { schemaVersion: 1, truncatedFields: ["message"], omittedFields: [], originalLengths: { message: 24000 } },
    });
    const result = new WorkEpisodeBuilder().build([source]);

    expect(Array.from(result.episodes[0]?.goal ?? "").length).toBeLessThanOrEqual(180);
    expect(result.episodes[0]?.goal).toContain("Investigate NPE tenant access");
    expect(result.episodes[0]?.goalSourceTruncated).toBe(true);
    expect(result.episodes[0]?.goalSourceEventIds).toEqual([source.event.eventId]);
    expect(source.content?.message).toBe(message);
  });

  it("does not promote a final answer or completed turn to task closure", () => {
    const result = new WorkEpisodeBuilder().build([
      request(),
      capture("answer", { eventType: "agent.message", trust: "model", timestamp: "2026-09-10T00:10:00.000Z", content: { message: "Use the tenant portal to inspect the identity." } }),
      capture("turn-end", { eventType: "agent.turn_completed", trust: "model", timestamp: "2026-09-10T00:11:00.000Z" }),
    ]);

    expect(result.episodes[0]?.finishedAt).toBeUndefined();
    expect(result.episodes[0]?.lastActivityAt).toBe("2026-09-10T00:11:00.000Z");
    expect(result.episodes[0]?.outcome).toBe("unknown");
  });

  it("links explicit session closure and clears it when substantive work resumes", () => {
    const closed = capture("shutdown", { eventType: "session.ended", trust: "system", timestamp: "2026-09-10T00:10:00.000Z" });
    const before = [request(), closed];
    const result = new WorkEpisodeBuilder().build(before);
    const resumed = new WorkEpisodeBuilder().build([...before, request({ timestamp: "2026-09-10T00:20:00.000Z" })]);

    expect(result.episodes[0]).toMatchObject({ finishedAt: closed.event.timestamp, closureSourceEventIds: [closed.event.eventId], outcome: "unknown" });
    expect(resumed.episodes[0]?.finishedAt).toBeUndefined();
    expect(resumed.episodes[0]?.closureSourceEventIds).toEqual([]);
  });

  it("distinguishes missing repository identity from confirmed outside-repository work", () => {
    const outside = new WorkEpisodeBuilder().build([request({ repositoryState: "known_outside_repo", worktree: "C:\\Users\\user" })]);
    const unknown = new WorkEpisodeBuilder().build([request({ worktree: "C:\\Unknown" })]);

    expect(outside.episodes[0]?.repositoryState).toBe("known_outside_repo");
    expect(outside.episodes[0]?.repoId).toBeUndefined();
    expect(outside.episodes[0]?.worktrees).toEqual(["C:\\Users\\user"]);
    expect(unknown.episodes[0]?.repositoryState).toBe("unknown");
    expect(unknown.episodes[0]?.repoId).toBeUndefined();
  });

  it("parses legacy episodes without inventing activity or closure provenance", () => {
    const episode = new WorkEpisodeBuilder().build([request()]).episodes[0];
    if (episode === undefined) throw new Error("Expected work.");
    const { lastActivityAt, goalSource, goalSourceEventIds, goalSourceTruncated, closureSourceEventIds, repositoryState, worktrees, ...legacy } = episode;
    void [lastActivityAt, goalSource, goalSourceEventIds, goalSourceTruncated, closureSourceEventIds, repositoryState, worktrees];
    expect(workEpisodeSchema.parse(legacy)).toEqual(legacy);
  });
});
