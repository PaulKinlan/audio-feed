/**
 * Harness that executes the real service worker script (audio-feed-qn5).
 *
 * Why this exists: the Background Fetch handlers were pinned by
 * `assertStringIncludes(sw, "backgroundfetchsuccess")` — a check that a string
 * appears in the generated script. That passes for a handler that is registered and
 * empty, for one whose body throws once it runs, and for a reorder that keeps the
 * strings. It is the same class of defect as audio-feed-05b, where `confirm()` was
 * pinned by `assertStringIncludes(html, "confirm(")` while its discarded answer let
 * Cancel delete the feed anyway.
 *
 * So this evaluates the script that is actually SERVED, with `self`, `caches` and
 * the notification UI injected, and the tests dispatch the real lifecycle events.
 * The stub implements only what these handlers touch; a call it does not implement
 * throws rather than silently passing, which is the behaviour a test double should
 * have.
 *
 * Deliberately NOT a refactor of `src/routes/pwa.ts` into importable handler
 * functions. The worker ships as one string; a test of an extracted helper proves
 * the helper works, not that the served worker does. Testing the artifact cannot
 * drift from what a subscriber's browser runs.
 *
 * `dispatch` fails when no handler of that name was registered, and reports how many
 * `waitUntil` promises the handler registered — zero means it returned without
 * extending the event's lifetime, which a string assertion cannot tell you.
 */

export interface BackgroundFetchRecordStub {
  request: Request;
  responseReady: Promise<Response>;
}

export interface ServiceWorkerHarness {
  /** Dispatch one event and settle every `waitUntil` promise it registered. */
  dispatch(
    name: string,
    event?: Record<string, unknown>,
  ): Promise<{ waits: number }>;
  /** URLs present in one cache, in insertion order. */
  cachedUrls(cacheName: string): string[];
  /** Notification updates the worker asked for, in order. */
  updates: Array<Record<string, unknown>>;
  /** Windows the worker focused, in order. */
  focused: string[];
  /** URLs the worker opened, in order. */
  opened: string[];
  /** Windows `clients.matchAll` reports. Assign to model an open player. */
  openClients: Array<{ url: string; focus(): Promise<void> }>;
}

interface StubCache {
  put(request: Request | string, response: Response): Promise<void>;
  match(request: Request | string): Promise<Response | undefined>;
  addAll(urls: string[]): Promise<void>;
}

const keyOf = (request: Request | string): string =>
  typeof request === "string" ? request : request.url;

export function createServiceWorkerHarness(script: string): ServiceWorkerHarness {
  const cachesByName = new Map<string, Map<string, Response>>();

  const openCache = (name: string): Promise<StubCache> => {
    let entries = cachesByName.get(name);
    if (!entries) {
      entries = new Map();
      cachesByName.set(name, entries);
    }
    const cache = entries;
    return Promise.resolve({
      put: (request, response) => {
        cache.set(keyOf(request), response);
        return Promise.resolve();
      },
      match: (request) => Promise.resolve(cache.get(keyOf(request))),
      addAll: (urls) => {
        for (const url of urls) cache.set(url, new Response(null, { status: 200 }));
        return Promise.resolve();
      },
    });
  };

  const cachesStub = {
    open: openCache,
    keys: () => Promise.resolve([...cachesByName.keys()]),
    delete: (name: string) => Promise.resolve(cachesByName.delete(name)),
  };

  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const updates: Array<Record<string, unknown>> = [];
  const focused: string[] = [];
  const opened: string[] = [];

  const harness: ServiceWorkerHarness = {
    updates,
    focused,
    opened,
    openClients: [],
    cachedUrls: (cacheName) => [...(cachesByName.get(cacheName)?.keys() ?? [])],
    dispatch: async (name, event = {}) => {
      const handlers = listeners.get(name);
      if (!handlers || handlers.length === 0) {
        throw new Error(
          `the served service worker registers no "${name}" handler; ` +
            `registered: ${[...listeners.keys()].join(", ") || "(none)"}`,
        );
      }
      const waits: Array<Promise<unknown>> = [];
      const target: Record<string, unknown> = {
        ...event,
        waitUntil: (promise: Promise<unknown>) => {
          waits.push(promise);
        },
        updateUI: (update: Record<string, unknown>) => {
          updates.push(update);
          return Promise.resolve();
        },
      };
      for (const handler of handlers) handler(target);
      await Promise.all(waits);
      return { waits: waits.length };
    },
  };

  const selfStub = {
    location: {
      origin: "https://audio.example.com",
      href: "https://audio.example.com/sw.js",
    },
    addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
    },
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(harness.openClients),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve(null);
      },
    },
  };

  // Parameters shadow the globals of the same name, so the served script sees the
  // stubs without mutating anything in the test process.
  const run = new Function("self", "caches", script);
  run(selfStub, cachesStub);

  return harness;
}
