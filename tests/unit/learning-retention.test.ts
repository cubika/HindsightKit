import { describe, expect, it } from "vitest";
import type { CaptureEnvelope, RuleProposalInput } from "@provenloop/contracts";
import { assessLearningRetention, buildLearningWindows, createCaptureEnvelope, validateLearningResponse } from "@provenloop/domain";

const needed = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Expected fixture value.");
  return value;
};

const scope = { repoId: "repo", worktree: "C:/repos/project" };
const fixture = (message: string, result = "The cache must be scoped to the workspace because configuration changes between projects.") => {
  const shared = { adapter: "copilot-cli", adapterVersion: "1.0.84-1", sessionId: "task", ...scope, repositoryState: "known_repo" as const };
  const user = createCaptureEnvelope({ ...shared, sourceEventId: "user", eventType: "prompt.submitted", trust: "user",
    timestamp: "2026-09-10T00:00:00Z", content: { message } });
  const tool = createCaptureEnvelope({ ...shared, sourceEventId: "result", eventType: "tool.completed", trust: "tool",
    timestamp: "2026-09-10T00:00:01Z", content: { toolResult: result } });
  const closed = createCaptureEnvelope({ ...shared, sourceEventId: "closed", eventType: "agent.turn_completed", trust: "model", timestamp: "2026-09-10T00:00:02Z" });
  return { user, tool, events: [user, tool, closed], window: needed(buildLearningWindows([user, tool, closed], new Date("2026-09-10T00:00:10Z"))[0]) };
};
const proposal = (user: CaptureEnvelope, tool?: CaptureEnvelope): RuleProposalInput => ({
  rule: "Scope the cache to the workspace.", trigger: "Implementing a cache for repository configuration", exclusions: ["Other kinds of cache"],
  userSource: { eventId: user.event.eventId, quote: needed(user.content?.message) },
  retention: { kind: tool ? "reference" : "convention", lifetime: "durable", rationale: "This prevents cached configuration from leaking between projects.",
    futureUse: "When implementing another configuration cache in this repository.", targetRepository: { status: "captured", repoId: scope.repoId } },
  supportingSources: [{ eventId: (tool ?? user).event.eventId, quote: tool ? String(tool.content?.toolResult) : needed(user.content?.message) }],
  canonicalKey: "workspace scoped configuration cache",
});

describe("retention before persistence", () => {
  it.each([
    "Change the default model to gpt6.", "把默认模型改成 gpt6。",
    "Make these edits without committing.", "这次文档改完不要提交。",
    "嗯，删掉", "Remove the SDM qualifier from the agency review name.", "把 agency review 的 SDM 前缀去掉。",
    "For this deployment use sdmc-dev-ev2-deployment instead of sdmc-dev-msi.",
    "当前分支使用 sdmc-dev-ev2-deployment，不是 sdmc-dev-msi。",
    "修改默认的 model 为 gpt6",
    "你都改下，然后不要 commit",
    "嗯，删除一下",
    "另外 “SDM agency review” 感觉可以不用提 “SDM”，这个是整个 repo 公用的",
  ])("does not retain a task request mislabeled durable: %s", (message) => {
    const f = fixture(message);
    const output = { schemaVersion: 1, proposals: [proposal(f.user, f.tool)] };
    expect(validateLearningResponse(f.window, output).proposals).toEqual([]);
  });

  it.each(["For future reviews, always use the repository review checklist.", "以后每次审查都使用仓库的审查清单。", "以后每次未经要求不要 commit"])("retains a sourced lasting convention: %s", (message) => {
    const f = fixture(message);
    expect(assessLearningRetention(proposal(f.user), f.events, scope)).toMatchObject({ retain: true, reusable: true, kind: "convention" });
  });

  it("permits a narrow reference supported by an actual requirement", () => {
    const f = fixture("Investigate how repository configuration is cached.");
    expect(assessLearningRetention(proposal(f.user, f.tool), f.events, scope)).toMatchObject({ retain: true, reusable: true, kind: "reference" });
  });

  it("requires source support rather than a rationale invented by the extractor", () => {
    const f = fixture("Investigate the configuration.", "model = gpt6");
    expect(assessLearningRetention(proposal(f.user, f.tool), f.events, scope)).toMatchObject({ retain: false, reason: "missing_reusable_finding" });
    const invented = proposal(f.user, f.tool);
    invented.supportingSources = [{ eventId: f.tool.event.eventId, quote: "An unseen source requires this." }];
    expect(assessLearningRetention(invented, f.events, scope)).toMatchObject({ retain: false, reason: "invalid_support" });
  });

  it("rejects unknown targets and observed operations outside the captured repository", () => {
    const f = fixture("For future reviews, always use the review checklist.");
    const target = proposal(f.user);
    needed(target.retention).targetRepository = { status: "unresolved" };
    expect(assessLearningRetention(target, f.events, scope).reason).toBe("scope_unresolved");
    for (const args of [{ cwd: "C:/repos/other" }, { filePath: "C:/repos/other/main.ts" }, { command: "dotnet test C:/repos/other/tests.csproj" },
      { cwd: "../other" }, { filePath: "../other/main.ts" }, { command: "dotnet test ../other/tests.csproj" }]) {
      const operation = { ...f.tool, event: { ...f.tool.event, redactedArguments: args } };
      expect(assessLearningRetention(proposal(f.user), [f.user, operation], scope)).toMatchObject({ retain: false, reason: "cross_repository_target" });
    }
  });

  it("uses the full source message to prevent cropped task or scope claims", () => {
    const f = fixture("For this task in C:/repos/other, always use the review checklist.");
    const cropped = proposal(f.user);
    needed(cropped.userSource).quote = "always use the review checklist";
    needed(cropped.supportingSources?.[0]).quote = "always use the review checklist";
    expect(assessLearningRetention(cropped, f.events, scope)).toMatchObject({ retain: false });
  });

  it("leaves legacy untyped proposals inspectable without granting reuse", () => {
    const f = fixture("Use a workspace cache.");
    const legacy = proposal(f.user);
    delete legacy.retention; delete legacy.supportingSources; delete legacy.canonicalKey;
    expect(assessLearningRetention(legacy, f.events, scope)).toEqual({ retain: true, reusable: false, reason: "legacy_unreviewed" });
    expect(validateLearningResponse(f.window, { schemaVersion: 1, proposals: [legacy] }).proposals).toHaveLength(1);
  });

  it.each([
    "An example of a rule to reject is: Always record customer names in diagnostic output. Explain why this is unsuitable.",
    "Suppose the convention were: always log customer names. Discuss whether that is acceptable.",
    "下面是一个应该拒绝的示例：以后每次都记录客户姓名。解释为什么不应采纳。",
  ])("does not turn quoted or hypothetical instructions into conventions: %s", (message) => {
    const f = fixture(message);
    expect(assessLearningRetention(proposal(f.user), f.events, scope)).toMatchObject({ retain: false, reason: "unasserted_convention" });
  });

  it("resolves operation-relative paths against the effective cwd on both platforms", () => {
    const f = fixture("For future reviews, always use the review checklist.");
    const nested = { ...f.tool, event: { ...f.tool.event, redactedArguments: { cwd: "C:/repos/project/src", path: "../../other/main.ts" } } };
    expect(assessLearningRetention(proposal(f.user), [f.user, nested], scope).reason).toBe("cross_repository_target");
    const linuxScope = { repoId: "repo", worktree: "/repos/project" };
    const linuxUser = { ...f.user, event: { ...f.user.event, worktree: linuxScope.worktree } };
    const linuxTool = { ...f.tool, event: { ...f.tool.event, worktree: linuxScope.worktree, redactedArguments: { cwd: "/repos/project/src", path: "../../other/main.ts" } } };
    expect(assessLearningRetention(proposal(linuxUser), [linuxUser, linuxTool], linuxScope).reason).toBe("cross_repository_target");
    linuxTool.event.redactedArguments = { cwd: "/repos/project", path: "/repos/other/main.ts" };
    expect(assessLearningRetention(proposal(linuxUser), [linuxUser, linuxTool], linuxScope).reason).toBe("cross_repository_target");
  });
});
