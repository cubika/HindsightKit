import { createHash } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseCopilotSessionFile,
  type CopilotSessionEvent,
  type CopilotSessionFileIssue,
  type CopilotSessionFileCursor,
} from "@provenloop/copilot-adapter";

const temporaryDirectories: string[] = [];
const timestamp = "2026-08-29T00:00:00.000Z";

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(process.cwd(), ".provenloop-session-parser-test-"),
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

const header = (
  copilotVersion = "1.0.82-0",
  version = 1,
) => ({
  data: {
    context: {
      branch: "feature/recovery",
      cwd: "C:\\repo",
      gitRoot: "C:\\repo",
      headCommit: "abcdef1234567890abcdef1234567890abcdef12",
    },
    copilotVersion,
    producer: "copilot-agent",
    sessionId: "session-1",
    version,
  },
  id: "session-start-1",
  parentId: null,
  timestamp,
  type: "session.start",
});

const userEvent = {
  data: {
    content: "hello",
  },
  id: "user-event-1",
  parentId: "session-start-1",
  timestamp,
  type: "user.message",
};

describe("Copilot Session file parser", () => {
  it("continues past event and byte budgets with source-bound prefix digests", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    const source = Buffer.from(`${[
      header(),
      ...Array.from({ length: 30 }, (_, index) => ({ ...userEvent, id: `user-${index}` })),
    ].map((event) => JSON.stringify(event)).join("\n")}\n`);
    await writeFile(path, source);
    let cursor: CopilotSessionFileCursor | undefined;
    const ids: unknown[] = [];
    for (let pass = 0; pass < 40; pass += 1) {
      const previousOffset = cursor?.byteOffset ?? 0;
      const result = await parseCopilotSessionFile(path, {
        ...(cursor === undefined ? {} : { cursor }),
        maxBytes: 1024,
        maxEvents: 3,
        maxLineChars: 10_000,
        onEvent: (event, _line, provenance) => {
          ids.push(event.id);
          expect(provenance.sourceDigest).toBe(createHash("sha256")
            .update(source.subarray(0, provenance.nextByteOffset)).digest("hex"));
        },
      });
      expect(result.status).toBe("supported");
      if (result.status !== "supported") throw new Error("Expected supported fixture.");
      expect(result.eventCount).toBeLessThanOrEqual(3);
      expect(result.bytesRead).toBeLessThanOrEqual(1024);
      expect(result.cursor.byteOffset).toBeGreaterThan(previousOffset);
      cursor = result.cursor;
      if (!result.budgetExhausted) break;
    }
    expect(ids).toEqual(["session-start-1", ...Array.from({ length: 30 }, (_, index) => `user-${index}`)]);
    expect(cursor?.byteOffset).toBe(source.length);
  });

  it("does not follow additions beyond the opening size snapshot", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    await writeFile(path, `${JSON.stringify(header())}\n`);
    const first = await parseCopilotSessionFile(path, {
      maxLineChars: 10_000,
      onEvent: async () => { await appendFile(path, `${JSON.stringify(userEvent)}\n`); },
    });
    expect(first).toMatchObject({ status: "supported", eventCount: 1, budgetExhausted: false });
    if (first.status !== "supported") throw new Error("Expected supported fixture.");
    const second = await parseCopilotSessionFile(path, {
      cursor: first.cursor,
      maxLineChars: 10_000,
      onEvent: () => undefined,
    });
    expect(second).toMatchObject({ status: "supported", eventCount: 1 });
  });

  it("preserves an incomplete record until a complete line is appended", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    const prefix = `${JSON.stringify(header())}\n`;
    const event = JSON.stringify(userEvent);
    await writeFile(path, `${prefix}${event}`);
    const first = await parseCopilotSessionFile(path, {
      maxLineChars: 10_000,
      requireCompleteLines: true,
      onEvent: () => undefined,
    });
    expect(first).toMatchObject({ status: "supported", eventCount: 1, partialTail: true });
    if (first.status !== "supported") throw new Error("Expected supported fixture.");
    expect(first.cursor.byteOffset).toBe(Buffer.byteLength(prefix));
    await appendFile(path, "\n");
    const second = await parseCopilotSessionFile(path, {
      cursor: first.cursor, maxLineChars: 10_000, requireCompleteLines: true,
      onEvent: () => undefined,
    });
    expect(second).toMatchObject({ status: "supported", eventCount: 1, partialTail: false });
  });

  it("rejects forged cursors and source truncation", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    await writeFile(path, `${JSON.stringify(header())}\n${JSON.stringify(userEvent)}\n`);
    await expect(parseCopilotSessionFile(path, {
      cursor: { byteOffset: 100, lineNumber: 2 }, maxLineChars: 10_000, onEvent: () => undefined,
    })).rejects.toThrow();
    const first = await parseCopilotSessionFile(path, {
      maxEvents: 1, maxLineChars: 10_000, onEvent: () => undefined,
    });
    if (first.status !== "supported") throw new Error("Expected supported fixture.");
    await writeFile(path, `${JSON.stringify(header())}\n`);
    const second = await parseCopilotSessionFile(path, {
      cursor: first.cursor, maxLineChars: 10_000, onEvent: () => undefined,
    });
    expect(second).toMatchObject({ status: "malformed", reason: "Session source changed instead of appending." });
  });

  it("advances across one oversized record without repeatedly scanning its first bytes", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    await writeFile(path, `${JSON.stringify(header())}\n${JSON.stringify({
      ...userEvent, id: "oversized", data: { content: "x".repeat(10_000) },
    })}\n${JSON.stringify(userEvent)}\n`);
    let cursor: CopilotSessionFileCursor | undefined;
    const ids: unknown[] = [];
    let issues = 0;
    for (let pass = 0; pass < 30; pass += 1) {
      const offset = cursor?.byteOffset ?? 0;
      const result = await parseCopilotSessionFile(path, {
        ...(cursor === undefined ? {} : { cursor }), maxBytes: 1024, maxLineChars: 4096,
        onEvent: (event) => { ids.push(event.id); },
        onIssue: () => { issues += 1; },
      });
      if (result.status !== "supported") throw new Error("Expected supported fixture.");
      expect(result.cursor.byteOffset).toBeGreaterThan(offset);
      cursor = result.cursor;
      if (!result.budgetExhausted) break;
    }
    expect(ids).toEqual(["session-start-1", "user-event-1"]);
    expect(issues).toBe(1);
  });

  it("reports cancellation without invoking a capture callback", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    await writeFile(path, `${JSON.stringify(header())}\n`);
    const controller = new AbortController();
    controller.abort();
    await expect(parseCopilotSessionFile(path, {
      signal: controller.signal, maxLineChars: 10_000,
      onEvent: () => { throw new Error("Unexpected capture."); },
    })).rejects.toMatchObject({ reason: "cancelled" });
  });

  it("streams supported events and tolerates an incomplete tail", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    const events: CopilotSessionEvent[] = [];
    await writeFile(
      path,
      `${JSON.stringify(header())}\n${JSON.stringify(userEvent)}\n{"id":`,
      "utf8",
    );

    const result = await parseCopilotSessionFile(path, {
      expectedSessionId: "session-1",
      maxLineChars: 10_000,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toMatchObject({
      status: "supported",
      eventCount: 2,
      issueCount: 0,
      partialTail: true,
      stoppedAfterHeader: false,
      header: {
        adapterVersion: "1.0.82-0",
        fileVersion: 1,
        sessionId: "session-1",
        workspace: {
          branch: "feature/recovery",
          commitSha: "abcdef1234567890abcdef1234567890abcdef12",
          worktree: "C:\\repo",
        },
      },
    });
    expect(events.map((event) => event.type)).toEqual([
      "session.start",
      "user.message",
    ]);
  });

  it("rejects unsupported Copilot versions after the header", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    let eventCount = 0;
    await writeFile(
      path,
      `${JSON.stringify(header("1.0.70-0"))}\n${JSON.stringify(userEvent)}\n`,
      "utf8",
    );

    const result = await parseCopilotSessionFile(path, {
      maxLineChars: 10_000,
      onEvent: () => {
        eventCount += 1;
      },
    });

    expect(result).toEqual({
      status: "incompatible",
      adapterVersion: "1.0.70-0",
      fileVersion: 1,
      reason: "unsupported_adapter_version",
    });
    expect(eventCount).toBe(0);
  });

  it("accepts newer compatible Copilot versions with the known file format", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    await writeFile(
      path,
      `${JSON.stringify(header("1.1.0"))}\n${JSON.stringify(userEvent)}\n`,
      "utf8",
    );

    await expect(
      parseCopilotSessionFile(path, {
        maxLineChars: 10_000,
        onEvent: () => undefined,
      }),
    ).resolves.toMatchObject({
      status: "supported",
      header: {
        adapterVersion: "1.1.0",
        fileVersion: 1,
      },
    });
  });

  it("reports oversized records without retaining their content", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    const issues: CopilotSessionFileIssue[] = [];
    await writeFile(
      path,
      `${JSON.stringify(header())}\n${"x".repeat(2_000)}\n${JSON.stringify(userEvent)}\n`,
      "utf8",
    );

    const result = await parseCopilotSessionFile(path, {
      maxLineChars: 1_000,
      onEvent: () => undefined,
      onIssue: (issue) => {
        issues.push(issue);
      },
    });

    expect(result).toMatchObject({
      status: "supported",
      eventCount: 2,
      issueCount: 1,
      partialTail: false,
    });
    expect(issues).toEqual([
      {
        kind: "oversized_line",
        lineNumber: 2,
        message: "Session event exceeds the line-size limit.",
      },
    ]);
  });

  it("reports non-object JSON values and continues parsing", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    const events: CopilotSessionEvent[] = [];
    const issues: CopilotSessionFileIssue[] = [];
    await writeFile(
      path,
      `${JSON.stringify(header())}\nnull\n${JSON.stringify(userEvent)}\n`,
      "utf8",
    );

    const result = await parseCopilotSessionFile(path, {
      maxLineChars: 10_000,
      onEvent: (event) => {
        events.push(event);
      },
      onIssue: (issue) => {
        issues.push(issue);
      },
    });

    expect(result).toMatchObject({
      status: "supported",
      eventCount: 2,
      issueCount: 1,
    });
    expect(issues).toEqual([
      {
        kind: "malformed_event",
        lineNumber: 2,
        message: "Session event must be a JSON object.",
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "session.start",
      "user.message",
    ]);
  });

  it("can stop immediately after an internal Session header", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    await writeFile(
      path,
      `${JSON.stringify(header())}\n${"x".repeat(20_000)}\n`,
      "utf8",
    );

    const result = await parseCopilotSessionFile(path, {
      maxLineChars: 1_000,
      onEvent: () => {
        throw new Error("Internal events must not be parsed.");
      },
      onHeader: () => false,
    });

    expect(result).toMatchObject({
      status: "supported",
      eventCount: 0,
      issueCount: 0,
      stoppedAfterHeader: true,
    });
  });

  it("reports an oversized final record as an issue", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    const issues: CopilotSessionFileIssue[] = [];
    await writeFile(
      path,
      `${JSON.stringify(header())}\n${"x".repeat(2_000)}`,
      "utf8",
    );

    const result = await parseCopilotSessionFile(path, {
      maxLineChars: 1_000,
      onEvent: () => undefined,
      onIssue: (issue) => {
        issues.push(issue);
      },
    });

    expect(result).toMatchObject({
      status: "supported",
      issueCount: 1,
      partialTail: true,
    });
    expect(issues[0]).toMatchObject({
      kind: "oversized_line",
      lineNumber: 2,
    });
  });

  it("reports an oversized header instead of an empty file", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    await writeFile(path, `${JSON.stringify(header())}\n`, "utf8");

    expect(
      await parseCopilotSessionFile(path, {
        maxLineChars: 32,
        onEvent: () => undefined,
      }),
    ).toEqual({
      status: "malformed",
      lineNumber: 1,
      reason: "session.start exceeds the line-size limit.",
    });
  });

  it("does not count CRLF framing against the line limit", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    const serializedHeader = JSON.stringify(header());
    await writeFile(path, `${serializedHeader}\r\n`, "utf8");

    expect(
      await parseCopilotSessionFile(path, {
        maxLineChars: serializedHeader.length,
        onEvent: () => undefined,
      }),
    ).toMatchObject({
      status: "supported",
      eventCount: 1,
      issueCount: 0,
    });
  });

  it("reports the physical line of a header after blank lines", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "events.jsonl");
    await writeFile(
      path,
      `\n${JSON.stringify(header("1.0.70-0"))}\n`,
      "utf8",
    );

    expect(
      await parseCopilotSessionFile(path, {
        maxLineChars: 10_000,
        onEvent: () => undefined,
      }),
    ).toEqual({
      status: "incompatible",
      adapterVersion: "1.0.70-0",
      fileVersion: 1,
      reason: "unsupported_adapter_version",
    });

    await writeFile(
      path,
      `\n${JSON.stringify({
        ...header(),
        type: "user.message",
      })}\n`,
      "utf8",
    );
    expect(
      await parseCopilotSessionFile(path, {
        maxLineChars: 10_000,
        onEvent: () => undefined,
      }),
    ).toEqual({
      status: "malformed",
      lineNumber: 2,
      reason: "The first Session record must be session.start.",
    });
  });
});
