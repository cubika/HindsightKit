import { createRequire } from "node:module";

// Keep this loader self-contained: the FTS reader serializes it into a Worker.
export const loadNodeSqlite = (
  load: (id: string) => unknown,
): typeof import("node:sqlite") => {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning: string | Error, ...args: unknown[]): void => {
    if (
      warning === "SQLite is an experimental feature and might change at any time" &&
      args[0] === "ExperimentalWarning"
    ) {
      return;
    }
    Reflect.apply(emitWarning, process, [warning, ...args]);
  };
  try {
    return load("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
};

const sqlite = loadNodeSqlite(createRequire(import.meta.url));

export const backup = sqlite.backup;
export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = import("node:sqlite").DatabaseSync;
