/**
 * Harness that executes the admin console's real shipped client (audio-feed-05b; re-pointed by
 * audio-feed-3xq part 4a when the client moved out of the page template).
 *
 * Why this exists: the console's destructive actions are guarded by a confirm dialog,
 * and the only test covering them once asserted `assertStringIncludes(html, "confirm(")`.
 * That checks a string appears somewhere. It cannot tell a guard from a
 * decoration -- a `confirm()` whose return value is discarded passes it, while
 * clicking Cancel deletes the feed anyway.
 *
 * So this runs the code that is actually served -- src/assets/admin.js, the exact bytes
 * registered in src/routes/assets.ts and linked from the rendered page -- against a stub DOM,
 * with `confirm` and `fetch` injected. Tests can then answer the only question that
 * matters: when the admin clicks Cancel, does the request go out?
 *
 * The contract being enforced (adminClientFromHtml, with its own decoy tests in
 * admin_confirm_test.ts): the page carries exactly one #admin-data JSON island and exactly one
 * module link, and that link is the content-addressed URL the server would actually serve. A
 * stale link or a second island is a loud error, never a silent substitution.
 *
 * Deliberately NOT a refactor of the client into testable units. The
 * module is shipped as one file; a test of an extracted helper proves
 * the helper works, not that the page does. Testing the artifact cannot drift
 * from what subscribers' admins actually load.
 *
 * The stub DOM implements only what the client touches -- verified by reading
 * every `document.*`, element property and global out of the shipped module:
 *   document.getElementById / createElement
 *   textContent, className, type, value, checked, disabled, hidden, readOnly,
 *   dataset, appendChild, append, replaceChildren, setAttribute,
 *   addEventListener, focus, select, scrollIntoView, reset, click
 *   sessionStorage, localStorage, navigator.clipboard, confirm, setTimeout,
 *   fetch
 * If the client grows a new DOM call, this harness throws rather than silently
 * passing, which is the behaviour we want from a test double.
 *
 * Owned by: audio-feed-05b, audio-feed-3xq.
 */
import { renderAdminPage } from "../src/routes/admin.ts";
import { assetBody, assetUrl } from "../src/routes/assets.ts";

/** Every id the served page defines, so `getElementById` resolves like a browser. */
const PAGE_IDS = [
  "usersFeedback",
  "usersBody",
  "usersCaption",
  "created",
  "loadUsers",
  "createForm",
  "createFeedback",
  "email",
  "displayName",
  "feedUrl",
  "createUser",
  "manageSection",
  "manageName",
  "manageDetails",
  "manageFeedUrl",
  "copyManageFeedUrl",
  "rotateManageToken",
  "manageSourcesBody",
  "manageSourcesCaption",
  "manageSourcesFeedback",
  "addSourceForm",
  "addSourceFeedback",
  "submitAddSource",
  "closeManage",
  "subFeedUrl",
  "subFeedTitle",
  "subFeedMode",
  "pollNowBtn",
  "synthesizeNowBtn",
  "triggersFeedback",
  // audio-feed-ndc
  "refreshStats",
  "statDownloads",
  "statLastPoll",
  "statPollDuration",
  // audio-feed-ct1: says how many polls the mean actually covers.
  "statPollNote",
  "statRuns",
  "runsBody",
  "runsCaption",
  "downloadsBody",
  "downloadsCaption",
  "statsFeedback",
  // audio-feed-8fc: setup links and admin rights.
  "setupLinkBox",
  "setupLinkUrl",
  "setupLinkNote",
  "copySetupLink",
  "newIsAdmin",
  // audio-feed-8oz
  "manageEpisodesBody",
  "manageEpisodesCaption",
  "manageEpisodesFeedback",
  "regenOutdated",
  "regenFailed",
  "regenAll",
  // audio-feed-9mp: spend visibility & budget
  "statSynthesis",
  "synthesisBody",
  "synthesisCaption",
  "newDailyBudget",
  // audio-feed-ytl: native accessible modal dialog
  "confirmDialog",
  "confirmTitle",
  "confirmMessage",
  "confirmOkBtn",
  "confirmCancelBtn",
  // audio-feed-pzwe: accessible tooltip container
  "appTooltip",
  // audio-feed-3xq part 4a: the console's data island, and the two select ids the submit
  // handlers read that were missing from this list while the script was an untyped string.
  "admin-data",
  "newFeedCodeHandling",
  "subFeedCodeHandling",
];

export interface StubElement {
  tag: string;
  id: string;
  textContent: string;
  className: string;
  type: string;
  value: string;
  /** audio-feed-ndc — the remember-token checkbox is read AND written by the script. */
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  readOnly: boolean;
  dataset: Record<string, string>;
  children: StubElement[];
  attributes: Record<string, string>;
  listeners: Map<string, Array<(event: StubEvent) => unknown>>;
  appendChild(child: StubElement): StubElement;
  append(...children: StubElement[]): void;
  replaceChildren(...children: StubElement[]): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, fn: (event: StubEvent) => unknown): void;
  removeEventListener(type: string, fn: (event: StubEvent) => unknown): void;
  focus(): void;
  select(): void;
  scrollIntoView(): void;
  reset(): void;
  click(): unknown;
  /** Fire a submit listener, as pressing the form's submit button would. */
  submit(): unknown;
  /** audio-feed-ytl — native dialog methods and properties */
  open?: boolean;
  returnValue?: string;
  showModal?: () => void;
  close?: (val?: string) => void;
  /** Every element at or below this one, depth first. */
  descendants(): StubElement[];
}

export interface StubEvent {
  type: string;
  key?: string;
  preventDefault(): void;
  defaultPrevented: boolean;
}

function fire(el: StubElement, type: string): unknown {
  const event: StubEvent = {
    type,
    preventDefault() {
      event.defaultPrevented = true;
    },
    defaultPrevented: false,
  };
  const results = (el.listeners.get(type) ?? []).map((fn) => fn(event));
  return results.length === 1 ? results[0] : results;
}

function makeElement(tag: string, id = ""): StubElement {
  const el: StubElement = {
    tag,
    id,
    textContent: "",
    className: "",
    type: "",
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    readOnly: false,
    dataset: {},
    children: [],
    attributes: {},
    listeners: new Map(),
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    append(...children) {
      el.children.push(...children);
    },
    replaceChildren(...children) {
      el.children = [...children];
    },
    setAttribute(name, value) {
      el.attributes[name] = value;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
      el.listeners.set(type, list);
    },
    focus() {},
    select() {},
    scrollIntoView() {},
    reset() {
      for (const child of el.descendants()) child.value = "";
    },
    click() {
      return fire(el, "click");
    },
    submit() {
      return fire(el, "submit");
    },
    descendants() {
      const out: StubElement[] = [el];
      for (const child of el.children) out.push(...child.descendants());
      return out;
    },
  };
  return el;
}

/** A request the page actually sent, in order. */
export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  adminToken: string | null;
}

export interface ConfirmCall {
  message: string;
  answer: boolean;
}

export interface AdminHarness {
  /** Elements by page id. */
  byId(id: string): StubElement;
  /** Every request the page sent, oldest first. */
  requests: RecordedRequest[];
  /** Every `confirm()` the page raised, with the answer it was given. */
  confirms: ConfirmCall[];
  /** What the next `confirm()` returns. Set before clicking. */
  setConfirmAnswer(answer: boolean): void;
  /** Buttons currently rendered under an element, by visible label. */
  buttons(root: StubElement, label: string): StubElement[];
  /** Let queued promises settle. */
  flush(): Promise<void>;
  /**
   * What is in each web storage right now (audio-feed-ndc).
   *
   * Exposed because "remember me" is a claim about WHERE the token went, and
   * the only way to falsify it is to look in both stores. A test that asserted
   * the checkbox state would pass while the token sat in the wrong one.
   */
  sessionStore(key: string): string | null;
  localStore(key: string): string | null;
}

export interface HarnessOptions {
  publicBaseUrl?: string;
  /** Answers API calls. Return `null` to 404. */
  respond: (
    method: string,
    path: string,
    body: unknown,
  ) => unknown | null | Promise<unknown | null>;
  /** Admin token pre-seeded into sessionStorage, so the page auto-loads. */
  storedToken?: string | null;
  /** Render the page for a signed-in admin session (audio-feed-8fc). */
  signedIn?: boolean;
  /**
   * Admin token pre-seeded into localStorage — the "remembered on this device"
   * case (audio-feed-ndc). Separate from `storedToken` so a test can seed one,
   * the other, or both and see which the page prefers.
   */
  persistedToken?: string | null;
}

/**
 * The console's client and its data, resolved the way a browser resolves them.
 *
 * `source` is the exact bytes the asset route serves (assetBody reads the same registry
 * handleAsset does); `data` is the raw text of the page's one #admin-data island.
 */
export interface AdminClient {
  source: string;
  data: string;
}

/**
 * Render the admin page for a given session state and resolve its client contract.
 */
export function adminClient(
  publicBaseUrl = "https://audio.example.com",
  signedIn = true,
): AdminClient {
  const viewer = signedIn
    ? { displayName: "Admin", email: "admin@example.com", isAdmin: true }
    : null;
  return adminClientFromHtml(
    renderAdminPage({ nonce: "test-nonce", publicBaseUrl, adminConfigured: true, viewer }),
  );
}

/**
 * The validation itself, taking HTML directly so its failure paths are testable.
 *
 * History (audio-feed-euq): when the client was an inline block, this guard refused to guess
 * WHICH `<script>` was the console's -- taking the first block would have silently run a decoy
 * (JSON-LD, analytics) while the suite stayed green. The client is now a content-addressed
 * module and the data a JSON island, so the ambiguity moved: the guards now are exactly one
 * island, exactly one module link, and that link must be the address the server actually
 * serves -- a stale hash must fail here, not 404 in production. Keeping this pure lets
 * `admin_confirm_test.ts` feed it decoy pages and check it refuses rather than substituting.
 */
export function adminClientFromHtml(html: string): AdminClient {
  const islands = [
    ...html.matchAll(
      /<script\b[^>]*type="application\/json"[^>]*id="admin-data"[^>]*>([\s\S]*?)<\/script>/g,
    ),
  ];
  if (islands.length === 0) {
    throw new Error(
      "admin page carries no #admin-data document. The console client reads its origin and " +
        "session state from that island; without it, the page cannot drive the module.",
    );
  }
  if (islands.length > 1) {
    throw new Error(
      `admin page carries ${islands.length} #admin-data documents; exactly one may define ` +
        `the console's data.`,
    );
  }

  const modules = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)];
  if (modules.length !== 1) {
    throw new Error(
      `admin page must link exactly one client module, found ${modules.length}. ` +
        `Teach this harness which one is the console's rather than letting it run whichever ` +
        `comes first.`,
    );
  }
  const expected = assetUrl("admin.js");
  if (modules[0]![1] !== expected) {
    throw new Error(
      `admin page links ${modules[0]![1]} but the server serves the client at ${expected} -- ` +
        `a stale or wrong asset link would 404 in production.`,
    );
  }

  const source = assetBody("admin.js");
  if (source === null) {
    throw new Error("admin.js is not registered in src/routes/assets.ts");
  }
  // The console client drives the manage pane. If that stops being true the wrong file is
  // registered, and these tests must fail loudly rather than exercise a decoy.
  if (!source.includes("rotateManageToken")) {
    throw new Error(
      "the registered admin.js does not look like the console client (no rotateManageToken). " +
        "Check what assets.ts serves before trusting these tests.",
    );
  }
  return { source, data: islands[0]![1]! };
}

/**
 * Render the admin page, then run its client module against a stub DOM.
 *
 * Returns once the module's synchronous body has run and the initial
 * `loadUsers()` (if a token was stored) has settled.
 */
export async function runAdminScript(options: HarnessOptions): Promise<AdminHarness> {
  const publicBaseUrl = options.publicBaseUrl ?? "https://audio.example.com";
  const signedIn = options.signedIn ?? true;
  const client = adminClient(publicBaseUrl, signedIn);
  const elements = new Map<string, StubElement>();
  for (const id of PAGE_IDS) {
    elements.set(
      id,
      makeElement(id === "confirmDialog" ? "dialog" : id === "admin-data" ? "script" : "div", id),
    );
  }
  // Seed the island with the bytes the server actually rendered, so the client parses the
  // page's real payload rather than a test-authored lookalike.
  const dataEl = elements.get("admin-data");
  if (!dataEl) throw new Error("PAGE_IDS lost admin-data; the harness cannot seed the island");
  dataEl.textContent = client.data;

  const requests: RecordedRequest[] = [];
  const confirms: ConfirmCall[] = [];
  let confirmAnswer = true;

  const confirmDialogEl = elements.get("confirmDialog");
  if (confirmDialogEl) {
    confirmDialogEl.showModal = () => {
      confirmDialogEl.open = true;
      const msgEl = elements.get("confirmMessage");
      const msg = msgEl ? msgEl.textContent : "";
      confirms.push({ message: msg, answer: confirmAnswer });
      confirmDialogEl.returnValue = confirmAnswer ? "confirm" : "cancel";
      confirmDialogEl.open = false;
      fire(confirmDialogEl, "close");
    };
    confirmDialogEl.close = (val?: string) => {
      confirmDialogEl.open = false;
      if (val !== undefined) confirmDialogEl.returnValue = val;
      fire(confirmDialogEl, "close");
    };
  }

  const document = {
    getElementById(id: string): StubElement {
      const found = elements.get(id);
      if (!found) {
        throw new Error(
          `admin script asked for #${id}, which the page does not define. ` +
            `Add it to PAGE_IDS in tests/admin_script.ts if the page really has it.`,
        );
      }
      return found;
    },
    createElement(tag: string): StubElement {
      return makeElement(tag);
    },
  };

  // Two independent maps, exactly like a browser. Sharing one would make the
  // "clear the other store" behaviour untestable: every write would appear in
  // both, and unchecking the box would look like it forgot the token when it
  // had not (audio-feed-ndc).
  const makeStorage = (seed?: string | null) => {
    const map = new Map<string, string>();
    if (seed) map.set("audio-feed-admin-token", seed);
    return {
      map,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    };
  };
  const sessionStorage = makeStorage(options.storedToken);
  const localStorage = makeStorage(options.persistedToken);

  const navigator = { clipboard: { writeText: () => Promise.resolve() } };

  const confirmFn = (message: string): boolean => {
    confirms.push({ message, answer: confirmAnswer });
    return confirmAnswer;
  };

  const fetchFn = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    let parsed: unknown = null;
    if (typeof init.body === "string" && init.body.length > 0) {
      try {
        parsed = JSON.parse(init.body);
      } catch {
        parsed = init.body;
      }
    }
    requests.push({
      method,
      path,
      body: parsed,
      adminToken: headers["x-admin-token"] ?? null,
    });
    const answer = await options.respond(method, path, parsed);
    if (answer === null || answer === undefined) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  // Parameters shadow the globals of the same name, so the module sees the stubs
  // without any global mutation leaking into the test process. The client is plain
  // statements -- an ESM file with no import/export -- so a function body runs the
  // exact shipped bytes.
  const run = new Function(
    "document",
    "sessionStorage",
    "localStorage",
    "navigator",
    "confirm",
    "fetch",
    "setTimeout",
    client.source,
  );
  run(
    document,
    sessionStorage,
    localStorage,
    navigator,
    confirmFn,
    fetchFn,
    // Deferred UI touch-ups ("Copied" -> "Copy feed URL") must not outlive the test.
    () => 0,
  );

  const flush = async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };
  await flush();

  return {
    byId: (id) => document.getElementById(id),
    requests,
    confirms,
    setConfirmAnswer: (answer) => {
      confirmAnswer = answer;
    },
    buttons: (root, label) =>
      root.descendants().filter((el) => el.tag === "button" && el.textContent === label),
    flush,
    sessionStore: (key) => sessionStorage.getItem(key),
    localStore: (key) => localStorage.getItem(key),
  };
}
