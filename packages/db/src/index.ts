/**
 * @astro/db: thin, dependency-free SQLite layer on top of node:sqlite (Node >= 24).
 * Plain SQL + typed helpers. Schema lives in ./migrations/*.sql (portable to D1 / Postgres).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { scrubSecrets } from "./redact.ts";

export { scrubSecrets };

export type Row = Record<string, unknown>;
export type Param = SQLInputValue;

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "migrations");

export interface Db {
  raw: DatabaseSync;
  path: string;
  run(sql: string, params?: Param[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = Row>(sql: string, params?: Param[]): T | undefined;
  all<T = Row>(sql: string, params?: Param[]): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function openDb(path = process.env.ASTRO_DB_PATH || "./data/astro.db"): Db {
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") raw.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

  let depth = 0;
  const db: Db = {
    raw,
    path,
    run(sql, params = []) {
      const r = raw.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    get<T = Row>(sql: string, params: Param[] = []) {
      return raw.prepare(sql).get(...params) as T | undefined;
    },
    all<T = Row>(sql: string, params: Param[] = []) {
      return raw.prepare(sql).all(...params) as T[];
    },
    exec(sql) {
      raw.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      // Nested calls use savepoints so engines can compose freely (order-engine -> commerce-core -> cashflow).
      if (depth === 0) {
        raw.exec("BEGIN");
        depth++;
        try {
          const out = fn();
          raw.exec("COMMIT");
          return out;
        } catch (e) {
          raw.exec("ROLLBACK");
          throw e;
        } finally {
          depth--;
        }
      }
      const sp = `sp_${depth}`;
      raw.exec(`SAVEPOINT ${sp}`);
      depth++;
      try {
        const out = fn();
        raw.exec(`RELEASE SAVEPOINT ${sp}`);
        return out;
      } catch (e) {
        raw.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
        raw.exec(`RELEASE SAVEPOINT ${sp}`);
        throw e;
      } finally {
        depth--;
      }
    },
    close() {
      raw.close();
    },
  };
  return db;
}

/** Apply all migrations in order (idempotent). */
export function migrate(db: Db, dir = MIGRATIONS_DIR): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));",
  );
  const applied = new Set(db.all<{ name: string }>("SELECT name FROM schema_migrations").map((r) => r.name));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const done: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    db.exec(sql);
    db.run("INSERT INTO schema_migrations(name) VALUES (?)", [f]);
    done.push(f);
  }
  return done;
}

/** Open + migrate in one call (used by API, worker, scripts, tests). */
export function openMigratedDb(path?: string): Db {
  const db = openDb(path);
  migrate(db);
  return db;
}

// ---------- tiny helpers shared by repositories ----------

export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

/** Insert an object as a row (keys must be column names). */
export function insert(db: Db, table: string, row: Record<string, Param>): void {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`;
  db.run(
    sql,
    keys.map((k) => row[k] as Param),
  );
}

export function upsert(db: Db, table: string, row: Record<string, Param>, conflictKeys: string[]): void {
  const keys = Object.keys(row);
  const updates = keys.filter((k) => !conflictKeys.includes(k));
  const sql = `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})
    ON CONFLICT(${conflictKeys.join(",")}) DO UPDATE SET ${updates.map((k) => `${k}=excluded.${k}`).join(",")}`;
  db.run(
    sql,
    keys.map((k) => row[k] as Param),
  );
}

export function update(
  db: Db,
  table: string,
  id: string,
  patch: Record<string, Param>,
  idCol = "id",
): number {
  const keys = Object.keys(patch);
  if (keys.length === 0) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(",")} WHERE ${idCol}=?`;
  return db.run(sql, [...keys.map((k) => patch[k] as Param), id]).changes;
}

/** Versioned settings with history (self-improvement must never change rules silently). */
export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const row = db.get<{ value: string }>("SELECT value FROM settings WHERE key=?", [key]);
  return row ? parseJson<T>(row.value, fallback) : fallback;
}

export function setSetting(db: Db, key: string, value: unknown, changedBy: string, reason?: string): number {
  const prev = db.get<{ value: string; version: number }>("SELECT value, version FROM settings WHERE key=?", [
    key,
  ]);
  const version = (prev?.version ?? 0) + 1;
  const ts = nowIso();
  db.transaction(() => {
    upsert(db, "settings", { key, value: json(value), version, updated_at: ts, updated_by: changedBy }, [
      "key",
    ]);
    insert(db, "settings_history", {
      key,
      old_value: prev?.value ?? null,
      new_value: json(value),
      version,
      reason: reason ?? null,
      changed_by: changedBy,
      changed_at: ts,
    });
  });
  return version;
}

export function logEvent(
  db: Db,
  level: "debug" | "info" | "warn" | "error",
  source: string,
  event: string,
  data?: unknown,
  storeId?: string | null,
): void {
  // Sink-side scrubbing: a caller that forgot redact() still cannot write a credential into the log.
  insert(db, "system_events", {
    level,
    source,
    event: scrubSecrets(event),
    store_id: storeId ?? null,
    data: data === undefined ? null : scrubSecrets(json(data)),
    created_at: nowIso(),
  });
}

export function audit(
  db: Db,
  actor: string,
  action: string,
  entity?: { type: string; id: string },
  before?: unknown,
  after?: unknown,
): void {
  insert(db, "audit_log", {
    actor,
    action,
    entity_type: entity?.type ?? null,
    entity_id: entity?.id ?? null,
    before: before === undefined ? null : scrubSecrets(json(before)),
    after: after === undefined ? null : scrubSecrets(json(after)),
    ip: null,
    created_at: nowIso(),
  });
}
