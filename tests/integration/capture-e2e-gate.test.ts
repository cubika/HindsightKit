import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AsyncCaptureWriter,
  BoundedCaptureBuffer,
  CopilotEventMapper,
} from "@provenloop/copilot-adapter";
import {
  createCaptureDeduplicationKey,
} from "@provenloop/domain";
import {
  createCanonicalCaptureLedgerEntry,
  evaluateCanonicalCaptureGate,
  EvidenceLedgerWriter,
} from "@provenloop/evaluation";
import { CaptureWorker } from "@provenloop/host";
import {
  WindowsCaptureQueue,
  WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const temporaryDirectories: string[] = [];
const timestamp = "2026-08-29T00:00:00.000Z";

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-capture-e2e-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("capture to canonical Ledger Gate", () => {
  it("carries a supported event through the complete evidence chain", async () => {
    const root = await createTemporaryDirectory();
    const queueRoot = join(root, "queue");
    const secret = "ghp_1234567890abcdefghijklmnopqrst";
    let queueSequence = 0;
    const queue = new WindowsCaptureQueue(queueRoot, {
      idGenerator: () => `queue-${queueSequence += 1}`,
    });
    await queue.initialize();
    const writer = new AsyncCaptureWriter({
      buffer: new BoundedCaptureBuffer({
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 20_000,
        maxItems: 20,
      }),
      queue,
      retryDelayMs: 1,
    });
    const mapper = new CopilotEventMapper({
      adapterVersion: "1.0.82-0",
      copyLimits: {
        maxStringChars: 1_024,
      },
      sessionId: "session-1",
      workspace: {
        branch: "feature/e2e",
        repoId: "repo-1",
      },
    });
    const mapped = mapper.map({
      data: {
        content: `Implement canonical storage with token=${secret}`,
      },
      id: "user-event-1",
      parentId: null,
      timestamp,
      type: "user.message",
    });
    if (mapped.status !== "mapped") {
      throw new Error("Expected the fixture event to map.");
    }

    writer.submit(mapped.value);
    expect(await writer.flush(30_000)).toBe(true);
    expect(
      await readFile(join(queueRoot, "queue-1.json"), "utf8"),
    ).not.toContain(secret);

    const store = new CanonicalSqliteStore(
      join(root, "provenloop.db"),
    );
    const worker = new CaptureWorker({
      batchSize: 10,
      lease: new WindowsNamedPipeLeaseProvider(
        `worker-${randomUUID()}`,
      ),
      queue,
      store,
      workerId: "worker-1",
    });
    expect(await worker.runOnce()).toMatchObject({
      status: "completed",
      acknowledged: 1,
      stored: 1,
    });

    const deduplicationKey =
      createCaptureDeduplicationKey(mapped.value);
    const canonical = store.rawEvent(deduplicationKey);
    expect(canonical).toBeDefined();
    if (canonical === undefined) {
      throw new Error("Expected a canonical raw event.");
    }
    expect(JSON.stringify(canonical)).not.toContain(secret);

    const ledgerPath = join(root, "evidence-ledger.jsonl");
    const ledgerWriter = new EvidenceLedgerWriter(ledgerPath);
    await ledgerWriter.initialize();
    const ledgerEntry = createCanonicalCaptureLedgerEntry(
      "capture-e2e-run",
      canonical.envelope,
    );
    const persisted = await ledgerWriter.append([
      ledgerEntry,
    ]);
    const gate = evaluateCanonicalCaptureGate(
      canonical.envelope,
      persisted[0] ?? ledgerEntry,
      "capture-e2e-run",
    );

    expect(gate).toEqual({
      schemaVersion: 1,
      evidenceIds: [
        ledgerEntry.ledgerEntryId,
      ],
      gateId: "capture-e2e-run:canonical-capture",
      message:
        "Canonical capture is supported and bound to Ledger evidence.",
      status: "pass",
    });
    expect(await readFile(ledgerPath, "utf8")).not.toContain(secret);
    expect(
      evaluateCanonicalCaptureGate(canonical.envelope, {
        ...ledgerEntry,
        inputDigest: "0".repeat(64),
      }, "capture-e2e-run").status,
    ).toBe("fail");
    expect(
      evaluateCanonicalCaptureGate(
        {
          ...canonical.envelope,
          content: {
            message: "tampered",
          },
        },
        ledgerEntry,
        "capture-e2e-run",
      ).status,
    ).toBe("fail");
    expect(
      evaluateCanonicalCaptureGate(
        canonical.envelope,
        {
          ...ledgerEntry,
          ledgerEntryId: "other-run:capture:forged",
          runId: "other-run",
          timestamp: "2026-08-29T00:00:01.000Z",
        },
        "capture-e2e-run",
      ).status,
    ).toBe("fail");
    store.close();
  });
});
