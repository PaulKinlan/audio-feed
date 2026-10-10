/**
 * Synthesis segments: the reservation that stops a retried episode paying twice.
 *
 * Split out of tests/conformance/metadata.ts (audio-feed-fydf). The cases are unchanged: each one
 * was moved here verbatim from the section it already lived in.
 */

import type { MetadataHarness } from "./harness.ts";
import { assertEquals, assertNotEquals } from "@std/assert";
import type { SynthesisSegmentRecord } from "../../../src/types.ts";
import { makeUser } from "../../fixtures.ts";
import { CLAIM } from "./harness.ts";
import { queued } from "./harness.ts";

export function registerSegmentsCases(suite: MetadataHarness) {
  const { test } = suite;

  // -- synthesis segments (audio-feed-wr1u) -----------------------------------
  test("segment reservation is claim-conditional, single-owner, and stealable after lease expiry", async (store) => {
    await store.putUser(makeUser({ id: "user-1" }));
    await store.putEpisode(queued({ id: "e-seg" }));
    const t0 = Date.parse(CLAIM.now);
    const record = (hash: string, owner: string): SynthesisSegmentRecord => ({
      textHash: hash,
      text: `text ${hash}`,
      promptVersion: "v-test",
      voice: "Charon",
      audioKey: "",
      byteLength: 0,
      owner,
      claimAt: CLAIM.now,
      createdAt: CLAIM.now,
      finalized: false,
    });
    assertEquals(
      await store.reserveSynthesisSegment(
        "user-1",
        "e-seg",
        record("h1", "worker-a"),
        t0,
        CLAIM.leaseMs,
      ),
      "no-claim",
      "without a claim nothing may be reserved",
    );
    assertNotEquals(await store.claimEpisode("user-1", "e-seg", CLAIM), null);
    assertEquals(
      await store.reserveSynthesisSegment(
        "user-1",
        "e-seg",
        record("h1", "worker-b"),
        t0,
        CLAIM.leaseMs,
      ),
      "no-claim",
      "a second worker must not reserve under someone else's live claim",
    );
    assertEquals(
      await store.reserveSynthesisSegment(
        "user-1",
        "e-seg",
        record("h1", "worker-a"),
        t0,
        CLAIM.leaseMs,
      ),
      "reserved",
    );
    assertEquals(
      await store.finalizeSynthesisSegment(
        "user-1",
        "e-seg",
        { textHash: "h1", promptVersion: "v-test", voice: "Charon" },
        { audioKey: "k", byteLength: 1 },
        "worker-b",
        t0,
        CLAIM.leaseMs,
      ),
      false,
      "a slot may only be finalized by its reserver",
    );
    assertEquals(
      await store.finalizeSynthesisSegment(
        "user-1",
        "e-seg",
        { textHash: "h1", promptVersion: "v-test", voice: "Charon" },
        { audioKey: "k", byteLength: 1 },
        "worker-a",
        t0,
        CLAIM.leaseMs,
      ),
      true,
    );
    assertEquals(
      await store.reserveSynthesisSegment(
        "user-1",
        "e-seg",
        record("h1", "worker-a"),
        t0,
        CLAIM.leaseMs,
      ),
      "finalized",
      "a finalized slot reports reuse, not a fresh reservation",
    );
    assertEquals(
      await store.reserveSynthesisSegment(
        "user-1",
        "e-seg",
        record("h2", "worker-a"),
        t0,
        CLAIM.leaseMs,
      ),
      "reserved",
    );
    const later = t0 + CLAIM.leaseMs + 1;
    assertNotEquals(
      await store.claimEpisode("user-1", "e-seg", {
        ...CLAIM,
        owner: "worker-b",
        now: new Date(later).toISOString(),
      }),
      null,
    );
    assertEquals(
      await store.reserveSynthesisSegment(
        "user-1",
        "e-seg",
        record("h2", "worker-b"),
        later,
        CLAIM.leaseMs,
      ),
      "reserved",
      "a reservation whose claim lease expired is stealable",
    );
    assertEquals((await store.listSynthesisSegments("user-1", "e-seg")).length, 2);
    await store.clearSynthesisSegments("user-1", "e-seg");
    assertEquals(await store.listSynthesisSegments("user-1", "e-seg"), []);
  });
}
