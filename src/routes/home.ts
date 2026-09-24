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
import type { RouteContext } from "../router.ts";

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
}

/**
 * The whole page. A pure function of its options so a test can assert on the
 * markup without binding a port.
 */
export function renderHomePage({
  publicBaseUrl,
  synthesisConfigured,
}: HomePageOptions): string {
  const base = esc(publicBaseUrl.replace(/\/+$/, ""));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Audio Feed — turn articles into a private podcast</title>
<meta name="description" content="Audio Feed turns articles and RSS sources into a private podcast: single-voice author reads and two-voice deep dive discussions, delivered to any podcast app.">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎧</text></svg>">
<style>
  /* ---- tokens ---------------------------------------------------------- */
  :root {
    color-scheme: light dark;

    --bg: #fbfaf9;
    --surface: #ffffff;
    --surface-sunken: #f2f0ee;
    --text: #1b1a18;
    --text-muted: #55514c;
    --border: #ddd8d2;
    --accent: #7a3e12;
    --accent-text: #ffffff;
    --danger: #a3261a;
    --ok: #1e6b3a;

    --space-1: 0.25rem;
    --space-2: 0.5rem;
    --space-3: 0.75rem;
    --space-4: 1rem;
    --space-6: 1.5rem;
    --space-8: 2rem;
    --space-12: 3rem;

    --radius: 10px;
    --measure: 68ch;
    --page: 54rem;

    --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #171614;
      --surface: #201e1c;
      --surface-sunken: #2a2724;
      --text: #f2efec;
      --text-muted: #b3aca4;
      --border: #3a3633;
      --accent: #e8a866;
      --accent-text: #201e1c;
      --danger: #f08a7e;
      --ok: #7fc99a;
    }
  }

  /* ---- base ------------------------------------------------------------ */
  *, *::before, *::after { box-sizing: border-box; }

  body {
    margin: 0;
    /* min-inline-size on the body is what actually stops a long unbroken
       string (a feed URL) from widening the viewport on a narrow phone. */
    min-inline-size: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: clamp(1rem, 0.96rem + 0.2vw, 1.0625rem);
    line-height: 1.6;
    -webkit-text-size-adjust: 100%;
  }

  .page {
    inline-size: 100%;
    max-inline-size: var(--page);
    margin-inline: auto;
    padding-inline: var(--space-4);
    padding-block: var(--space-8) var(--space-12);
  }

  h1, h2, h3 { line-height: 1.2; text-wrap: balance; margin-block: 0 var(--space-3); }
  h1 { font-size: clamp(1.75rem, 1.3rem + 2.2vw, 2.75rem); letter-spacing: -0.02em; }
  h2 { font-size: clamp(1.25rem, 1.1rem + 0.8vw, 1.5rem); margin-block-start: var(--space-8); }
  h3 { font-size: 1.05rem; }
  p { max-inline-size: var(--measure); margin-block: 0 var(--space-4); }
  a { color: inherit; text-underline-offset: 0.2em; }
  a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 2px;
  }

  .lede {
    font-size: 1.125em;
    color: var(--text-muted);
  }

  /* ---- layout ---------------------------------------------------------- */
  .cards {
    display: grid;
    gap: var(--space-4);
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr));
    padding: 0;
    margin-block: var(--space-4) 0;
    list-style: none;
  }

  .card {
    /* Without min-inline-size:0 a grid item refuses to shrink below its
       content, which is how a code sample pushes a phone layout sideways. */
    min-inline-size: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-4);
  }
  .card p:last-child { margin-block-end: 0; }
  .card .voices {
    font-size: 0.875rem;
    color: var(--text-muted);
    margin-block-end: 0;
  }

  /* ---- code ------------------------------------------------------------ */
  code, kbd, samp, pre {
    font-family: var(--mono);
    font-size: 0.875em;
  }
  code {
    background: var(--surface-sunken);
    border-radius: 4px;
    padding: 0.15em 0.4em;
    /* A feed URL has no spaces; without this it is a single unbreakable word. */
    overflow-wrap: anywhere;
  }
  pre {
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-3);
    margin-block: var(--space-3) var(--space-4);
    /* Scroll the block, never the page. */
    overflow-x: auto;
    max-inline-size: 100%;
  }
  pre code { background: none; padding: 0; overflow-wrap: normal; }

  .urls { list-style: none; padding: 0; margin-block: var(--space-3) var(--space-4); }
  .urls li { margin-block-end: var(--space-2); }
  .urls .what { color: var(--text-muted); font-size: 0.875rem; display: block; }

  /* ---- form ------------------------------------------------------------ */
  form { margin-block-start: var(--space-4); }

  .field { margin-block-end: var(--space-4); max-inline-size: var(--measure); }
  .field > label,
  fieldset > legend {
    display: block;
    font-weight: 600;
    margin-block-end: var(--space-1);
  }
  .hint {
    display: block;
    color: var(--text-muted);
    font-size: 0.875rem;
    margin-block-end: var(--space-2);
  }

  input[type="url"], input[type="password"] {
    inline-size: 100%;
    font: inherit;
    font-size: max(1rem, 1em); /* >=16px: smaller text makes iOS zoom on focus. */
    padding: var(--space-2) var(--space-3);
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  fieldset {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--space-3);
    margin: 0 0 var(--space-4);
    max-inline-size: var(--measure);
    min-inline-size: 0; /* fieldsets ignore flex/grid shrinking without this */
  }
  fieldset legend { padding-inline: var(--space-2); }

  .choice {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding-block: var(--space-2);
  }
  .choice input { margin-block-start: 0.3em; flex: none; }
  .choice .what { display: block; color: var(--text-muted); font-size: 0.875rem; }

  /*
    Errors appear only after the user has interacted, never on load.
    Two indicators, not one: colour alone is not a usable signal.
  */
  .error {
    display: none;
    color: var(--danger);
    font-size: 0.875rem;
    margin-block-start: var(--space-1);
  }
  input:user-invalid,
  input.is-invalid {
    border-color: var(--danger);
    border-width: 2px;
  }
  input:user-invalid ~ .error,
  input.is-invalid ~ .error { display: block; }

  button[type="submit"] {
    font: inherit;
    font-weight: 600;
    padding: var(--space-3) var(--space-6);
    color: var(--accent-text);
    background: var(--accent);
    border: 1px solid transparent;
    border-radius: var(--radius);
    cursor: pointer;
    min-block-size: 44px; /* comfortable touch target */
  }
  button[type="submit"]:hover { filter: brightness(1.1); }
  button[type="submit"][aria-disabled="true"] { opacity: 0.6; cursor: progress; }

  #result {
    margin-block-start: var(--space-4);
    max-inline-size: var(--measure);
    overflow-wrap: anywhere;
  }
  #result:not(:empty) {
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-inline-start: 4px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }
  #result.ok { border-inline-start-color: var(--ok); }
  #result.bad { border-inline-start-color: var(--danger); }
  #result p { margin: 0; }
  #result .detail { color: var(--text-muted); font-size: 0.875rem; margin-block-start: var(--space-1); }

  .note {
    background: var(--surface-sunken);
    border-radius: var(--radius);
    padding: var(--space-3);
    font-size: 0.9375rem;
    max-inline-size: var(--measure);
  }

  footer {
    margin-block-start: var(--space-12);
    padding-block-start: var(--space-4);
    border-block-start: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
</style>
</head>
<body>
<main class="page">

  <h1>Audio Feed</h1>
  <p class="lede">
    A personal podcast generator. It turns articles and RSS sources into audio you
    can listen to in any podcast app — read aloud, or discussed by two voices.
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
      <p class="voices">Default voice: Charon</p>
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
    Every listener gets a private feed token. That token <em>is</em> the
    credential — podcast apps cannot log in, so anyone holding your feed URL can
    read your feed. Treat it like a password and do not share it.
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

  <h2 id="send">Send an article to audio</h2>
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

  <noscript>
    <p class="note">
      This form needs JavaScript, because the feed token travels in a request
      header rather than the URL. Without it, use curl:
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

  <footer>
    <p>
      Service status: <a href="/health">/health</a> ·
      Source: <a href="https://github.com/PaulKinlan/audio-feed">github.com/PaulKinlan/audio-feed</a>
    </p>
  </footer>

</main>

<script>
(() => {
  const form = document.getElementById("ingest");
  const button = document.getElementById("submit");
  const result = document.getElementById("result");
  const url = document.getElementById("url");
  const token = document.getElementById("token");
  const required = [url, token];

  // :user-invalid is a visual state only. Assistive technology needs
  // aria-invalid, and it has to appear on the same schedule as the styling —
  // after interaction, not on page load.
  const supportsUserInvalid = (() => {
    try { return document.querySelector(":user-invalid") !== undefined; }
    catch { return false; }
  })();

  const sync = (input) => {
    const valid = input.checkValidity();
    if (valid) input.removeAttribute("aria-invalid");
    else input.setAttribute("aria-invalid", "true");
    if (!supportsUserInvalid) input.classList.toggle("is-invalid", !valid);
  };

  form.addEventListener("blur", (e) => {
    if (required.includes(e.target)) sync(e.target);
  }, true);

  form.addEventListener("input", (e) => {
    if (required.includes(e.target) && e.target.checkValidity()) {
      e.target.removeAttribute("aria-invalid");
      e.target.classList.remove("is-invalid");
    }
  });

  const say = (kind, message, detail) => {
    result.className = kind;
    result.innerHTML = "";
    const p = document.createElement("p");
    p.textContent = message;
    result.append(p);
    if (detail) {
      const d = document.createElement("p");
      d.className = "detail";
      d.textContent = detail;
      result.append(d);
    }
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    required.forEach(sync);
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    button.setAttribute("aria-disabled", "true");
    button.textContent = "Sending…";
    say("", "Queueing the article…");

    try {
      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // A header, never a query parameter: a token in a URL ends up in
          // history, referrers and server logs.
          "x-feed-token": token.value.trim(),
        },
        body: JSON.stringify({
          url: url.value.trim(),
          mode: form.elements.mode.value,
        }),
      });

      const body = await response.json().catch(() => ({}));

      if (response.status === 202) {
        say(
          "ok",
          "Queued. It will appear in your feed once synthesis finishes.",
          body.article && body.article.title ? "Article: " + body.article.title : undefined,
        );

        // Clearing url.value alone is not enough, and the difference is
        // visible: an emptied required field the user has already interacted
        // with matches :user-invalid, so a red "Enter a full URL" error appeared
        // directly beneath the green success message. form.reset() is what
        // clears the browser's interaction state; the token and mode are then
        // restored because someone sending a second article wants to keep them.
        //
        // NOTE: no backticks in comments inside this template literal — one
        // would close the template and break the whole page.
        const keptToken = token.value;
        const keptMode = form.elements.mode.value;
        form.reset();
        token.value = keptToken;
        form.elements.mode.value = keptMode;
        for (const field of required) {
          field.removeAttribute("aria-invalid");
          field.classList.remove("is-invalid");
        }
        url.focus();
      } else if (response.status === 403) {
        say("bad", "That token was not accepted, or the account is not approved yet.",
          "New accounts need admin approval before audio can be generated.");
      } else {
        say("bad", body.error || "The article could not be queued.",
          "Status " + response.status);
      }
    } catch (error) {
      say("bad", "Could not reach the server.", String(error));
    } finally {
      button.removeAttribute("aria-disabled");
      button.textContent = "Send to Audio";
    }
  });
})();
</script>
</body>
</html>
`;
}

/** `GET /` — the human entry point. */
export function handleHome({ ctx }: RouteContext<AppContext>): Response {
  const html = renderHomePage({
    publicBaseUrl: ctx.config.publicBaseUrl,
    synthesisConfigured: Boolean(ctx.config.geminiApiKey),
  });

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Short: the page reports whether synthesis is configured, so a stale
      // copy could tell a visitor the service is unavailable after it is fixed.
      "cache-control": "public, max-age=300",
    },
  });
}
