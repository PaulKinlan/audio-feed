import { assert } from "@std/assert";
import type { EpisodeQuery, MetadataStore, RunRecord } from "../../../src/storage/mod.ts";
import type { Episode } from "../../../src/types.ts";
import { makeEpisode } from "../../fixtures.ts";

/**
 * The shared harness for the `MetadataStore` conformance suite.
 *
 * `runMetadataConformance` is still the entry point (`tests/storage_test.ts` calls it once per
 * adapter); the cases now live in one module per domain under this directory (audio-feed-fydf), and
 * this file is what they share.
 *
 * The `test` closure is the whole contract: it gives a case a FRESH store and closes it afterwards,
 * so a case cannot leak state into the next one. It stays in one place on purpose — a domain module
 * that registered its own `Deno.test` could drift from that guarantee without any test failing.
 */

export interface MetadataSuiteOptions {
  name: string;
  /** Fresh, empty store per test. */
  create: () => Promise<MetadataStore> | MetadataStore;
}

/** What a domain module is handed: register a case with `test(label, fn)`. */
export interface MetadataHarness {
  readonly name: string;
  readonly create: MetadataSuiteOptions["create"];
  test(label: string, fn: (store: MetadataStore) => void | Promise<void>): void;
}

export function createMetadataHarness(
  { name, create }: MetadataSuiteOptions,
): MetadataHarness {
  return {
    name,
    create,
    test(label, fn) {
      Deno.test(`${name}: ${label}`, async () => {
        const store = await create();
        try {
          await fn(store);
        } finally {
          await store.close();
        }
      });
    },
  };
}

/**
 * The suite-scoped fixtures the cases share.
 *
 * These lived inside `runMetadataConformance` when every case was in one file, so a fixture declared
 * in one section stayed in scope for a case in another: `run` was declared with the statistics cases
 * and used by the outbox cases, `drainPages` with the paging cases and used by the claim cases. One
 * file per domain takes that scope apart, so they live here — named exactly as they were, which is
 * why no case body had to change to move.
 */

/** Distinct, ordered timestamps for history tests. */
export function isoAt(index: number): string {
  return new Date(Date.UTC(2026, 8, 25, 0, 0, 0) + index * 60_000).toISOString();
}

export async function drainPages(
  store: MetadataStore,
  query: Omit<EpisodeQuery, "limit">,
  limit: number,
) {
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await store.listEpisodePage({ ...query, limit, cursor });
    seen.push(...page.episodes.map((e) => e.id));
    pages++;
    if (!page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
    assert(pages < 50, "paging did not terminate");
  }
  return { seen, pages };
}

export const CLAIM = {
  owner: "worker-a",
  now: "2026-09-20T12:00:00.000Z",
  leaseMs: 60_000,
  maxClaims: 3,
};

export const queued = (over: Partial<Episode> = {}) =>
  makeEpisode({ id: "e1", status: "pending", audioKey: undefined, ...over });

export const published = (over: Partial<Episode> = {}) =>
  makeEpisode({
    id: "e1",
    status: "ready",
    audioKey: "audio/user-1/direct/e1.wav",
    contentType: "audio/wav",
    ...over,
  });

export const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-1",
  kind: "feed-poll",
  trigger: "cron",
  startedAt: "2026-09-25T10:00:00.000Z",
  durationMs: 120,
  polled: 3,
  queued: 2,
  failed: 0,
  ...over,
});

export const FUTURE = "2999-01-01T00:00:00.000Z";
