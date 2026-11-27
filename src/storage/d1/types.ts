/**
 * Minimal structural subset of Cloudflare D1's API used by `D1MetadataStore`.
 *
 * Keeping this structural (rather than importing global `@cloudflare/workers-types`)
 * lets `D1MetadataStore` type-check cleanly in Cloudflare Workers, Node, and Deno,
 * and allows a local `node:sqlite` driver to run the full conformance suite against
 * real SQLite semantics without a network hop.
 */

export interface D1MetaLike {
  changes?: number;
  last_row_id?: number;
}

export interface D1ResultLike<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1MetaLike;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T = unknown>(colName: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementLike[],
  ): Promise<D1ResultLike<T>[]>;
  exec?(query: string): Promise<unknown>;
}
