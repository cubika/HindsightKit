import type {
  KnowledgeCandidate,
} from "@provenloop/contracts";
import {
  KnowledgeAdmissionPolicy,
  sha256,
  learningSourceUse,
  type LearningSourceUse,
} from "@provenloop/domain";
import { posix, win32 } from "node:path";

import {
  AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS,
  branchScopeIdFor,
  scopeMatches,
  type CanonicalKnowledgeAdmissionStore,
  type KnowledgeBackend,
  type KnowledgeRetrievalQuery,
  type RetrievedKnowledge,
  type KnowledgeRecord,
} from "./types.js";
import { learningApplicable } from "./learning-applicability.js";
import { knowledgeProjectionFromCandidate, reviewedRetrievalScope } from "./projection.js";

const eligible = (
  candidate: KnowledgeCandidate,
  query: KnowledgeRetrievalQuery,
  now: Date,
  sourceUse?: LearningSourceUse,
): boolean =>
  ((candidate.state === "candidate" && sourceUse !== undefined) || (candidate.state === "active" &&
  AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS.has(
    candidate.evidenceTier,
  ))) &&
  (
    candidate.expiresAt === undefined ||
    Date.parse(candidate.expiresAt) > now.getTime()
  ) &&
  scopeMatches(candidate.scope, candidate.scopeId, query);

const sameWorktree = (left: string, right: string): boolean => {
  const windows = /^[a-z]:[\\/]|^[\\/]{2}/iu.test(left);
  const normalize = (path: string): string => windows
    ? win32.normalize(path).replace(/[\\/]+$/u, "").toLowerCase()
    : posix.normalize(path).replace(/\/+$/u, "");
  const root = normalize(left);
  const target = normalize(right);
  const api = windows ? win32 : posix;
  if (!api.isAbsolute(right)) return false;
  const relative = api.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${api.sep}`) && relative !== ".." && !api.isAbsolute(relative));
};

export class CanonicalKnowledgeRetriever {
  readonly #admissionPolicy: KnowledgeAdmissionPolicy;
  readonly #backend: KnowledgeBackend;
  readonly #store: CanonicalKnowledgeAdmissionStore;

  public constructor(options: {
    readonly admissionPolicy?: KnowledgeAdmissionPolicy;
    readonly backend: KnowledgeBackend;
    readonly store: CanonicalKnowledgeAdmissionStore;
  }) {
    this.#admissionPolicy =
      options.admissionPolicy ?? new KnowledgeAdmissionPolicy();
    this.#backend = options.backend;
    this.#store = options.store;
  }

  public async search(
    query: KnowledgeRetrievalQuery,
    options: {
      readonly timeoutMs?: number;
      readonly accept?: (item: RetrievedKnowledge) => boolean;
      readonly maxCandidates?: number;
      readonly onCandidateBudgetExhausted?: () => void;
    } = {},
  ): Promise<readonly RetrievedKnowledge[]> {
    if (!Number.isInteger(query.limit) || query.limit <= 0) {
      throw new RangeError("Knowledge retrieval limit must be positive.");
    }
    if (
      options.timeoutMs !== undefined &&
      (
        !Number.isInteger(options.timeoutMs) ||
        options.timeoutMs <= 0
      )
    ) {
      throw new RangeError(
        "Knowledge retrieval timeout must be positive.",
      );
    }
    const now = query.now ?? new Date();
    const maxCandidates = options.maxCandidates ?? 500;
    if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 10_000) {
      throw new RangeError("Knowledge retrieval candidate budget must be between 1 and 10000.");
    }
    const routes = query.routes?.length ? query.routes.map((route) => ({ ...route, offset: 0, done: false }))
      : [{ route: "lexical" as const, text: query.text, offset: 0, done: false }];
    if (routes.length > 8 || routes.some((route) => !route.text.trim() || route.text.length > 16_000)) {
      throw new RangeError("Knowledge retrieval routes exceed the bounded query contract.");
    }
    const pageSize = routes.length > 1 ? 30 : Math.max(query.limit * 5, 20);
    let examined = 0;
    const retrieved: RetrievedKnowledge[] = [];
    const admissionById = new Map<
      string,
      ReturnType<KnowledgeAdmissionPolicy["evaluate"]>
    >();
    const applicableById = new Map<string, boolean>();
    const sourceUseById = new Map<string, LearningSourceUse>();
    const learningApplicabilityById = new Map<string, readonly string[]>();
    const projectionsById = new Map<string, ReturnType<typeof knowledgeProjectionFromCandidate>>();
    const retrievalScopesById = new Map<string, NonNullable<RetrievedKnowledge["retrievalScope"]>>();
    const deadline =
      options.timeoutMs === undefined
        ? undefined
        : Date.now() + options.timeoutMs;
    const returnedIds = new Set<string>();
    const routeRanks = new Map<string, Partial<Record<"lexical" | "concept", number>>>();
    while (retrieved.length < query.limit) {
      if (
        deadline !== undefined &&
        Date.now() >= deadline
      ) {
        throw new Error("Knowledge retrieval timed out.");
      }
      const hits: KnowledgeRecord[] = [];
      let reserved = examined;
      const pages = routes.filter((route) => !route.done).flatMap((route) => {
        const limit = Math.min(pageSize, maxCandidates - reserved);
        reserved += limit;
        return limit > 0 ? [{ route, limit }] : [];
      });
      const results = await Promise.all(pages.map(async ({ route, limit }) => {
        const backendQuery = {
          limit,
          filter: {
            now: now.toISOString(),
            scopes: [
              { scope: "personal" as const },
              ...(query.repositoryScopeId === undefined ? [] : [{ scope: "repository" as const, scopeId: query.repositoryScopeId }]),
              ...(query.workflowScopeId === undefined ? [] : [{ scope: "workflow" as const, scopeId: query.workflowScopeId }]),
              ...(query.repositoryScopeId === undefined || query.branchScopeId === undefined ? [] : [{
                scope: "branch" as const, scopeId: branchScopeIdFor(query.repositoryScopeId, query.branchScopeId),
              }]),
            ],
          },
          ...(query.match === undefined ? {} : { match: query.match }),
          offset: route.offset,
          text: route.text,
        };
        const remaining = deadline === undefined ? undefined : deadline - Date.now();
        if (remaining !== undefined && remaining <= 0) throw new Error("Knowledge retrieval timed out.");
        const page = remaining !== undefined && this.#backend.searchWithTimeout !== undefined
          ? await this.#backend.searchWithTimeout(backendQuery, remaining)
          : await this.#backend.search(backendQuery);
        return { route, page, limit };
      }));
      for (const { route, page, limit } of results) {
        for (const [index, hit] of page.entries()) {
          const ranks = routeRanks.get(hit.knowledgeId) ?? {};
          ranks[route.route] = Math.min(ranks[route.route] ?? Infinity, route.offset + index + 1);
          routeRanks.set(hit.knowledgeId, ranks);
          hits.push(hit);
        }
        route.offset += page.length;
        route.done = page.length < limit;
        examined += page.length;
      }
      if (hits.length === 0) break;
      const uniqueHits = [...new Map(hits.map((hit) => [hit.knowledgeId, hit])).values()];
      // Backend paging yields to writers. Evidence, controls, and source payloads
      // can change without a candidate ID change, so admission is page-local.
      admissionById.clear(); applicableById.clear(); sourceUseById.clear();
      learningApplicabilityById.clear(); projectionsById.clear(); retrievalScopesById.clear();
      const fusion = (hit: KnowledgeRecord) => Object.values(routeRanks.get(hit.knowledgeId) ?? {})
        .reduce((sum, rank) => sum + 1 / (60 + rank), 0);
      uniqueHits.sort((left, right) => fusion(right) - fusion(left) || right.score - left.score);
      const candidates = this.#store.knowledgeCandidates(
        uniqueHits.map((hit) => hit.knowledgeId),
      ).filter((candidate) =>
        scopeMatches(candidate.scope, candidate.scopeId, query) &&
        (candidate.expiresAt === undefined || Date.parse(candidate.expiresAt) > now.getTime()) &&
        (candidate.state === "candidate" || (candidate.state === "active" &&
          AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS.has(candidate.evidenceTier))));
      const byId = new Map(
        candidates.map((candidate) => [
          candidate.knowledgeId,
          candidate,
        ]),
      );
      const deleted = this.#store
        .knowledgeCandidatesWithUnavailableSources(candidates);
      const unevaluatedCandidates = candidates.filter(
        (candidate) => !admissionById.has(candidate.knowledgeId),
      );
      if (unevaluatedCandidates.length > 0) {
        const enrichment = this.#store.discoveryProfiles?.(unevaluatedCandidates);
        const evidence = this.#store.knowledgeAdmissionEvidence(
          unevaluatedCandidates,
        );
        for (const candidate of unevaluatedCandidates) {
          projectionsById.set(candidate.knowledgeId, knowledgeProjectionFromCandidate(candidate, evidence.learningProposals, enrichment?.get(candidate.knowledgeId)));
          const retrievalScope = reviewedRetrievalScope(candidate, evidence.learningProposals ?? []);
          if (retrievalScope) retrievalScopesById.set(candidate.knowledgeId, retrievalScope);
          const sourceUse = learningSourceUse(candidate, evidence.learningProposals ?? [], evidence.envelopes, evidence.contextUseRecords);
          if (sourceUse) sourceUseById.set(candidate.knowledgeId, sourceUse);
          const sourceApplicable = sourceUse !== undefined && query.worktree !== undefined &&
            sameWorktree(sourceUse.worktree, query.worktree) &&
            !(query.projectInstructions ?? []).some((instruction) => {
              const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
              const existing = normalize(instruction);
              return existing.includes(normalize(candidate.content)) || sourceUse.sources.some((source) => existing.includes(normalize(source.quote)));
            }) &&
            (sourceUse.mode !== "reference" || (query.headSha !== undefined &&
              /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(query.headSha)));
          applicableById.set(candidate.knowledgeId, sourceUse ? sourceApplicable : learningApplicable(
            candidate, evidence.learningProposals ?? [], query, evidence.learningReceipts ?? [],
          ));
          const proposal = evidence.learningProposals?.find((entry) =>
            entry.knowledgeId === candidate.knowledgeId && entry.predicate !== undefined &&
            entry.sourceDigests.length === candidate.sourceEvidenceIds.length &&
            entry.sourceDigests.every((source) => candidate.sourceEvidenceIds.includes(source.eventId)));
          if (proposal?.predicate) learningApplicabilityById.set(candidate.knowledgeId, [
            `Calling ${proposal.predicate.serverName}/${proposal.predicate.toolName} under its verified tool contract.`,
          ]);
        }
        for (const admission of this.#admissionPolicy.evaluateAll({
          candidates: unevaluatedCandidates,
          ...evidence,
        })) {
          admissionById.set(admission.knowledgeId, admission);
        }
      }
      if (
        deadline !== undefined &&
        Date.now() >= deadline
      ) {
        throw new Error("Knowledge retrieval timed out.");
      }
      for (const hit of uniqueHits) {
        if (returnedIds.has(hit.knowledgeId)) continue;
        const candidate = byId.get(hit.knowledgeId);
        const projection = projectionsById.get(hit.knowledgeId);
        if (
          candidate === undefined ||
          deleted.has(candidate.knowledgeId) ||
          !eligible(candidate, query, now, sourceUseById.get(candidate.knowledgeId)) ||
          applicableById.get(candidate.knowledgeId) !== true ||
          admissionById.get(candidate.knowledgeId)?.admitted !== true ||
          hit.sourceDigest !== projection?.sourceDigest ||
          (hit.retrievalMetadata !== undefined && sha256(hit.retrievalMetadata) !== sha256(projection?.retrievalMetadata)) ||
          sha256(hit.searchAliases ?? []) !== sha256(projection?.searchAliases ?? []) ||
          sha256(hit.searchExclusions ?? []) !== sha256(projection?.searchExclusions ?? [])
          || (hit.discoveryProfile !== undefined && sha256(hit.discoveryProfile) !== sha256(projection?.discoveryProfile))
        ) {
          continue;
        }
        const sourceUse = sourceUseById.get(candidate.knowledgeId);
        const retrievalScope = retrievalScopesById.get(candidate.knowledgeId);
        const item: RetrievedKnowledge = {
          ...(projection?.discoveryProfile ? { discoveryProfile: projection.discoveryProfile } : {}),
          routeRanks: routeRanks.get(hit.knowledgeId) ?? {},
          ...(sourceUse ? { deliveryMode: sourceUse.mode, sources: sourceUse.sources } : {}),
          ...(sourceUse?.researchSummary ? { researchSummary: sourceUse.researchSummary } : {}),
          ...(sourceUse?.distilledLesson ? { distilledLesson: sourceUse.distilledLesson } : {}),
          ...(sourceUse?.mode === "reference" && sourceUse.commitSha && query.headSha ? { reference: {
            capturedCommitSha: sourceUse.commitSha, currentCommitSha: query.headSha,
            revisionStatus: sourceUse.commitSha === query.headSha ? "unchanged" as const : "changed" as const,
            requiresRevalidation: true as const,
          } } : {}),
          candidate,
          ...(learningApplicabilityById.has(candidate.knowledgeId) ? { displayApplicability: learningApplicabilityById.get(candidate.knowledgeId) ?? [] } : {}),
          ...(projection?.searchAliases ? { searchAliases: projection.searchAliases } : {}),
          ...(projection?.searchExclusions ? { searchExclusions: projection.searchExclusions } : {}),
          ...(retrievalScope ? { retrievalScope } : {}),
          score: hit.score,
        };
        if (options.accept !== undefined && !options.accept(item)) continue;
        retrieved.push(item);
        returnedIds.add(item.candidate.knowledgeId);
        if (retrieved.length === query.limit) {
          break;
        }
      }
      if (routes.every((route) => route.done)) break;
      if (retrieved.length < query.limit && examined >= maxCandidates) {
        if (retrieved.length > 0) {
          options.onCandidateBudgetExhausted?.();
          return this.#revalidate(retrieved, query, now);
        }
        throw new Error("Knowledge retrieval candidate budget exhausted.");
      }
    }
    return this.#revalidate(retrieved, query, now);
  }

  #revalidate(items: readonly RetrievedKnowledge[], query: KnowledgeRetrievalQuery, now: Date): readonly RetrievedKnowledge[] {
    if (!items.length) return items;
    const candidates = this.#store.knowledgeCandidates(items.map((item) => item.candidate.knowledgeId));
    const evidence = this.#store.knowledgeAdmissionEvidence(candidates);
    const admissions = new Map(this.#admissionPolicy.evaluateAll({ candidates, ...evidence }).map((entry) => [entry.knowledgeId, entry.admitted]));
    const unavailable = this.#store.knowledgeCandidatesWithUnavailableSources(candidates);
    const current = new Map(candidates.map((candidate) => [candidate.knowledgeId, candidate]));
    const enrichment = this.#store.discoveryProfiles?.(candidates);
    return items.filter((item) => {
      const candidate = current.get(item.candidate.knowledgeId);
      if (!candidate || sha256(candidate) !== sha256(item.candidate) || unavailable.has(candidate.knowledgeId) || !admissions.get(candidate.knowledgeId)) return false;
      const profile = knowledgeProjectionFromCandidate(candidate, evidence.learningProposals, enrichment?.get(candidate.knowledgeId)).discoveryProfile;
      if (sha256(profile ?? null) !== sha256(item.discoveryProfile ?? null)) return false;
      const sourceUse = learningSourceUse(candidate, evidence.learningProposals ?? [], evidence.envelopes, evidence.contextUseRecords);
      if (!eligible(candidate, query, now, sourceUse)) return false;
      if (sourceUse && (!query.worktree || !sameWorktree(sourceUse.worktree, query.worktree))) return false;
      if (!sourceUse && !learningApplicable(candidate, evidence.learningProposals ?? [], query, evidence.learningReceipts ?? [])) return false;
      return true;
    });
  }
}
