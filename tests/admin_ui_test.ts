/**
 * Admin console tests (audio-feed-z2s).
 *
 * Two things matter here beyond "the endpoint answers":
 *  1. every admin route refuses without the token, including the ones that only
 *     read — a subscriber list is still other people's data;
 *  2. the console's happy path actually produces a working subscriber, so the UI
 *     is not a form that fills a table while the feed URL it hands out 404s.
 *
 * The last test is the one Paul's question was really about: create a subscriber
 * from the console API and play the audio their new feed advertises.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { renderAdminPage } from "../src/routes/admin.ts";
import { assetBody } from "../src/routes/assets.ts";
import { shippedCss } from "./admin_css.ts";
import { makeEpisode, makeSource, makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import type { DecodedAudioResult } from "../src/tts/gemini.ts";
import { runSynthesisBatch } from "../src/worker/synthesis.ts";

const BASE = "https://audio.example.com";
const ADMIN = "admin-secret";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: ADMIN };

const app = (extra: Partial<AppConfig> = {}) => {
  const stores: Stores = memoryStores();
  const cfg = { ...config, ...extra };
  const ctx = { config: cfg, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return { fetch, stores, ctx };
};

const req = (path: string, init: RequestInit = {}) =>
  new Request(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
const auth = { "x-admin-token": ADMIN };

// ---------------------------------------------------------------------------
// The page itself
// ---------------------------------------------------------------------------

Deno.test("the admin page renders the console with accessible controls (audio-feed-0jp)", () => {
  const html = renderAdminPage({ publicBaseUrl: BASE, adminConfigured: true });
  // The core controls an admin actually needs, present in the document.
  assertStringIncludes(html, 'id="createForm"');
  assertStringIncludes(html, 'id="usersBody"');
  // Token paste controls are removed in audio-feed-0jp; passkey sign-in is used
  assertEquals(html.includes('id="adminToken"'), false);
  assertEquals(html.includes('id="saveToken"'), false);
  assertStringIncludes(html, 'id="pollNowBtn"');
  assertStringIncludes(html, 'id="synthesizeNowBtn"');
  assertStringIncludes(html, 'id="triggersFeedback"');
  assertStringIncludes(html, "Poll Feeds Now");
  assertStringIncludes(html, "Synthesize Queue Now");
  // Accessible labelling: every input has a label, the table has a caption and
  // scoped headers, and the live regions announce results.
  assertStringIncludes(html, 'for="email"');
  assertStringIncludes(html, 'for="displayName"');
  assertEquals(html.includes('for="adminToken"'), false);
  assertStringIncludes(html, "<caption");
  assertStringIncludes(html, '<th scope="col">');
  assertStringIncludes(html, 'aria-live="polite"');
  // No data is baked in: the shell is public, the data is token-gated.
  // audio-feed-3xq part 4a: the client is a linked module now, so "the client must know
  // about the field" is asserted against the shipped module bytes, not the page string.
  assertStringIncludes(assetBody("admin.js") ?? "", "feedToken");
  assertEquals(html.includes(ADMIN), false, "the server token must never be in the page");
});

Deno.test("the background-runs table keeps a readable width on a phone (audio-feed-8fc)", () => {
  const html = renderAdminPage({ publicBaseUrl: BASE, adminConfigured: true });
  // At 390px an unconstrained five-column table squeezed Result to one
  // character per line; the table now holds a minimum width and scrolls.
  assertStringIncludes(html, '<table class="runs">');
  // Resolved through the link, not the inline <style>: this rule moved to src/assets/admin.css in
  // audio-feed-3xq part 3, and reading the HTML alone would now miss it.
  // Whitespace-normalised: deno fmt rewrites the extracted file across lines, and asserting on exact
  // formatting ties a behavioural test to the formatter's opinion rather than to the rule existing.
  const flat = shippedCss(html).replace(/\s+/g, " ");
  assert(
    flat.includes("table.runs { min-inline-size: 40rem; }"),
    "the runs table must keep its phone-width floor, inline or linked",
  );
});

Deno.test("GET /admin serves the console and is never cached", async () => {
  const { fetch } = app();
  const res = await fetch(req("/admin"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  // It prompts for a credential and displays a capability, so it must not sit in
  // any cache.
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertStringIncludes(await res.text(), "Audio Feed admin");
});

Deno.test("the page says so when the server has no admin token", () => {
  const html = renderAdminPage({ publicBaseUrl: BASE, adminConfigured: false });
  assertStringIncludes(html, "Admin token not configured");
});

Deno.test("subscriber-supplied text is never interpolated into the shell", () => {
  // The console holds the admin token in sessionStorage, so a stored-XSS payload
  // in a display name would be able to read it. Neither the page nor its client
  // module may contain server-side interpolation of user data or HTML-sink calls.
  // audio-feed-3xq part 4a: the client moved to src/assets/admin.js, so the
  // assertions follow the shipped bytes there AND stay on the page markup.
  const html = renderAdminPage({ publicBaseUrl: BASE, adminConfigured: true });
  const client = assetBody("admin.js") ?? "";
  assertStringIncludes(client, "textContent");
  // Assert on USAGE, not on the word: the client documents the rule in a
  // comment, so a bare substring check fails on its own documentation.
  for (const [where, text] of [["page", html], ["client module", client]] as const) {
    assertEquals(/\.innerHTML\s*=/.test(text), false, `no innerHTML assignment in the ${where}`);
    assertEquals(/insertAdjacentHTML/.test(text), false, `no insertAdjacentHTML in the ${where}`);
    assertEquals(/document\.write/.test(text), false, `no document.write in the ${where}`);
  }
});

// ---------------------------------------------------------------------------
// Token protection on every admin route
// ---------------------------------------------------------------------------

Deno.test("every admin route refuses without the token, including the read", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(makeUser({ id: "user-1" }));

  const calls: Array<[string, RequestInit]> = [
    ["/api/admin/users", { method: "GET" }],
    ["/api/admin/users", { method: "POST", body: JSON.stringify({ email: "new@example.com" }) }],
    ["/api/admin/users/user-1/approve", { method: "POST" }],
    ["/api/admin/users/user-1/suspend", { method: "POST" }],
    ["/api/admin/poll-now", { method: "POST" }],
    ["/api/admin/synthesize-now", { method: "POST" }],
  ];
  for (const [path, init] of calls) {
    assertEquals((await fetch(req(path, init))).status, 401, `${path} without a token`);
    assertEquals(
      (await fetch(req(path, { ...init, headers: { "x-admin-token": "wrong" } }))).status,
      401,
      `${path} with a wrong token`,
    );
  }
  // A wrong token must not have changed anything.
  assertEquals((await stores.metadata.getUser("user-1"))?.status, "approved");
});

Deno.test("an unconfigured server refuses instead of allowing", async () => {
  const { fetch } = app({ adminToken: undefined });
  // 403 with a reason, not a 500 and never a pass.
  const res = await fetch(req("/api/admin/users", { headers: auth }));
  assertEquals(res.status, 403);
  assertStringIncludes(await res.text(), "ADMIN_TOKEN");
});

// ---------------------------------------------------------------------------
// Creating, listing and suspending
// ---------------------------------------------------------------------------

Deno.test("creating a subscriber approves them and returns their feed token once", async () => {
  const { fetch, stores } = app();
  const res = await fetch(
    req("/api/admin/users", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "sub@example.com", displayName: "Subscriber" }),
    }),
  );
  assertEquals(res.status, 201);
  const created = await res.json();
  assertEquals(created.email, "sub@example.com");
  assertEquals(created.displayName, "Subscriber");
  // Created AND approved: an admin typing the details has already decided.
  assertEquals(created.status, "approved");
  assert(typeof created.feedToken === "string" && created.feedToken.length > 10);

  const stored = await stores.metadata.getUser(created.id);
  assertEquals(stored?.status, "approved");
  assertEquals(stored?.feedToken, created.feedToken);
});

Deno.test("creating a subscriber accepts dailyEpisodeBudget (audio-feed-9mp)", async () => {
  const { fetch, stores } = app();
  const res = await fetch(
    req("/api/admin/users", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        email: "budgeted@example.com",
        displayName: "Budgeted",
        dailyEpisodeBudget: 5,
      }),
    }),
  );
  assertEquals(res.status, 201);
  const created = await res.json();
  assertEquals(created.dailyEpisodeBudget, 5);

  const stored = await stores.metadata.getUser(created.id);
  assertEquals(stored?.dailyEpisodeBudget, 5);
});

Deno.test("the subscriber list returns everyone and leaks no capability", async () => {
  const { fetch } = app();
  await fetch(
    req("/api/admin/users", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "a@example.com", displayName: "A" }),
    }),
  );
  const res = await fetch(req("/api/admin/users", { headers: auth }));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.users.length, 1);
  assertEquals(body.users[0].email, "a@example.com");
  assertEquals("feedToken" in body.users[0], false, "the list must not carry capabilities");
});

Deno.test("duplicate emails are refused with a conflict, not a 500", async () => {
  const { fetch } = app();
  const body = JSON.stringify({ email: "dup@example.com" });
  assertEquals(
    (await fetch(req("/api/admin/users", { method: "POST", headers: auth, body }))).status,
    201,
  );
  const second = await fetch(req("/api/admin/users", { method: "POST", headers: auth, body }));
  assertEquals(second.status, 409);
});

Deno.test("a missing email is a 400 and creates nothing", async () => {
  const { fetch, stores } = app();
  const res = await fetch(
    req("/api/admin/users", { method: "POST", headers: auth, body: JSON.stringify({}) }),
  );
  assertEquals(res.status, 400);
  assertEquals((await stores.metadata.listUsers()).length, 0);
});

Deno.test("suspending stops the feed immediately", async () => {
  const { fetch, stores } = app();
  const created = await (await fetch(
    req("/api/admin/users", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "s@example.com" }),
    }),
  )).json();
  await stores.metadata.putSource(makeSource({ id: "inbox", userId: created.id }));
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-1",
      userId: created.id,
      sourceId: "inbox",
      status: "ready",
      audioKey: "e.wav",
    }),
  );
  await stores.blobs.put("e.wav", new Uint8Array(8), { contentType: "audio/wav" });

  const feed = `/feed/${created.feedToken}/master.xml`;
  assertEquals((await fetch(req(feed))).status, 200);

  const suspended = await fetch(
    req(`/api/admin/users/${created.id}/suspend`, { method: "POST", headers: auth }),
  );
  assertEquals(suspended.status, 200);
  assertEquals((await suspended.json()).status, "suspended");
  // A suspended subscriber's feed stops serving, so a revocation is immediate.
  assertEquals((await fetch(req(feed))).status, 403);
  // And their synthesis is refused too.
  const ingest = await fetch(
    req("/api/ingest", {
      method: "POST",
      headers: { "x-feed-token": created.feedToken },
      body: JSON.stringify({ url: "https://example.com/x", mode: "direct" }),
    }),
  );
  assertEquals(ingest.status, 403);
});

Deno.test("approving a pending user through the console works", async () => {
  const { fetch, stores } = app();
  await stores.metadata.putUser(
    makeUser({ id: "pending-1", email: "p@example.com", status: "pending" }),
  );
  const res = await fetch(
    req("/api/admin/users/pending-1/approve", { method: "POST", headers: auth }),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).status, "approved");
});

// ---------------------------------------------------------------------------
// The flow Paul asked about: make a user, then play what their feed serves
// ---------------------------------------------------------------------------

Deno.test("END TO END: create from the console, then play the subscriber's feed", async () => {
  const stores: Stores = memoryStores();
  const ctx = { config, stores };
  const { fetch } = createApp(
    ctx,
    createHandlers(ctx, {
      fetchArticle: () =>
        Promise.resolve({
          url: "https://example.com/aggregation",
          title: "Why platforms win",
          author: "Ben Thompson",
          publishedAt: "2026-09-01T00:00:00.000Z",
          lead: "A lead.",
          body: "Aggregation theory explains why platforms win.",
        }),
    }),
  );

  // 1. The admin creates a subscriber in the console.
  const created = await (await fetch(
    req("/api/admin/users", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "paul@example.com", displayName: "Paul" }),
    }),
  )).json();
  assertEquals(created.status, "approved");

  // 2. That subscriber sends an article to their own feed.
  const ingest = await fetch(
    req("/api/ingest", {
      method: "POST",
      headers: { "x-feed-token": created.feedToken },
      body: JSON.stringify({ url: "https://example.com/aggregation", mode: "direct" }),
    }),
  );
  assertEquals(ingest.status, 202);

  // 3. The worker synthesises it.
  const audio = (): DecodedAudioResult => {
    const raw = new Uint8Array(44 + 200);
    raw.set([0x52, 0x49, 0x46, 0x46], 0);
    raw.set([0x57, 0x41, 0x56, 0x45], 8);
    raw.set([0x64, 0x61, 0x74, 0x61], 36);
    return {
      rawBytes: raw,
      mimeType: "audio/wav",
      format: "wav",
      sampleRate: 24000,
      channels: 1,
      bitsPerSample: 16,
      durationSeconds: 1,
      finishReason: "STOP",
      truncated: false,
      toWav: () => raw,
    };
  };
  const run = await runSynthesisBatch(ctx, () => Promise.resolve(audio()));
  assertEquals(run.ready.length, 1);

  // 4. The URL the console hands out is the URL that serves the audio.
  const feedUrl = `/feed/${created.feedToken}/master.xml`;
  const feed = await fetch(req(feedUrl));
  assertEquals(feed.status, 200);
  const xml = await feed.text();
  const enclosure = xml.match(/<enclosure url="([^"]+)" length="(\d+)"/);
  assert(enclosure, "the subscriber's feed must advertise their new episode");
  const bytes = await fetch(new Request(enclosure[1]!));
  assertEquals(bytes.status, 200);
  assertEquals((await bytes.bytes()).length, Number(enclosure[2]));
});

Deno.test("a hostile origin cannot break out of the script block", () => {
  // The origin can be request-derived (Host header), so a value containing
  // </script> must not be able to close the element and inject markup.
  const hostile = "https://example.com/</script><img src=x onerror=alert(1)>";
  const html = renderAdminPage({ publicBaseUrl: hostile, adminConfigured: true });
  assertEquals(/<\/script><img/.test(html), false, "the payload must not appear as markup");
  assertStringIncludes(html, "\\u003c/script\\u003e");
  // And the document still has exactly the script blocks it should: the shell's inline
  // script, the #admin-data island, and the client module (audio-feed-3xq part 4a).
  const opens = html.match(/<script\b/g)?.length ?? 0;
  const closes = html.match(/<\/script>/g)?.length ?? 0;
  assertEquals(opens, closes);
  assertEquals(opens, 3);
});
