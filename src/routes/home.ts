/**
 * Homepage (audio-feed-f2a).
 *
 * Paul hit the deployed site and got `{"error":"not_found","detail":"No route
 * for GET /"}`. Every route the product has is machine-facing — feed XML, audio
 * bytes, a JSON API — so a person arriving at the origin saw a 404 and had no
 * way to find out what the service was or how to use it.
 *
 * This page is the human entry point: what the service does, how the two audio
 * modes differ, what a feed URL looks like, and a working Send-to-Audio form.
 *
 * Deliberately one self-contained document — no build step, no bundle, no
 * external fetch. The server has no static asset pipeline and this page does
 * not justify inventing one.
 *
 * SECURITY: the form collects a feed token, which is a bearer credential. It is
 * sent as a request HEADER and never as a query parameter, and the form is
 * `method="post"` so that a submit with JavaScript broken cannot put the token
 * in the URL bar, browser history, or a proxy log.
 */

import type { AppContext } from "../app.ts";
import { bookmarkletHref } from "./bookmarklet.ts";
import type { RouteContext } from "../router.ts";
import { originCacheControl, resolveOrigin } from "../origin.ts";
import { DEFAULT_NARRATION_VOICE } from "../tts/gemini.ts";
import { renderShell, type Viewer, viewerOf } from "./shell.ts";
import { htmlResponse, newCspNonce } from "./csp.ts";
import { assetUrl } from "./assets.ts";
import { jsonForScript } from "./html.ts";
import { sessionUser } from "../auth/sessions.ts";

/** Escapes text interpolated into the document. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface HomePageOptions {
  /** Absolute origin, used to show real feed URLs rather than placeholders. */
  publicBaseUrl: string;
  /** Whether synthesis is actually available in this deployment. */
  synthesisConfigured: boolean;
  /**
   * The voice a direct read falls back to in THIS deployment (audio-feed-4xt).
   *
   * Passed in rather than hard-coded: the page used to say "Default voice: Charon"
   * unconditionally, so the moment DEFAULT_VOICE became configurable the copy would
   * have been a prose claim no check can see — a generated-block guard cannot catch
   * a sentence that contradicts itself. Deriving it keeps the page honest.
   */
  defaultVoice: string;
  /** Who is signed in (audio-feed-8fc), for the shared header. */
  viewer?: Viewer | null;
  /** CSP nonce for this response (audio-feed-syhu); stamped on the shell's inline tags. */
  nonce: string;
}

/**
 * The whole page. A pure function of its options so a test can assert on the
 * markup without binding a port.
 */
export function renderHomePage({
  publicBaseUrl,
  synthesisConfigured,
  defaultVoice,
  viewer = null,
  nonce,
}: HomePageOptions): string {
  const base = esc(publicBaseUrl.replace(/\/+$/, ""));

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Audio Feed — turn articles into a private podcast</title>
<meta name="description" content="Audio Feed turns articles and RSS sources into a private podcast: single-voice author reads and two-voice deep dive discussions, delivered to any podcast app.">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎧</text></svg>">

</head>
<body>
<div class="page">

  <h1>Audio Feed</h1>
  <p class="lede">
    A personal podcast generator. It turns articles and RSS sources into audio you
    can listen to in any podcast app or in the <a href="/listen">Web Player</a> — read aloud, or discussed by two voices.
    Speech is synthesised with Gemini&nbsp;3.8 Flash TTS.
  </p>

  <h2>Two ways to hear an article</h2>
  <ul class="cards">
    <li class="card">
      <h3>Direct read</h3>
      <p>
        One narrator reads the article straight through, announcing the title,
        author and publication date first. Clear and uninterrupted — the
        equivalent of the author reading their own piece to you.
      </p>
      <p class="voices">Default voice: ${esc(defaultVoice)}</p>
    </li>
    <li class="card">
      <h3>Deep dive</h3>
      <p>
        Two voices discuss the article: an expert and a curious interviewer who
        asks the obvious questions. Useful when you want the argument examined
        rather than recited.
      </p>
      <p class="voices">Default voices: Kore and Puck</p>
    </li>
  </ul>

  <h2>Subscribing</h2>
  <p>
    Listen in the <a href="/listen">Web Player</a> directly in your browser, or subscribe in a podcast app.
    Every listener gets a private feed token. That token <em>is</em> the
    credential — podcast apps cannot log in, so anyone holding your feed URL can
    read your feed. Treat it like a password and do not share it.
    Don't have a token? <a href="#request-access">Request access</a> below to join the preview.
  </p>
  <ul class="urls">
    <li>
      <span class="what">Everything, newest first</span>
      <code>${base}/feed/<var>your-token</var>/master.xml</code>
    </li>
    <li>
      <span class="what">One source, read aloud</span>
      <code>${base}/feed/<var>your-token</var>/<var>source</var>/direct.xml</code>
    </li>
    <li>
      <span class="what">One source, as a discussion</span>
      <code>${base}/feed/<var>your-token</var>/<var>source</var>/deepdive.xml</code>
    </li>
  </ul>
  <p>
    Paste one into Pocket Casts, Apple Podcasts, Overcast or anything else that
    accepts an RSS URL. Episodes appear once synthesis finishes.
  </p>

  <div id="returningSubscriber" class="note u-my-4" hidden>
    <p><strong>Welcome back!</strong> A saved player was found on this device:
    <a href="/listen" id="openPlayerLink" class="u-strong-link">Open your Web Player &rarr;</a></p>
  </div>

  <h2 id="request-access">Request access</h2>
  <p>
    Audio Feed is currently in private preview. Every account requires administrator approval
    before audio is synthesised, keeping resource spend within budget. Request access below
    and an administrator will review your account.
  </p>
  <form id="request-access-form" action="/api/request-access" method="post">
    <div class="field">
      <label for="request-email">Email address</label>
      <span class="hint" id="request-email-hint">Where you'll receive your approval notification.</span>
      <input
        type="email"
        id="request-email"
        name="email"
        required
        placeholder="you@example.com"
        aria-describedby="request-email-hint"
        aria-errormessage="request-email-error"
        autocomplete="email"
        spellcheck="false"
      >
      <span class="error" id="request-email-error"><span aria-hidden="true">⚠</span> Enter a valid email address.</span>
    </div>

    <div class="field">
      <label for="request-name">Display name (optional)</label>
      <span class="hint" id="request-name-hint">How you'd like your private feed named.</span>
      <input
        type="text"
        id="request-name"
        name="displayName"
        placeholder="e.g. Ada Lovelace"
        aria-describedby="request-name-hint"
        autocomplete="name"
        spellcheck="false"
      >
    </div>

    <button type="submit" id="request-submit">Request access</button>
  </form>

  <div id="request-result" role="status" aria-live="polite"></div>

  <h2 id="send">Send an article to audio</h2>
  ${
    viewer
      ? `<p class="note" role="status">You're signed in: <a href="/account">send from your
    account</a> without pasting a token. The form below still works with one.</p>`
      : ""
  }
  <p>
    Give it a link and it will be queued, synthesised, and added to your feed.
    Accounts need admin approval before anything is generated, because synthesis
    is the part that costs money.
  </p>

  ${
    synthesisConfigured ? "" : `<p class="note" role="status">
    <strong>Note:</strong> this deployment has no Gemini API key configured, so
    articles can be queued but will not be synthesised until one is set.
  </p>`
  }

  <!--
    method="post" is a safety property, not a formality: if scripting fails, the
    browser's native submit posts the token in the request body and gets a 415,
    instead of a GET that would write the token into the URL bar and history.
  -->
  <form id="ingest" action="/api/ingest" method="post">
    <div class="field">
      <label for="url">Article URL</label>
      <span class="hint" id="url-hint">A public link to the article you want read.</span>
      <input
        type="url"
        id="url"
        name="url"
        required
        placeholder="https://example.com/an-article"
        aria-describedby="url-hint"
        aria-errormessage="url-error"
        autocomplete="url"
        spellcheck="false"
      >
      <span class="error" id="url-error"><span aria-hidden="true">⚠</span> Enter a full URL, including https://</span>
    </div>

    <div class="field">
      <label for="token">Your feed token</label>
      <span class="hint" id="token-hint">
        The token from your feed URL. Sent as a request header, never in the address bar.
      </span>
      <input
        type="password"
        id="token"
        name="token"
        required
        aria-describedby="token-hint"
        aria-errormessage="token-error"
        autocomplete="off"
        spellcheck="false"
      >
      <span class="error" id="token-error"><span aria-hidden="true">⚠</span> A feed token is required.</span>
    </div>

    <fieldset>
      <legend>How should it sound?</legend>
      <div class="choice">
        <input type="radio" id="mode-direct" name="mode" value="direct" checked>
        <label for="mode-direct">
          Direct read
          <span class="what">One voice, reading the article.</span>
        </label>
      </div>
      <div class="choice">
        <input type="radio" id="mode-deepdive" name="mode" value="deepdive">
        <label for="mode-deepdive">
          Deep dive
          <span class="what">Two voices, discussing it.</span>
        </label>
      </div>
    </fieldset>

    <button type="submit" id="submit">Send to Audio</button>
  </form>

  <div id="result" role="status" aria-live="polite"></div>

  <div class="note bookmarklet-box u-mt-4">
    <p><strong>Browser Bookmarklet:</strong> Drag <a class="bookmarklet-link" href="${
    esc(bookmarkletHref(base))
  }" draggable="true" title="Drag to your bookmarks bar" data-tooltip="Drag to your bookmarks bar" class="u-strong-link">🎙️ Add to Audio Feed</a> to your bookmarks bar. Click it on any article to send it or subscribe in one click.</p>
  </div>

  <h2 id="subscribe-feed">Subscribe to an RSS feed</h2>
  <p>
    Follow an entire publication. Recent posts will be queued and converted to audio as they are published.
  </p>

  <!--
    method="post" ensures a no-JS native submit never puts the token in the URL.
    Uses the same feed token field entered above.
  -->
  <form id="subscribe-source" action="/api/sources" method="post">
    <div class="field">
      <label for="feed-url">RSS or Atom feed URL</label>
      <span class="hint" id="feed-url-hint">The XML feed address of the blog or newsletter.</span>
      <input
        type="url"
        id="feed-url"
        name="feedUrl"
        required
        placeholder="https://example.com/feed.xml"
        aria-describedby="feed-url-hint"
        aria-errormessage="feed-url-error"
        autocomplete="url"
        spellcheck="false"
      >
      <span class="error" id="feed-url-error"><span aria-hidden="true">⚠</span> Enter a full feed URL, including https://</span>
    </div>

    <div class="field">
      <label for="feed-title">Feed title (optional)</label>
      <span class="hint" id="feed-title-hint">Defaults to the title in the feed.</span>
      <input
        type="text"
        id="feed-title"
        name="title"
        placeholder="e.g. Stratechery"
        aria-describedby="feed-title-hint"
        autocomplete="off"
        spellcheck="false"
      >
    </div>

    <fieldset>
      <legend>Audio presentation mode</legend>
      <div class="choice">
        <input type="radio" id="feed-mode-direct" name="feedMode" value="direct" checked>
        <label for="feed-mode-direct">
          Direct read
          <span class="what">One narrator reading each post.</span>
        </label>
      </div>
      <div class="choice">
        <input type="radio" id="feed-mode-deepdive" name="feedMode" value="deepdive">
        <label for="feed-mode-deepdive">
          Deep dive
          <span class="what">Two-voice discussion of each post.</span>
        </label>
      </div>
    </fieldset>

    <button type="submit" id="submit-feed">Subscribe to Feed</button>
  </form>

  <div id="feed-result" role="status" aria-live="polite"></div>

  <noscript>
    <p class="note">
      These forms need JavaScript, because the feed token travels in a request
      header rather than the URL. Without it, use curl:
    </p>
    <pre><code>curl -X POST ${base}/api/ingest \\
  -H 'content-type: application/json' \\
  -H 'x-feed-token: YOUR_TOKEN' \\
  -d '{"url":"https://example.com/an-article","mode":"direct"}'

curl -X POST ${base}/api/sources \\
  -H 'content-type: application/json' \\
  -H 'x-feed-token: YOUR_TOKEN' \\
  -d '{"feedUrl":"https://example.com/feed.xml","modes":["direct"]}'</code></pre>
  </noscript>

  <h2>Prefer the command line?</h2>
  <p>The same request, without the form:</p>
  <pre><code>curl -X POST ${base}/api/ingest \\
  -H 'content-type: application/json' \\
  -H 'x-feed-token: YOUR_TOKEN' \\
  -d '{"url":"https://example.com/an-article","mode":"direct"}'</code></pre>

</div>

<!-- audio-feed-3xq part 4b: the homepage's client is a content-addressed module
     (src/assets/home.js), and the one server value it needs rides in this island. Data in the
     page, code in a file — the same contract the listen and admin pages use. -->
<script type="application/json" id="home-data" nonce="${esc(nonce)}">${
    jsonForScript({ base })
  }</script>
</body>
</html>
`;
  // Written as one document so it reads top to bottom; the shared shell
  // (audio-feed-8fc) supplies the header, footer and tokens around its parts. The data island
  // is part of main: it is the page's payload, not code. The client itself is a module the
  // shell links, and the stylesheet is a content-addressed asset like admin.css.
  const main = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</script>") + 9).trim();
  return renderShell({
    title: "Audio Feed — turn articles into a private podcast",
    description:
      "Audio Feed turns articles and RSS sources into a private podcast: single-voice author reads and two-voice deep dive discussions, delivered to any podcast app.",
    viewer,
    current: "home",
    stylesheets: [assetUrl("home.css")],
    main,
    scriptModule: assetUrl("home.js"),
    nonce,
  });
}

/** `GET /` — the human entry point. */
export async function handleHome({ ctx, req }: RouteContext<AppContext>): Promise<Response> {
  // Resolved per request (audio-feed-0k3). An unconfigured deployment used to
  // print `http://localhost:8000/feed/...` as the URL to subscribe to.
  const origin = resolveOrigin(ctx.config, req);

  const viewer = viewerOf(await sessionUser(ctx.stores.metadata, req));
  const nonce = newCspNonce();
  const html = renderHomePage({
    publicBaseUrl: origin.baseUrl,
    synthesisConfigured: Boolean(ctx.config.geminiApiKey),
    // Resolved, not hard-coded: an operator who sets DEFAULT_VOICE must not be
    // shown a page that still claims the default is Charon (audio-feed-4xt).
    defaultVoice: ctx.config.defaultVoice ?? DEFAULT_NARRATION_VOICE,
    viewer,
    nonce,
  });

  return htmlResponse(html, nonce, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // `private` whenever the origin came from the request rather than from
      // configuration. This page tells people where to send a feed token, and a
      // feed token is a bearer credential — a document whose content depends on
      // the request host must never sit in a shared cache, or one spoofed
      // request poisons the copy served to everyone after it.
      //
      // The max-age is short regardless: the page reports whether synthesis is
      // configured, so a stale copy could claim the service is unavailable
      // after it has been fixed.
      //
      // audio-feed-8fc: the header names whoever is signed in, so a signed-in
      // response is never stored, and every response varies on Cookie so a
      // cached signed-out copy is not replayed to someone who just signed in.
      "cache-control": viewer ? "private, no-store" : originCacheControl(origin, 300),
      // The response body varies with the host that routed the request, so say
      // so: a cache keyed only on path would otherwise be free to mix them.
      vary: origin.explicit ? "Cookie" : "Host, Cookie",
    },
  });
}
