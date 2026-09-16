import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const directories: string[] = [];
const sqliteNotice = "SQLite is an experimental feature";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { force: true, recursive: true }),
  ));
});

describe("packaged runtime warnings", () => {
  it("keeps the real CLI output free of the SQLite notice", async () => {
    const result = await run(process.execPath, [
      resolve("packages", "cli", "dist", "bin.js"), "version",
    ], { windowsHide: true });
    expect(JSON.parse(result.stdout)).toHaveProperty("version");
    expect(result.stderr).not.toContain(sqliteNotice);
  });

  it.each(["index.js", "extension-entry.js"])(
    "loads %s without the SQLite notice while preserving other warnings and SQL errors",
    async (entry) => {
      const url = pathToFileURL(resolve("packages", "cli", "dist", entry)).href;
      const result = await run(process.execPath, ["--input-type=module", "-e", `
        const emitWarning = process.emitWarning;
        await import(${JSON.stringify(url)});
        if (process.emitWarning !== emitWarning) throw new Error("Warning handler was not restored");
        process.emitWarning("Other experimental feature", "ExperimentalWarning");
        process.emitWarning("Deprecated API", "DeprecationWarning");
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(":memory:");
        try {
          db.exec("SELECT * FROM missing_table");
          throw new Error("SQLite error was hidden");
        } catch (error) {
          if (!error.message.includes("no such table")) throw error;
          console.log("SQLite error preserved");
        } finally {
          db.close();
        }
      `], { windowsHide: true });
      expect(result.stdout).toContain("SQLite error preserved");
      expect(result.stderr).not.toContain(sqliteNotice);
      expect(result.stderr).toContain("ExperimentalWarning: Other experimental feature");
      expect(result.stderr).toContain("DeprecationWarning: Deprecated API");
    },
  );

  it("keeps the background SQLite reader free of the same notice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provenloop-warnings-"));
    directories.push(directory);
    const path = join(directory, "knowledge.db");
    const backend = new SqliteFtsKnowledgeBackend(path);
    await backend.closeAsync();
    const result = await run(process.execPath, ["-e", `
      void (async () => {
      const { SqliteFtsKnowledgeBackend } = await import("@provenloop/retrieval");
      const backend = new SqliteFtsKnowledgeBackend(${JSON.stringify(path)});
      try {
        console.log(JSON.stringify(await backend.healthWithTimeout(5_000)));
      } finally {
        await backend.closeAsync();
      }
      })();
    `], { windowsHide: true });
    expect(JSON.parse(result.stdout)).toMatchObject({ quickCheck: "ok" });
    expect(result.stderr).not.toContain(sqliteNotice);
  });
});
