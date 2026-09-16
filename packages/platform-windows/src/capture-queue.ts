import {
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  captureQueueItemSchema,
  CURRENT_SCHEMA_VERSION,
  type CaptureQueueItem,
  type CaptureQueueState,
  type DeletionIdentityType,
} from "@provenloop/contracts";
import {
  createCaptureEnvelope,
  deletionIdentityDigest,
  isProvenLoopInternalEnvironment,
  sanitizeDiagnostic,
  type CaptureEventInput,
  type CaptureRedactionLimits,
} from "@provenloop/domain";

import {
  WindowsNamedPipeLeaseProvider,
  type ProcessLease,
} from "./process-lease.js";
import { isRecordsResetPending } from "./record-reset.js";

const queueItemIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export interface EnqueueCaptureOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly redactionLimits?: Partial<CaptureRedactionLimits>;
}

export type EnqueueCaptureIfAbsentResult =
  | {
      readonly status: "duplicate";
    }
  | {
      readonly item: CaptureQueueItem;
      readonly status: "enqueued";
    };

export interface CaptureQueueClaim {
  readonly attemptCount: number;
  readonly claimOwnerId: string;
  readonly queueItemId: string;
}

export interface DeleteCaptureQueueResult {
  readonly identities: readonly CaptureQueueIdentity[];
  readonly queueItemIds: readonly string[];
}

export interface CaptureQueueIdentity {
  readonly identifier: string;
  readonly identityType: DeletionIdentityType;
}

export interface DeleteCaptureQueueOptions {
  readonly beforeDelete?: (
    result: DeleteCaptureQueueResult,
  ) => Promise<void>;
  readonly queueItemIds?: ReadonlySet<string>;
  readonly sessionIds?: ReadonlySet<string>;
}

export interface WindowsCaptureQueueOptions {
  readonly acknowledgedRetentionMs?: number;
  readonly claimLeaseMs?: number;
  readonly idGenerator?: () => string;
  readonly maxAttempts?: number;
  readonly now?: () => Date;
  readonly processLeaseTimeoutMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly onDiagnostic?: (message: string) => void;
}

export interface CaptureQueueIssue {
  readonly queueItemId: string;
  readonly error: string;
}

export class CaptureQueueNotInitializedError extends Error {
  public override readonly name = "CaptureQueueNotInitializedError";

  public constructor() {
    super("The capture queue must be initialized before use.");
  }
}

export class CaptureQueueLeaseTimeoutError extends Error {
  public override readonly name = "CaptureQueueLeaseTimeoutError";

  public constructor() {
    super(
      "Timed out waiting for the ProvenLoop capture queue. Retry after the active queue operation completes.",
    );
  }
}

export class InvalidCaptureQueueConfigurationError extends Error {
  public override readonly name = "InvalidCaptureQueueConfigurationError";

  public constructor(option: string) {
    super(`Capture queue option ${option} must be a positive integer.`);
  }
}

export class InvalidQueueItemIdError extends Error {
  public override readonly name = "InvalidQueueItemIdError";

  public constructor() {
    super("Capture queue item ID is invalid.");
  }
}

export class DuplicateQueueItemIdError extends Error {
  public override readonly name = "DuplicateQueueItemIdError";

  public constructor(queueItemId: string) {
    super(`Capture queue item ${queueItemId} already exists.`);
  }
}

export class CaptureQueueItemNotFoundError extends Error {
  public override readonly name = "CaptureQueueItemNotFoundError";

  public constructor(queueItemId: string) {
    super(`Capture queue item ${queueItemId} was not found.`);
  }
}

export class CorruptCaptureQueueItemError extends Error {
  public override readonly name = "CorruptCaptureQueueItemError";

  public constructor(queueItemId: string) {
    super(`Capture queue item ${queueItemId} is malformed.`);
  }
}

export class InvalidCaptureQueueTransitionError extends Error {
  public override readonly name = "InvalidCaptureQueueTransitionError";

  public constructor(
    queueItemId: string,
    state: CaptureQueueState,
    operation: string,
  ) {
    super(
      `Cannot ${operation} capture queue item ${queueItemId} from ${state}.`,
    );
  }
}

export class StaleCaptureQueueClaimError extends Error {
  public override readonly name = "StaleCaptureQueueClaimError";

  public constructor(queueItemId: string) {
    super(`Capture queue claim for ${queueItemId} is stale or expired.`);
  }
}

export class CaptureQueueDeletionInProgressError extends Error {
  public override readonly name =
    "CaptureQueueDeletionInProgressError";

  public constructor() {
    super("Capture queue writes are blocked by an active deletion.");
  }
}

export class ConflictingCaptureQueueDeletionError extends Error {
  public override readonly name =
    "ConflictingCaptureQueueDeletionError";

  public constructor() {
    super("Another capture queue deletion barrier is active.");
  }
}

export class DeletedCaptureSourceError extends Error {
  public override readonly name = "DeletedCaptureSourceError";

  public constructor() {
    super("The capture source was deleted and cannot be replayed.");
  }
}

const positiveInteger = (
  value: number,
  option: string,
): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidCaptureQueueConfigurationError(option);
  }
  return value;
};

export class WindowsCaptureQueue {
  readonly #acknowledgedRetentionMs: number;
  readonly #claimLeaseMs: number;
  readonly #idGenerator: () => string;
  #initialized = false;
  readonly #maxAttempts: number;
  readonly #now: () => Date;
  #operationChain: Promise<void> = Promise.resolve();
  #processLease?: WindowsNamedPipeLeaseProvider;
  readonly #processLeaseTimeoutMs: number;
  readonly #retryBaseDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #root: string;
  readonly #onDiagnostic: ((message: string) => void) | undefined;
  #claimCandidates: string[] = [];
  #claimCandidateIndex = 0;

  public constructor(
    root: string,
    options: WindowsCaptureQueueOptions = {},
  ) {
    this.#root = resolve(root);
    this.#onDiagnostic = options.onDiagnostic;
    this.#acknowledgedRetentionMs = positiveInteger(
      options.acknowledgedRetentionMs ?? 7 * 24 * 60 * 60 * 1_000,
      "acknowledgedRetentionMs",
    );
    this.#claimLeaseMs = positiveInteger(
      options.claimLeaseMs ?? 30_000,
      "claimLeaseMs",
    );
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#maxAttempts = positiveInteger(
      options.maxAttempts ?? 3,
      "maxAttempts",
    );
    this.#now = options.now ?? (() => new Date());
    this.#processLeaseTimeoutMs = positiveInteger(
      options.processLeaseTimeoutMs ?? 5_000,
      "processLeaseTimeoutMs",
    );
    this.#retryBaseDelayMs = positiveInteger(
      options.retryBaseDelayMs ?? 1_000,
      "retryBaseDelayMs",
    );
    this.#retryMaxDelayMs = positiveInteger(
      options.retryMaxDelayMs ?? 60_000,
      "retryMaxDelayMs",
    );
  }

  public get root(): string {
    return this.#root;
  }

  public async initialize(): Promise<void> {
    await mkdir(this.#root, {
      recursive: true,
    });
    const leaseRoot = await realpath(this.#root);
    const leaseId = createHash("sha256")
      .update(leaseRoot.toLocaleLowerCase("en-US"))
      .digest("hex")
      .slice(0, 24);
    this.#processLease =
      new WindowsNamedPipeLeaseProvider(`capture-queue-${leaseId}`);
    this.#initialized = true;
    await this.#runExclusive(async () => {
      await mkdir(join(this.#root, ".active"), { recursive: true });
      await mkdir(join(this.#root, ".acknowledged"), { recursive: true });
      const marker = join(this.#root, ".indexes-v2");
      try {
        await access(marker);
        return;
      } catch (error) {
        if (!this.#isMissing(error)) {
          throw error;
        }
      }
      for await (const item of this.#iterateItems()) {
        await this.#updateStateIndex(item);
        await this.#claimSourceIndex(
          this.#sourceIndexPath(item.envelope.deduplicationKey),
          item.queueItemId,
          item.envelope.deduplicationKey,
        );
      }
      await writeFile(marker, "2\n", "utf8");
    });
  }

  public enqueue(
    input: CaptureEventInput,
    options: EnqueueCaptureOptions = {},
  ): Promise<CaptureQueueItem> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const now = this.#now().toISOString();
      const queueItemId = this.#nextQueueItemId();
      if (await this.#exists(queueItemId)) {
        throw new DuplicateQueueItemIdError(queueItemId);
      }
      const item = this.#pendingItem(
        input,
        options,
        queueItemId,
        now,
      );
      await this.#assertNoDeletionBarrier();
      if (await this.#predatesRecordsReset(item.envelope.event.timestamp)) throw new DeletedCaptureSourceError();
      if (
        await this.#identitiesBlocked([
          {
            identifier: item.envelope.deduplicationKey,
            identityType: "deduplication",
          },
          {
            identifier: item.envelope.event.eventId,
            identityType: "event",
          },
          ...(item.envelope.event.sessionId === undefined
            ? []
            : [
                {
                  identifier: item.envelope.event.sessionId,
                  identityType: "session" as const,
                },
              ]),
          ...(item.envelope.event.parentEventId === undefined
            ? []
            : [
                {
                  identifier: item.envelope.event.parentEventId,
                  identityType: "event" as const,
                },
              ]),
        ])
      ) {
        throw new DeletedCaptureSourceError();
      }
      const indexPath = this.#sourceIndexPath(item.envelope.deduplicationKey);
      const existing = await this.#validatedSourceIndex(indexPath, item.envelope.deduplicationKey);
      if (existing === undefined) await this.#writeSourceIndex(indexPath, queueItemId);
      try {
        await this.#write(item);
      } catch (error) {
        if (existing === undefined && !await this.#exists(queueItemId)) {
          await this.#removeSourceIndexIfOwned(indexPath, queueItemId);
        }
        throw error;
      }
      return item;
    });
  }

  public enqueueIfSourceAbsent(
    input: CaptureEventInput,
    options: EnqueueCaptureOptions = {},
  ): Promise<EnqueueCaptureIfAbsentResult> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const now = this.#now().toISOString();
      const queueItemId = this.#nextQueueItemId();
      if (await this.#exists(queueItemId)) {
        throw new DuplicateQueueItemIdError(queueItemId);
      }
      const item = this.#pendingItem(
        input,
        options,
        queueItemId,
        now,
      );
      await this.#assertNoDeletionBarrier();
      if (await this.#predatesRecordsReset(item.envelope.event.timestamp)) return { status: "duplicate" };
      if (
        await this.#identitiesBlocked([
          {
            identifier: item.envelope.deduplicationKey,
            identityType: "deduplication",
          },
          {
            identifier: item.envelope.event.eventId,
            identityType: "event",
          },
          ...(item.envelope.event.sessionId === undefined
            ? []
            : [
                {
                  identifier: item.envelope.event.sessionId,
                  identityType: "session" as const,
                },
              ]),
          ...(item.envelope.event.parentEventId === undefined
            ? []
            : [
                {
                  identifier: item.envelope.event.parentEventId,
                  identityType: "event" as const,
                },
              ]),
        ])
      ) {
        return {
          status: "duplicate",
        };
      }
      const indexPath = this.#sourceIndexPath(
        item.envelope.deduplicationKey,
      );
      const indexedQueueItemId =
        await this.#validatedSourceIndex(
          indexPath,
          item.envelope.deduplicationKey,
        );
      if (indexedQueueItemId !== undefined) {
        return {
          status: "duplicate",
        };
      }

      // Reserve the source before publishing the item. A crash can leave an
      // orphan index, but never an unindexed published item.
      await this.#writeSourceIndex(indexPath, queueItemId);
      try {
        await this.#write(item);
      } catch (error) {
        if (!await this.#exists(queueItemId)) {
          await this.#removeSourceIndexIfOwned(indexPath, queueItemId);
        }
        throw error;
      }
      return {
        status: "enqueued",
        item,
      };
    });
  }

  public list(
    state?: CaptureQueueState,
  ): Promise<readonly CaptureQueueItem[]> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const items = await this.#readAll();
      return state === undefined
        ? items
        : items.filter((item) => item.state === state);
    });
  }

  /** Reset only this owned queue while its capture barrier is held. */
  public clearAllRecords(cutoff: string): Promise<{ readonly clearedItems: number }> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const timestamp = Date.parse(cutoff);
      if (!Number.isFinite(timestamp) || timestamp > this.#now().getTime()) {
        throw new Error("Queue reset cutoff must be a valid time no later than now.");
      }
      if (!await this.#deletionBarrierActive()) throw new Error("Queue reset requires an active capture barrier.");
      const root = await realpath(this.#root);
      if ((await lstat(this.#root)).isSymbolicLink() || root.toLowerCase() !== this.#root.toLowerCase()) {
        throw new Error("Queue reset refuses indirect queue roots.");
      }
      const previous = await this.#recordsResetCutoff();
      if (previous !== undefined && timestamp < previous) throw new Error("Queue reset cutoff cannot move backwards.");
      const protectedPaths = new Set([
        join(this.#root, ".deletion", "active"),
        join(this.#root, ".records-reset-cutoff"),
      ]);
      const files: string[] = [];
      const directories: string[] = [];
      let clearedItems = 0;
      const collect = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          const within = relative(this.#root, path);
          if (within === "" || within === ".." || within.startsWith(".." + sep)) throw new Error("Queue reset path escaped its root.");
          const info = await lstat(path);
          if (info.isSymbolicLink()) throw new Error("Queue reset refuses indirect child paths.");
          if (protectedPaths.has(path)) {
            if (!info.isFile()) throw new Error("Queue reset marker must be a regular file.");
            continue;
          }
          if (info.isDirectory()) {
            await collect(path);
            if (path !== join(this.#root, ".deletion")) directories.push(path);
          } else if (info.isFile()) {
            files.push(path);
            if (directory === this.#root && entry.name.endsWith(".json")) clearedItems += 1;
          } else throw new Error("Queue reset encountered an unsupported filesystem entry.");
        }
      };
      // Inventory before changing records. File contents may be corrupt and are
      // deliberately not parsed; recursive filesystem links are never followed.
      await collect(this.#root);
      const marker = join(this.#root, ".records-reset-cutoff");
      const pending = marker + "." + randomUUID() + ".tmp";
      try {
        const handle = await open(pending, "wx");
        try { await handle.writeFile(new Date(timestamp).toISOString() + "\n", "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        await rename(pending, marker);
      } finally { await unlink(pending).catch((error: unknown) => { if (!this.#isMissing(error)) throw error; }); }
      for (const path of files) await unlink(path).catch((error: unknown) => { if (!this.#isMissing(error)) throw error; });
      for (const path of directories) await rmdir(path).catch((error: unknown) => { if (!this.#isMissing(error)) throw error; });
      await mkdir(join(this.#root, ".active"), { recursive: true });
      await mkdir(join(this.#root, ".acknowledged"), { recursive: true });
      await writeFile(join(this.#root, ".indexes-v2"), "2\n", "utf8");
      this.#claimCandidates = [];
      this.#claimCandidateIndex = 0;
      return { clearedItems };
    });
  }

  async #recordsResetCutoff(): Promise<number | undefined> {
    const path = join(this.#root, ".records-reset-cutoff");
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 128) throw new Error("Invalid queue reset cutoff marker.");
      const timestamp = Date.parse((await readFile(path, "utf8")).trim());
      if (!Number.isFinite(timestamp)) throw new Error("Invalid queue reset cutoff marker.");
      return timestamp;
    } catch (error) { if (this.#isMissing(error)) return undefined; throw error; }
  }

  async #predatesRecordsReset(timestamp: string): Promise<boolean> {
    const cutoff = await this.#recordsResetCutoff();
    return cutoff !== undefined && Date.parse(timestamp) <= cutoff;
  }

  public get(queueItemId: string): Promise<CaptureQueueItem> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      return this.#read(queueItemId);
    });
  }

  public depth(): Promise<number> {
    return this.#runExclusive(async () =>
      (await readdir(join(this.#root, ".active"))).length,
    );
  }

  public quarantineIssues(): Promise<readonly CaptureQueueIssue[]> {
    return this.#runExclusive(async () => {
      const root = join(this.#root, ".quarantine");
      let names: string[];
      try {
        names = await readdir(root);
      } catch (error) {
        if (this.#isMissing(error)) {
          return [];
        }
        throw error;
      }
      return names.filter((name) => name.endsWith(".json")).sort().map(
        (name) => ({
          queueItemId: name.slice(0, -5),
          error: "Malformed queue item was isolated; healthy items remain available.",
        }),
      );
    });
  }

  public claimNext(
    claimOwnerId: string,
  ): Promise<CaptureQueueItem | undefined> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      if (await this.#deletionBarrierActive()) {
        return undefined;
      }
      if (claimOwnerId.trim().length === 0) {
        throw new InvalidQueueItemIdError();
      }
      const now = this.#now();
      if (this.#claimCandidateIndex >= this.#claimCandidates.length) {
        this.#claimCandidates = await this.#activeNames();
        this.#claimCandidateIndex = 0;
      }
      let item: CaptureQueueItem | undefined;
      while (this.#claimCandidateIndex < this.#claimCandidates.length) {
        const name = this.#claimCandidates[this.#claimCandidateIndex++];
        if (name === undefined) {
          break;
        }
        const candidate = await this.#readIndexed(".active", name);
        if (
          candidate?.state === "pending" ||
          (candidate?.state === "retry" &&
            Date.parse(candidate.nextAttemptAt) <= now.getTime())
        ) {
          item = candidate;
          break;
        }
      }
      if (item === undefined) {
        return undefined;
      }
      const timestamp = now.toISOString();
      const claimed = captureQueueItemSchema.parse({
        ...this.#baseItem(item, timestamp),
        attemptCount: item.attemptCount + 1,
        claimedAt: timestamp,
        claimExpiresAt: new Date(
          now.getTime() + this.#claimLeaseMs,
        ).toISOString(),
        claimOwnerId,
        state: "claimed",
      });
      await this.#write(claimed);
      return claimed;
    });
  }

  public acknowledge(
    claim: CaptureQueueClaim,
  ): Promise<CaptureQueueItem> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const item = await this.#read(claim.queueItemId);
      this.#assertActiveClaim(item, claim, "acknowledge");
      const timestamp = this.#now().toISOString();
      const acknowledged = captureQueueItemSchema.parse({
        ...this.#baseItem(item, timestamp),
        acknowledgedAt: timestamp,
        state: "acknowledged",
      });
      await this.#write(acknowledged);
      return acknowledged;
    });
  }

  public retry(
    claim: CaptureQueueClaim,
    error: unknown,
    nextAttemptAt?: string,
  ): Promise<CaptureQueueItem> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const item = await this.#read(claim.queueItemId);
      this.#assertActiveClaim(item, claim, "retry");
      return this.#retryClaimed(item, error, nextAttemptAt);
    });
  }

  public retryAfterCommit(
    claim: CaptureQueueClaim,
    error: unknown,
  ): Promise<CaptureQueueItem> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const item = await this.#read(claim.queueItemId);
      this.#assertActiveClaim(
        item,
        claim,
        "retry after commit",
      );
      return this.#retryClaimed(
        item,
        error,
        undefined,
        false,
      );
    });
  }

  public deadLetter(
    claim: CaptureQueueClaim,
    error: unknown,
  ): Promise<CaptureQueueItem> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const item = await this.#read(claim.queueItemId);
      this.#assertActiveClaim(item, claim, "dead-letter");
      const deadLetter = this.#deadLetterItem(item, error);
      await this.#write(deadLetter);
      return deadLetter;
    });
  }

  public recoverExpiredClaims(): Promise<readonly CaptureQueueItem[]> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      if (await this.#deletionBarrierActive()) {
        return [];
      }
      const now = this.#now();
      const expired = (await this.#readActive()).filter(
        (
          item,
        ): item is Extract<
          CaptureQueueItem,
          { readonly state: "claimed" }
        > =>
          item.state === "claimed" &&
          Date.parse(item.claimExpiresAt) <= now.getTime(),
      );
      const recovered: CaptureQueueItem[] = [];
      for (const item of expired) {
        recovered.push(
          await this.#retryClaimed(
            item,
            "Claim lease expired before acknowledgement.",
            undefined,
            false,
          ),
        );
      }
      return recovered;
    });
  }

  public pruneAcknowledged(): Promise<readonly string[]> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const cutoff =
        this.#now().getTime() - this.#acknowledgedRetentionMs;
      const acknowledged: CaptureQueueItem[] = [];
      const names = await readdir(join(this.#root, ".acknowledged"));
      for (const name of names.sort()) {
        if (Number(name.slice(0, 16)) > cutoff) {
          break;
        }
        const item = await this.#readIndexed(".acknowledged", name);
        if (item?.state === "acknowledged" &&
            Date.parse(item.acknowledgedAt) <= cutoff) {
          acknowledged.push(item);
        }
      }
      for (const item of acknowledged) {
        await unlink(this.#path(item.queueItemId));
        await this.#removeStateIndexes(item);
        await this.#removeSourceIndexIfOwned(
          this.#sourceIndexPath(
            item.envelope.deduplicationKey,
          ),
          item.queueItemId,
        );
      }
      return acknowledged.map((item) => item.queueItemId);
    });
  }

  public beginDeletionBarrier(deletionId: string): Promise<void> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const normalized = deletionId.trim();
      if (normalized.length === 0) {
        throw new InvalidQueueItemIdError();
      }
      const path = this.#deletionBarrierPath();
      const deletionRoot = join(this.#root, ".deletion");
      await mkdir(deletionRoot, {
        recursive: true,
      });
      const temporaryPath = join(
        deletionRoot,
        `active.${randomUUID()}.tmp`,
      );
      const handle = await open(temporaryPath, "wx");
      try {
        try {
          await handle.writeFile(normalized, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await link(temporaryPath, path);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          const active = (await readFile(path, "utf8")).trim();
          if (active === normalized) {
            return;
          }
          throw new ConflictingCaptureQueueDeletionError();
        }
        throw error;
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    });
  }

  public activeDeletionBarrier(): Promise<string | undefined> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      try {
        const active = (
          await readFile(this.#deletionBarrierPath(), "utf8")
        ).trim();
        return active.length === 0 ? undefined : active;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return undefined;
        }
        throw error;
      }
    });
  }

  public endDeletionBarrier(deletionId: string): Promise<void> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const path = this.#deletionBarrierPath();
      let active: string;
      try {
        active = (await readFile(path, "utf8")).trim();
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return;
        }
        throw error;
      }
      if (active !== deletionId.trim()) {
        throw new ConflictingCaptureQueueDeletionError();
      }
      await unlink(path);
    });
  }

  public blockIdentities(
    identities: readonly CaptureQueueIdentity[],
  ): Promise<void> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      await this.#blockIdentitiesExclusive(identities);
    });
  }

  public deleteByIdentifiers(
    identifiers: ReadonlySet<string>,
    options: DeleteCaptureQueueOptions = {},
  ): Promise<DeleteCaptureQueueResult> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const normalized = new Set(
        [...identifiers]
          .map((identifier) => identifier.trim())
          .filter((identifier) => identifier.length > 0),
      );
      if (normalized.size === 0) {
        return {
          identities: [],
          queueItemIds: [],
        };
      }
      try {
        const quarantined = await readdir(join(this.#root, ".quarantine"));
        if (quarantined.some((name) => name.endsWith(".json"))) {
          throw new Error(
            "Targeted deletion requires reviewing quarantined capture files; their identities cannot be safely determined.",
          );
        }
      } catch (error) {
        if (!this.#isMissing(error)) throw error;
      }
      const entries = await readdir(this.#root, {
        withFileTypes: true,
      });
      const queueTemporaryFiles = entries.filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith(".queue-") &&
          entry.name.endsWith(".tmp"),
      );
      const sourceTemporaryFiles = entries.filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith(".source-") &&
          entry.name.endsWith(".tmp"),
      );
      const temporaryItems: {
        readonly entryName: string;
        readonly item: CaptureQueueItem;
      }[] = [];
      for (const entry of queueTemporaryFiles) {
        try {
          const parsed = captureQueueItemSchema.safeParse(
            JSON.parse(
              await readFile(join(this.#root, entry.name), "utf8"),
            ) as unknown,
          );
          if (parsed.success) {
            temporaryItems.push({
              entryName: entry.name,
              item: parsed.data,
            });
          }
        } catch {
          // Partial artifacts remain unless their filename identifies a match.
        }
      }
      const allItems = [
        ...await this.#readAll(),
        ...temporaryItems.map(({ item }) => item),
      ];
      const matched = new Map<string, CaptureQueueItem>();
      let changed: boolean;
      do {
        changed = false;
        for (const item of allItems) {
          if (matched.has(item.queueItemId)) {
            continue;
          }
          const direct = [
            item.envelope.deduplicationKey,
            item.envelope.event.eventId,
          ].some(
            (identifier) =>
              identifier !== undefined &&
              normalized.has(identifier),
          ) ||
            options.queueItemIds?.has(item.queueItemId) === true ||
            (
              item.envelope.event.sessionId !== undefined &&
              options.sessionIds?.has(
                item.envelope.event.sessionId,
              ) === true
            );
          if (
            !direct &&
            !(
              item.envelope.event.parentEventId !== undefined &&
              normalized.has(item.envelope.event.parentEventId)
            )
          ) {
            continue;
          }
          matched.set(item.queueItemId, item);
          normalized.add(item.queueItemId);
          normalized.add(item.envelope.deduplicationKey);
          normalized.add(item.envelope.event.eventId);
          changed = true;
        }
      } while (changed);
      const identities: CaptureQueueIdentity[] = [
        ...matched.values(),
      ].flatMap((item) => [
        {
          identifier: item.envelope.deduplicationKey,
          identityType: "deduplication" as const,
        },
        {
          identifier: item.envelope.event.eventId,
          identityType: "event" as const,
        },
      ]);
      await this.#blockIdentitiesExclusive(identities);
      const result: DeleteCaptureQueueResult = {
        identities: [
          ...new Map(
            identities.map((identity) => [
              `${identity.identityType}\u0000${identity.identifier}`,
              identity,
            ]),
          ).values(),
        ].sort(
          (left, right) =>
            left.identityType.localeCompare(right.identityType) ||
            left.identifier.localeCompare(right.identifier),
        ),
        queueItemIds: [...matched.values()]
          .map((item) => item.queueItemId)
          .sort(),
      };
      await options.beforeDelete?.(result);
      for (const item of matched.values()) {
        await unlink(this.#path(item.queueItemId)).catch(
          (error: unknown) => {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
            ) {
              throw error;
            }
          },
        );
        await this.#removeStateIndexes(item);
        await this.#removeSourceIndexIfOwned(
          this.#sourceIndexPath(
            item.envelope.deduplicationKey,
          ),
          item.queueItemId,
        );
      }
      const cleanupQueueItemIds = new Set([
        ...matched.keys(),
        ...(options.queueItemIds ?? []),
      ]);
      const temporaryArtifactsToDelete = new Set(
        temporaryItems
          .filter(({ item }) =>
            cleanupQueueItemIds.has(item.queueItemId),
          )
          .map(({ entryName }) => entryName),
      );
      for (const entry of queueTemporaryFiles) {
        if (
          [...cleanupQueueItemIds].some((queueItemId) =>
            entry.name.startsWith(`.queue-${queueItemId}-`),
          )
        ) {
          temporaryArtifactsToDelete.add(entry.name);
        }
      }
      for (const entry of sourceTemporaryFiles) {
        try {
          const queueItemId = (
            await readFile(join(this.#root, entry.name), "utf8")
          ).trim();
          if (
            cleanupQueueItemIds.has(queueItemId) ||
            normalized.has(queueItemId)
          ) {
            temporaryArtifactsToDelete.add(entry.name);
          }
        } catch {
          // Unknown source-index artifacts are preserved rather than overdeleted.
        }
      }
      for (const entryName of temporaryArtifactsToDelete) {
        await unlink(join(this.#root, entryName)).catch(
          () => undefined,
        );
      }
      const remainingQueueIds = new Set(
        (await this.#readAll()).map((item) => item.queueItemId),
      );
      const indexEntries = await readdir(this.#root, {
        withFileTypes: true,
      });
      for (const entry of indexEntries) {
        if (
          !entry.isFile() ||
          !entry.name.startsWith(".source-") ||
          !entry.name.endsWith(".idx")
        ) {
          continue;
        }
        const deduplicationKey = entry.name.slice(
          ".source-".length,
          -".idx".length,
        );
        const path = join(this.#root, entry.name);
        const indexedQueueItemId = (
          await readFile(path, "utf8")
        ).trim();
        if (
          normalized.has(deduplicationKey) ||
          normalized.has(indexedQueueItemId) ||
          !remainingQueueIds.has(indexedQueueItemId)
        ) {
          await unlink(path);
        }
      }
      return result;
    });
  }

  public remainingIdentifiers(
    identifiers: ReadonlySet<string>,
  ): Promise<readonly string[]> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const remaining = new Set<string>();
      for (const item of await this.#readAll()) {
        for (const identifier of [
          item.queueItemId,
          item.envelope.deduplicationKey,
          item.envelope.event.eventId,
          item.envelope.event.sessionId,
        ]) {
          if (
            identifier !== undefined &&
            identifiers.has(identifier)
          ) {
            remaining.add(identifier);
          }
        }
        const parentEventId = item.envelope.event.parentEventId;
        if (
          parentEventId !== undefined &&
          identifiers.has(parentEventId)
        ) {
          remaining.add(parentEventId);
        }
      }
      const artifacts = await readdir(this.#root, {
        withFileTypes: true,
      });
      for (const artifact of artifacts) {
        if (
          !artifact.isFile() ||
          !(
            artifact.name.endsWith(".tmp") ||
            artifact.name.endsWith(".idx")
          )
        ) {
          continue;
        }
        const content = await readFile(
          join(this.#root, artifact.name),
          "utf8",
        );
        if (
          artifact.name.startsWith(".queue-") &&
          artifact.name.endsWith(".tmp")
        ) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(content) as unknown;
          } catch {
            throw new Error(
              "An incomplete queue crash artifact remains after deletion.",
            );
          }
          const item = captureQueueItemSchema.parse(parsed);
          for (const identifier of [
            item.queueItemId,
            item.envelope.deduplicationKey,
            item.envelope.event.eventId,
            item.envelope.event.sessionId,
            item.envelope.event.parentEventId,
          ]) {
            if (
              identifier !== undefined &&
              identifiers.has(identifier)
            ) {
              remaining.add(identifier);
            }
          }
          continue;
        }
        if (artifact.name.endsWith(".idx")) {
          const deduplicationKey = artifact.name.slice(
            ".source-".length,
            -".idx".length,
          );
          if (identifiers.has(deduplicationKey)) {
            remaining.add(deduplicationKey);
          }
        }
        const queueItemId = content.trim();
        if (identifiers.has(queueItemId)) {
          remaining.add(queueItemId);
        }
      }
      return [...remaining].sort();
    });
  }

  public remainingIdentities(
    identities: readonly CaptureQueueIdentity[],
  ): Promise<readonly CaptureQueueIdentity[]> {
    return this.#runExclusive(async () => {
      this.#assertInitialized();
      const remaining = new Map<string, CaptureQueueIdentity>();
      const record = (identity: CaptureQueueIdentity): void => {
        remaining.set(
          `${identity.identityType}\u0000${identity.identifier}`,
          identity,
        );
      };
      for (const item of await this.#readAll()) {
        for (const identity of identities) {
          const present =
            identity.identityType === "deduplication"
              ? item.envelope.deduplicationKey === identity.identifier
              : identity.identityType === "event"
                ? (
                    item.envelope.event.eventId ===
                      identity.identifier ||
                    item.envelope.event.parentEventId ===
                      identity.identifier
                  )
                : identity.identityType === "session"
                  ? item.envelope.event.sessionId ===
                    identity.identifier
                  : false;
          if (present) {
            record(identity);
          }
        }
      }
      const artifacts = await readdir(this.#root, {
        withFileTypes: true,
      });
      for (const artifact of artifacts) {
        if (
          !artifact.isFile() ||
          !artifact.name.endsWith(".idx")
        ) {
          continue;
        }
        const deduplicationKey = artifact.name.slice(
          ".source-".length,
          -".idx".length,
        );
        for (const identity of identities) {
          if (
            identity.identityType === "deduplication" &&
            identity.identifier === deduplicationKey
          ) {
            record(identity);
          }
        }
      }
      return [...remaining.values()].sort(
        (left, right) =>
          left.identityType.localeCompare(right.identityType) ||
          left.identifier.localeCompare(right.identifier),
      );
    });
  }

  async #assertNoDeletionBarrier(): Promise<void> {
    if (await this.#deletionBarrierActive() || await isRecordsResetPending(dirname(this.#root))) {
      throw new CaptureQueueDeletionInProgressError();
    }
  }

  async #deletionBarrierActive(): Promise<boolean> {
    try {
      await access(this.#deletionBarrierPath());
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }

  async #identityBlocked(
    identity: CaptureQueueIdentity,
  ): Promise<boolean> {
    const key = await this.#readDeletionIdentityKey();
    if (key === undefined) {
      return false;
    }
    try {
      await access(
        this.#deletionTombstonePath(
          identity.identityType,
          deletionIdentityDigest(
            identity.identityType,
            identity.identifier,
            key,
          ),
        ),
      );
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }

  async #identitiesBlocked(
    identities: readonly CaptureQueueIdentity[],
  ): Promise<boolean> {
    for (const identity of identities) {
      if (await this.#identityBlocked(identity)) {
        return true;
      }
    }
    return false;
  }

  async #blockIdentitiesExclusive(
    identities: readonly CaptureQueueIdentity[],
  ): Promise<void> {
    await mkdir(this.#deletionTombstoneRoot(), {
      recursive: true,
    });
    const identityKey = await this.#deletionIdentityKey();
    for (const identity of identities) {
      const digest = deletionIdentityDigest(
        identity.identityType,
        identity.identifier,
        identityKey,
      );
      const path = this.#deletionTombstonePath(
        identity.identityType,
        digest,
      );
      try {
        const handle = await open(path, "wx");
        await handle.close();
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  #deletionBarrierPath(): string {
    return join(this.#root, ".deletion", "active");
  }

  #deletionTombstoneRoot(): string {
    return join(this.#root, ".deletion", "tombstones");
  }

  async #deletionIdentityKey(): Promise<string> {
    const deletionRoot = join(this.#root, ".deletion");
    const path = this.#deletionIdentityKeyPath();
    await mkdir(deletionRoot, {
      recursive: true,
    });
    try {
      const existing = (await readFile(path, "utf8")).trim();
      if (/^[a-f0-9]{64}$/u.test(existing)) {
        await this.#ensureDeletionKeyVerifier(existing);
        return existing;
      }
      throw new Error("Capture queue deletion identity key is malformed.");
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
    }
    const generated = randomBytes(32).toString("hex");
    const temporaryPath = join(
      deletionRoot,
      `identity-key.${randomUUID()}.tmp`,
    );
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(generated, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, path);
      await this.#writeDeletionKeyVerifier(generated);
      return generated;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        const existing = (await readFile(path, "utf8")).trim();
        if (/^[a-f0-9]{64}$/u.test(existing)) {
          await this.#ensureDeletionKeyVerifier(existing);
          return existing;
        }
      }
      throw error;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  #deletionIdentityKeyPath(): string {
    return join(this.#root, ".deletion", "identity.key");
  }

  #deletionKeyVerifierPath(): string {
    return join(this.#root, ".deletion", "identity.verifier");
  }

  async #readDeletionIdentityKey(): Promise<string | undefined> {
    let key: string;
    try {
      key = (
        await readFile(this.#deletionIdentityKeyPath(), "utf8")
      ).trim();
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        if (await this.#hasDeletionTombstones()) {
          throw new Error(
            "Capture queue deletion identity key is missing.",
            {
              cause: error,
            },
          );
        }
        return undefined;
      }
      throw error;
    }
    if (!/^[a-f0-9]{64}$/u.test(key)) {
      throw new Error(
        "Capture queue deletion identity key is malformed.",
      );
    }
    const expected = deletionIdentityDigest(
      "key",
      "provenloop-queue-tombstone-key",
      key,
    );
    let verifier: string;
    try {
      verifier = (
        await readFile(this.#deletionKeyVerifierPath(), "utf8")
      ).trim();
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT" &&
        !await this.#hasDeletionTombstones()
      ) {
        await this.#writeDeletionKeyVerifier(key);
        return key;
      }
      throw new Error(
        "Capture queue deletion key verifier is missing.",
        {
          cause: error,
        },
      );
    }
    if (verifier !== expected) {
      throw new Error(
        "Capture queue deletion identity key does not match tombstones.",
      );
    }
    return key;
  }

  async #ensureDeletionKeyVerifier(key: string): Promise<void> {
    if (!await this.#hasDeletionTombstones()) {
      await this.#writeDeletionKeyVerifier(key);
      return;
    }
    await this.#readDeletionIdentityKey();
  }

  async #writeDeletionKeyVerifier(key: string): Promise<void> {
    const verifier = deletionIdentityDigest(
      "key",
      "provenloop-queue-tombstone-key",
      key,
    );
    await writeFile(
      this.#deletionKeyVerifierPath(),
      verifier,
      "utf8",
    );
  }

  async #hasDeletionTombstones(): Promise<boolean> {
    try {
      return (
        await readdir(this.#deletionTombstoneRoot())
      ).length > 0;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }

  #deletionTombstonePath(
    identityType: DeletionIdentityType,
    digest: string,
  ): string {
    return join(
      this.#deletionTombstoneRoot(),
      `${identityType}-${digest}`,
    );
  }

  async #retryClaimed(
    item: Extract<CaptureQueueItem, { readonly state: "claimed" }>,
    error: unknown,
    nextAttemptAt?: string,
    enforceAttemptLimit = true,
  ): Promise<CaptureQueueItem> {
    const failureCount = enforceAttemptLimit
      ? item.failureCount + 1
      : item.failureCount;
    if (
      enforceAttemptLimit &&
      failureCount >= this.#maxAttempts
    ) {
      const deadLetter = this.#deadLetterItem(
        item,
        error,
        failureCount,
      );
      await this.#write(deadLetter);
      return deadLetter;
    }
    const now = this.#now();
    const timestamp = now.toISOString();
    const retryItem = captureQueueItemSchema.parse({
      ...this.#baseItem(item, timestamp),
      failureCount,
      lastError: sanitizeDiagnostic(error),
      nextAttemptAt:
        nextAttemptAt ??
        new Date(
          now.getTime() + this.#retryDelay(failureCount),
        ).toISOString(),
      state: "retry",
    });
    await this.#write(retryItem);
    return retryItem;
  }

  #deadLetterItem(
    item: CaptureQueueItem,
    error: unknown,
    failureCount = item.failureCount,
  ): CaptureQueueItem {
    return captureQueueItemSchema.parse({
      ...this.#baseItem(item, this.#now().toISOString()),
      failureCount,
      lastError: sanitizeDiagnostic(error),
      state: "dead-letter",
    });
  }

  #retryDelay(attemptCount: number): number {
    return Math.min(
      this.#retryBaseDelayMs * 2 ** Math.max(0, attemptCount - 1),
      this.#retryMaxDelayMs,
    );
  }

  #assertActiveClaim(
    item: CaptureQueueItem,
    claim: CaptureQueueClaim,
    operation: string,
  ): asserts item is Extract<
    CaptureQueueItem,
    { readonly state: "claimed" }
  > {
    if (item.state !== "claimed") {
      throw new InvalidCaptureQueueTransitionError(
        claim.queueItemId,
        item.state,
        operation,
      );
    }
    if (
      item.claimOwnerId !== claim.claimOwnerId ||
      item.attemptCount !== claim.attemptCount ||
      Date.parse(item.claimExpiresAt) <= this.#now().getTime()
    ) {
      throw new StaleCaptureQueueClaimError(claim.queueItemId);
    }
  }

  #baseItem(
    item: CaptureQueueItem,
    updatedAt: string,
  ): {
    readonly attemptCount: number;
    readonly createdAt: string;
    readonly envelope: CaptureQueueItem["envelope"];
    readonly failureCount: number;
    readonly queueItemId: string;
    readonly schemaVersion: 1;
    readonly updatedAt: string;
  } {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      attemptCount: item.attemptCount,
      createdAt: item.createdAt,
      envelope: item.envelope,
      failureCount: item.failureCount,
      queueItemId: item.queueItemId,
      updatedAt,
    };
  }

  #pendingItem(
    input: CaptureEventInput,
    options: EnqueueCaptureOptions,
    queueItemId: string,
    now: string,
  ): CaptureQueueItem {
    const internalSession =
      input.internalSession === true ||
      isProvenLoopInternalEnvironment(
        options.environment ?? process.env,
      );
    const envelope = createCaptureEnvelope(
      {
        ...input,
        ...(internalSession
          ? {
              internalSession: true,
            }
          : {}),
      },
      {
        capturedAt: now,
        ...(options.redactionLimits === undefined
          ? {}
          : {
              redactionLimits: options.redactionLimits,
            }),
      },
    );
    return captureQueueItemSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      attemptCount: 0,
      createdAt: now,
      envelope,
      failureCount: 0,
      queueItemId,
      state: "pending",
      updatedAt: now,
    });
  }

  async *#iterateItems(): AsyncGenerator<CaptureQueueItem> {
    const entries = await readdir(this.#root, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const queueItemId = entry.name.slice(0, -5);
      try {
        yield await this.#read(queueItemId);
      } catch (error) {
        if (error instanceof CaptureQueueItemNotFoundError) {
          continue;
        }
        if (!(error instanceof CorruptCaptureQueueItemError ||
              error instanceof InvalidQueueItemIdError)) {
          throw error;
        }
        await this.#quarantine(queueItemId, entry.name);
      }
    }
  }

  async #readAll(): Promise<readonly CaptureQueueItem[]> {
    const items: CaptureQueueItem[] = [];
    for await (const item of this.#iterateItems()) items.push(item);
    return items.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.queueItemId.localeCompare(right.queueItemId),
    );
  }

  async #read(queueItemId: string): Promise<CaptureQueueItem> {
    this.#validateQueueItemId(queueItemId);
    let serialized: string;
    try {
      if ((await stat(this.#path(queueItemId))).size > 2 * 1024 * 1024) {
        throw new CorruptCaptureQueueItemError(queueItemId);
      }
      serialized = await readFile(this.#path(queueItemId), "utf8");
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new CaptureQueueItemNotFoundError(queueItemId);
      }
      throw error;
    }
    let input: unknown;
    try {
      input = JSON.parse(serialized) as unknown;
    } catch {
      throw new CorruptCaptureQueueItemError(queueItemId);
    }
    const parsed = captureQueueItemSchema.safeParse(input);
    if (!parsed.success || parsed.data.queueItemId !== queueItemId) {
      throw new CorruptCaptureQueueItemError(queueItemId);
    }
    return parsed.data;
  }

  async #write(item: CaptureQueueItem): Promise<void> {
    const parsed = captureQueueItemSchema.parse(item);
    const serialized = `${JSON.stringify(parsed)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) {
      throw new Error("Capture queue item exceeds the 2 MiB safety limit.");
    }
    const temporaryPath = join(
      this.#root,
      `.queue-${parsed.queueItemId}-${randomUUID()}.tmp`,
    );
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

    await handle.close();
    try {
      if (parsed.state !== "acknowledged" && parsed.state !== "dead-letter") {
        await this.#touchIndex(".active", parsed.createdAt, parsed.queueItemId);
      }
      await rename(temporaryPath, this.#path(parsed.queueItemId));
      if (parsed.state === "acknowledged" || parsed.state === "dead-letter") {
        await this.#updateStateIndex(parsed);
      }
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async #claimSourceIndex(
    path: string,
    queueItemId: string,
    deduplicationKey: string,
  ): Promise<"duplicate" | "owned"> {
    while (true) {
      const existing = await this.#validatedSourceIndex(
        path,
        deduplicationKey,
      );
      if (existing !== undefined) {
        return existing === queueItemId
          ? "owned"
          : "duplicate";
      }
      try {
        await this.#writeSourceIndex(path, queueItemId);
        return "owned";
      } catch (error) {
        if (!this.#isAlreadyExists(error)) {
          throw error;
        }
      }
    }
  }

  async #writeSourceIndex(
    path: string,
    queueItemId: string,
  ): Promise<void> {
    const temporaryPath = join(
      this.#root,
      `.source-${queueItemId}-${randomUUID()}.tmp`,
    );
    try {
      const handle = await open(temporaryPath, "wx");
      try {
        await handle.writeFile(`${queueItemId}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporaryPath, path);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async #validatedSourceIndex(
    path: string,
    deduplicationKey: string,
  ): Promise<string | undefined> {
    let queueItemId: string;
    try {
      queueItemId = (await readFile(path, "utf8")).trim();
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
    if (!queueItemIdPattern.test(queueItemId)) {
      await unlink(path);
      return undefined;
    }

    try {
      const item = await this.#read(queueItemId);
      if (item.envelope.deduplicationKey === deduplicationKey) {
        return queueItemId;
      }
    } catch (error) {
      if (error instanceof CorruptCaptureQueueItemError) {
        await this.#quarantine(queueItemId, `${queueItemId}.json`);
      } else if (!(error instanceof CaptureQueueItemNotFoundError)) {
        throw error;
      }
    }
    await unlink(path).catch((error: unknown) => {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    });
    return undefined;
  }

  async #removeSourceIndexIfOwned(
    path: string,
    queueItemId: string,
  ): Promise<void> {
    let indexedQueueItemId: string;
    try {
      indexedQueueItemId = (await readFile(path, "utf8")).trim();
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    if (indexedQueueItemId !== queueItemId) {
      return;
    }
    await unlink(path).catch((error: unknown) => {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    });
  }

  async #exists(queueItemId: string): Promise<boolean> {
    try {
      await access(this.#path(queueItemId));
      return true;
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }

  #nextQueueItemId(): string {
    const queueItemId = this.#idGenerator();
    this.#validateQueueItemId(queueItemId);
    return queueItemId;
  }

  #path(queueItemId: string): string {
    this.#validateQueueItemId(queueItemId);
    return join(this.#root, `${queueItemId}.json`);
  }

  #sourceIndexPath(deduplicationKey: string): string {
    return join(
      this.#root,
      `.source-${deduplicationKey}.idx`,
    );
  }

  #isAlreadyExists(error: unknown): boolean {
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    );
  }

  #isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }

  #indexName(timestamp: string, queueItemId: string): string {
    return `${String(Date.parse(timestamp)).padStart(16, "0")}-${queueItemId}`;
  }

  async #touchIndex(directory: string, timestamp: string, queueItemId: string): Promise<void> {
    const path = join(this.#root, directory, this.#indexName(timestamp, queueItemId));
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "wx");
    } catch (error) {
      if (this.#isAlreadyExists(error)) return;
      throw error;
    }
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #updateStateIndex(item: CaptureQueueItem): Promise<void> {
    if (item.state === "acknowledged") {
      await this.#touchIndex(".acknowledged", item.acknowledgedAt, item.queueItemId);
    }
    if (item.state === "acknowledged" || item.state === "dead-letter") {
      await unlink(join(this.#root, ".active", this.#indexName(item.createdAt, item.queueItemId)))
        .catch((error: unknown) => { if (!this.#isMissing(error)) throw error; });
    } else {
      await this.#touchIndex(".active", item.createdAt, item.queueItemId);
    }
  }

  async #removeStateIndexes(item: CaptureQueueItem): Promise<void> {
    await unlink(join(this.#root, ".active", this.#indexName(item.createdAt, item.queueItemId)))
      .catch((error: unknown) => { if (!this.#isMissing(error)) throw error; });
    if (item.state === "acknowledged") {
      await unlink(join(this.#root, ".acknowledged", this.#indexName(item.acknowledgedAt, item.queueItemId)))
        .catch((error: unknown) => { if (!this.#isMissing(error)) throw error; });
    }
  }

  async #activeNames(): Promise<string[]> {
    return (await readdir(join(this.#root, ".active"))).sort();
  }

  async #readIndexed(directory: string, name: string): Promise<CaptureQueueItem | undefined> {
    const queueItemId = name.slice(17);
    try {
      const item = await this.#read(queueItemId);
      if (directory === ".active" &&
          (item.state === "acknowledged" || item.state === "dead-letter")) {
        await this.#updateStateIndex(item);
        return undefined;
      }
      if (directory === ".acknowledged" && item.state !== "acknowledged") {
        await unlink(join(this.#root, directory, name));
        return undefined;
      }
      return item;
    } catch (error) {
      if (error instanceof CorruptCaptureQueueItemError) {
        await this.#quarantine(queueItemId, `${queueItemId}.json`);
      } else if (!(error instanceof CaptureQueueItemNotFoundError ||
                   error instanceof InvalidQueueItemIdError)) {
        throw error;
      }
      await unlink(join(this.#root, directory, name)).catch(() => undefined);
      return undefined;
    }
  }

  async #readActive(): Promise<CaptureQueueItem[]> {
    const items: CaptureQueueItem[] = [];
    for (const name of await this.#activeNames()) {
      const item = await this.#readIndexed(".active", name);
      if (item !== undefined) items.push(item);
    }
    return items;
  }

  async #quarantine(queueItemId: string, fileName: string): Promise<void> {
    const root = join(this.#root, ".quarantine");
    await mkdir(root, { recursive: true });
    await rename(join(this.#root, fileName), join(root, fileName))
      .catch((error: unknown) => { if (!this.#isMissing(error)) throw error; });
    try {
      this.#onDiagnostic?.(sanitizeDiagnostic(
        `Malformed capture queue item ${queueItemId} was quarantined.`,
      ));
    } catch {
      // Diagnostics cannot stop healthy queue traffic.
    }
  }

  #validateQueueItemId(queueItemId: string): void {
    if (!queueItemIdPattern.test(queueItemId)) {
      throw new InvalidQueueItemIdError();
    }
  }

  #assertInitialized(): void {
    if (!this.#initialized) {
      throw new CaptureQueueNotInitializedError();
    }
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationChain.then(async () => {
      const lease = await this.#acquireProcessLease();
      try {
        return await operation();
      } finally {
        await lease.release();
      }
    });
    this.#operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #acquireProcessLease(): Promise<ProcessLease> {
    const processLease = this.#processLease;
    if (processLease === undefined) {
      throw new CaptureQueueNotInitializedError();
    }
    const deadline = Date.now() + this.#processLeaseTimeoutMs;
    while (true) {
      const lease = await processLease.tryAcquire();
      if (lease !== undefined) {
        return lease;
      }
      if (Date.now() >= deadline) {
        throw new CaptureQueueLeaseTimeoutError();
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }
}
