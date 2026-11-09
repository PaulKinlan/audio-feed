/**
 * What a public feed response may disclose about the account behind a capability.
 *
 * Both rows come from the 2026-11-09 threat-model audit and land on the same seam
 * (`src/compose/feeds.ts`), because both are statements about the document and the
 * refusal that leave the deployment in a subscriber's hands:
 *
 * - audio-feed-vcpyi: the refusal branched on the resolved user (`forbidden("Feed
 *   unavailable (status: ${user.status})")` for a known-but-unapproved owner, 404
 *   only for an unknown token), so a caller holding a token learned TWO facts from
 *   one request: the token exists, and the account's exact lifecycle state. That
 *   contradicts the uniform-refusal policy `/listen` already follows
 *   (audio-feed-se8s8) and recorded in THREAT_MODEL Boundary 1.
 * - audio-feed-zlu04: the served RSS carried `ownerEmail: user.email`, which the
 *   generator renders as `<itunes:owner><itunes:email>`. A capability URL is pasted
 *   into third-party podcast clients and directories, so the subscriber's account
 *   address left deployment control on the first subscribe.
 *
 * These drive the real dispatcher (`createApp`), not the handlers directly: the
 * claim being made is about what a client actually receives.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { bytes, makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { UserStatus } from "../src/types.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE };

/** Every lifecycle state that is NOT approved, with the user seeded in it. */
const UNAPPROVED: readonly UserStatus[] = ["pending", "suspended", "rejected"];

async function app() {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "user-1", status: "approved" }));
  for (const status of UNAPPROVED) {
    // makeUser derives the feed token from the id, so each row has its own capability.
    await stores.metadata.putUser(makeUser({ id: `user-${status}`, status }));
  }
  await stores.metadata.putSource(makeSource({ id: "stratechery", userId: "user-1" }));
  const audio = bytes(1024);
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "episode-1",
      userId: "user-1",
      sourceId: "stratechery",
      status: "ready",
      mode: "direct",
      audioKey: "audio/user-1/direct/episode-1.mp3",
      byteLength: audio.length,
      contentType: "audio/mpeg",
    }),
  );
  await stores.blobs.put("audio/user-1/direct/episode-1.mp3", audio, {
    contentType: "audio/mpeg",
  });
  const { fetch } = createApp({ config, stores }, createHandlers({ config, stores }));
  return { fetch, stores };
}

const get = (fetch: (req: Request) => Promise<Response>, path: string) =>
  fetch(new Request(`${BASE}${path}`));

/** The two capability route families, each with the three refusal rows it admits. */
const ROUTES = [
  { name: "master", path: (token: string) => `/feed/${token}/master.xml` },
  {
    name: "source",
    path: (token: string) => `/feed/${token}/stratechery/direct.xml`,
  },
] as const;

Deno.test("feed refusals are uniform: an unknown token and a non-approved owner answer the same response (audio-feed-vcpyi)", async () => {
  const { fetch } = await app();

  for (const route of ROUTES) {
    const unknown = await get(fetch, route.path("no-such-token"));
    const unknownBody = await unknown.text();

    // The baseline row: an unknown token is a plain 404.
    assertEquals(unknown.status, 404, `${route.name}: an unknown token must be 404`);
    assertEquals(unknownBody, JSON.stringify({ error: "Unknown feed" }));

    for (const status of UNAPPROVED) {
      const refusal = await get(fetch, route.path(`token-user-${status}`));
      const body = await refusal.text();
      // Row: identical STATUS. A 403 here was the oracle — it said the token is real.
      assertEquals(
        refusal.status,
        unknown.status,
        `${route.name} (${status}): refusal status must equal the unknown-token status`,
      );
      // Row: identical BODY. This is the row that fails if `${user.status}` comes back.
      assertEquals(
        body,
        unknownBody,
        `${route.name} (${status}): refusal body must be byte-identical to the unknown-token body`,
      );
      // Row: no cache or error detail differs either — a client, or a cache in between,
      // must not be able to tell the two apart from any header.
      assertEquals(refusal.headers.get("cache-control"), unknown.headers.get("cache-control"));
      assertEquals(refusal.headers.get("content-type"), unknown.headers.get("content-type"));
    }
  }
});

Deno.test("no feed response body carries the account's status string (audio-feed-vcpyi)", async () => {
  const { fetch } = await app();

  for (const route of ROUTES) {
    for (const status of UNAPPROVED) {
      const body = await (await get(fetch, route.path(`token-user-${status}`))).text();
      // The words the old interpolation published ("Feed unavailable (status: pending)").
      // Checked as a whole body, not per-field: any future field naming the state is a leak.
      for (const leak of [status, "status", "Feed unavailable"]) {
        assert(
          !body.includes(leak),
          `${route.name} (${status}): refusal body must not contain ${JSON.stringify(leak)}: ${
            JSON.stringify(body)
          }`,
        );
      }
    }
  }
});

Deno.test("an approved token still serves both feed routes (audio-feed-vcpyi)", async () => {
  const { fetch } = await app();

  const master = await get(fetch, "/feed/token-user-1/master.xml");
  assertEquals(master.status, 200);
  const masterXml = await master.text();
  assertStringIncludes(masterXml, '<rss version="2.0"');
  assertStringIncludes(masterXml, `<atom:link href="${BASE}/feed/token-user-1/master.xml"`);
  assertStringIncludes(masterXml, "episode-1");

  const source = await get(fetch, "/feed/token-user-1/stratechery/direct.xml");
  assertEquals(source.status, 200);
  const sourceXml = await source.text();
  assertStringIncludes(sourceXml, `<atom:link href="${BASE}/feed/token-user-1`);
  assertStringIncludes(sourceXml, "episode-1");
});

Deno.test("the served feed publishes no account email and no itunes:owner (audio-feed-zlu04)", async () => {
  const { fetch, stores } = await app();
  const user = await stores.metadata.getUser("user-1");
  assert(user, "the seeded subscriber must exist");

  for (const route of ROUTES) {
    const xml = await (await get(fetch, route.path("token-user-1"))).text();

    // Row: the account email appears NOWHERE in the document — not as an attribute, not
    // inside a description, not on a per-episode element. Substring, not element-shaped,
    // because the finding is "the address left deployment control", not "this tag is wrong".
    assert(
      !xml.includes(user.email),
      `${route.name}: the served feed must not contain the account email`,
    );
    // Row: no element can carry it either.
    assert(
      !xml.includes("<itunes:owner"),
      `${route.name}: the served feed must not publish <itunes:owner>`,
    );
    assert(
      !xml.includes("<itunes:email"),
      `${route.name}: the served feed must not publish <itunes:email>`,
    );
    // Row: no email-shaped value at all, whoever wrote it.
    assert(
      !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(xml),
      `${route.name}: the served feed must contain no email-shaped value`,
    );
  }
});

Deno.test("the metadata a subscriber keeps is the show's, not the account's (audio-feed-zlu04)", async () => {
  const { fetch } = await app();

  // The removal is narrow: the channel still publishes a title, an author and the
  // self-link, which is what a client displays. What is gone is the owner block.
  const master = await (await get(fetch, "/feed/token-user-1/master.xml")).text();
  assertStringIncludes(master, "<title>Paul — Audio Feed</title>");
  assertStringIncludes(master, "<itunes:author>Paul</itunes:author>");

  const source = await (await get(fetch, "/feed/token-user-1/stratechery/direct.xml")).text();
  assertStringIncludes(source, "<title>Stratechery — Direct Read</title>");
  assertStringIncludes(source, "<itunes:author>Stratechery</itunes:author>");
});
