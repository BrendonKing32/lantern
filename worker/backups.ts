const TABLES = [
  "projects",
  "chapters",
  "chapter_snapshots",
  "daily_words",
  "settings",
  "bible_entries",
  "ai_calls",
  "book_checks",
  "scenes",
  "project_shares",
  "share_comments",
  "claude_changes",
] as const;

const BACKUP_PREFIX = "backups/";
const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

function backupTimestamp(key: string): number | null {
  const id = key.slice(BACKUP_PREFIX.length).split("/", 1)[0];
  const match = /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(id);
  if (!match) return null;
  const timestamp = Date.parse(`${match[1]}${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export interface BackupEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
  BACKUPS: R2Bucket;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot back up a non-finite database number");
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  throw new Error(`Cannot back up database value of type ${typeof value}`);
}

function insertStatements(table: string, rows: Record<string, unknown>[]): string[] {
  return rows.map((row) => {
    const columns = Object.keys(row);
    if (columns.length === 0) throw new Error(`Cannot back up an empty row in ${table}`);
    return `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns
      .map((column) => sqlValue(row[column]))
      .join(", ")});`;
  });
}

interface DatabaseExport {
  sql: string;
  chapterCount: number;
}

// D1 runs a batch as one transaction, so every table is read from the same state.
async function exportDatabase(env: BackupEnv): Promise<DatabaseExport> {
  const statements = await env.DB.batch(
    TABLES.map((table) => env.DB.prepare(`SELECT * FROM ${table}`)),
  );
  const rows = new Map(
    TABLES.map((table, index) => [
      table,
      (statements[index].results ?? []) as Record<string, unknown>[],
    ]),
  );

  const sql = [
    "-- Lantern D1 backup. Restore only after downloading and reviewing this file.",
    "DELETE FROM \"book_checks\";",
    "DELETE FROM \"scenes\";",
    "DELETE FROM \"share_comments\";",
    "DELETE FROM \"project_shares\";",
    "DELETE FROM \"ai_calls\";",
    "DELETE FROM \"bible_entries\";",
    "DELETE FROM \"daily_words\";",
    "DELETE FROM \"chapter_snapshots\";",
    "DELETE FROM \"chapters\";",
    "DELETE FROM \"projects\";",
    "DELETE FROM \"settings\";",
    ...TABLES.flatMap((table) => insertStatements(table, rows.get(table) ?? [])),
    "",
  ].join("\n");
  return { sql, chapterCount: rows.get("chapters")?.length ?? 0 };
}

async function listObjects(bucket: R2Bucket): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function listKeys(bucket: R2Bucket): Promise<string[]> {
  return (await listObjects(bucket)).map((object) => object.key);
}

// R2 gives every upload a new version, so equal versions mean an object is unchanged.
function objectVersions(objects: R2Object[]): Map<string, string> {
  return new Map(objects.map((object) => [object.key, object.version]));
}

function sameVersions(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([key, version]) => b.get(key) === version);
}

class ConcurrentChangeError extends Error {
  constructor(what: string) {
    super(`${what} changed during backup; this incomplete backup will not be marked ready`);
  }
}

async function copyManuscripts(env: BackupEnv, backupId: string): Promise<Map<string, string>> {
  const versions = objectVersions(await listObjects(env.BUCKET));
  for (const [key, version] of versions) {
    const object = await env.BUCKET.get(key);
    if (!object) throw new ConcurrentChangeError(`Manuscript object ${key}`);
    if (!object.body) throw new Error(`Could not read manuscript object ${key}`);
    if (object.version !== version) throw new ConcurrentChangeError(`Manuscript object ${key}`);
    await env.BACKUPS.put(`${BACKUP_PREFIX}${backupId}/r2/${key}`, object.body, {
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
    });
  }
  return versions;
}

async function deleteExpiredBackups(bucket: R2Bucket, now: Date): Promise<void> {
  const cutoff = now.getTime() - RETENTION_DAYS * DAY_MS;
  const expired: string[] = [];
  for (const key of await listKeys(bucket)) {
    const timestamp = backupTimestamp(key);
    if (timestamp !== null && timestamp < cutoff) expired.push(key);
  }
  for (let i = 0; i < expired.length; i += 1000) {
    await bucket.delete(expired.slice(i, i + 1000));
  }
}

export async function createBackup(env: BackupEnv): Promise<void> {
  const started = new Date();
  const backupId = started.toISOString().replace(/[:.]/g, "-");
  const prefix = `${BACKUP_PREFIX}${backupId}/`;
  // Snapshot protocol: export D1, copy R2, then export D1 and list R2 again. If the
  // database export is identical and every object kept the version that was copied,
  // the database and objects existed together at the moment of the second export.
  const database = await exportDatabase(env);
  const copied = await copyManuscripts(env, backupId);
  const databaseAfter = await exportDatabase(env);
  if (databaseAfter.sql !== database.sql) throw new ConcurrentChangeError("The database");
  if (!sameVersions(copied, objectVersions(await listObjects(env.BUCKET)))) {
    throw new ConcurrentChangeError("Manuscript storage");
  }
  const objects = [...copied.keys()];

  await env.BACKUPS.put(`${prefix}database.sql`, database.sql, {
    httpMetadata: { contentType: "application/sql; charset=utf-8" },
  });
  await env.BACKUPS.put(`${prefix}r2-objects.json`, JSON.stringify(objects), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  await env.BACKUPS.put(
    `${prefix}manifest.json`,
    JSON.stringify({
      format: 1,
      created_at: started.toISOString(),
      retention_days: RETENTION_DAYS,
      database_file: `${prefix}database.sql`,
      r2_objects_file: `${prefix}r2-objects.json`,
      r2_object_count: objects.length,
      chapter_count: database.chapterCount,
    }),
    { httpMetadata: { contentType: "application/json; charset=utf-8" } },
  );
  await deleteExpiredBackups(env.BACKUPS, started);
}
