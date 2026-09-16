import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "provenloop-sqlite-"));
const databasePath = join(root, "probe.db");

try {
  const database = new DatabaseSync(databasePath);
  const sqliteVersion = database
    .prepare("select sqlite_version() as version")
    .get().version;
  const journalMode = database
    .prepare("pragma journal_mode = WAL")
    .get().journal_mode;

  database.exec(`
    pragma user_version = 1;
    create table facts (
      id integer primary key,
      value text not null
    );
    begin;
    insert into facts(value) values ('committed');
    commit;
    create virtual table facts_fts using fts5(value);
    insert into facts_fts(value) values ('reusable intelligence');
  `);

  const transactionRows = database
    .prepare("select count(*) as count from facts")
    .get().count;
  const fts5Rows = database
    .prepare(
      "select count(*) as count from facts_fts where facts_fts match 'intelligence'",
    )
    .get().count;
  const userVersion = database.prepare("pragma user_version").get().user_version;
  const compileOptions = database
    .prepare("pragma compile_options")
    .all()
    .map((row) => Object.values(row)[0]);

  database.close();

  const result = {
    nodeVersion: process.version,
    sqliteVersion,
    journalMode,
    userVersion,
    transactionRows,
    fts5Rows,
    fts5CompileOption: compileOptions.some((option) =>
      String(option).includes("ENABLE_FTS5"),
    ),
  };

  if (
    result.journalMode !== "wal" ||
    result.userVersion !== 1 ||
    result.transactionRows !== 1 ||
    result.fts5Rows !== 1 ||
    !result.fts5CompileOption
  ) {
    throw new Error(`SQLite probe failed: ${JSON.stringify(result)}`);
  }

  console.log(JSON.stringify(result, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
