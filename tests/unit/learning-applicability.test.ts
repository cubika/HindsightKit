import { describe, expect, it } from "vitest";
import type { KnowledgeCandidate, RuleProposal, ShellRecoveryReceipt } from "@provenloop/contracts";
import { learningApplicable } from "../../packages/retrieval/src/learning-applicability.js";

const candidate = { knowledgeId: "learning-knowledge-example", scope: "repository", scopeId: "repo",
  sourceEvidenceIds: ["source"], content: "Supply the required path argument when calling files/read." } as KnowledgeCandidate;
const proposal = { knowledgeId: candidate.knowledgeId, sourceDigests: [{ eventId: "source", digest: "c".repeat(64) }], predicate: { kind: "required_argument",
  serverName: "files", toolName: "read", argument: "path", contractDigest: "a".repeat(64) } } as RuleProposal;
const query = { limit: 3, text: "files read path", repositoryScopeId: "repo",
  toolInvocation: { serverName: "files", toolName: "read", contractDigest: "a".repeat(64) } };

describe("automatic learning applicability", () => {
  it("requires the exact native test invocation, workspace and revision", () => {
    const shellPredicate = { kind: "repository_test_command" as const, toolName: "powershell" as const,
      failedCommand: "npm test", command: "npm run test:unit" };
    const shellProposal = { ...proposal, predicate: undefined, proposalId: "shell-proposal", shellPredicate };
    const receipt = { proves: "repository_test_command", proposalId: "shell-proposal", predicate: shellPredicate,
      repoId: "repo", worktree: "C:/repo", branch: "main", commitSha: "f".repeat(40) } as ShellRecoveryReceipt;
    const shellInvocation = { toolName: "powershell" as const, command: "npm test", cwd: "C:/repo", branch: "main", commitSha: "f".repeat(40) };
    const shellQuery = { limit: 3, text: "npm test", repositoryScopeId: "repo", shellInvocation };
    expect(learningApplicable(candidate, [shellProposal], shellQuery, [receipt])).toBe(true);
    for (const change of [
      { commitSha: "e".repeat(40) }, { branch: "other" }, { cwd: "C:/other" },
      { command: "npm run deploy" }, { command: "npm test; echo extra" },
    ]) expect(learningApplicable(candidate, [shellProposal], { ...shellQuery, shellInvocation: { ...shellInvocation, ...change } }, [receipt])).toBe(false);
    expect(learningApplicable(candidate, [shellProposal], shellQuery, [])).toBe(false);
    expect(learningApplicable(candidate, [shellProposal], { limit: 3, text: "npm test", repositoryScopeId: "repo" }, [receipt])).toBe(false);
  });
  it("requires observed exact tool and contract identity before ranking", () => {
    expect(learningApplicable(candidate, [proposal], query)).toBe(true);
    expect(learningApplicable(candidate, [proposal], { limit: 3, text: query.text, repositoryScopeId: "repo" })).toBe(false);
    for (const toolInvocation of [
      { ...query.toolInvocation, toolName: "write" },
      { ...query.toolInvocation, serverName: "other" },
      { ...query.toolInvocation, contractDigest: "b".repeat(64) },
    ]) expect(learningApplicable(candidate, [proposal], { ...query, toolInvocation })).toBe(false);
  });
  it("blocks missing provenance and cross-repository use", () => {
    expect(learningApplicable(candidate, [], query)).toBe(false);
    expect(learningApplicable(candidate, [{ ...proposal, sourceDigests: [] }], query)).toBe(false);
    expect(learningApplicable(candidate, [proposal], { ...query, repositoryScopeId: "other" })).toBe(false);
  });
  it("suppresses guidance actually observed in project instructions", () => {
    expect(learningApplicable(candidate, [proposal], { ...query,
      projectInstructions: [`# Rules\n${candidate.content.toUpperCase()}`] })).toBe(false);
    expect(learningApplicable(candidate, [proposal], { ...query, projectInstructions: ["Another constraint"] })).toBe(true);
  });
});
