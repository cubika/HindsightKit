import type { DiscoveryEnrichmentJob, DiscoveryMetadata, KnowledgeCandidate, LearningDistillationReview } from "@provenloop/contracts";
import { discoveryMetadataSchema, learningDistillationReviewSchema } from "@provenloop/contracts";
import { buildDiscoveryProfile, containsPotentialSecret, sha256, validateDiscoveryMetadata } from "@provenloop/domain";
import type { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

export interface DiscoveryEnrichmentProvider {
  readonly identity: { readonly provider: string; readonly model: string; readonly version: string };
  readonly timeoutMs?: number;
  enrichDiscovery(candidate: KnowledgeCandidate, options: { readonly signal: AbortSignal; readonly reserveReviewAttempt: () => boolean | Promise<boolean> }):
    Promise<{ readonly discovery: DiscoveryMetadata; readonly review: LearningDistillationReview }>;
}
export interface DiscoveryEnrichmentOptions {
  readonly store: CanonicalSqliteStore; readonly provider: DiscoveryEnrichmentProvider; readonly enabled: () => Promise<boolean>;
  readonly signal?: AbortSignal; readonly now?: () => Date; readonly dailyLimit?: number;
}
export interface DiscoveryEnrichmentResult { readonly status: "idle" | "disabled" | "accepted" | "rejected" | "paused" | "failed" | "superseded"; readonly knowledgeId?: string }

/** Runs under the host's existing learning-inference lease, at most one job per idle pass. */
export class DiscoveryEnrichmentCoordinator {
  public constructor(private readonly options: DiscoveryEnrichmentOptions) {
    const budget = options.dailyLimit ?? 200; const timeout = options.provider.timeoutMs ?? 100_000;
    if (!Number.isInteger(budget) || budget < 1 || budget > 10_000 || !Number.isInteger(timeout) || timeout < 1 || timeout > 120_000) {
      throw new RangeError("Invalid discovery enrichment budget or deadline.");
    }
  }
  public async run(): Promise<DiscoveryEnrichmentResult> {
    const { store, provider } = this.options; const now = this.options.now ?? (() => new Date());
    const enabled = async () => !this.options.signal?.aborted && !store.hasActiveDeletion() && await this.options.enabled();
    if (!await enabled()) return { status: "disabled" };
    store.scheduleDiscoveryEnrichment(now());
    const pending = store.discoveryEnrichmentJob(now()); if (!pending) return { status: "idle" };
    const finish = (state: DiscoveryEnrichmentJob["state"], reason: DiscoveryEnrichmentJob["reason"], retryAfter?: string) => {
      const next = { ...pending, state, reason, updatedAt: now().toISOString(), ...(retryAfter ? { retryAfter } : {}) };
      delete next.deadline;
      store.transitionDiscoveryEnrichmentJob(next, pending.state);
    };
    const candidate = store.discoveryEnrichmentCandidate(pending, now());
    if (!candidate) { finish("superseded", "stale_input"); return { status: "superseded", knowledgeId: pending.knowledgeId }; }
    if (pending.attempts >= 3) { finish("failed", "deadline"); return { status: "failed", knowledgeId: pending.knowledgeId }; }
    if (candidate.content.length > 8_192 || candidate.appliesWhen.length > 16 || candidate.nonApplicability.length > 16 ||
        [candidate.content, ...candidate.appliesWhen, ...candidate.nonApplicability].some(containsPotentialSecret) ||
        Buffer.byteLength(JSON.stringify(candidate), "utf8") > 16_384) {
      finish("rejected", "invalid_metadata"); return { status: "rejected", knowledgeId: pending.knowledgeId };
    }
    const tomorrow = () => { const time = now(); return new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate() + 1)).toISOString(); };
    if (!await enabled()) return { status: "disabled" };
    if (!store.reserveLearningAttempt(now(), this.options.dailyLimit ?? 200)) {
      finish("paused", "daily_budget", tomorrow()); return { status: "paused", knowledgeId: pending.knowledgeId };
    }
    const running: DiscoveryEnrichmentJob = { ...pending, attempts: pending.attempts + 1, state: "running", updatedAt: now().toISOString(),
      deadline: new Date(now().getTime() + (provider.timeoutMs ?? 100_000)).toISOString() };
    delete running.reason; delete running.retryAfter;
    if (!store.transitionDiscoveryEnrichmentJob(running, pending.state)) return { status: "idle" };
    const controller = new AbortController(); const abort = () => controller.abort(); this.options.signal?.addEventListener("abort", abort, { once: true });
    if (this.options.signal?.aborted) controller.abort();
    let timer: NodeJS.Timeout | undefined; let budgetPaused = false; let staleInput = false; let reviewReserved = false; let abortListener: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Discovery deadline exceeded.")); }, provider.timeoutMs ?? 100_000); });
      const aborted = new Promise<never>((_resolve, reject) => { abortListener = () => reject(new Error("Discovery cancelled."));
        if (controller.signal.aborted) abortListener(); else controller.signal.addEventListener("abort", abortListener, { once: true }); });
      const inference = Promise.resolve().then(() => { if (controller.signal.aborted) throw new Error("Discovery cancelled.");
        return provider.enrichDiscovery(candidate, { signal: controller.signal, reserveReviewAttempt: async () => {
        if (!await enabled() || controller.signal.aborted || reviewReserved) return false;
        if (!store.discoveryEnrichmentCandidate(running, now())) { staleInput = true; return false; }
        const reserved = store.reserveLearningAttempt(now(), this.options.dailyLimit ?? 200); budgetPaused = !reserved; reviewReserved = reserved; return reserved;
      } }); });
      const result = await Promise.race([inference, deadline, aborted]);
      if (!await enabled() || controller.signal.aborted) throw new Error("Discovery enrichment stopped.");
      const metadata = discoveryMetadataSchema.parse(result.discovery); const review = learningDistillationReviewSchema.parse(result.review);
      const valid = reviewReserved && (metadata.producer === undefined || metadata.producer === "model_reviewed") && validateDiscoveryMetadata(candidate, metadata) &&
        (!metadata.sourceReferences?.length || sha256(metadata.sourceReferences) === sha256(candidate.discovery?.sourceReferences ?? [])) &&
        !containsPotentialSecret(JSON.stringify(metadata));
      if (!valid || !Object.values(review.criteria).every(Boolean)) {
        store.transitionDiscoveryEnrichmentJob({ ...running, state: "rejected", reason: valid ? "review_rejected" : "invalid_metadata", updatedAt: now().toISOString() }, "running");
        return { status: "rejected", knowledgeId: pending.knowledgeId };
      }
      const profile = buildDiscoveryProfile(candidate, { ...metadata,
        ...(candidate.discovery?.sourceReferences ? { sourceReferences: candidate.discovery.sourceReferences } : {}),
      }, { reviewedBy: provider.identity.provider + "/" + provider.identity.model,
        reviewVersion: provider.identity.version + "/discovery-review-1" });
      if (!store.commitDiscoveryEnrichment(running, profile, now())) {
        store.transitionDiscoveryEnrichmentJob({ ...running, state: "superseded", reason: "stale_input", updatedAt: now().toISOString() }, "running");
        return { status: "superseded", knowledgeId: pending.knowledgeId };
      }
      return { status: "accepted", knowledgeId: pending.knowledgeId };
    } catch {
      controller.abort();
      store.transitionDiscoveryEnrichmentJob({ ...running, attempts: budgetPaused ? pending.attempts : running.attempts,
        state: staleInput ? "superseded" : budgetPaused ? "paused" : "failed", reason: staleInput ? "stale_input" : budgetPaused ? "daily_budget" : "provider_failed",
        updatedAt: now().toISOString(), retryAfter: budgetPaused ? tomorrow() : new Date(now().getTime() + 300_000).toISOString() }, "running");
      return { status: staleInput ? "superseded" : budgetPaused ? "paused" : "failed", knowledgeId: pending.knowledgeId };
    } finally { clearTimeout(timer); this.options.signal?.removeEventListener("abort", abort); if (abortListener) controller.signal.removeEventListener("abort", abortListener); }
  }
}
