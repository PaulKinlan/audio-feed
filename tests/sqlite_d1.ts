/**
 * In-memory SQLite implementation of `D1DatabaseLike` backed by `node:sqlite`.
 *
 * Runs real SQLite SQL, UNIQUE/PK constraints, RETURNING clauses, and atomic
 * `batch()` transactions identically in both Node 22+ and Deno 2.9+.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from "../src/storage/d1/types.ts";

const INITIAL_SCHEMA_SQL = readFileSync(
  new URL("../migrations/0001_initial.sql", import.meta.url),
  "utf8",
);

function normalizeParam(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  return String(value);
}

class SqlitePreparedStatement implements D1PreparedStatementLike {
  readonly #db: DatabaseSync;
  readonly #sql: string;
  readonly #params: SQLInputValue[];

  constructor(db: DatabaseSync, sql: string, params: SQLInputValue[] = []) {
    this.#db = db;
    this.#sql = sql;
    this.#params = params;
  }

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new SqlitePreparedStatement(this.#db, this.#sql, values.map(normalizeParam));
  }

  #execAll<T>(): D1ResultLike<T> {
    const stmt = this.#db.prepare(this.#sql);
    const trimmed = this.#sql.trimStart().toUpperCase();
    const returnsRows = trimmed.startsWith("SELECT") ||
      trimmed.startsWith("WITH") ||
      trimmed.startsWith("PRAGMA") ||
      /\bRETURNING\b/i.test(this.#sql);

    if (returnsRows) {
      const rows = stmt.all(...this.#params) as T[];
      return {
        results: rows.map((r) => ({ ...(r as Record<string, unknown>) }) as T),
        success: true,
        meta: { changes: rows.length },
      };
    }

    const info = stmt.run(...this.#params);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
      },
    };
  }

  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const res = this.#execAll<Record<string, unknown>>();
    const row = res.results[0];
    if (!row) return Promise.resolve(null);
    if (colName !== undefined) {
      return Promise.resolve((row[colName] ?? null) as T | null);
    }
    return Promise.resolve(row as T);
  }

  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return Promise.resolve(this.#execAll<T>());
  }

  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return Promise.resolve(this.#execAll<T>());
  }

  _execSync<T>(): D1ResultLike<T> {
    return this.#execAll<T>();
  }
}

export class SqliteD1Database implements D1DatabaseLike {
  readonly db: DatabaseSync;

  constructor(filename = ":memory:", schemaSql = INITIAL_SCHEMA_SQL) {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if (filename !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    if (schemaSql) {
      this.db.exec(schemaSql);
    }
  }

  prepare(query: string): D1PreparedStatementLike {
    return new SqlitePreparedStatement(this.db, query);
  }

  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementLike[],
  ): Promise<D1ResultLike<T>[]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out: D1ResultLike<T>[] = [];
      for (const stmt of statements) {
        out.push((stmt as SqlitePreparedStatement)._execSync<T>());
      }
      this.db.exec("COMMIT");
      return Promise.resolve(out);
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback error
      }
      return Promise.reject(err);
    }
  }

  exec(query: string): Promise<unknown> {
    this.db.exec(query);
    return Promise.resolve();
  }

  close(): void {
    this.db.close();
  }
}

export function createTestD1(filename = ":memory:"): SqliteD1Database {
  return new SqliteD1Database(filename);
}
