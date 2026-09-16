import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { scopeSchema } from "@provenloop/contracts";
import { cancelLearningScratch, readTrustedSessionContext } from "@provenloop/copilot-adapter";
import { sha256 } from "@provenloop/domain";
import { EvidenceLedgerWriter } from "@provenloop/evaluation";
import { DeletionService, KnowledgeControlService } from "@provenloop/host";
import { resolveWindowsProvenLoopLeaseName, WindowsCaptureQueue, WindowsNamedPipeLeaseProvider, type WindowsProvenLoopPaths } from "@provenloop/platform-windows";
import { KnowledgeProjectionManager, SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { invalidateLocalObservationProjection } from "./collect-observations.js";

export class UiActionError extends Error {
  public constructor(message: string, public readonly status = 400) { super(message); }
}

const scalar = (form: URLSearchParams, name: string): string => {
  if (form.getAll(name).length > 1) throw new UiActionError(`Duplicate form field: ${name}.`);
  return form.get(name)?.trim() ?? "";
};

/** The caller holds the projection and canonical restore leases. */
export const applyUiKnowledgeAction = async (paths: WindowsProvenLoopPaths, knowledgeId: string, form: URLSearchParams): Promise<string> => {
  const allowed = new Set(["csrf", "action", "expectedDigest", "confirmed", "content", "appliesWhen", "nonApplicability", "reason", "resolve", "replacementScope", "replacementScopeId", "deleteId"]);
  for (const key of form.keys()) if (!allowed.has(key)) throw new UiActionError("Unexpected form field.");
  const action = scalar(form, "action");
  if (!["confirm", "replace", "revoke", "delete"].includes(action)) throw new UiActionError("Unknown knowledge action.");
  if (scalar(form, "confirmed") !== action) throw new UiActionError("Select the confirmation checkbox for this action.");
  const expectedDigest = scalar(form, "expectedDigest");
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) throw new UiActionError("A current review digest is required.");
  if (action === "delete" && scalar(form, "deleteId") !== knowledgeId) throw new UiActionError("Type the Knowledge ID to confirm permanent deletion.");
  const store = new CanonicalSqliteStore(paths.database);
  let backend: SqliteFtsKnowledgeBackend | undefined;
  try {
    const candidate = store.knowledgeCandidates([knowledgeId])[0];
    if (!candidate) throw new UiActionError("Knowledge is unavailable. It may have been deleted.", 404);
    if (sha256(candidate) !== expectedDigest) throw new UiActionError("Knowledge changed after review. Reload the detail page before trying again.", 409);
    backend = new SqliteFtsKnowledgeBackend(paths.knowledgeDatabase);
    const projection = new KnowledgeProjectionManager({ store, backend });
    const sessionId = process.env.SESSION_ID?.trim();
    const trusted = sessionId ? await readTrustedSessionContext(paths.root, sessionId) : undefined;
    const service = new KnowledgeControlService({ store, projection: { acquireLease: async () => ({ release: async () => undefined }), rebuild: async () => { await projection.rebuild(); } },
      ...(trusted?.workflowScopeId ? { workflowScopeId: trusted.workflowScopeId } : {}) });
    const scope = { scope: candidate.scope, ...(candidate.scopeId === undefined ? {} : { scopeId: candidate.scopeId }) };
    const review = service.review({ ...scope, knowledgeId });
    const common = { ...scope, knowledgeId, expectedDigest, userConfirmed: true, ...(scalar(form, "reason") ? { reason: scalar(form, "reason") } : {}) };
    if (action === "delete") {
      const lease = await new WindowsNamedPipeLeaseProvider(await resolveWindowsProvenLoopLeaseName(paths.root, "observations")).tryAcquire();
      if (!lease) throw new UiActionError("Observations are busy. Retry after the current operation finishes.", 409);
      try {
        const queue = new WindowsCaptureQueue(paths.queue); await queue.initialize();
        const ledgers = new Map<string, EvidenceLedgerWriter>();
        await new DeletionService({ store, queue,
          transientCleanup: async () => {
            const inference = new WindowsNamedPipeLeaseProvider(await resolveWindowsProvenLoopLeaseName(paths.root, "learning-inference"));
            const deadline = Date.now() + 12_000;
            while (true) {
              await cancelLearningScratch(paths.temporary);
              const active = await inference.tryAcquire();
              if (active) { try { await cancelLearningScratch(paths.temporary); return; } finally { await active.release(); } }
              if (Date.now() >= deadline) throw new Error("Inference shutdown has not completed; deletion remains pending.");
              await new Promise<void>((done) => setTimeout(done, 50));
            }
          },
          knowledgeProjection: { acquireLease: async () => ({ release: async () => undefined }),
            rebuild: async () => { await projection.rebuild(); },
            remainingIdentifiers: async (identifiers) => {
              const remaining: string[] = [];
              for (const identifier of identifiers) if (identifier.startsWith("knowledge:") && await backend?.get(identifier.slice(10)) !== undefined) remaining.push(identifier);
              return remaining;
            },
          },
          recordEvidence: async (entry) => {
            let ledger = ledgers.get(entry.runId);
            if (!ledger) { ledger = new EvidenceLedgerWriter(join(paths.evaluation, "deletions", entry.runId, "evidence-ledger.jsonl")); await ledger.initialize(); ledgers.set(entry.runId, ledger); }
            await ledger.appendIfAbsent([entry]);
          },
        }).delete({ targetType: "knowledge", targetId: knowledgeId, deletionId: `deletion-${randomUUID()}` });
        await invalidateLocalObservationProjection(paths.root);
        return "knowledge?notice=deleted";
      } finally { await lease.release(); }
    }
    if (action === "revoke") { await service.revoke(common); return `knowledge/${encodeURIComponent(knowledgeId)}?notice=archived`; }
    const resolvesEvidenceIds = form.getAll("resolve");
    if (resolvesEvidenceIds.some((id) => !review.unresolvedEvidenceIds.includes(id))) throw new UiActionError("Counterevidence changed. Reload before confirming.", 409);
    const lines = (key: string) => scalar(form, key).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    const replacementScope = action === "replace" ? scopeSchema.safeParse(scalar(form, "replacementScope")) : undefined;
    if (replacementScope && !replacementScope.success) throw new UiActionError("Select a valid replacement scope.");
    const result = await service.resolve({ ...common, resolvesEvidenceIds,
      ...(action === "replace" ? { content: scalar(form, "content"), appliesWhen: lines("appliesWhen"), nonApplicability: lines("nonApplicability"),
        ...(replacementScope?.success ? { replacementScope: { scope: replacementScope.data, ...(scalar(form, "replacementScopeId") ? { scopeId: scalar(form, "replacementScopeId") } : {}) } } : {}) } : {}),
    });
    return `knowledge/${encodeURIComponent(result.candidate?.knowledgeId ?? knowledgeId)}?notice=confirmed`;
  } finally { await backend?.closeAsync(); store.close(); }
};
