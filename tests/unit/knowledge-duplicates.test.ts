import { describe, expect, it } from "vitest";
import { knowledgeCandidateSchema, type RuleProposal } from "@provenloop/contracts";
import { capturedRepositoryAliases, createCaptureEnvelope, suggestKnowledgeDuplicates } from "@provenloop/domain";

const record = (knowledgeId: string, content: string, scopeId = "repo") => knowledgeCandidateSchema.parse({
  schemaVersion: 1, knowledgeId, content, scope: "repository", scopeId, appliesWhen: ["Code review"], nonApplicability: [],
  conflictsWith: [], sourceEpisodeIds: [], sourceEvidenceIds: [], createdAt: "2026-09-10T00:00:00.000Z",
  evidenceMarks: [], evidenceTier: "inferred", state: "candidate", kind: "semantic", importance: 0, topicKey: "review",
  utility: { applied: 0, helpful: 0, harmful: 0 }, coverage: { applicableOpportunities: 0, observedOutcomes: 0 },
});
describe("knowledge duplicate suggestions", () => {
  it("recognizes captured identity aliases without equating different worktrees or sessions", () => {
    const event = (repoId: string, sessionId = "same-session", worktree = "C:/repo") => createCaptureEnvelope({
      adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: repoId, repoId, sessionId, worktree,
      branch: "main", commitSha: "a".repeat(40), repositoryState: "known_repo",
      eventType: "prompt.submitted", trust: "user", timestamp: "2026-09-10T00:00:00.000Z",
    });
    const events = [event("C:/repo/.git"), event("Org/Project/Repo"), event("unrelated", "other-session"), event("other-root", "same-session", "C:/other")];
    const aliases = capturedRepositoryAliases("C:/repo/.git", events);
    expect(aliases).toEqual(["Org/Project/Repo"]);
    const first = record("one", "For code review use GPT-5.6 rather than GPT-5.4.", "C:/repo/.git");
    const second = record("two", "代码审查使用 GPT-5.6，不使用 GPT-5.4。", "Org/Project/Repo");
    expect(suggestKnowledgeDuplicates(first, [second], [], aliases)).toHaveLength(1);
    expect(suggestKnowledgeDuplicates(first, [second], [])).toEqual([]);
  });
  it("flags equivalent model choices across languages only within the same scope", () => {
    const first = record("one", "For code reviews use GPT-5.6 rather than GPT-5.4.");
    const second = record("two", "代码审查使用 GPT-5.6，不使用 GPT-5.4。");
    const other = record("other", second.content, "different-repo");
    expect(suggestKnowledgeDuplicates(first, [first, second, other], [])).toEqual([{ knowledgeId: "two", reason: "same_model_choice" }]);
    expect(first.state).toBe("candidate");
    expect(second.sourceEvidenceIds).toEqual([]);
  });
  it("keeps opposite preferences and archived records out of suggestions", () => {
    const first = record("one", "For code review use GPT-5.6 rather than GPT-5.4.");
    const opposite = record("two", "代码审查使用 GPT-5.4，不使用 GPT-5.6。");
    expect(suggestKnowledgeDuplicates(first, [opposite, { ...first, knowledgeId: "old", state: "archived" }], [])).toEqual([]);
  });
  it("uses a shared extracted concept only as a review hint", () => {
    const first = record("one", "Cache keys include the revision.");
    const second = record("two", "缓存键应包含版本信息。");
    const proposals = [first, second].map((item) => ({ knowledgeId: item.knowledgeId, canonicalKey: "cache revision key" })) as RuleProposal[];
    expect(suggestKnowledgeDuplicates(first, [second], proposals)).toEqual([{ knowledgeId: "two", reason: "same_concept" }]);
  });
});
