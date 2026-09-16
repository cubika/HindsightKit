import {
  discoveryMetadataSchema,
  learningDistillationSchema, learningDistillationReviewSchema, learningSourceSchema,
  type CaptureEnvelope, type LearningDistillation, type LearningDistillationReview, type RuleProposalInput,
} from "@provenloop/contracts";
import { sha256 } from "./digest.js";
import { capturedToolQuote } from "./agent-learning-source.js";
import { containsPotentialSecret } from "./redaction.js";
import { validateDiscoveryMetadata } from "./discovery.js";

interface LearningDistillationSource { readonly eventId: string; readonly digest: string }

const hasLiteral = (text: string, literal: string): boolean => {
  let offset = text.indexOf(literal);
  const adjacent = /[\p{L}\p{N}_./\\%?#=&:+~-]/u;
  while (offset >= 0) {
    const following = text.slice(offset + literal.length);
    if (!adjacent.test(text[offset - 1] ?? "") && (!adjacent.test(following[0] ?? "") || /^\.(?:$|\s|["')\]}])/u.test(following))) return true;
    offset = text.indexOf(literal, offset + 1);
  }
  return false;
};

const capturedLocators = (entry: CaptureEnvelope): string[] => {
  const result = [entry.event.worktree, entry.event.evidence?.workingDirectory, ...(entry.event.evidence?.targetPaths ?? [])]
    .filter((value): value is string => value !== undefined);
  const pending: unknown[] = [entry.event.redactedArguments];
  let visited = 0;
  while (pending.length && visited++ < 512) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value).slice(0, 512 - visited)) {
      if (/^(?:path|file|filePath|filepath|targetPath|sourcePath|directory|folder|cwd|url|uri|href|paths|files|urls)$/u.test(key)) {
        if (typeof child === "string") result.push(child);
        else if (Array.isArray(child)) result.push(...child.filter((item): item is string => typeof item === "string"));
      } else if (child !== null && typeof child === "object") pending.push(child);
    }
  }
  return result;
};

/** Include actual captured navigation metadata in the separate semantic review. */
export const learningDiscoverySourceContext = (
  proposals: readonly RuleProposalInput[], events: readonly CaptureEnvelope[],
): readonly {
  eventId: string; role: string; locators: string[]; timestamp: string; capturedAt: string;
  repoId?: string; commitSha?: string; resultDigest?: string; operationId?: string;
}[] => {
  const references = proposals.flatMap((proposal) => proposal.discovery?.sourceReferences ?? []);
  if (references.length === 0) return [];
  const locators = new Set(references.map((reference) => reference.locator));
  const cited = new Set(proposals.flatMap((proposal) => [
    ...(proposal.userSource ? [proposal.userSource.eventId] : []),
    ...(proposal.supportingSources ?? []).map((source) => source.eventId),
    ...(proposal.agentSource?.evidenceSources ?? []).map((source) => source.eventId),
  ]));
  const matched = events.filter((entry) => entry.event.trust !== "model" && (cited.has(entry.event.eventId) ||
    capturedLocators(entry).some((locator) => locators.has(locator))));
  const operations = new Set(matched.flatMap((entry) => entry.event.operationId ? [entry.event.operationId] : []));
  return events.filter((entry) => entry.event.trust !== "model" &&
    (matched.includes(entry) || entry.event.operationId !== undefined && operations.has(entry.event.operationId))).map((entry) => ({
    eventId: entry.event.eventId, role: entry.event.trust,
    locators: [...new Set(capturedLocators(entry))].filter((locator) => locators.has(locator)),
    timestamp: entry.event.timestamp, capturedAt: entry.capturedAt,
    ...(entry.event.repoId ? { repoId: entry.event.repoId } : {}),
    ...(entry.event.commitSha ? { commitSha: entry.event.commitSha } : {}),
    ...(entry.event.resultDigest ? { resultDigest: entry.event.resultDigest } : {}),
    ...(entry.event.operationId ? { operationId: entry.event.operationId } : {}),
  }));
};

/** Metadata may describe captured material, but cannot create a source locator or a new evidence receipt. */
export const validLearningDiscoveryMetadata = (proposal: RuleProposalInput, events: readonly CaptureEnvelope[]): boolean => {
  if (!proposal.discovery) return true;
  const parsed = discoveryMetadataSchema.safeParse(proposal.discovery);
  if (!parsed.success || sha256(parsed.data) !== sha256(proposal.discovery) ||
      parsed.data.producer !== undefined && parsed.data.producer !== "model_reviewed") return false;
  const metadata = parsed.data;
  if (!validateDiscoveryMetadata({ content: proposal.rule, appliesWhen: [proposal.trigger], nonApplicability: proposal.exclusions }, metadata)) return false;
  const features = [...(metadata.purposes ?? []), ...(metadata.topics ?? []), ...(metadata.entities ?? []),
    ...(metadata.paraphrases ?? []), ...(metadata.shorterSummary ? [metadata.shorterSummary] : [])];
  const text = features.flatMap((feature) => typeof feature.value === "string" ? [feature.value] : Object.values(feature.value));
  text.push(...(metadata.sourceReferences ?? []).flatMap((reference) => [reference.sourceRefId, reference.locator, reference.anchor ?? "",
    reference.repositoryId ?? "", reference.revision ?? ""]));
  if (text.some(containsPotentialSecret)) return false;
  const byId = new Map(events.map((entry) => [entry.event.eventId, entry]));
  const quotes = [...(proposal.userSource ? [proposal.userSource] : []), ...(proposal.supportingSources ?? []),
    ...(proposal.agentSource?.evidenceSources ?? [])].filter((source) => {
    const entry = byId.get(source.eventId);
    return entry && (entry.event.trust === "user" && entry.event.eventType === "prompt.submitted" &&
      entry.content?.message?.includes(source.quote) || capturedToolQuote(entry, source.quote));
  });
  const anchor = byId.get(proposal.userSource?.eventId ?? proposal.agentSource?.eventId ?? "");
  for (const reference of metadata.sourceReferences ?? []) {
    if (reference.evidenceIds.some((id) => !byId.has(id)) ||
        reference.repositoryId !== undefined && reference.repositoryId !== anchor?.event.repoId ||
        reference.kind !== "url" && !/^(?:[a-z]:[\\/]|[/\\])/iu.test(reference.locator) && !reference.repositoryId) return false;
    const located = events.filter((entry) => entry.event.trust !== "model" && (
      capturedLocators(entry).includes(reference.locator) ||
      quotes.some((quote) => quote.eventId === entry.event.eventId && hasLiteral(quote.quote, reference.locator))));
    if (located.length === 0) return false;
    const related = events.filter((entry) => located.some((source) => source.event.eventId === entry.event.eventId ||
      source.event.operationId !== undefined && source.event.operationId === entry.event.operationId));
    const relatedQuotes = quotes.filter((quote) => related.some((entry) => entry.event.eventId === quote.eventId));
    if (reference.evidenceIds.some((id) => !relatedQuotes.some((quote) => quote.eventId === id))) return false;
    if (reference.anchor && !relatedQuotes.some((quote) => hasLiteral(quote.quote, reference.anchor ?? ""))) return false;
    if (reference.revision && !related.some((entry) => entry.event.commitSha === reference.revision) &&
        !relatedQuotes.some((quote) => hasLiteral(quote.quote, reference.revision ?? ""))) return false;
    if (reference.contentDigest && !related.some((entry) => entry.event.resultDigest === reference.contentDigest) &&
        !relatedQuotes.some((quote) => hasLiteral(quote.quote, reference.contentDigest ?? ""))) return false;
    if (reference.observedAt && !related.some((entry) => entry.capturedAt === reference.observedAt || entry.event.timestamp === reference.observedAt)) return false;
    if (reference.availability === "captured" && !relatedQuotes.some((quote) =>
      reference.evidenceIds.includes(quote.eventId) && byId.get(quote.eventId)?.event.trust === "tool" &&
      quote.quote.trim() !== reference.locator)) return false;
  }
  return true;
};

/** Bind the reviewed proposal to the original captured window, including source text. */
export const learningDistillationInputDigest = (
  proposal: RuleProposalInput,
  sourceDigests: readonly LearningDistillationSource[],
): string => sha256({
  rule: proposal.rule, trigger: proposal.trigger, exclusions: proposal.exclusions,
  retention: proposal.retention, canonicalKey: proposal.canonicalKey,
  userSource: proposal.userSource, agentSource: proposal.agentSource, supportingSources: proposal.supportingSources,
  predicate: proposal.predicate, shellPredicate: proposal.shellPredicate,
  failedOperationEventId: proposal.failedOperationEventId, retryOperationEventId: proposal.retryOperationEventId,
  completionEventId: proposal.completionEventId,
  ...(proposal.queryTerms ? { queryTerms: proposal.queryTerms } : {}),
  ...(proposal.discovery ? { discovery: proposal.discovery } : {}),
  ...(proposal.retrievalScope ? { retrievalScope: proposal.retrievalScope } : {}),
  ...(proposal.relations ? { relations: proposal.relations } : {}),
  sourceDigests: sourceDigests.map(({ eventId, digest }) => ({ eventId, digest })),
});

const validSources = (sources: readonly LearningDistillationSource[]): boolean =>
  sources.length > 0 && sources.length <= 32 && new Set(sources.map((source) => source.eventId)).size === sources.length &&
  sources.every((source) => learningSourceSchema.safeParse(source).success);

/** Called after independent model review. Identity, time and digests come from the host. */
export const createLearningDistillation = (
  proposal: RuleProposalInput,
  sourceDigests: readonly LearningDistillationSource[],
  review: LearningDistillationReview,
  reviewer: LearningDistillation["reviewer"],
  reviewedAt: string,
): LearningDistillation => {
  if (!validSources(sourceDigests)) throw new Error("Distillation requires valid captured source digests.");
  const assessment = learningDistillationReviewSchema.parse(review);
  const metadata = {
    ...assessment, schemaVersion: 1 as const, comparisonBasis: "provided_material" as const,
    inputDigest: learningDistillationInputDigest(proposal, sourceDigests), reviewer, reviewedAt,
  };
  // Parse before hashing so schema normalization cannot invalidate the stored digest.
  const parsed = learningDistillationSchema.parse({ ...metadata, reviewDigest: "0".repeat(64) });
  const bound = { schemaVersion: parsed.schemaVersion, inputDigest: parsed.inputDigest,
    criteria: parsed.criteria, rationale: parsed.rationale, comparisonBasis: parsed.comparisonBasis,
    reviewer: parsed.reviewer, reviewedAt: parsed.reviewedAt };
  return { ...bound, reviewDigest: sha256(bound) };
};

/**
 * Accept a complete model assessment only while its reviewed inputs and metadata
 * match. Hashes detect later edits; they are not signatures or semantic proof.
 * Acceptance never grants external verification, user confirmation or authority.
 */
export const hasAcceptedLearningDistillation = (
  proposal: RuleProposalInput,
  sourceDigests: readonly LearningDistillationSource[],
): boolean => {
  const result = learningDistillationSchema.safeParse(proposal.distillation);
  if (!result.success || !validSources(sourceDigests) || sha256(proposal.distillation) !== sha256(result.data)) return false;
  const { reviewDigest, ...bound } = result.data;
  return reviewDigest === sha256(bound) && bound.inputDigest === learningDistillationInputDigest(proposal, sourceDigests) &&
    Object.values(bound.criteria).every((accepted) => accepted);
};
