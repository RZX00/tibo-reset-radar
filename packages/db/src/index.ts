import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

export interface RadarDatabaseOptions {
  /** File path, or ":memory:" for an ephemeral database. */
  file: string;
}

/**
 * The whole radar runs in one process against one SQLite file, so the database layer is a thin
 * wrapper rather than a pool: statements are cached, `$n` placeholders are rewritten to SQLite's
 * numbered form, and the async surface exists only so call sites read the same as they would
 * against any other engine.
 */
export class RadarDatabase {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();

  constructor(options: RadarDatabaseOptions) {
    this.#db = new DatabaseSync(options.file);
    // WAL keeps the worker's writes from blocking API reads inside the same process.
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA busy_timeout = 5000");
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const statement = this.#prepare(sql);
    const bound = params.map(toSqliteValue);
    if (returnsRows(sql)) {
      // node:sqlite hands back null-prototype objects; callers should get ordinary ones so that
      // spreading, deep equality and schema parsing behave the way they read.
      const rows = (statement.all(...bound) as Record<string, unknown>[]).map(
        (row) => ({ ...row }) as Row,
      );
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...bound);
    return { rows: [], rowCount: Number(result.changes) };
  }

  /** Runs `work` inside a single transaction, rolling back if it throws. */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    this.#db.exec("BEGIN");
    try {
      const result = await work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Executes raw SQL that may contain several statements, such as a migration file. */
  exec(sql: string): void {
    this.#db.exec(sql);
  }

  async close(): Promise<void> {
    this.#statements.clear();
    this.#db.close();
  }

  #prepare(sql: string): StatementSync {
    const translated = translatePlaceholders(sql);
    const cached = this.#statements.get(translated);
    if (cached) return cached;
    const statement = this.#db.prepare(translated);
    this.#statements.set(translated, statement);
    return statement;
  }
}

/** `$1` is the placeholder style the queries are written in; SQLite spells the same thing `?1`. */
export function translatePlaceholders(sql: string): string {
  return sql.replace(/\$(\d+)/g, "?$1");
}

/** ISO-8601 UTC is the only timestamp representation this schema stores. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Parses a JSON column, returning `fallback` when the column is null or unreadable. */
export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function returnsRows(sql: string): boolean {
  const head = sql.trimStart().slice(0, 6).toUpperCase();
  return head.startsWith("SELECT") || head.startsWith("WITH") || /RETURNING/i.test(sql);
}

function toSqliteValue(value: unknown): null | number | bigint | string | Uint8Array {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && !(value instanceof Uint8Array)) return JSON.stringify(value);
  return value as number | bigint | string | Uint8Array;
}

export { type MigrationResult, migrate } from "./migrate.js";
