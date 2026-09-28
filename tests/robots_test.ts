/**
 * robots.txt (audio-feed-0mv).
 *
 * The private routes are token-fronted, so this is not the access control — it
 * is about not inviting crawlers to spend KV reads on capability URLs, and about
 * keeping a subscriber's token out of a search result. Pinned verbatim because
 * a reordered or weakened file still "returns 200".
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import type { AppConfig } from "../src/config.ts";

const config: AppConfig = {
  port: 8000,
  publicBaseUrl: "https://audio.example.com",
  adminToken: "admin-secret",
};

Deno.test("GET /robots.txt disallows the private routes and allows the public ones (audio-feed-0mv)", async () => {
  const stores = memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));

  const res = await fetch(new Request("https://audio.example.com/robots.txt"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/plain");

  const body = await res.text();
  const expected = [
    "User-agent: *",
    "Disallow: /listen/",
    "Disallow: /admin",
    "Disallow: /api/",
    "Allow: /",
    "Allow: /assets/",
  ];
  assertEquals(
    body.trim().split("\n"),
    expected,
    "robots.txt must be exactly the agreed rules, in order",
  );
  // A bare Disallow: / would deindex the whole site; the file must never grow one.
  assertEquals(/^Disallow: \/$/m.test(body), false, "the public site must stay crawlable");
});
