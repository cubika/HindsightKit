import type { KnowledgeCandidate, RuleProposal, LearningRecoveryReceipt } from "@provenloop/contracts";
import { posix, win32 } from "node:path";
import { sha256 } from "@provenloop/domain";
import type { KnowledgeRetrievalQuery } from "./types.js";

const normalize = (text: string): string =>
  text.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();

const workspaceIdentity = (path: string): string | undefined => {
  const normalized = path.trim().replaceAll("\\", "/");
  if (/^[a-z]:\//iu.test(normalized) || /^\/\/[^/]+\/[^/]+(?:\/|$)/u.test(normalized)) {
    return win32.normalize(normalized).replace(/[\\]+$/u, "").toLocaleLowerCase("en-US");
  }
  return posix.isAbsolute(normalized) && !normalized.startsWith("//")
    ? posix.normalize(normalized).replace(/\/+$/u, "") || "/"
    : undefined;
};

export const learningApplicable = (
  candidate: KnowledgeCandidate,
  proposals: readonly RuleProposal[],
  query: KnowledgeRetrievalQuery,
  receipts: readonly LearningRecoveryReceipt[] = [],
): boolean => {
  const sources = proposals.filter((proposal) => proposal.knowledgeId === candidate.knowledgeId);
  if (!candidate.knowledgeId.startsWith("learning-knowledge-") && sources.length === 0) return true;
  const tool = query.toolInvocation;
  if (candidate.scope !== "repository" ||
      candidate.scopeId !== query.repositoryScopeId || sources.length === 0) return false;
  const matchingSources = sources.filter(({ sourceDigests }) =>
    sourceDigests.length === candidate.sourceEvidenceIds.length &&
    sourceDigests.every((source) => candidate.sourceEvidenceIds.includes(source.eventId)));
  const mcpMatches = tool !== undefined && matchingSources.some(({ predicate }) => predicate !== undefined &&
    predicate.serverName === tool.serverName && predicate.toolName === tool.toolName && predicate.contractDigest === tool.contractDigest);
  const shell = query.shellInvocation;
  const shellMatches = shell !== undefined && matchingSources.some((proposal) => {
    const predicate = proposal.shellPredicate;
    const receipt = receipts.find((entry) => entry.proposalId === proposal.proposalId && entry.proves === "repository_test_command");
    const worktree = receipt?.proves === "repository_test_command" ? workspaceIdentity(receipt.worktree) : undefined;
    return predicate !== undefined && receipt?.proves === "repository_test_command" &&
      sha256(receipt.predicate) === sha256(predicate) &&
      predicate.toolName === shell.toolName && [predicate.failedCommand, predicate.command].includes(shell.command.trim()) &&
      receipt.repoId === query.repositoryScopeId && receipt.branch === shell.branch && receipt.commitSha === shell.commitSha &&
      worktree !== undefined && worktree === workspaceIdentity(shell.cwd);
  });
  if (!mcpMatches && !shellMatches) return false;
  const guidance = normalize(candidate.content);
  return !(query.projectInstructions ?? []).some((instruction) =>
    normalize(instruction).includes(guidance));
};
