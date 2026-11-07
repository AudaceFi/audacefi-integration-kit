import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { unsafeJournalOwnership } from "./journal.ts";

type Value = string | number | null;
type Row = Record<string, Value>;
interface Statement {
  get(...values: Value[]): Row | undefined;
  all(...values: Value[]): Row[];
  run(...values: Value[]): { changes: number };
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

/** Open only in the verified journal directory, while holding its ranked signal lock. */
export async function openRankedInbox(directory: string, scope: string) {
  const path = join(directory, "ranked-signals.sqlite");
  try {
    const file = await open(path, "wx", 0o600);
    await file.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || unsafeJournalOwnership(info, process.platform, process.geteuid?.())) {
    throw new Error("UNSAFE_RANKED_INBOX");
  }
  // The kit runs on Node 24. Its Node 20 declarations predate the bundled SQLite module.
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => Database };
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK (id = 1), scope TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL,
        operation_key TEXT NOT NULL UNIQUE, quote TEXT, target_position TEXT,
        reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved IN (0, 1)),
        result_attempt INTEGER NOT NULL DEFAULT 0 CHECK (result_attempt IN (0, 1)),
        completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
        position_after TEXT, receipt TEXT, independent_exit INTEGER CHECK (independent_exit IN (0, 1)), exit_blockhash TEXT
      ) STRICT;
    `);
    db.prepare("INSERT OR IGNORE INTO binding VALUES (1, ?)").run(scope);
    if (db.prepare("SELECT scope FROM binding WHERE id = 1").get()?.scope !== scope) {
      throw new Error("RANKED_INBOX_SCOPE_CHANGED");
    }
    const columns = new Set(db.prepare("PRAGMA table_info(signals)").all().map(column => column.name));
    if (!columns.has("target_position")) {
      db.exec("ALTER TABLE signals ADD COLUMN target_position TEXT");
    }
    if (!columns.has("reserved")) {
      db.exec("ALTER TABLE signals ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved IN (0, 1))");
    }
    if (!columns.has("independent_exit")) {
      db.exec("ALTER TABLE signals ADD COLUMN independent_exit INTEGER CHECK (independent_exit IN (0, 1))");
    }
    if (!columns.has("exit_blockhash")) db.exec("ALTER TABLE signals ADD COLUMN exit_blockhash TEXT");
    function changed(statement: string, ...values: Value[]) {
      if (db.prepare(statement).run(...values).changes !== 1) throw new Error("RANKED_INBOX_STATE_CHANGED");
    }
    return {
      read: (id: string) => db.prepare("SELECT * FROM signals WHERE id = ?").get(id),
      latest: () => db.prepare("SELECT * FROM signals ORDER BY sequence DESC LIMIT 1").get(),
      previous: (sequence: number) => db.prepare("SELECT completed, position_after FROM signals WHERE sequence < ? ORDER BY sequence DESC LIMIT 1").get(sequence),
      accept(id: string, sequence: number, payload: string, operationKey: string, independentExit: boolean, priorExit?: { id: string; position: string }) {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (priorExit) changed("UPDATE signals SET completed = 1, position_after = ? WHERE id = ? AND completed = 0",
            priorExit.position, priorExit.id);
          changed("INSERT INTO signals (id, sequence, payload, operation_key, independent_exit) VALUES (?, ?, ?, ?, ?)",
            id, sequence, payload, operationKey, independentExit ? 1 : 0);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
      reserve(id: string) {
        changed("UPDATE signals SET reserved = 1 WHERE id = ? AND reserved = 0 AND completed = 0", id);
      },
      hasEarlierExitBlockhash(id: string, blockhash: string) {
        return db.prepare("SELECT 1 FROM signals WHERE id <> ? AND exit_blockhash = ? LIMIT 1").get(id, blockhash) !== undefined;
      },
      bindExitBlockhash(id: string, blockhash: string) {
        changed("UPDATE signals SET exit_blockhash = ? WHERE id = ? AND completed = 0 AND exit_blockhash IS NULL", blockhash, id);
      },
      bindQuote(id: string, quote: string, targetPosition: string) {
        changed(`UPDATE signals SET quote = ?, target_position = ? WHERE id = ? AND completed = 0
          AND (quote IS NULL OR quote = ?) AND (target_position IS NULL OR target_position = ?)`,
        quote, targetPosition, id, quote, targetPosition);
      },
      beforeResult(id: string) {
        changed("UPDATE signals SET result_attempt = 1 WHERE id = ? AND result_attempt = 0 AND completed = 0", id);
      },
      complete(id: string, positionAfter: string, receipt: string | null) {
        changed("UPDATE signals SET completed = 1, position_after = ?, receipt = ? WHERE id = ? AND completed = 0", positionAfter, receipt, id);
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
