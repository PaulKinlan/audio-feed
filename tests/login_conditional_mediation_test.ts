/**
 * Tests for WebAuthn passkey conditional mediation (Conditional UI) on /login (audio-feed-0cd0r).
 *
 * Requirements:
 * - autocomplete="username webauthn" on the username field on the shipped login page
 * - On load, where supported, issue navigator.credentials.get({ publicKey, signal, mediation: "conditional" })
 * - Abort ongoing conditional mediation when the user submits the password form (or any form) or navigates away
 * - Do not double-prompt when the existing button is clicked (abort conditional get before explicit prompt)
 * - Degrade silently on unsupported browsers (no error toast on browsers without conditional mediation or WebAuthn)
 *
 * Four primary rows:
 * (a) the attribute is present on the shipped login page;
 * (b) a conditional get is ISSUED on load where supported (stub or observe);
 * (c) is ABORTED on submit - assert the abort rather than assuming it;
 * (d) unsupported browser path shows no error.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderLoginPage } from "../src/routes/login.ts";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { type AppConfig, memoryStores, type Stores } from "../src/config.ts";

// Helper: extract inline login client script from rendered HTML.
function extractLoginScript(html: string): string {
  const marker = '(() => {\n  "use strict";\n  const NEXT = ';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error("Could not find inline login script marker in HTML");
  const end = html.indexOf("\n})();", start);
  if (end === -1) throw new Error("Could not find inline login script end in HTML");
  return html.slice(start, end + 6);
}

interface StubEvent {
  type: string;
  defaultPrevented?: boolean;
  preventDefault?: () => void;
}

type EventListenerFn = (e: StubEvent) => void;

// Stub DOM element
class StubElement {
  id: string;
  disabled = false;
  dataset: Record<string, string> = {};
  textContent = "";
  value = "";
  open = false;
  hidden = false;
  listeners = new Map<string, Array<EventListenerFn>>();

  constructor(id: string) {
    this.id = id;
  }

  addEventListener(type: string, fn: EventListenerFn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(fn);
  }

  dispatchEvent(event: StubEvent) {
    if (!event.preventDefault) {
      event.preventDefault = () => {
        event.defaultPrevented = true;
      };
    }
    const fns = this.listeners.get(event.type) || [];
    for (const fn of fns) fn(event);
  }

  click() {
    this.dispatchEvent({ type: "click" });
  }

  focus() {}
}

interface CredentialGetCall {
  publicKey?: unknown;
  signal?: AbortSignal;
  mediation?: string;
}

interface HarnessContext {
  elements: Map<string, StubElement>;
  doc: {
    getElementById(id: string): StubElement;
    addEventListener(type: string, fn: EventListenerFn): void;
    dispatchEvent(event: StubEvent): void;
  };
  win: {
    addEventListener(type: string, fn: EventListenerFn): void;
    dispatchEvent(event: StubEvent): void;
    PublicKeyCredential?: unknown;
  };
  calls: CredentialGetCall[];
  nav: {
    credentials?: {
      get(opts: CredentialGetCall): Promise<unknown>;
      create(opts: unknown): Promise<unknown>;
    };
  };
  loc: {
    hash: string;
    pathname: string;
    search: string;
    assign(url: string): void;
  };
  hist: {
    replaceState(data: unknown, title: string, url: string): void;
  };
  fetchCalls: string[];
}

function createHarness(options: {
  passkeysSupported?: boolean;
  conditionalAvailable?: boolean | (() => Promise<boolean>);
  credentialResult?: unknown;
  fetchOptionsResult?: unknown;
  fetchOptionsStatus?: number;
  hash?: string;
}): HarnessContext {
  const elements = new Map<string, StubElement>();
  const docListeners = new Map<string, Array<EventListenerFn>>();
  const winListeners = new Map<string, Array<EventListenerFn>>();
  const calls: CredentialGetCall[] = [];
  const fetchCalls: string[] = [];

  const doc = {
    getElementById(id: string): StubElement {
      if (!elements.has(id)) elements.set(id, new StubElement(id));
      return elements.get(id)!;
    },
    addEventListener(type: string, fn: EventListenerFn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type)!.push(fn);
    },
    dispatchEvent(event: StubEvent) {
      if (!event.preventDefault) event.preventDefault = () => {};
      for (const fn of docListeners.get(event.type) || []) fn(event);
    },
  };

  const win = {
    addEventListener(type: string, fn: EventListenerFn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type)!.push(fn);
    },
    dispatchEvent(event: StubEvent) {
      if (!event.preventDefault) event.preventDefault = () => {};
      for (const fn of winListeners.get(event.type) || []) fn(event);
    },
    PublicKeyCredential: undefined as unknown,
  };

  let fakePK: Record<string, unknown> | undefined = undefined;
  if (options.passkeysSupported !== false) {
    const pkFn = function () {};
    fakePK = pkFn as unknown as Record<string, unknown>;
    if (options.conditionalAvailable !== undefined) {
      if (typeof options.conditionalAvailable === "function") {
        fakePK.isConditionalMediationAvailable = options.conditionalAvailable;
      } else {
        const val = options.conditionalAvailable;
        fakePK.isConditionalMediationAvailable = () => Promise.resolve(val);
      }
    }
    fakePK.parseRequestOptionsFromJSON = (j: unknown) => j;
    win.PublicKeyCredential = fakePK;
  }

  const nav = options.passkeysSupported === false ? {} : {
    credentials: {
      get(opts: CredentialGetCall) {
        calls.push(opts);
        if (options.credentialResult) return Promise.resolve(options.credentialResult);
        return new Promise(() => {}); // stay pending until aborted or completed
      },
      create(_opts: unknown) {
        return new Promise(() => {});
      },
    },
  };

  const loc = {
    hash: options.hash || "",
    pathname: "/login",
    search: "",
    assign(_url: string) {},
  };

  const hist = {
    replaceState(_data: unknown, _title: string, _url: string) {},
  };

  const fakeFetch = (path: string) => {
    fetchCalls.push(path);
    const status = options.fetchOptionsStatus ?? 200;
    const ok = status >= 200 && status < 300;
    return Promise.resolve({
      ok,
      status,
      json: () =>
        Promise.resolve(
          options.fetchOptionsResult || (ok
            ? {
              challenge: "dGVzdA",
              rpId: "audio.test",
              allowCredentials: [],
            }
            : { error: "Rate limit exceeded" }),
        ),
    });
  };

  const html = renderLoginPage({ viewer: null, next: "/account", nonce: "test" });
  const code = extractLoginScript(html);

  const runner = new Function(
    "document",
    "window",
    "navigator",
    "location",
    "history",
    "PublicKeyCredential",
    "fetch",
    code,
  );
  runner(doc, win, nav, loc, hist, fakePK, fakeFetch);

  return { elements, doc, win, calls, nav, loc, hist, fetchCalls };
}

// -----------------------------------------------------------------------------
// Row (a): autocomplete="username webauthn" on shipped login page
// Mutant (a): omitting webauthn token (e.g. autocomplete="username") fails this row.
// -----------------------------------------------------------------------------
Deno.test("login: (a) autocomplete='username webauthn' is present on the shipped login page (audio-feed-0cd0r)", () => {
  const html = renderLoginPage({ viewer: null, next: "/account", nonce: "test" });
  assertStringIncludes(
    html,
    'autocomplete="username webauthn"',
    "Login page must render autocomplete='username webauthn' for autofill anchoring",
  );

  // Assert it is placed on the username input element
  const usernameInputMatch = html.match(/<input[^>]+autocomplete="username webauthn"[^>]*>/);
  assert(
    usernameInputMatch !== null,
    "autocomplete='username webauthn' must be on an <input> element",
  );
  assertStringIncludes(usernameInputMatch[0], 'name="username"');
  assertStringIncludes(usernameInputMatch[0], 'id="loginUsername"');

  // Verify form wrapper exists
  assertStringIncludes(html, '<form id="signInForm"');
});

Deno.test("login: (a) shipped GET /login HTTP response includes autocomplete='username webauthn' (audio-feed-0cd0r)", async () => {
  const stores: Stores = memoryStores();
  const config: AppConfig = {
    port: 8000,
    publicBaseUrl: "https://audio.example.com",
    adminToken: "admin-secret",
  };
  const ctx = { config, stores };
  const app = createApp(ctx, createHandlers(ctx));
  const res = await app.fetch(new Request("https://audio.example.com/login"));
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, 'autocomplete="username webauthn"');
});

// -----------------------------------------------------------------------------
// Row (b): conditional get is ISSUED on load where supported
// Mutant (b): omitting mediation: "conditional" or failing to invoke on load fails this row.
// -----------------------------------------------------------------------------
Deno.test("login: (b) a conditional get is ISSUED on load where supported (audio-feed-0cd0r)", async () => {
  const h = createHarness({
    passkeysSupported: true,
    conditionalAvailable: true,
  });

  // Allow microtasks and options fetch to resolve
  await new Promise((r) => setTimeout(r, 20));

  assertEquals(h.fetchCalls, ["/api/auth/login/options"], "Fetched login options on page load");
  assertEquals(h.calls.length, 1, "Exactly one credentials.get called on load");

  const call = h.calls[0]!;
  assertEquals(
    call.mediation,
    "conditional",
    "navigator.credentials.get called with mediation: 'conditional'",
  );
  assert(call.signal instanceof AbortSignal, "Call must pass an AbortSignal");
  assertEquals(call.signal.aborted, false, "Signal must be active, not aborted");
});

// -----------------------------------------------------------------------------
// Row (c): conditional get is ABORTED on submit - assert the abort rather than assuming it
// Mutant (c): omitting abortConditional() on submit leaves signal.aborted false, failing this row.
// -----------------------------------------------------------------------------
Deno.test("login: (c) conditional get is ABORTED on submit of password form (audio-feed-0cd0r)", async () => {
  const h = createHarness({
    passkeysSupported: true,
    conditionalAvailable: true,
  });

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(h.calls.length, 1);
  const signal = h.calls[0]!.signal!;
  assertEquals(signal.aborted, false, "Initially not aborted");

  // Track abort event firing explicitly
  let abortEventFired = false;
  signal.addEventListener("abort", () => {
    abortEventFired = true;
  });

  // User submits the admin bootstrap password form
  const bootstrapForm = h.doc.getElementById("bootstrapForm");
  bootstrapForm.dispatchEvent({ type: "submit" });

  // Direct assertion of the abort state
  assertEquals(signal.aborted, true, "Signal must be aborted on password form submit");
  assertEquals(abortEventFired, true, "Abort event listener must fire on submit");
});

Deno.test("login: (c) conditional get is ABORTED on submit of sign-in form (audio-feed-0cd0r)", async () => {
  const h = createHarness({
    passkeysSupported: true,
    conditionalAvailable: true,
  });

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(h.calls.length, 1);
  const signal = h.calls[0]!.signal!;
  assertEquals(signal.aborted, false);

  let abortEventFired = false;
  signal.addEventListener("abort", () => {
    abortEventFired = true;
  });

  // User submits the sign-in form (e.g. presses enter in username field)
  const signInForm = h.doc.getElementById("signInForm");
  signInForm.dispatchEvent({ type: "submit" });

  assertEquals(signal.aborted, true, "Signal must be aborted on sign-in form submit");
  assertEquals(abortEventFired, true, "Abort event must fire on sign-in form submit");
});

Deno.test("login: (c) conditional get is ABORTED on document submit event (audio-feed-0cd0r)", async () => {
  const h = createHarness({
    passkeysSupported: true,
    conditionalAvailable: true,
  });

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(h.calls.length, 1);
  const signal = h.calls[0]!.signal!;
  assertEquals(signal.aborted, false);

  h.doc.dispatchEvent({ type: "submit" });

  assertEquals(signal.aborted, true, "Signal must be aborted on document submit");
});

Deno.test("login: (c) conditional get is ABORTED when existing button is clicked (no double-prompt) (audio-feed-0cd0r)", async () => {
  const h = createHarness({
    passkeysSupported: true,
    conditionalAvailable: true,
  });

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(h.calls.length, 1);
  const conditionalSignal = h.calls[0]!.signal!;
  assertEquals(conditionalSignal.aborted, false);

  // User clicks "Sign in with a passkey" button
  const signInBtn = h.doc.getElementById("signIn");
  signInBtn.click();

  assertEquals(
    conditionalSignal.aborted,
    true,
    "Conditional get must be aborted before button prompt starts",
  );

  // Wait for button click's options fetch and explicit credentials.get
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(h.calls.length, 2, "Second credentials.get issued for button click");
  assertEquals(
    h.calls[1]!.mediation,
    undefined,
    "Explicit button call does not use conditional mediation",
  );
});

Deno.test("login: (c) conditional get is ABORTED on pagehide and beforeunload (audio-feed-0cd0r)", async () => {
  const h1 = createHarness({ passkeysSupported: true, conditionalAvailable: true });
  await new Promise((r) => setTimeout(r, 20));
  const s1 = h1.calls[0]!.signal!;
  assertEquals(s1.aborted, false);
  h1.win.dispatchEvent({ type: "pagehide" });
  assertEquals(s1.aborted, true, "Aborted on pagehide");

  const h2 = createHarness({ passkeysSupported: true, conditionalAvailable: true });
  await new Promise((r) => setTimeout(r, 20));
  const s2 = h2.calls[0]!.signal!;
  assertEquals(s2.aborted, false);
  h2.win.dispatchEvent({ type: "beforeunload" });
  assertEquals(s2.aborted, true, "Aborted on beforeunload");
});

// -----------------------------------------------------------------------------
// Row (d): unsupported browser path shows no error
// Mutant (d): displaying an error toast on load when conditional mediation or WebAuthn
// is unsupported fails this row.
// -----------------------------------------------------------------------------
Deno.test("login: (d) unsupported browser path shows no error when conditionalAvailable is false (audio-feed-0cd0r)", async () => {
  const h = createHarness({
    passkeysSupported: true,
    conditionalAvailable: false,
  });

  await new Promise((r) => setTimeout(r, 20));

  assertEquals(h.calls.length, 0, "No credentials.get should be issued");
  assertEquals(h.fetchCalls.length, 0, "No options fetch should be issued");

  const feedback = h.doc.getElementById("signInFeedback");
  assertEquals(feedback.dataset.tone, undefined, "No error tone set on feedback");
  assertEquals(feedback.textContent, "", "No error toast displayed");
});

Deno.test("login: (d) unsupported browser path shows no error when PublicKeyCredential rejects (audio-feed-0cd0r)", async () => {
  const h = createHarness({
    passkeysSupported: true,
    conditionalAvailable: () => Promise.reject(new Error("unsupported")),
  });

  await new Promise((r) => setTimeout(r, 20));

  assertEquals(h.calls.length, 0);
  const feedback = h.doc.getElementById("signInFeedback");
  assertEquals(feedback.dataset.tone, undefined);
  assertEquals(feedback.textContent, "");
});

Deno.test("login: (d) unsupported browser path shows no error on page load when WebAuthn is unsupported (audio-feed-0cd0r)", async () => {
  const h = createHarness({
    passkeysSupported: false,
  });

  await new Promise((r) => setTimeout(r, 20));

  const signInBtn = h.doc.getElementById("signIn");
  assertEquals(signInBtn.disabled, true, "Button is disabled on unsupported browser");

  // On page load, no error toast must be shown
  const feedback = h.doc.getElementById("signInFeedback");
  assertEquals(feedback.dataset.tone, undefined, "No error tone on initial page load");
  assertEquals(feedback.textContent, "", "No error toast on initial page load");
  assertEquals(h.calls.length, 0);
});

// -----------------------------------------------------------------------------
// Row (d / options 429): page load with options endpoint returning 429 leaves
// #signInFeedback text empty and data-tone undefined (audio-feed-0cd0r)
// Mutant: if initConditionalUI catch shows the toast again on 429, this row reds.
// -----------------------------------------------------------------------------
Deno.test("login: (d) page load with options endpoint returning 429 leaves #signInFeedback text empty and data-tone undefined (audio-feed-0cd0r)", async () => {
  const h = createHarness({
    passkeysSupported: true,
    conditionalAvailable: true,
    fetchOptionsStatus: 429,
  });

  await new Promise((r) => setTimeout(r, 20));

  assertEquals(h.fetchCalls, ["/api/auth/login/options"], "Attempted options fetch");
  const feedback = h.doc.getElementById("signInFeedback");
  assertEquals(
    feedback.dataset.tone,
    undefined,
    "No error tone set on feedback when options rate-limited",
  );
  assertEquals(feedback.textContent, "", "No error toast displayed when options rate-limited");
});

Deno.test("login: explicit passkey button click with options returning 429 surfaces error toast (audio-feed-0cd0r)", async () => {
  const h = createHarness({
    passkeysSupported: true,
    conditionalAvailable: true,
    fetchOptionsStatus: 429,
  });

  await new Promise((r) => setTimeout(r, 20));

  const signInBtn = h.doc.getElementById("signIn");
  signInBtn.click();
  await new Promise((r) => setTimeout(r, 20));

  const feedback = h.doc.getElementById("signInFeedback");
  assertEquals(feedback.dataset.tone, "error", "Explicit button click sets error tone");
  assertEquals(
    feedback.textContent,
    "Rate limit exceeded",
    "Explicit button click shows error message",
  );
  assertEquals(signInBtn.disabled, false, "Sign in button re-enabled after error");
});

// -----------------------------------------------------------------------------
// Setup Link: no conditional get initiated if #setup link is in URL fragment
// -----------------------------------------------------------------------------
Deno.test("login: setup fragment does not initiate conditional get (audio-feed-0cd0r)", async () => {
  const h = createHarness({
    passkeysSupported: true,
    conditionalAvailable: true,
    hash: "#setup=abcdef1234567890",
  });

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(h.calls.length, 0, "Setup flow must not initiate login conditional get");
});
