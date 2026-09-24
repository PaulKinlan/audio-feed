/**
 * Harness that executes the admin console's real inline script (audio-feed-05b).
 *
 * Why this exists: the console's destructive actions are guarded by `confirm()`,
 * and the only test covering them asserted `assertStringIncludes(html, "confirm(")`.
 * That checks a string appears in the page. It cannot tell a guard from a
 * decoration -- a `confirm()` whose return value is discarded passes it, while
 * clicking Cancel deletes the feed anyway.
 *
 * So this runs the script that is actually served, against a stub DOM, with
 * `confirm` and `fetch` injected. Tests can then answer the only question that
 * matters: when the admin clicks Cancel, does the request go out?
 *
 * Deliberately NOT a refactor of `src/routes/admin.ts` into testable units. The
 * script is shipped as one inline block; a test of an extracted helper proves
 * the helper works, not that the page does. Testing the artifact cannot drift
 * from what subscribers' admins actually load.
 *
 * The stub DOM implements only what the script touches -- verified by reading
 * every `document.*`, element property and global out of the rendered script:
 *   document.getElementById / createElement
 *   textContent, className, type, value, disabled, hidden, readOnly, dataset,
 *   appendChild, append, replaceChildren, setAttribute, addEventListener,
 *   focus, select, scrollIntoView, reset, click
 *   sessionStorage, navigator.clipboard, confirm, setTimeout, fetch
 * If the script grows a new DOM call, this harness throws rather than silently
 * passing, which is the behaviour we want from a test double.
 *
 * Owned by: audio-feed-05b.
 */
import { renderAdminPage } from "../src/routes/admin.ts";

/** Every id the served page defines, so `getElementById` resolves like a browser. */
const PAGE_IDS = [
  "adminToken",
  "authFeedback",
  "usersFeedback",
  "usersBody",
  "usersCaption",
  "created",
  "loadUsers",
  "createForm",
  "saveToken",
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
];

export interface StubElement {
  tag: string;
  id: string;
  textContent: string;
  className: string;
  type: string;
  value: string;
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
  focus(): void;
  select(): void;
  scrollIntoView(): void;
  reset(): void;
  click(): unknown;
  /** Fire a submit listener, as pressing the form's submit button would. */
  submit(): unknown;
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
}

/** Pull the inline script out of the page exactly as a browser would. */
export function adminScriptSource(publicBaseUrl = "https://audio.example.com"): string {
  const html = renderAdminPage({ publicBaseUrl, adminConfigured: true });
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match || !match[1]) throw new Error("admin page has no inline script");
  return match[1];
}

/**
 * Render the admin page, then run its script against a stub DOM.
 *
 * Returns once the script's synchronous body has run and the initial
 * `loadUsers()` (if a token was stored) has settled.
 */
export async function runAdminScript(options: HarnessOptions): Promise<AdminHarness> {
  const publicBaseUrl = options.publicBaseUrl ?? "https://audio.example.com";
  const elements = new Map<string, StubElement>();
  for (const id of PAGE_IDS) elements.set(id, makeElement("div", id));

  const requests: RecordedRequest[] = [];
  const confirms: ConfirmCall[] = [];
  let confirmAnswer = true;

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

  const store = new Map<string, string>();
  if (options.storedToken) store.set("audio-feed-admin-token", options.storedToken);
  const sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };

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

  // Parameters shadow the globals of the same name, so the script sees the stubs
  // without any global mutation leaking into the test process.
  const run = new Function(
    "document",
    "sessionStorage",
    "navigator",
    "confirm",
    "fetch",
    "setTimeout",
    adminScriptSource(publicBaseUrl),
  );
  run(
    document,
    sessionStorage,
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
  };
}
