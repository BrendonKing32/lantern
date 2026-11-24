// Test doubles for D1 and R2 backed by real SQLite (node:sqlite) and memory,
// with every migration applied, so tests run the Worker's actual SQL.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Value = string | number | null;

class Statement {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private args: Value[] = [],
  ) {}
  bind(...args: unknown[]) {
    return new Statement(this.db, this.sql, args.map((a) => (a === undefined ? null : (a as Value))));
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[], success: true, meta: {} };
  }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.args) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : { ...row }) as T;
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  runSync() {
    const isQuery = /^\s*(select|with)\b/i.test(this.sql);
    if (isQuery) return { results: this.db.prepare(this.sql).all(...this.args), success: true, meta: {} };
    const r = this.db.prepare(this.sql).run(...this.args);
    return { results: [], success: true, meta: { changes: Number(r.changes) } };
  }
}

export function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  const dir = join(process.cwd(), "migrations"); // tests run from the repository root
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, file), "utf8"));
  }
  return {
    raw: db,
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => s.runSync());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

export function memoryR2() {
  const objects = new Map<string, string>();
  const metadata = new Map<string, Record<string, string>>();
  return {
    objects,
    /** Make puts to keys matching this fail, to test what happens when storage does. */
    failPuts: null as RegExp | null,
    async get(key: string) {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value, key, customMetadata: metadata.get(key) };
    },
    async put(key: string, value: string, options?: { customMetadata?: Record<string, string> }) {
      if (this.failPuts?.test(key)) throw new Error(`R2 put failed for ${key}`);
      objects.set(key, value);
      if (options?.customMetadata) metadata.set(key, { ...options.customMetadata });
      else metadata.delete(key);
      return { key };
    },
    async delete(key: string) {
      objects.delete(key);
      metadata.delete(key);
    },
  };
}
