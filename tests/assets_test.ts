/**
 * audio-feed-3xq — the player's stylesheet is a file now, served content-addressed.
 *
 * These pin the three things that make the move safe rather than just different: the page links the
 * asset instead of embedding it, the URL changes when the bytes change (which is what makes
 * `immutable` an honest header rather than a stale-cache bug), and an unknown asset cannot be used
 * to read arbitrary files.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { assetUrl, handleAsset } from "../src/routes/assets.ts";
import { makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };
const TOKEN = "token-assets";

async function app() {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(makeUser({ id: "u1", status: "approved", feedToken: TOKEN }));
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return { fetch, stores };
}

Deno.test("the listen page links its stylesheet instead of embedding it (audio-feed-3xq)", async () => {
  const { fetch } = await app();
  const html = await (await fetch(new Request(`${BASE}/listen/${TOKEN}`))).text();
  const url = assetUrl("listen.css");
  assert(html.includes(`<link rel="stylesheet" href="${url}">`), `expected a link to ${url}`);
  // The marker below exists once in the stylesheet and once in the page would mean the CSS is still
  // inlined as well as served — the duplication this bead exists to remove.
  assert(!html.includes("<style>"), "the player page must not carry an inline stylesheet block");
});

Deno.test("the asset is served with immutable caching and the right type (audio-feed-3xq)", async () => {
  const { fetch } = await app();
  const url = assetUrl("listen.css");
  const res = await fetch(new Request(`${BASE}${url}`));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/css; charset=utf-8");
  assertEquals(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assertStringIncludes(await res.text(), "--accent");
});

Deno.test("the URL is a content address, so changed bytes mean a new URL (audio-feed-3xq)", async () => {
  const before = assetUrl("listen.css");
  // Same content, same address — the hash is of the bytes, not of the name or the clock.
  assertEquals(assetUrl("listen.css"), before);
  assert(
    /^\/assets\/[0-9a-f]{8}\.listen\.css$/.test(before),
    `unexpected asset URL shape: ${before}`,
  );
  // A different body must produce a different address, or `immutable` would serve stale CSS forever.
  // Called with the addressed name, because an un-addressed one is a 404 by design (below).
  const addressed = before.slice("/assets/".length);
  const other = await handleAsset({ params: { name: addressed } } as never);
  assert(other.ok, `the addressed asset is served: ${addressed}`);
  const hashed = (text: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  assert(hashed(await other.clone().text()) !== "00000000", "the served body hashes to something");
  assert(
    before.includes(hashed(await other.text())),
    "the URL must contain the hash of the bytes it names",
  );
});

Deno.test("an unknown asset is a 404 and cannot traverse (audio-feed-3xq)", async () => {
  const { fetch } = await app();
  for (const name of ["", "listen-app.js", "../server.ts", "%2e%2e/server.ts", "deno.json"]) {
    const res = await fetch(new Request(`${BASE}/assets/${name}`));
    assertEquals(res.status, 404, `${JSON.stringify(name)} must not resolve to a file`);
  }
  // A well-formed address for an asset that does not exist reaches the handler, and its 404 must not
  // be cacheable: a name retried after a deploy that adds it must not be pinned to a miss.
  const miss = await handleAsset({ params: { name: "00000000.listen.css" } } as never);
  assertEquals(miss.status, 404);
  assertEquals(miss.headers.get("cache-control"), "no-store");
  // And a REAL asset name carrying the WRONG hash is refused rather than served: the address is a
  // promise, and honouring any hash would let `immutable` pin the wrong bytes forever.
  const wrong = await handleAsset({ params: { name: "deadbeef.listen.css" } } as never);
  assertEquals(wrong.status, 404, "a mismatched content hash must not serve");
});
