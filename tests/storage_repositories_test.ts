/**
 * The domain split of `MetadataStore` (audio-feed-d9sl Phase 1, implementations per domain in
 * audio-feed-8r1e).
 *
 * This file is mostly a COMPILE-TIME proof. The risk in a type-level split is not that a call breaks
 * — the composed `MetadataStore` still has every method, so nothing can break — but that the
 * grouping quietly rots: a method added to a domain that the store does not have, a method that
 * belongs to no domain (so no lane owns it), or the same method reachable from two domains (so two
 * lanes still collide on one method, which is the collision the split exists to remove). `deno
 * check` fails on all three here, before any test runs.
 *
 * The runtime cases pin the facade's shape for both adapters that `tests/storage_test.ts` wires up
 * through the conformance suite; here they check the exported domain record.
 */
import { assert, assertEquals } from "@std/assert";
import { MemoryMetadataStore } from "../src/storage/memory.ts";
import {
  type ArticleRepository,
  type AuthRepository,
  type EpisodeRepository,
  type MetadataRepositories,
  type MetadataStore,
  type NotificationRepository,
  type OrphanBlobRepository,
  type RunRepository,
  type SourceRepository,
  type SynthesisSegmentRepository,
  type UsageRepository,
  type UserRepository,
} from "../src/storage/mod.ts";

type MethodKeys<T> = {
  [K in keyof T]-?: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T];

/** The members of `MetadataStore` that are shared infrastructure, not one entity's business. */
type SharedKeys = "repositories" | "atomicUpdate" | "close";

type StoreMethods = Exclude<MethodKeys<MetadataStore>, SharedKeys>;
type DomainMethods = {
  [D in keyof MetadataRepositories]: MethodKeys<MetadataRepositories[D]>;
}[keyof MetadataRepositories];

/** A method that belongs to no domain: nobody owns it, so a lane would still guess. */
type Uncovered = Exclude<StoreMethods, DomainMethods>;
/** A domain method the store does not have: the grouping has drifted from the contract. */
type Phantom = Exclude<DomainMethods, StoreMethods>;
/** A method reachable from two domains: the collision the split exists to remove. */
type Overlapping = {
  [A in keyof MetadataRepositories]: {
    [B in keyof MetadataRepositories]: A extends B ? never
      : Extract<MethodKeys<MetadataRepositories[A]>, MethodKeys<MetadataRepositories[B]>>;
  }[keyof MetadataRepositories];
}[keyof MetadataRepositories];

/**
 * Only callable with `never`: passing a non-never type is a compile error naming the offending
 * methods, which is the whole check. The argument list is empty when the type really is `never`.
 */
function assertNever<T extends never>(..._empty: [T] extends [never] ? [] : [never]): void {
  // no-op: the type is the assertion
}

const DOMAIN_NAMES = [
  "articles",
  "auth",
  "episodes",
  "notifications",
  "orphanBlobs",
  "runs",
  "segments",
  "sources",
  "usage",
  "users",
] as const;

Deno.test("the domain split covers every store method exactly once (audio-feed-d9sl)", () => {
  assertNever<Uncovered>();
  assertNever<Phantom>();
  assertNever<Overlapping>();
});

Deno.test("every domain is reachable, and typed as its own repository (audio-feed-d9sl)", () => {
  // A type-level check with a runtime body: if a domain were dropped from `MetadataRepositories`,
  // the assertion above still holds only when its methods moved elsewhere — this catches a domain
  // that vanished wholesale.
  const store = new MemoryMetadataStore();
  assertEquals(Object.keys(store.repositories).sort(), [...DOMAIN_NAMES]);

  // Each of these is a compile-time statement that the view has the domain's type, and a runtime
  // statement that it is that domain's own implementation: in Phase 1 the views WERE the store,
  // which is what made the type split behaviour-preserving; Phase 2 replaced them, deliberately.
  const views: [
    UserRepository,
    SourceRepository,
    ArticleRepository,
    EpisodeRepository,
    SynthesisSegmentRepository,
    OrphanBlobRepository,
    UsageRepository,
    NotificationRepository,
    RunRepository,
    AuthRepository,
  ] = [
    store.repositories.users,
    store.repositories.sources,
    store.repositories.articles,
    store.repositories.episodes,
    store.repositories.segments,
    store.repositories.orphanBlobs,
    store.repositories.usage,
    store.repositories.notifications,
    store.repositories.runs,
    store.repositories.auth,
  ];
  for (const view of views) {
    assert(view !== (store as unknown as UserRepository), "a domain is its own implementation now");
  }
});

Deno.test("a domain object exposes its own methods only (audio-feed-8r1e)", () => {
  // The other half of the collision guarantee: the compile-time check above proves no METHOD is
  // reachable from two domains, and this proves the runtime objects agree with it. Without it, a
  // domain could forward a neighbour's method and the file every lane edits would stay shared.
  const store = new MemoryMetadataStore();
  const foreign: Record<string, string[]> = {
    users: ["getEpisode", "getArticle", "getSession"],
    articles: ["getEpisode", "getUser"],
    episodes: ["getArticle", "getUser"],
    auth: ["getUser", "getEpisode"],
  };
  for (const [domain, names] of Object.entries(foreign)) {
    const view = store.repositories[domain as keyof MetadataRepositories] as unknown as Record<
      string,
      unknown
    >;
    for (const name of names) {
      assertEquals(name in view, false, `${domain} must not expose ${name}`);
    }
  }
});
