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
import { renderShell, type Viewer } from "./shell.ts";
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

  <h2 id="request-access">Request access</h2>
  <p>
    Audio Feed is currently in private preview. Every account requires administrator approval
    before audio is synthesised, keeping resource spend within budget. Request access below
    and an administrator will review your account. Already have an account? <a href="/login">Sign in</a>.
  </p>
  <!-- audio-feed-dc2y: WebMCP annotations. Additive and ignored by browsers without support. -->
  <form id="request-access-form" action="/api/request-access" method="post"
        toolname="request_access"
        tooldescription="Submit an email address and an optional display name to request an Audio Feed account for administrator approval.">
    <div class="field">
      <label for="request-email">Email address</label>
      <span class="hint" id="request-email-hint">Where you'll receive your approval notification.</span>
      <input
        type="email"
        id="request-email"
        name="email"
        required
        toolparamdescription="Email address that should be invited to Audio Feed"
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

  ${
    synthesisConfigured ? "" : `<p class="note" role="status">
    <strong>Note:</strong> this deployment has no Gemini API key configured, so
    articles can be queued but will not be synthesised until one is set.
  </p>`
  }

  <div class="note bookmarklet-box u-mt-4">
    <p><strong>Browser Bookmarklet:</strong> Drag <a class="bookmarklet-link u-strong-link" href="${
    esc(bookmarkletHref(base))
  }" draggable="true" title="Drag to your bookmarks bar" data-tooltip="Drag to your bookmarks bar">🎙️ Add to Audio Feed</a> to your bookmarks bar. Click it on any article to send it or subscribe in one click.</p>
    <details class="bookmarklet-code u-mt-2">
      <summary>Can’t drag it? Get the bookmarklet code</summary>
      <p class="u-fs-sm u-mt-quarter">Browsers refuse <code>javascript:</code> links when clicked directly on a page protected by this app’s Content Security Policy. To install it manually, drag the link above to your bookmarks bar, or create a bookmark and paste this code as its URL:</p>
      <pre class="bookmarklet-snippet u-break-all u-fs-xs"><code>${
    esc(bookmarkletHref(base))
  }</code></pre>
    </details>
  </div>

  <noscript>
    <p class="note">
      JavaScript is optional. With a private feed token, you can also send articles via curl:
    </p>
    <pre><code>curl -X POST ${base}/api/ingest \\
  -H 'content-type: application/json' \\
  -H 'x-feed-token: YOUR_TOKEN' \\
  -d '{"url":"https://example.com/an-article","mode":"direct"}'</code></pre>
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

  // Signed-in users are redirected to their account page (audio-feed-irgu).
  const user = await sessionUser(ctx.stores.metadata, req);
  if (user) {
    return new Response(null, {
      status: 303,
      headers: {
        location: "/account",
        "cache-control": "private, no-store",
        vary: origin.explicit ? "Cookie" : "Host, Cookie",
      },
    });
  }

  const nonce = newCspNonce();
  const html = renderHomePage({
    publicBaseUrl: origin.baseUrl,
    synthesisConfigured: Boolean(ctx.config.geminiApiKey),
    // Resolved, not hard-coded: an operator who sets DEFAULT_VOICE must not be
    // shown a page that still claims the default is Charon (audio-feed-4xt).
    defaultVoice: ctx.config.defaultVoice ?? DEFAULT_NARRATION_VOICE,
    viewer: null,
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
      "cache-control": originCacheControl(origin, 300),
      // The response body varies with the host that routed the request, so say
      // so: a cache keyed only on path would otherwise be free to mix them.
      vary: origin.explicit ? "Cookie" : "Host, Cookie",
    },
  });
}
