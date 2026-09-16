import type { CaptureEnvelope, KnowledgeCandidate, RuleProposal } from "@provenloop/contracts";
import { posix, win32 } from "node:path";

export interface KnowledgeDuplicateSuggestion { readonly knowledgeId: string; readonly reason: "same_text" | "same_concept" | "same_model_choice" }
const text = (value: string): string => value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}]+/gu, "");
const models = (value: string): string[] => [...value.matchAll(/gpt[- ]?(\d+(?:\.\d+)?)/giu)].map((match) => match[1] ?? "");
const review = (value: string): boolean => /code reviews?|reviewing code|代码审查|代码审阅|代码评审/iu.test(value);

/** Alias evidence is limited to the same captured session, worktree, branch and revision. */
export const capturedRepositoryAliases = (repoId: string, events: readonly CaptureEnvelope[]): string[] => {
  const groups = new Map<string, Set<string>>();
  for (const { event } of events) {
    if (event.repositoryState !== "known_repo" || !event.sessionId || !event.repoId || !event.worktree || !event.branch || !event.commitSha) continue;
    const windows = /^[a-z]:[\\/]/iu.test(event.worktree);
    const root = windows ? win32.normalize(event.worktree).toLowerCase() : posix.normalize(event.worktree);
    const group = JSON.stringify([event.sessionId, root, event.branch, event.commitSha]);
    const ids = groups.get(group) ?? new Set<string>(); ids.add(event.repoId); groups.set(group, ids);
  }
  return [...new Set([...groups.values()].filter((ids) => ids.has(repoId)).flatMap((ids) => [...ids]))].filter((id) => id !== repoId);
};

/** Review suggestions only. Similarity does not authorize a merge or add evidence. */
export const suggestKnowledgeDuplicates = (candidate: KnowledgeCandidate, peers: readonly KnowledgeCandidate[], proposals: readonly RuleProposal[], repositoryAliases: readonly string[] = []): KnowledgeDuplicateSuggestion[] => {
  const key = (id: string): string | undefined => proposals.find((proposal) => proposal.knowledgeId === id && proposal.canonicalKey)?.canonicalKey;
  const ownKey = key(candidate.knowledgeId);
  const ownModels = models(candidate.content);
  return peers.flatMap((peer): KnowledgeDuplicateSuggestion[] => {
    const sameScope = peer.scopeId === candidate.scopeId || (candidate.scope === "repository" && peer.scopeId !== undefined && repositoryAliases.includes(peer.scopeId));
    if (peer.knowledgeId === candidate.knowledgeId || peer.scope !== candidate.scope || !sameScope ||
        ["archived", "superseded"].includes(peer.state)) return [];
    if (text(peer.content) === text(candidate.content)) return [{ knowledgeId: peer.knowledgeId, reason: "same_text" }];
    const peerKey = key(peer.knowledgeId);
    if (ownKey && peerKey && text(ownKey) === text(peerKey)) return [{ knowledgeId: peer.knowledgeId, reason: "same_concept" }];
    // The two reported languages keep the same ordered model identifiers. Conditions still need review.
    if (ownModels.length >= 2 && review(candidate.content) && review(peer.content) &&
        JSON.stringify(ownModels) === JSON.stringify(models(peer.content))) return [{ knowledgeId: peer.knowledgeId, reason: "same_model_choice" }];
    return [];
  }).slice(0, 10);
};
