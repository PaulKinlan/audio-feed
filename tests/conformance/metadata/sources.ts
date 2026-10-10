/**
 * Sources: the subscriptions a feed is built from.
 *
 * Split out of tests/conformance/metadata.ts (audio-feed-fydf). The cases are unchanged: each one
 * was moved here verbatim from the section it already lived in.
 */

import type { MetadataHarness } from "./harness.ts";
import { assertEquals } from "@std/assert";
import { makeSource } from "../../fixtures.ts";

export function registerSourcesCases(suite: MetadataHarness) {
  const { test } = suite;

  // -- sources --------------------------------------------------------------

  test("scopes sources to their user", async (store) => {
    await store.putSource(makeSource({ id: "s1", userId: "user-1" }));
    await store.putSource(makeSource({ id: "s1", userId: "user-2", title: "Other" }));

    assertEquals((await store.getSource("user-1", "s1"))?.title, "Stratechery");
    assertEquals((await store.getSource("user-2", "s1"))?.title, "Other");
    assertEquals((await store.listSources("user-1")).length, 1);
  });

  test("deletes a source", async (store) => {
    await store.putSource(makeSource({ id: "s1", userId: "user-1" }));
    assertEquals((await store.getSource("user-1", "s1"))?.id, "s1");

    await store.deleteSource("user-1", "s1");
    assertEquals(await store.getSource("user-1", "s1"), null);
    assertEquals((await store.listSources("user-1")).length, 0);

    // Deleting non-existent source does not throw
    await store.deleteSource("user-1", "s1");
  });
}
