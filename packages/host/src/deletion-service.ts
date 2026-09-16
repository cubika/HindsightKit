import { randomUUID } from "node:crypto";
import type {
  DeletionOperation,
  DeletionTargetType,
  EvidenceLedgerEntry,
  GateResult,
  DeletionPlannedIdentity,
} from "@provenloop/contracts";
import {
  CURRENT_SCHEMA_VERSION,
  gateResultSchema,
} from "@provenloop/contracts";
import {
  createDeletionCompletionEvidence,
  evaluateDeletionPropagation,
} from "@provenloop/evaluation";
import type {
  CaptureQueueIdentity,
  DeleteCaptureQueueResult,
} from "@provenloop/platform-windows";
import {
  WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import type {
  CanonicalDeletionMutationResult,
  CanonicalDeletionTarget,
} from "@provenloop/storage-sqlite";

import {
  BranchContextProjector,
  type BranchContextProjectionStore,
} from "./branch-context-projector.js";
import {
  WorkEpisodeProjector,
  type WorkEpisodeProjectionStore,
} from "./work-episode-projector.js";

export interface DeletionQueue {
  activeDeletionBarrier(): Promise<string | undefined>;
  beginDeletionBarrier(deletionId: string): Promise<void>;
  blockIdentities(
    identities: readonly CaptureQueueIdentity[],
  ): Promise<void>;
  deleteByIdentifiers(
    identifiers: ReadonlySet<string>,
    options?: {
      readonly beforeDelete?: (
        result: DeleteCaptureQueueResult,
      ) => Promise<void>;
      readonly queueItemIds?: ReadonlySet<string>;
      readonly sessionIds?: ReadonlySet<string>;
    },
  ): Promise<DeleteCaptureQueueResult>;
  remainingIdentifiers(
    identifiers: ReadonlySet<string>,
  ): Promise<readonly string[]>;
  remainingIdentities(
    identities: readonly CaptureQueueIdentity[],
  ): Promise<readonly CaptureQueueIdentity[]>;
  endDeletionBarrier(deletionId: string): Promise<void>;
}

export interface DeletionStore
extends WorkEpisodeProjectionStore, BranchContextProjectionStore {
  beginDeletion(
    target: CanonicalDeletionTarget,
    deletionId?: string,
  ): DeletionOperation;
  prepareDeletionCompletion(input: {
    readonly deletedDependentCount: number;
    readonly deletedQueueItemCount: number;
    readonly deletedSourceCount: number;
    readonly deletionId: string;
    readonly gateDigest: string;
    readonly propagationEvidenceId: string;
  }): DeletionOperation;
  completeDeletion(deletionId: string): DeletionOperation;
  checkpointDeletionQueue(input: {
    readonly deletionId: string;
    readonly identities: readonly DeletionPlannedIdentity[];
    readonly queueItemIds: readonly string[];
  }): DeletionOperation;
  deleteCanonicalTarget(
    deletionId: string,
    target: CanonicalDeletionTarget,
  ): CanonicalDeletionMutationResult;
  deletionOperation(
    deletionId: string,
  ): DeletionOperation | undefined;
  failDeletion(
    deletionId: string,
    error: unknown,
  ): DeletionOperation;
  remainingIdentifiers(
    identifiers: ReadonlySet<string>,
  ): readonly string[];
  remainingDeletionIdentities(
    identities: readonly DeletionPlannedIdentity[],
  ): readonly DeletionPlannedIdentity[];
  deleteQueueArtifacts(queueItemIds: readonly string[]): number;
}

export interface DeletionServiceOptions {
  readonly transientCleanup?: () => Promise<void>;
  readonly knowledgeProjection?: DeletionKnowledgeProjection;
  readonly now?: () => Date;
  readonly queue: DeletionQueue;
  readonly recordEvidence: (
    entry: EvidenceLedgerEntry,
  ) => Promise<void>;
  readonly store: DeletionStore;
}

export interface DeletionKnowledgeProjection {
  acquireLease(): Promise<{
    release(): Promise<void>;
  }>;
  rebuild(): Promise<void>;
  remainingIdentifiers(
    identifiers: ReadonlySet<string>,
  ): Promise<readonly string[]>;
}

export interface DeletionExecutionResult {
  readonly deletedDependentIds: readonly string[];
  readonly deletedQueueItemIds: readonly string[];
  readonly deletedSourceIds: readonly string[];
  readonly gate: GateResult;
  readonly ledgerEntry?: EvidenceLedgerEntry;
  readonly operation: DeletionOperation;
  readonly remainingIds: readonly string[];
}

export class DeletionPropagationGateError extends Error {
  public override readonly name = "DeletionPropagationGateError";
  public readonly gate: GateResult;

  public constructor(gate: GateResult) {
    super("Deletion propagation Gate failed.");
    this.gate = gate;
  }
}

const typedSourceIdentities = (
  target: CanonicalDeletionTarget,
  sourceIds: readonly string[],
  affectedSessionIds: readonly string[],
): readonly DeletionPlannedIdentity[] => {
  const identities = new Map<string, DeletionPlannedIdentity>();
  const add = (
    identityType: DeletionPlannedIdentity["identityType"],
    identifier: string,
  ): void => {
    identities.set(
      `${identityType}\u0000${identifier}`,
      {
        identifier,
        identityType,
      },
    );
  };
  if (target.targetType === "episode") {
    add("episode", target.targetId);
  } else if (target.targetType === "session") {
    add("session", target.targetId);
  }
  if (
    target.targetType === "session" ||
    target.targetType === "episode"
  ) {
    for (const sessionId of affectedSessionIds) {
      add("session", sessionId);
    }
  }
  for (const identifier of sourceIds) {
    if (/^event-[a-f0-9]{64}$/iu.test(identifier)) {
      add("event", identifier.toLowerCase());
    } else if (/^[a-f0-9]{64}$/iu.test(identifier)) {
      add("deduplication", identifier.toLowerCase());
    }
  }
  return [...identities.values()];
};

export class DeletionService {
  readonly #transientCleanup: (() => Promise<void>) | undefined;
  readonly #now: () => Date;
  readonly #branchContextProjector: BranchContextProjector;
  readonly #knowledgeProjection:
    | DeletionKnowledgeProjection
    | undefined;
  readonly #projector: WorkEpisodeProjector;
  readonly #queue: DeletionQueue;
  readonly #recordEvidence: (
    entry: EvidenceLedgerEntry,
  ) => Promise<void>;
  readonly #store: DeletionStore;

  public constructor(options: DeletionServiceOptions) {
    this.#transientCleanup = options.transientCleanup;
    this.#now = options.now ?? (() => new Date());
    this.#knowledgeProjection = options.knowledgeProjection;
    this.#queue = options.queue;
    this.#recordEvidence = options.recordEvidence;
    this.#store = options.store;
    this.#branchContextProjector = new BranchContextProjector({
      store: options.store,
    });
    this.#projector = new WorkEpisodeProjector({
      store: options.store,
    });
  }

  public async delete(input: {
    readonly deletionId?: string;
    readonly preflight?: () => Promise<void>;
    readonly targetId: string;
    readonly targetType: DeletionTargetType;
  }): Promise<DeletionExecutionResult> {
    const target: CanonicalDeletionTarget = {
      targetId: input.targetId,
      targetType: input.targetType,
    };
    const activeBarrier =
      await this.#queue.activeDeletionBarrier();
    if (activeBarrier !== undefined) {
      const barrierOperation =
        this.#store.deletionOperation(activeBarrier);
      if (
        barrierOperation === undefined ||
        barrierOperation.status === "completed"
      ) {
        // A preflight may own the barrier before any canonical operation exists.
        // Recover it only after the owning operation lease is no longer live.
        if (barrierOperation === undefined) {
          const barrierLease = await new WindowsNamedPipeLeaseProvider("deletion-" + activeBarrier).tryAcquire();
          if (barrierLease === undefined) throw new Error("This deletion operation is already executing.");
          try { await this.#queue.endDeletionBarrier(activeBarrier); }
          finally { await barrierLease.release(); }
        } else {
          await this.#queue.endDeletionBarrier(activeBarrier);
        }
      }
    }
    let operationLease: Awaited<
      ReturnType<WindowsNamedPipeLeaseProvider["tryAcquire"]>
    > = undefined;
    let operation: DeletionOperation;
    if (input.preflight !== undefined) {
      const deletionId = input.deletionId ?? randomUUID();
      operationLease = await new WindowsNamedPipeLeaseProvider("deletion-" + deletionId).tryAcquire();
      if (operationLease === undefined) throw new Error("This deletion operation is already executing.");
      let barrierStarted = false;
      try {
        await this.#queue.beginDeletionBarrier(deletionId);
        barrierStarted = true;
        await input.preflight();
        operation = this.#store.beginDeletion(target, deletionId);
        if (operation.deletionId !== deletionId) {
          // The store may resolve an already completed deletion of this target.
          await this.#queue.endDeletionBarrier(deletionId);
          barrierStarted = false;
          await operationLease.release();
          operationLease = undefined;
        }
      } catch (error) {
        try { if (barrierStarted) await this.#queue.endDeletionBarrier(deletionId); }
        finally { await operationLease?.release(); }
        throw error;
      }
    } else {
      operation = this.#store.beginDeletion(target, input.deletionId);
    }
    try {
      operationLease ??= await new WindowsNamedPipeLeaseProvider(
        `deletion-${operation.deletionId}`,
      ).tryAcquire();
    } catch (error) {
      if (this.#store.deletionOperation(operation.deletionId)?.status === "running") {
        this.#store.failDeletion(operation.deletionId, error);
      }
      throw error;
    }
    if (operationLease === undefined) {
      throw new Error(
        "This deletion operation is already executing.",
      );
    }
    let knowledgeProjectionLease:
      | Awaited<ReturnType<DeletionKnowledgeProjection["acquireLease"]>>
      | undefined;
    try {
      knowledgeProjectionLease =
        await this.#knowledgeProjection?.acquireLease();
      if (
        operation.status === "completed" &&
        operation.gateDigest !== undefined
      ) {
        await this.#queue.endDeletionBarrier(operation.deletionId);
        return {
          deletedDependentIds: [],
          deletedQueueItemIds: [],
          deletedSourceIds: [],
          gate: gateResultSchema.parse({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            evidenceIds:
              operation.propagationEvidenceId === undefined
                ? []
                : [
                    operation.propagationEvidenceId,
                  ],
            gateId: `${operation.deletionId}:deletion-propagation`,
            message:
              "Deletion was already completed and its evidence was recovered.",
            status: "pass",
          }),
          operation,
          remainingIds: [],
        };
      }
      if (
        operation.status === "completing" &&
        operation.gateDigest !== undefined &&
        operation.propagationEvidenceId !== undefined
      ) {
        await this.#queue.beginDeletionBarrier(
          operation.deletionId,
        );
        const completionEvidence = createDeletionCompletionEvidence({
          deletionId: operation.deletionId,
          gateDigest: operation.gateDigest,
          propagationEvidenceId: operation.propagationEvidenceId,
          timestamp: this.#now().toISOString(),
        });
        await this.#recordEvidence(completionEvidence);
        const completed = this.#store.completeDeletion(
          operation.deletionId,
        );
        await this.#queue.endDeletionBarrier(operation.deletionId);
        return {
          deletedDependentIds: [],
          deletedQueueItemIds:
            operation.plannedQueueItemIds ?? [],
          deletedSourceIds: operation.plannedSourceIds ?? [],
          gate: gateResultSchema.parse({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            evidenceIds: [
              operation.propagationEvidenceId,
              completionEvidence.ledgerEntryId,
            ],
            gateId: `${operation.deletionId}:deletion-propagation`,
            message:
              "Deletion completion evidence was recovered.",
            status: "pass",
          }),
          ledgerEntry: completionEvidence,
          operation: completed,
          remainingIds: [],
        };
      }
      let barrierStarted = false;
      try {
        await this.#queue.beginDeletionBarrier(
          operation.deletionId,
        );
        barrierStarted = true;
        await this.#transientCleanup?.();
        this.#projector.rebuild(undefined, {
          associationMode: "connected",
          allowDuringDeletion: true,
        });
        const mutation = this.#store.deleteCanonicalTarget(
          operation.deletionId,
          target,
        );
      const queueIdentifiers = new Set([
        ...mutation.sourceIds,
        ...(target.targetType === "session"
          ? mutation.affectedSessionIds
          : []),
      ]);
      await this.#queue.blockIdentities(
        typedSourceIdentities(
          target,
          mutation.sourceIds,
          mutation.affectedSessionIds,
        ),
      );
      const deletedQueue = await this.#queue.deleteByIdentifiers(
        queueIdentifiers,
        {
          beforeDelete: async (result) => {
            this.#store.checkpointDeletionQueue({
              deletionId: operation.deletionId,
              identities: result.identities,
              queueItemIds: result.queueItemIds,
            });
          },
          ...(target.targetType === "session" ||
          target.targetType === "episode"
            ? {
                sessionIds: new Set(
                  mutation.affectedSessionIds,
                ),
              }
            : {}),
          ...(operation.plannedQueueItemIds === undefined
            ? {}
            : {
                queueItemIds: new Set(
                  operation.plannedQueueItemIds,
                ),
              }),
        },
      );
      this.#store.deleteQueueArtifacts(
        deletedQueue.queueItemIds,
      );
      this.#projector.rebuild(undefined, {
        associationMode: "connected",
        allowDuringDeletion: true,
      });
      this.#branchContextProjector.rebuild({
        allowDuringDeletion: true,
      });
      await this.#knowledgeProjection?.rebuild();
      const checkpoint =
        this.#store.deletionOperation(operation.deletionId);
      const sourceIds = [
        ...new Set([
          ...mutation.sourceIds,
          ...deletedQueue.identities.map(
            (identity) => identity.identifier,
          ),
          ...(checkpoint?.plannedSourceIds ?? []),
          ...(checkpoint?.plannedQueueIdentities ?? []).map(
            (identity) => identity.identifier,
          ),
        ]),
      ].sort();
      const sourceIdentities = [
        ...new Map(
          [
            ...typedSourceIdentities(
              target,
              sourceIds,
              mutation.affectedSessionIds,
            ),
            ...deletedQueue.identities,
            ...(checkpoint?.plannedQueueIdentities ?? []),
          ].map((identity) => [
            `${identity.identityType}\u0000${identity.identifier}`,
            identity,
          ]),
        ).values(),
      ];
      const deletedQueueItemIds = [
        ...new Set([
          ...deletedQueue.queueItemIds,
          ...(checkpoint?.plannedQueueItemIds ?? []),
        ]),
      ].sort();
      const dependentIds = [
        ...new Set([
          ...mutation.dependentIds,
          ...deletedQueueItemIds,
        ]),
      ].sort();
      const dependentSet = new Set(dependentIds);
      const remainingSourceIdentities = [
        ...this.#store.remainingDeletionIdentities(
          sourceIdentities,
        ),
        ...await this.#queue.remainingIdentities(
          sourceIdentities,
        ),
      ];
      const remainingIds = [
        ...new Set([
          ...remainingSourceIdentities.map(
            (identity) =>
              `${identity.identityType}:${identity.identifier}`,
          ),
          ...this.#store
            .remainingIdentifiers(dependentSet)
            .map((identifier) => `record:${identifier}`),
          ...(await this.#queue.remainingIdentifiers(
            dependentSet,
          )).map((identifier) => `record:${identifier}`),
          ...(
            await this.#knowledgeProjection?.remainingIdentifiers(
              dependentSet,
            ) ?? []
          ).map((identifier) => `record:${identifier}`),
        ]),
      ].sort();
      const gateResult = evaluateDeletionPropagation({
        attemptCount: operation.attemptCount,
        deletionId: operation.deletionId,
        dependentIds: dependentIds.map(
          (identifier) => `record:${identifier}`,
        ),
        remainingIds,
        sourceIds: sourceIdentities.map(
          (identity) =>
            `${identity.identityType}:${identity.identifier}`,
        ),
        timestamp: this.#now().toISOString(),
      });
      await this.#recordEvidence(gateResult.ledgerEntry);
      if (gateResult.gate.status !== "pass") {
        throw new DeletionPropagationGateError(gateResult.gate);
      }
      this.#store.prepareDeletionCompletion({
        deletedDependentCount: dependentIds.length,
        deletedQueueItemCount: deletedQueueItemIds.length,
        deletedSourceCount: sourceIds.length,
        deletionId: operation.deletionId,
        gateDigest: gateResult.gateDigest,
        propagationEvidenceId:
          gateResult.ledgerEntry.ledgerEntryId,
      });
      const completionEvidence = createDeletionCompletionEvidence({
        deletionId: operation.deletionId,
        gateDigest: gateResult.gateDigest,
        propagationEvidenceId:
          gateResult.ledgerEntry.ledgerEntryId,
        timestamp: this.#now().toISOString(),
      });
      await this.#recordEvidence(completionEvidence);
      const completed = this.#store.completeDeletion(
        operation.deletionId,
      );
      return {
        deletedDependentIds: dependentIds,
        deletedQueueItemIds,
        deletedSourceIds: sourceIds,
        gate: gateResult.gate,
        ledgerEntry: completionEvidence,
        operation: completed,
        remainingIds,
      };
      } catch (error) {
        if (
          this.#store.deletionOperation(operation.deletionId)?.status ===
          "running"
        ) {
          this.#store.failDeletion(operation.deletionId, error);
        }
        throw error;
      } finally {
        if (
          barrierStarted &&
          this.#store.deletionOperation(operation.deletionId)
            ?.status === "completed"
        ) {
          await this.#queue.endDeletionBarrier(
            operation.deletionId,
          );
        }
      }
    } catch (error) {
      if (
        this.#store.deletionOperation(operation.deletionId)?.status ===
        "running"
      ) {
        this.#store.failDeletion(operation.deletionId, error);
      }
      throw error;
    } finally {
      try {
        await knowledgeProjectionLease?.release();
      } finally {
        await operationLease.release();
      }
    }
  }
}
