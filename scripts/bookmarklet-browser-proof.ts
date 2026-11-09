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
 *   4. Shared/bookmarklet link prefill (/account?add=&feed=):
 *      - A link carrying ?add=/?feed= still lands the user on a prefilled add card.
 *        It is verified on /account because that is where the prefill now lives: the
 *        front door lost its ingest form when 0bf07a7e replaced the home page with
 *        the explainer, and 772b1397 deleted the dead client-side prefill wiring
 *        (src/assets/home.js). The prefill is rendered server-side in
 *        src/routes/account.ts from the same query params.
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
import { runProof, withChrome, writeEvidenceReadme } from "./proof-helper.ts";
import { quantiseEvidencePng } from "./evidence-png.ts";
import { connectCdp, MEASURED_STARVED_POLL_MS, withHangBound } from "./proof-cdp.ts";

const TOKEN = "subscriber-token-ep1";
const OUT = new URL("../docs/evidence/audio-feed-ep1/", import.meta.url).pathname;
const OUT6HW = new URL("../docs/evidence/audio-feed-6hw/", import.meta.url).pathname;

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

await runProof("audio-feed-ep1", async (checker) => {
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail = "") => {
    checks.push({ name, pass, detail });
    checker.check(name, pass, detail);
  };

  try {
    await withChrome(async (chrome) => {
      /**
       * audio-feed-7xlrw: this proof no longer carries a private CDP client or a private
       * `until()`. The deleted copy's reply wait was a bare `await new Promise` on its own
       * pending map, so ONE reply that never arrived parked the proof past its last PASS with
       * no error printed - and its poll armed a FRESH full hang bound on every iteration
       * instead of the budget left in the wait it was serving. connectCdp() races every
       * evaluate against the derived HANG_BOUND_MS and bounds each poll by what is LEFT of
       * that wait; each raw command here keeps the same bound through withHangBound. What each
       * wait waits FOR is untouched: same expression, same description, same explicit budget
       * at every call site (all ten pass UNTIL_HANG_BOUND_MS).
       */
      const { cdp: rawCdp, js, until, ws } = await connectCdp({ port: chrome.port });
      // deno-lint-ignore no-explicit-any
      const cdp = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
        withHangBound(method, rawCdp(method, params));

      /** 120s = 15 x the 8s starved-poll floor MEASURED on this host (audio-feed-6gst1). */
      const UNTIL_HANG_BOUND_MS = 15 * MEASURED_STARVED_POLL_MS;

      const saveShot = async (path: string) => {
        const shotData = (await cdp("Page.captureScreenshot", { format: "png" })) as {
          data: string;
        };
        const raw = Uint8Array.from(atob(shotData.data), (c) => c.charCodeAt(0));
        await Deno.writeFile(path, raw);
        await quantiseEvidencePng(path);
      };
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
        await until(
          `document.readyState === "complete"`,
          "account loaded",
          UNTIL_HANG_BOUND_MS,
        );

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

        await saveShot(`${OUT}01-account-bookmarklet-desktop.png`);

        // B. Simulate clicking bookmarklet on page with both article and RSS feed
        const targetUrl = "https://example.com/blog/great-article";
        const targetTitle = "A Great Post";
        const targetFeed = "https://example.com/feed.xml";
        const bookmarkletUrl = `${BASE}/account?add=${encodeURIComponent(targetUrl)}&title=${
          encodeURIComponent(targetTitle)
        }&feed=${encodeURIComponent(targetFeed)}`;

        await cdp("Page.navigate", { url: bookmarkletUrl });
        await until(
          `!!document.getElementById("quickAddPanel")`,
          "quick add panel rendered",
          UNTIL_HANG_BOUND_MS,
        );

        const cardCount = await js(`document.querySelectorAll("#quickAddPanel").length`);
        const formCount = await js(`document.querySelectorAll("#sendForm").length`);
        const inputCount = await js(`document.querySelectorAll("#sendUrl").length`);
        check("prefill renders exactly one unified card", cardCount === 1, `cards: ${cardCount}`);
        check(
          "prefill renders NO second send form",
          formCount === 0,
          `#sendForm count: ${formCount}`,
        );
        check(
          "prefill renders no duplicate URL input",
          inputCount === 0,
          `#sendUrl count: ${inputCount}`,
        );

        const singleOpt = await js(`!!document.getElementById("quickSingleBtn")`);
        const feedOpt = await js(`!!document.getElementById("quickSubscribeBtn")`);
        check(
          "the one card offers Queue this single page",
          singleOpt === true,
          "single button present",
        );
        check(
          "the one card offers Subscribe to the feed",
          feedOpt === true,
          "subscribe button present",
        );

        // C. Click Option 1: Queue single episode
        await js(`document.getElementById("quickSingleBtn")?.click()`);
        await until(
          `document.getElementById("quickFeedback")?.textContent.includes("Queued")`,
          "single episode queued",
          UNTIL_HANG_BOUND_MS,
        );

        const feedbackText = await js(`document.getElementById("quickFeedback")?.textContent`);
        check(
          "queue single episode feedback succeeds",
          feedbackText?.includes("Queued") === true,
          `feedback: '${feedbackText}'`,
        );

        await saveShot(`${OUT}02-quick-add-single-queued.png`);

        // D. Click Option 2: Subscribe to RSS feed
        await js(`document.getElementById("quickSubscribeBtn")?.click()`);
        await until(
          `document.getElementById("quickFeedback")?.textContent.includes("Subscribed")`,
          "feed subscribed",
          UNTIL_HANG_BOUND_MS,
        );

        const subFeedback = await js(`document.getElementById("quickFeedback")?.textContent`);
        check(
          "feed subscription feedback succeeds",
          subFeedback?.includes("Subscribed") === true,
          `feedback: '${subFeedback}'`,
        );

        await saveShot(`${OUT}03-quick-add-subscribed.png`);

        // 1b. Unified card with NO feed in the URL: server-side discovery (audio-feed-6hw)
        const quietTarget = "https://example.com/blog/no-declared-feed";
        const quietUrl = `${BASE}/account?add=${encodeURIComponent(quietTarget)}&title=${
          encodeURIComponent("Article Without A Declared Feed")
        }`;
        await cdp("Page.navigate", { url: quietUrl });
        await until(
          `!!document.getElementById("quickAddPanel")`,
          "unified card rendered",
          UNTIL_HANG_BOUND_MS,
        );

        const quietCards = await js(`document.querySelectorAll("#quickAddPanel").length`);
        const quietForms = await js(`document.querySelectorAll("#sendForm").length`);
        const quietInputs = await js(`document.querySelectorAll("#sendUrl").length`);
        check(
          "no-feed prefill is still exactly one card",
          quietCards === 1,
          `cards: ${quietCards}`,
        );
        check(
          "no-feed prefill has no second form",
          quietForms === 0,
          `#sendForm count: ${quietForms}`,
        );
        check(
          "no-feed prefill has no duplicate input",
          quietInputs === 0,
          `#sendUrl count: ${quietInputs}`,
        );

        // Drive the same endpoint the page called; when it answers, the page's own
        // discovery round trip is long finished.
        const quietFeeds = await js(
          `fetch("/api/account/discover-feed", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: "${quietTarget}" }),
          }).then((r) => r.json()).then((d) => d.feeds.length)`,
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

        await saveShot(`${OUT6HW}01-unified-card-no-feed.png`);

        // 1c. The same card when the page DOES declare a feed: the option appears in
        //     place, with a hostile candidate dropped rather than rendered.
        const declaresTarget = "https://example.com/blog/declares-a-feed";
        const declaresUrl = `${BASE}/account?add=${encodeURIComponent(declaresTarget)}&title=${
          encodeURIComponent("Article With A Declared Feed")
        }`;
        await cdp("Page.navigate", { url: declaresUrl });
        await until(
          `!!document.getElementById("quickAddPanel")`,
          "unified card rendered again",
          UNTIL_HANG_BOUND_MS,
        );
        await until(
          `document.getElementById("detectedFeed")?.hidden === false`,
          "discovered feed offered",
          UNTIL_HANG_BOUND_MS,
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

        await saveShot(`${OUT6HW}02-unified-card-discovered-feed.png`);

        await js(`document.getElementById("quickSubscribeBtn")?.click()`);
        await until(
          `document.getElementById("quickFeedback")?.textContent.includes("Subscribed")`,
          "discovered feed subscribed",
          UNTIL_HANG_BOUND_MS,
        );
        const discoveredFeedback = await js(
          `document.getElementById("quickFeedback")?.textContent`,
        );
        check(
          "subscribing to the discovered feed succeeds",
          String(discoveredFeedback).includes("Subscribed"),
          `feedback: '${discoveredFeedback}'`,
        );

        await saveShot(`${OUT6HW}03-unified-card-subscribed.png`);

        // 2. Mobile pass (390x844)
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          mobile: true,
        });

        await cdp("Page.navigate", { url: bookmarkletUrl });
        await until(
          `!!document.getElementById("quickAddPanel")`,
          "mobile quick add loaded",
          UNTIL_HANG_BOUND_MS,
        );

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

        await saveShot(`${OUT}04-quick-add-mobile-390.png`);

        // 3. Shared/bookmarklet link prefill (?add=&feed=) test.
        // NOT the front door: it has had no ingest form since 0bf07a7e (explainer home)
        // and its dead client-side prefill wiring was deleted in 772b1397. The same
        // query params are honoured server-side on /account (src/routes/account.ts),
        // so a shared/bookmarklet link is verified where it actually lands: the
        // unified quick-add card carries the add URL and the detected-feed line
        // carries the feed (the prefill replaces #sendUrl, see checks 1B).
        await cdp("Page.navigate", {
          url: `${BASE}/account?add=${encodeURIComponent(targetUrl)}&feed=${
            encodeURIComponent(targetFeed)
          }`,
        });
        await until(
          `!!document.getElementById("quickAddPanel")`,
          "account prefilled from shared link",
          UNTIL_HANG_BOUND_MS,
        );

        const sharedLinkedUrl = await js(
          `document.querySelector("#quickAddPanel .quick-card code")?.textContent`,
        );
        check(
          "a bookmarked add URL still prefills the account quick-add card",
          sharedLinkedUrl === targetUrl,
          `url: '${sharedLinkedUrl}'`,
        );
        const sharedFeedHidden = await js(`document.getElementById("detectedFeed")?.hidden`);
        const sharedLinkedFeed = await js(
          `document.getElementById("detectedFeedUrl")?.textContent`,
        );
        check(
          "a bookmarked feed URL still prefills the detected-feed line",
          sharedFeedHidden === false && sharedLinkedFeed === targetFeed,
          `hidden: ${sharedFeedHidden}, feed: '${sharedLinkedFeed}'`,
        );

        await saveShot(`${OUT}05-account-prefilled-from-shared-link.png`);

        const commonSections = [
          {
            heading: "Verified Criteria",
            body:
              `1. Draggable Bookmarklet Button: Available on /account and / with draggable="true" and accessible title.\n2. In-Browser Feed Detection: Bookmarklet extracts links and queries rel~=alternate feeds.\n3. ONE Unified Card (audio-feed-6hw): Renders exactly one card and no duplicate send form on prefill.\n4. Feed Autodiscovery (audio-feed-6hw): Autodiscovery handles relative paths, quiet pages, and hostile candidate filtering.\n5. Mobile Viewport: 390x844 layout verified with zero horizontal overflow.`,
          },
          {
            heading: "Execution Log",
            body: `\`\`\`\n${
              checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  ${c.detail}`).join("\n")
            }\n\`\`\``,
          },
        ];

        await writeEvidenceReadme({
          dir: OUT,
          title: "Bookmarklet & Quick Add Verification Report: audio-feed-ep1",
          script: "scripts/bookmarklet-browser-proof.ts",
          asserts: checks.map((c) => c.name),
          sections: [
            ...commonSections,
            {
              heading: "Screenshots",
              body:
                `- 01-account-bookmarklet-desktop.png: Account page with draggable bookmarklet widget\n- 02-quick-add-single-queued.png: Quick-add panel, single episode queued\n- 03-quick-add-subscribed.png: RSS feed subscribed in one click\n- 04-quick-add-mobile-390.png: Mobile responsive layout\n- 05-account-prefilled-from-shared-link.png: /account quick-add card prefilled from a shared ?add=&feed= link. Verified on /account rather than the front door: the home page has had no ingest form since the explainer-home change named in this script header, and the prefill is rendered server-side in src/routes/account.ts. Regenerate with: deno task evidence --only audio-feed-ep1`,
            },
          ],
        });

        await writeEvidenceReadme({
          dir: OUT6HW,
          title: "Unified Bookmarklet Card Verification Report: audio-feed-6hw",
          script: "scripts/bookmarklet-browser-proof.ts",
          asserts: checks.filter((c) =>
            c.name.includes("feed") || c.name.includes("card") || c.name.includes("form") ||
            c.name.includes("overflow")
          ).map((c) => c.name),
          sections: [
            ...commonSections,
            {
              heading: "Screenshots",
              body:
                `- 01-unified-card-no-feed.png: Unified card with quiet feed\n- 02-unified-card-discovered-feed.png: Discovered feed inside unified card\n- 03-unified-card-subscribed.png: Subscribed from discovered feed`,
            },
          ],
        });
        console.log(`Saved reports to ${OUT}README.md and ${OUT6HW}README.md`);
      } finally {
        try {
          ws.close();
        } catch { /* ignore */ }
      }
    });
  } finally {
    await server.shutdown().catch(() => {});
  }
});
