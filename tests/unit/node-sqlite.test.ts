import { createRequire } from "node:module";

import { loadNodeSqlite } from "@provenloop/storage-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

const sqliteNotice = "SQLite is an experimental feature and might change at any time";
const require = createRequire(import.meta.url);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SQLite runtime loading", () => {
  it("suppresses only the SQLite experimental notice while loading", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const warning = new Error("Database diagnostic");
    const sqlite = loadNodeSqlite((id) => {
      expect(id).toBe("node:sqlite");
      process.emitWarning(sqliteNotice, "ExperimentalWarning");
      process.emitWarning("Other experimental feature", "ExperimentalWarning");
      process.emitWarning(sqliteNotice, "Warning");
      process.emitWarning("Deprecated API", { type: "DeprecationWarning", code: "DEP_TEST" });
      process.emitWarning(warning);
      return require(id);
    });
    expect(sqlite.DatabaseSync).toBeTypeOf("function");
    expect(emitWarning.mock.calls).toEqual([
      ["Other experimental feature", "ExperimentalWarning"],
      [sqliteNotice, "Warning"],
      ["Deprecated API", { type: "DeprecationWarning", code: "DEP_TEST" }],
      [warning],
    ]);
    expect(process.emitWarning).toBe(emitWarning);
    process.emitWarning(sqliteNotice, "ExperimentalWarning");
    expect(emitWarning).toHaveBeenCalledTimes(5);
  });

  it("restores warning handling and propagates module loading failures", () => {
    const emitWarning = process.emitWarning;
    const failure = new Error("SQLite module could not be loaded");
    expect(() => loadNodeSqlite(() => { throw failure; })).toThrow(failure);
    expect(process.emitWarning).toBe(emitWarning);
  });
});
