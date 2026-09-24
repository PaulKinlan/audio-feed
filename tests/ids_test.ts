/**
 * Identifier invariants.
 *
 * These assertions exist because the failure they guard against is silent: a
 * guessable episode id or feed token does not break any test, it just makes a
 * private feed enumerable by anyone who has one URL.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { newEpisodeId, newFeedToken, randomToken, timingSafeEqual } from "../src/ids.ts";
import { audioBlobKey, isPublishable, isSynthesisAuthorized } from "../src/types.ts";
import { makeEpisode, makeUser } from "./fixtures.ts";

Deno.test("feed tokens are long, URL-safe, and unique", () => {
  const tokens = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const token = newFeedToken();
    assert(/^[a-z0-9]{32}$/.test(token), `unexpected token shape: ${token}`);
    tokens.add(token);
  }
  assertEquals(tokens.size, 500, "feed tokens must not repeat");
});

Deno.test("episode ids are unguessable, not sequential", () => {
  const first = newEpisodeId();
  const second = newEpisodeId();
  assertNotEquals(first, second);
  // UUIDv4: a counter or timestamp-prefixed id would fail this.
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(first));
});

Deno.test("randomToken covers its alphabet (not stuck on one symbol)", () => {
  const sample = randomToken(2000);
  assert(new Set(sample).size > 20, "token generator is not spreading across the alphabet");
});

Deno.test("timingSafeEqual matches === semantics", () => {
  assert(timingSafeEqual("abc", "abc"));
  assert(!timingSafeEqual("abc", "abd"));
  assert(!timingSafeEqual("abc", "abcd"), "a prefix must not compare equal");
  assert(!timingSafeEqual("", "a"));
  assert(timingSafeEqual("", ""));
});

Deno.test("the approval gate authorizes only approved users", () => {
  assert(isSynthesisAuthorized(makeUser({ status: "approved" })));
  assert(!isSynthesisAuthorized(makeUser({ status: "pending" })));
  assert(!isSynthesisAuthorized(makeUser({ status: "suspended" })));
  assert(!isSynthesisAuthorized(null));
  assert(!isSynthesisAuthorized(undefined));
});

Deno.test("only ready episodes with audio are publishable", () => {
  assert(isPublishable(makeEpisode({ status: "ready" })));
  assert(!isPublishable(makeEpisode({ status: "pending", audioKey: undefined })));
  assert(!isPublishable(makeEpisode({ status: "failed", audioKey: undefined })));
  // A "ready" episode with no audio key would render an enclosure-less item.
  assert(!isPublishable(makeEpisode({ status: "ready", audioKey: undefined })));
  assert(!isPublishable(makeEpisode({ status: "ready", contentType: undefined })));
});

Deno.test("audio blob keys are scoped by user and mode", () => {
  const episode = makeEpisode({ id: "e1", userId: "u1", mode: "deepdive" });
  assertEquals(audioBlobKey(episode), "audio/u1/deepdive/e1.mp3");
  assertEquals(audioBlobKey(episode, "m4a"), "audio/u1/deepdive/e1.m4a");
});
