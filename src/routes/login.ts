/**
 * `GET /login` — passkey sign-in and setup-link enrolment (audio-feed-8fc).
 *
 * One page, two states. A visitor signs in with any passkey registered here; a
 * visitor holding a setup link (`/login#setup=<secret>`) creates one. The secret
 * is in the fragment, so the server never sees it in this request: the script
 * reads it, scrubs it from the address bar and history, and sends it only in a
 * POST body.
 */

import type { AppContext } from "../app.ts";
import type { RouteContext } from "../router.ts";
import { sessionUser } from "../auth/sessions.ts";
import { jsonForScript } from "./html.ts";
import { esc } from "./html.ts";
import { PASSKEY_CLIENT, renderShell, type Viewer, viewerOf } from "./shell.ts";
import { htmlResponse, newCspNonce } from "./csp.ts";

/** Only a same-site path: `/x`, never `//host` or `/\host`. */
export function safeNext(raw: string | null, fallback = "/account"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return fallback;
  }
  return raw;
}

const CSS = `
  .login-hero { text-align: center; margin-block: 1rem 1.5rem; }
  .login-hero svg { inline-size: 3.5rem; block-size: 3.5rem; }
  .login-hero h1 { margin-block-start: 0.75rem; }
  .login-hero .lede { margin-inline: auto; }
  .fineprint { color: var(--muted); font-size: 0.88rem; margin: 1rem 0 0; }
  .fineprint a { color: var(--text-2); }
`;

const KEY_ICON =
  `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3"/><path d="m16 7 3 3"/><path d="m14 9 2 2"/></svg>`;

export function renderLoginPage(o: { viewer: Viewer | null; next: string; nonce: string }): string {
  const signedIn = o.viewer
    ? `<p class="callout">You're signed in as <strong>${esc(o.viewer.displayName)}</strong>.
       <a href="${esc(o.next)}">Continue</a>, or sign in below as someone else.</p>`
    : "";
  const main = `<div class="wrap narrow">
  <div class="login-hero">
    <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="var(--accent)"/><g stroke="var(--accent-ink)" stroke-width="2.4" stroke-linecap="round"><path d="M9 13v6"/><path d="M13.5 9v14"/><path d="M18 12v8"/><path d="M22.5 14.5v3"/></g></svg>
    <h1 id="loginTitle">Sign in</h1>
    <p class="lede" id="loginLede">Use the passkey you saved for Audio Feed. There is no password to remember.</p>
  </div>
  ${signedIn}
  <section class="panel" id="signInPanel" aria-labelledby="loginTitle">
    <button class="btn big" type="button" id="signIn">${KEY_ICON}<span>Sign in with a passkey</span></button>
    <p class="feedback" id="signInFeedback" role="status" aria-live="polite"></p>
    <details class="more">
      <summary>No passkey yet, or lost it?</summary>
      <p class="sub">Accounts are set up by invitation. Ask the person who runs this
      Audio Feed for a setup link: it lets you create a passkey on this device, and
      works once, for seven days.</p>
    </details>
    <details class="more" id="bootstrapDetails">
      <summary>Admin bootstrap</summary>
      <form id="bootstrapForm" novalidate class="u-mt-sm">
        <p class="sub">Set up your admin passkey directly on this device using your server ADMIN_TOKEN.</p>
        <div class="field u-mb-sm">
          <label for="bootstrapEmail">Admin email</label>
          <input id="bootstrapEmail" type="email" required placeholder="admin@example.com" autocomplete="email" />
        </div>
        <div class="field u-mb-sm">
          <label for="bootstrapToken">Admin token</label>
          <input id="bootstrapToken" type="password" required placeholder="Value of ADMIN_TOKEN" autocomplete="current-password" />
        </div>
        <div class="actions u-mt-sm">
          <button class="btn" type="submit" id="bootstrapSubmit">${KEY_ICON}<span>Register admin passkey</span></button>
        </div>
        <p class="feedback" id="bootstrapFeedback" role="status" aria-live="polite"></p>
      </form>
    </details>
  </section>
  <section class="panel" id="setupPanel" hidden aria-labelledby="setupTitle">
    <h2 id="setupTitle">Create your passkey</h2>
    <p class="sub" id="setupWho">Checking your setup link…</p>
    <button class="btn big" type="button" id="createPasskey" disabled>${KEY_ICON}<span>Create a passkey</span></button>
    <p class="feedback" id="setupFeedback" role="status" aria-live="polite"></p>
    <p class="fineprint">Your device stores the passkey and unlocks it with your
    fingerprint, face or screen lock. Audio Feed only ever sees its public half.</p>
  </section>
  <p class="fineprint">Listening needs no sign-in: your feed URL works in any podcast app.
  <a href="/">What is Audio Feed?</a></p>
</div>`;

  const script = `(() => {
  "use strict";
  const NEXT = ${jsonForScript(o.next)};
${PASSKEY_CLIENT}
  const $ = (id) => document.getElementById(id);
  const say = (el, tone, text) => { el.dataset.tone = tone; el.textContent = text; };
  const signInBtn = $("signIn");
  const signInFeedback = $("signInFeedback");

  if (!passkeysSupported) {
    signInBtn.disabled = true;
    say(signInFeedback, "error", "This browser can't use passkeys. Try an up-to-date Chrome, Safari, Edge or Firefox.");
  }

  signInBtn.addEventListener("click", async () => {
    signInBtn.disabled = true;
    say(signInFeedback, "ok", "Waiting for your passkey…");
    try {
      const options = await post("/api/auth/login/options");
      const cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
      const encoded = credentialJSON(cred);
      try {
        await post("/api/auth/login/verify", encoded);
      } catch (error) {
        if (error.status === 404 && PublicKeyCredential.signalUnknownCredential) {
          PublicKeyCredential.signalUnknownCredential({ rpId: options.rpId, credentialId: encoded.id })
            .catch(() => {});
        }
        throw error;
      }
      say(signInFeedback, "ok", "Signed in. Taking you there…");
      location.assign(NEXT);
    } catch (error) {
      say(signInFeedback, "error", ceremonyError(error));
      signInBtn.disabled = false;
    }
  });

  // A setup link: /login#setup=<secret>. Take it, then scrub it from the address
  // bar and history before anything else can read or record it.
  const match = /^#setup=([A-Za-z0-9_-]+)$/.exec(location.hash);
  const bootstrapDetails = $("bootstrapDetails");
  if (location.hash === "#bootstrap" && bootstrapDetails) {
    bootstrapDetails.open = true;
  }

  const bootstrapForm = $("bootstrapForm");
  const bootstrapBtn = $("bootstrapSubmit");
  const bootstrapFeedback = $("bootstrapFeedback");

  bootstrapForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!passkeysSupported) {
      say(bootstrapFeedback, "error", "This browser can't create passkeys.");
      return;
    }
    const email = $("bootstrapEmail").value.trim();
    const adminToken = $("bootstrapToken").value.trim();
    if (!email) {
      say(bootstrapFeedback, "error", "Email is required.");
      $("bootstrapEmail").focus();
      return;
    }
    if (!adminToken) {
      say(bootstrapFeedback, "error", "Admin token is required.");
      $("bootstrapToken").focus();
      return;
    }
    bootstrapBtn.disabled = true;
    say(bootstrapFeedback, "ok", "Verifying token and preparing passkey…");
    try {
      const boot = await post("/api/auth/bootstrap", { email, adminToken });
      say(bootstrapFeedback, "ok", "Follow your device's prompt to register passkey…");
      const reg = await post("/api/auth/register/options", { setupToken: boot.setupToken });
      const cred = await navigator.credentials.create({ publicKey: creationOptions(reg.options) });
      await post("/api/auth/register/verify", credentialJSON(cred));
      say(bootstrapFeedback, "ok", "Admin passkey registered. Taking you to /admin…");
      location.assign("/admin");
    } catch (error) {
      say(bootstrapFeedback, "error", ceremonyError(error));
      bootstrapBtn.disabled = false;
    }
  });

  if (match) {
    const setupToken = match[1];
    history.replaceState(null, "", location.pathname + location.search);
    $("signInPanel").hidden = true;
    $("setupPanel").hidden = false;
    $("loginTitle").textContent = "Welcome to Audio Feed";
    $("loginLede").textContent = "You've been invited. One step and you're in.";
    const who = $("setupWho");
    const createBtn = $("createPasskey");
    const feedback = $("setupFeedback");
    let pending = null;
    const fetchOptions = () => post("/api/auth/register/options", { setupToken })
      .then((data) => { pending = { data, at: Date.now() }; return data; });
    fetchOptions().then((data) => {
      who.textContent = "Setting up " + data.user.displayName + " (" + data.user.email + ").";
      createBtn.disabled = !passkeysSupported;
      if (!passkeysSupported) say(feedback, "error", "This browser can't create passkeys.");
    }).catch((error) => {
      who.textContent = String(error.message || error);
      say(feedback, "error", "Ask for a new setup link.");
    });
    createBtn.addEventListener("click", async () => {
      createBtn.disabled = true;
      say(feedback, "ok", "Follow your device's prompt…");
      try {
        // Challenges live five minutes; a page left open gets a fresh one.
        const data = pending && Date.now() - pending.at < 240000 ? pending.data : await fetchOptions();
        pending = null;
        const cred = await navigator.credentials.create({ publicKey: creationOptions(data.options) });
        await post("/api/auth/register/verify", credentialJSON(cred));
        say(feedback, "ok", "Passkey created. You're signed in.");
        location.assign("/account");
      } catch (error) {
        say(feedback, "error", ceremonyError(error));
        createBtn.disabled = false;
      }
    });
  }
})();`;

  return renderShell({
    title: "Sign in — Audio Feed",
    description: "Sign in to Audio Feed with a passkey.",
    viewer: o.viewer,
    current: "login",
    kit: true,
    css: CSS,
    head: `<meta name="robots" content="noindex">`,
    main,
    script,
    nonce: o.nonce,
  });
}

export async function handleLogin({ ctx, req, url }: RouteContext<AppContext>): Promise<Response> {
  const viewer = viewerOf(await sessionUser(ctx.stores.metadata, req));
  const nonce = newCspNonce();
  const html = renderLoginPage({
    viewer,
    next: safeNext(url.searchParams.get("next")),
    nonce,
  });
  return htmlResponse(html, nonce, {
    headers: {
      "cache-control": "no-store",
      // The fragment is never sent in a Referer, but say so anyway.
      "referrer-policy": "no-referrer",
    },
  });
}
