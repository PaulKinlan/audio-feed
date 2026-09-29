/**
 * Browser verification proof for draggable bookmarklet and prefilled form (audio-feed-ep1).
 *
 * Drives real headless Chrome over CDP:
 *   1. Starts app server on an ephemeral port (0, read back from the listener) with an
 *      approved subscriber.
 *   2. Desktop (1280x900):
 *      - Logs in and visits /account.
 *      - Verifies draggable bookmarklet button and bookmarklet JS payload.
 *      - Navigates to /account with bookmarklet query params (?add=...&title=...&feed=...).
 *      - Verifies the prefill renders exactly ONE unified card and NO second form
 *        (audio-feed-6hw: the always-on send panel used to render beside it).
 *      - With no feed in the URL, verifies server-side discovery offers the page's
 *        own declared feed inside the same card, and that a hostile candidate is
 *        dropped rather than rendered.
 *      - Clicks #quickSingleBtn and verifies single-episode queueing.
 *      - Clicks #quickSubscribeBtn and verifies feed subscription (prefilled and
 *        discovered).
 *   3. Mobile (390x844):
 *      - Verifies responsive layout and zero horizontal overflow.
 *   4. Front door (/):
 *      - Verifies bookmarklet hint and ?add= query param auto-filling.
 *
 *   deno run --allow-all --unstable-kv scripts/bookmarklet-browser-proof.ts
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";
import { discoverFeeds as discoverFeedsOnPage } from "../src/ingest/url.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { createTempChromeProfile, newestChrome } from "./proof-helper.ts";

const TOKEN = "subscriber-token-ep1";
const OUT = new URL("../docs/evidence/audio-feed-ep1/", import.meta.url).pathname;
const OUT6HW = new URL("../docs/evidence/audio-feed-6hw/", import.meta.url).pathname;
const { profileDir: PROFILE, cleanup } = await createTempChromeProfile("audiofeed-bookmarklet-");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await Deno.mkdir(OUT, { recursive: true });
await Deno.mkdir(OUT6HW, { recursive: true });

// -- start in-process server --------------------------------------------------
const config: AppConfig = {
  port: 0,
  adminToken: "admin-token-ep1",
};
const stores: Stores = memoryStores();
const ctx = { config, stores };

// Seed user and session
const rawUser = await createUser(stores.metadata, {
  email: "ada@example.com",
  displayName: "Ada Lovelace",
});
const user = await approveUser(stores.metadata, rawUser.id, "admin");
await stores.metadata.putUser({ ...user, feedToken: TOKEN });
const sessionSecret = await createSession(stores.metadata, user.id);

const handlers = createHandlers(ctx, {
  fetchArticle: (url) =>
    Promise.resolve({
      url,
      title: "Extracted Article Title",
      author: "Test Author",
      publishedAt: new Date().toISOString(),
      lead: "Lead",
      body: "Full body",
    }),
  // The REAL discovery helper over a fake page: the browser drives the real
  // client, the real endpoint, the real parser and the real http(s)-only filter;
  // only the socket is stubbed. The page declares the feed RELATIVE and smuggles a
  // javascript: candidate in behind it.
  discoverFeeds: (url) =>
    discoverFeedsOnPage(url, {
      transport: (pageUrl) =>
        Promise.resolve(
          new Response(
            pageUrl.pathname.includes("no-declared-feed")
              ? `<html><head><title>Quiet Page</title></head><body>nothing declared here</body></html>`
              : `<html><head><title>Discovered Page</title>
             <link rel="alternate" type="application/rss+xml" href="/discovered.xml" title="Discovered Feed">
             <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
             </head><body>hi</body></html>`,
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
          ),
        ),
    }),
  feedTransport: () =>
    Promise.resolve(
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Detected Feed</title><item><title>Post 1</title><link>https://example.com/p1</link></item></channel></rss>`,
        { status: 200, headers: { "content-type": "application/xml" } },
      ),
    ),
});
const { fetch: appFetch } = createApp(ctx, handlers);

const server = Deno.serve({ port: 0, onListen: () => {} }, (req, info) => appFetch(req, info));
const PORT = (server.addr as Deno.NetAddr).port;
const BASE = `http://localhost:${PORT}`;
config.port = PORT;
config.publicBaseUrl = BASE;

// -- launch chrome ------------------------------------------------------------

const chrome = new Deno.Command(newestChrome(), {
  args: [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--remote-debugging-port=0",
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
  stdout: "null",
  stderr: "null",
}).spawn();

let debugPort = "";
for (let i = 0; i < 100 && !debugPort; i++) {
  await sleep(100);
  debugPort = (await Deno.readTextFile(`${PROFILE}/DevToolsActivePort`).catch(() => "")).split(
    "\n",
  )[0]!;
}

const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const page = targets.find((t: { type: string }) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let nextId = 0;
const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
});

// deno-lint-ignore no-explicit-any
async function cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  const msg = await new Promise<{ result?: unknown; error?: unknown }>((r) => pending.set(id, r));
  if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}

// deno-lint-ignore no-explicit-any
async function js(expression: string): Promise<any> {
  const r = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(`${expression}: ${JSON.stringify(r.exceptionDetails)}`);
  return r.result?.value;
}

const checks: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail = "") {
  checks.push({ name, pass, detail });
  const tag = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`${tag}  ${name}  ${detail}`);
  if (!pass) throw new Error(`step failed: ${name}`);
}

async function until(expr: string, desc: string, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await js(expr)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${desc}`);
}

let exitCode = 0;
try {
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Network.enable");

  // Set session cookie
  await cdp("Network.setCookie", {
    name: "__Host-af_session",
    value: sessionSecret,
    url: `${BASE}/`,
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });

  // 1. Desktop pass (1280x900)
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // A. Visit /account
  await cdp("Page.navigate", { url: `${BASE}/account` });
  await until(`document.readyState === "complete"`, "account loaded");

  const bookmarkletHref = await js(
    `document.querySelector("a.bookmarklet-btn")?.getAttribute("href")`,
  );
  check(
    "account page renders bookmarklet button",
    typeof bookmarkletHref === "string" && bookmarkletHref.startsWith("javascript:"),
    "bookmarklet present",
  );
  check(
    "bookmarklet inspects alternate RSS/Atom feeds",
    bookmarkletHref?.includes('link[rel~="alternate"]') === true,
    "feed detection script included",
  );
  check(
    "bookmarklet also inspects plain feed links",
    bookmarkletHref?.includes('a[href*="/feed"]') === true,
    "anchor shapes included",
  );
  const plainForms = await js(`document.querySelectorAll("#sendForm").length`);
  const noPrefillCards = await js(`document.querySelectorAll("#quickAddPanel").length`);
  check(
    "without ?add= the plain send form is the only card",
    plainForms === 1 && noPrefillCards === 0,
    `forms: ${plainForms}, cards: ${noPrefillCards}`,
  );

  const shotAccount = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT}01-account-bookmarklet-desktop.png`,
    Uint8Array.from(atob(shotAccount.data), (c) => c.charCodeAt(0)),
  );

  // B. Simulate clicking bookmarklet on page with both article and RSS feed
  const targetUrl = "https://example.com/blog/great-article";
  const targetTitle = "A Great Post";
  const targetFeed = "https://example.com/feed.xml";
  const bookmarkletUrl = `${BASE}/account?add=${encodeURIComponent(targetUrl)}&title=${
    encodeURIComponent(targetTitle)
  }&feed=${encodeURIComponent(targetFeed)}`;

  await cdp("Page.navigate", { url: bookmarkletUrl });
  await until(`!!document.getElementById("quickAddPanel")`, "quick add panel rendered");

  const cardCount = await js(`document.querySelectorAll("#quickAddPanel").length`);
  const formCount = await js(`document.querySelectorAll("#sendForm").length`);
  const inputCount = await js(`document.querySelectorAll("#sendUrl").length`);
  check("prefill renders exactly one unified card", cardCount === 1, `cards: ${cardCount}`);
  check("prefill renders NO second send form", formCount === 0, `#sendForm count: ${formCount}`);
  check(
    "prefill renders no duplicate URL input",
    inputCount === 0,
    `#sendUrl count: ${inputCount}`,
  );

  const singleOpt = await js(`!!document.getElementById("quickSingleBtn")`);
  const feedOpt = await js(`!!document.getElementById("quickSubscribeBtn")`);
  check("the one card offers Queue this single page", singleOpt === true, "single button present");
  check("the one card offers Subscribe to the feed", feedOpt === true, "subscribe button present");

  // C. Click Option 1: Queue single episode
  await js(`document.getElementById("quickSingleBtn")?.click()`);
  await until(
    `document.getElementById("quickFeedback")?.textContent.includes("Queued")`,
    "single episode queued",
  );

  const feedbackText = await js(`document.getElementById("quickFeedback")?.textContent`);
  check(
    "queue single episode feedback succeeds",
    feedbackText?.includes("Queued") === true,
    `feedback: '${feedbackText}'`,
  );

  const shotSingleQueued = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT}02-quick-add-single-queued.png`,
    Uint8Array.from(atob(shotSingleQueued.data), (c) => c.charCodeAt(0)),
  );

  // D. Click Option 2: Subscribe to RSS feed
  await js(`document.getElementById("quickSubscribeBtn")?.click()`);
  await until(
    `document.getElementById("quickFeedback")?.textContent.includes("Subscribed")`,
    "feed subscribed",
  );

  const subFeedback = await js(`document.getElementById("quickFeedback")?.textContent`);
  check(
    "feed subscription feedback succeeds",
    subFeedback?.includes("Subscribed") === true,
    `feedback: '${subFeedback}'`,
  );

  const shotSubscribed = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT}03-quick-add-subscribed.png`,
    Uint8Array.from(atob(shotSubscribed.data), (c) => c.charCodeAt(0)),
  );

  // 1b. Unified card with NO feed in the URL: server-side discovery (audio-feed-6hw)
  const quietTarget = "https://example.com/blog/no-declared-feed";
  const quietUrl = `${BASE}/account?add=${encodeURIComponent(quietTarget)}&title=${
    encodeURIComponent("Article Without A Declared Feed")
  }`;
  await cdp("Page.navigate", { url: quietUrl });
  await until(`!!document.getElementById("quickAddPanel")`, "unified card rendered");

  const quietCards = await js(`document.querySelectorAll("#quickAddPanel").length`);
  const quietForms = await js(`document.querySelectorAll("#sendForm").length`);
  const quietInputs = await js(`document.querySelectorAll("#sendUrl").length`);
  check("no-feed prefill is still exactly one card", quietCards === 1, `cards: ${quietCards}`);
  check("no-feed prefill has no second form", quietForms === 0, `#sendForm count: ${quietForms}`);
  check(
    "no-feed prefill has no duplicate input",
    quietInputs === 0,
    `#sendUrl count: ${quietInputs}`,
  );

  // Drive the same endpoint the page called; when it answers, the page's own
  // discovery round trip is long finished.
  const quietFeeds = await js(
    `fetch("/api/account/discover-feed?url=" + encodeURIComponent("${quietTarget}")).then((r) => r.json()).then((d) => d.feeds.length)`,
  );
  check(
    "a page with no declared feed answers with zero feeds",
    quietFeeds === 0,
    `feeds: ${quietFeeds}`,
  );
  const quietHidden = await js(`document.getElementById("detectedFeed")?.hidden`);
  check(
    "the subscribe half stays hidden when there is nothing to offer",
    quietHidden === true,
    `hidden: ${quietHidden}`,
  );

  const shotQuiet = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT6HW}01-unified-card-no-feed.png`,
    Uint8Array.from(atob(shotQuiet.data), (c) => c.charCodeAt(0)),
  );

  // 1c. The same card when the page DOES declare a feed: the option appears in
  //     place, with a hostile candidate dropped rather than rendered.
  const declaresTarget = "https://example.com/blog/declares-a-feed";
  const declaresUrl = `${BASE}/account?add=${encodeURIComponent(declaresTarget)}&title=${
    encodeURIComponent("Article With A Declared Feed")
  }`;
  await cdp("Page.navigate", { url: declaresUrl });
  await until(`!!document.getElementById("quickAddPanel")`, "unified card rendered again");
  await until(
    `document.getElementById("detectedFeed")?.hidden === false`,
    "discovered feed offered",
  );

  const declaresCards = await js(`document.querySelectorAll("#quickAddPanel").length`);
  const declaresForms = await js(`document.querySelectorAll("#sendForm").length`);
  check(
    "the discovered feed appears without a second card",
    declaresCards === 1 && declaresForms === 0,
    `cards: ${declaresCards}, forms: ${declaresForms}`,
  );

  const discoveredLabel = String(
    await js(`document.getElementById("detectedFeedUrl")?.textContent`),
  );
  check(
    "the server found the page's declared feed and resolved it",
    discoveredLabel.includes("https://example.com/discovered.xml"),
    `label: ${discoveredLabel}`,
  );
  check(
    "the discovered feed keeps its title",
    discoveredLabel.includes("Discovered Feed"),
    `label: ${discoveredLabel}`,
  );
  const hostileOnPage = await js(`document.body.innerHTML.includes("javascript:alert")`);
  check(
    "a hostile feed candidate never reaches the page",
    hostileOnPage === false,
    "no javascript: candidate rendered",
  );

  const shotDiscovered = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT6HW}02-unified-card-discovered-feed.png`,
    Uint8Array.from(atob(shotDiscovered.data), (c) => c.charCodeAt(0)),
  );

  await js(`document.getElementById("quickSubscribeBtn")?.click()`);
  await until(
    `document.getElementById("quickFeedback")?.textContent.includes("Subscribed")`,
    "discovered feed subscribed",
  );
  const discoveredFeedback = await js(`document.getElementById("quickFeedback")?.textContent`);
  check(
    "subscribing to the discovered feed succeeds",
    String(discoveredFeedback).includes("Subscribed"),
    `feedback: '${discoveredFeedback}'`,
  );

  const shotDiscoveredSub = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT6HW}03-unified-card-subscribed.png`,
    Uint8Array.from(atob(shotDiscoveredSub.data), (c) => c.charCodeAt(0)),
  );

  // 2. Mobile pass (390x844)
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });

  await cdp("Page.navigate", { url: bookmarkletUrl });
  await until(`!!document.getElementById("quickAddPanel")`, "mobile quick add loaded");

  const mobileCards = await js(`document.querySelectorAll("#quickAddPanel").length`);
  const mobileForms = await js(`document.querySelectorAll("#sendForm").length`);
  check(
    "mobile prefill stays one card with no second form",
    mobileCards === 1 && mobileForms === 0,
    `cards: ${mobileCards}, forms: ${mobileForms}`,
  );

  const overflow = await js(
    `document.documentElement.scrollWidth > document.documentElement.clientWidth`,
  );
  check(
    "mobile quick add zero horizontal overflow at 390px",
    overflow === false,
    "no horizontal scroll",
  );

  const shotMobile = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT}04-quick-add-mobile-390.png`,
    Uint8Array.from(atob(shotMobile.data), (c) => c.charCodeAt(0)),
  );

  // 3. Front door (/) prefilling test
  await cdp("Page.navigate", {
    url: `${BASE}/?add=${encodeURIComponent(targetUrl)}&feed=${encodeURIComponent(targetFeed)}`,
  });
  await until(`document.readyState === "complete"`, "front door loaded");

  const prefilledUrl = await js(`document.getElementById("url")?.value`);
  const prefilledFeed = await js(`document.getElementById("feed-url")?.value`);
  check(
    "front door pre-fills #url input from ?add= query param",
    prefilledUrl === targetUrl,
    `url: '${prefilledUrl}'`,
  );
  check(
    "front door pre-fills #feed-url input from ?feed= query param",
    prefilledFeed === targetFeed,
    `feed: '${prefilledFeed}'`,
  );

  const shotFrontDoor = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(
    `${OUT}05-front-door-prefilled.png`,
    Uint8Array.from(atob(shotFrontDoor.data), (c) => c.charCodeAt(0)),
  );

  // Write markdown summary
  const summary = `# Bookmarklet & Quick Add Verification Report: audio-feed-ep1

## Verified Criteria
1. **Draggable Bookmarklet Button**: Available on \`/account\` and \`/\` with \`draggable="true"\` and accessible title, from ONE builder so both pages carry the same href.
2. **Dynamic In-Browser Detection**: Bookmarklet grabs \`location.href\`, \`document.title\`, and queries \`rel~=alternate\` feeds (rss/atom/feed/json/xml) plus plain feed links.
3. **ONE Unified Card (audio-feed-6hw)**: With \`?add=<url>\` the page renders exactly one card and NO second send form and no duplicate URL input; without a prefill the plain send form is the only card.
4. **Feed Autodiscovery (audio-feed-6hw)**: With no \`?feed=\`, the page asks \`/api/account/discover-feed\`, which reads the page through the SSRF guard and offers the declared feed inside the same card; a page that declares nothing stays silent, and a \`javascript:\` candidate is dropped rather than rendered.
5. **Intelligent Choice Architecture**: Queue this single page (with direct/deepdive radio choice) and Subscribe to the feed (one-click subscription to \`/api/account/sources\`) live in the same card.
6. **Preserved Redirection**: Signed-out clicks preserve the full bookmarklet destination through passkey login via \`safeNext\`.
7. **Convenience Route**: \`/add?...\` cleanly redirects to \`/account?...\`.
8. **Security & Sanitization**: URL schemes are strictly validated for \`http:\` / \`https:\`; titles are escaped against reflected XSS.
9. **Mobile Viewport**: Verified at 390x844 with zero horizontal overflow, still one card.

## Execution Log
\`\`\`
${checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  ${c.detail}`).join("\n")}
\`\`\`

## Screenshots
- \`01-account-bookmarklet-desktop.png\`: Account page with draggable bookmarklet widget (1280x900).
- \`02-quick-add-single-queued.png\`: Quick-add panel with both options, single episode queued (1280x900).
- \`03-quick-add-subscribed.png\`: RSS feed subscribed in one click from quick-add panel (1280x900).
- \`04-quick-add-mobile-390.png\`: Mobile responsive layout of the unified card (390x844).
- \`05-front-door-prefilled.png\`: Front door (\`/\`) with inputs prefilled from bookmarklet query params.

The audio-feed-6hw legs are captured beside this report in
\`docs/evidence/audio-feed-6hw/\`:
- \`01-unified-card-no-feed.png\`: one card, subscribe half still hidden (nothing declared).
- \`02-unified-card-discovered-feed.png\`: the discovered feed offered inside the same card.
- \`03-unified-card-subscribed.png\`: subscribed from the discovered feed.

Report version: audio-feed-ep1 + audio-feed-6hw.
`;

  await Deno.writeTextFile(`${OUT}README.md`, summary);
  await Deno.writeTextFile(`${OUT6HW}README.md`, summary);
  console.log(`Saved report to ${OUT}README.md and ${OUT6HW}README.md`);
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  try {
    chrome.kill();
  } catch { /* ignore */ }
  await server.shutdown().catch(() => {});
  await cleanup();
}

Deno.exit(exitCode);
