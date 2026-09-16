import {
  mkdir,
  open,
  readFile,
  truncate,
} from "node:fs/promises";
import { dirname } from "node:path";

import {
  evidenceLedgerEntrySchema,
  type EvidenceLedgerEntry,
} from "@provenloop/contracts";

import { sha256 } from "./digest.js";
import {
  immutableLedgerIdentifierContainsSecret,
  ledgerEntryContainsSecret,
} from "./secret-detection.js";

export class UnsafeLedgerIdentifierError extends Error {
  public override readonly name = "UnsafeLedgerIdentifierError";

  public constructor() {
    super("Evidence Ledger contains an unsafe immutable identifier.");
  }
}

export class DuplicateLedgerEntryError extends Error {
  public override readonly name = "DuplicateLedgerEntryError";

  public constructor() {
    super("Evidence Ledger contains a duplicate ledgerEntryId.");
  }
}

export class EvidenceLedgerWriter {
  readonly #path: string;
  #appendChain: Promise<void> = Promise.resolve();
  #initialized = false;
  readonly #ledgerEntryIds = new Set<string>();

  public constructor(path: string) {
    this.#path = path;
  }

  public get path(): string {
    return this.#path;
  }

  public async initialize(): Promise<void> {
    await mkdir(dirname(this.#path), {
      recursive: true,
    });
    let content = Buffer.alloc(0);
    try {
      content = await readFile(this.#path);
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
    if (
      content.length > 0 &&
      content.at(-1) !== 0x0a
    ) {
      const lastNewline = content.lastIndexOf(0x0a);
      const trailing = content
        .subarray(lastNewline + 1)
        .toString("utf8");
      let parsedTrailing: unknown;
      try {
        parsedTrailing = JSON.parse(trailing) as unknown;
      } catch {
        await truncate(this.#path, lastNewline + 1);
        content = content.subarray(0, lastNewline + 1);
      }
      if (parsedTrailing !== undefined) {
        evidenceLedgerEntrySchema.parse(parsedTrailing);
        const handle = await open(this.#path, "a");
        try {
          await handle.writeFile("\n", "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
    for (const line of content
      .toString("utf8")
      .split(/\r?\n/u)
      .filter((value) => value.trim().length > 0)) {
      const entry = evidenceLedgerEntrySchema.parse(
        JSON.parse(line) as unknown,
      );
      if (this.#ledgerEntryIds.has(entry.ledgerEntryId)) {
        throw new DuplicateLedgerEntryError();
      }
      this.#ledgerEntryIds.add(entry.ledgerEntryId);
    }
    const handle = await open(this.#path, "a");
    await handle.close();
    this.#initialized = true;
  }

  public async append(
    entries: readonly EvidenceLedgerEntry[],
  ): Promise<readonly EvidenceLedgerEntry[]> {
    const operation = this.#appendChain.then(() =>
      this.#appendExclusive(entries),
    );
    this.#appendChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  public appendIfAbsent(
    entries: readonly EvidenceLedgerEntry[],
  ): Promise<readonly EvidenceLedgerEntry[]> {
    const operation = this.#appendChain.then(() =>
      this.#appendExclusive(
        entries.filter(
          (entry) =>
            !this.#ledgerEntryIds.has(entry.ledgerEntryId),
        ),
      ),
    );
    this.#appendChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #appendExclusive(
    entries: readonly EvidenceLedgerEntry[],
  ): Promise<readonly EvidenceLedgerEntry[]> {
    if (!this.#initialized) {
      throw new Error("Evidence Ledger is not initialized.");
    }
    if (entries.length === 0) {
      return [];
    }

    const persistedEntries = entries.map((entry) => {
      const parsed = evidenceLedgerEntrySchema.parse(entry);
      if (immutableLedgerIdentifierContainsSecret(parsed)) {
        throw new UnsafeLedgerIdentifierError();
      }
      if (!ledgerEntryContainsSecret(parsed)) {
        return parsed;
      }
      return evidenceLedgerEntrySchema.parse({
        schemaVersion: parsed.schemaVersion,
        ledgerEntryId: parsed.ledgerEntryId,
        runId: parsed.runId,
        status: "secret.redacted_before_ledger",
        inputDigest: sha256(parsed),
        timestamp: parsed.timestamp,
      });
    });
    const batchIds = new Set<string>();
    for (const entry of persistedEntries) {
      if (
        batchIds.has(entry.ledgerEntryId) ||
        this.#ledgerEntryIds.has(entry.ledgerEntryId)
      ) {
        throw new DuplicateLedgerEntryError();
      }
      batchIds.add(entry.ledgerEntryId);
    }
    const body = persistedEntries
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const handle = await open(this.#path, "a");
    try {
      await handle.writeFile(`${body}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (const entry of persistedEntries) {
      this.#ledgerEntryIds.add(entry.ledgerEntryId);
    }
    return persistedEntries;
  }
}
