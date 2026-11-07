/**
 * PWA surface: service worker, manifest and icon as ROUTES (audio-feed-4xb).
 *
 * This app has no static-file pipeline — every page is a self-contained document
 * rendered by a route (see home.ts, admin.ts, listen.ts) — so `/sw.js`,
 * `/manifest.json` and the icon are routes too. Dropping files in a `public/` dir
 * would quietly do nothing, which is the kind of "it looks wired" mistake this
 * codebase has been bitten by before.
 *
 * The service worker's strategy, and why:
 *
 * - AUDIO is cache-first. The offline cache is the whole point of the feature, so
 *   a downloaded episode must be served from it without a network round trip, and
 *   the player needs no separate offline mode: the same URL simply resolves.
 * - NAVIGATIONS are network-first, falling back to the cached page. A podcast's
 *   episode list changes; serving a stale shell to an online user would hide new
 *   episodes, while an offline user needs the last good page. Network-first is the
 *   only order that gives both.
 * - The MANIFEST and ICON are cache-first: they change rarely and are needed for
 *   install prompts offline.
 * - Nothing else is intercepted. Caching API responses here would create a second,
 *   invisible source of truth for the episode list and for admin data.
 */
import type { RouteContext } from "../router.ts";
import type { AppContext } from "../app.ts";

/** Must match the cache name the player writes downloads into. */
export const OFFLINE_CACHE = "audio-feed-offline-v1";
export const SHELL_CACHE = "audio-feed-shell-v2";

/**
 * Path prefixes excluded from service worker SHELL_CACHE caching (audio-feed-s3f0, audio-feed-9ooyy).
 *
 * Capability-bearing URLs (e.g. /listen/:token), authenticated administration
 * views (e.g. /admin, /account), auth endpoints (/login), bookmarks (/add),
 * and subscriber feeds (/feed/) contain secrets or subscriber-specific data that
 * must never be persisted in Cache Storage.
 *
 * This prefix list acts as an admission refuse guard inside the service worker's
 * fetch listener (alongside Cache-Control: no-store / private headers). Because
 * sensitive responses are strictly excluded at admission time, SHELL_CACHE contains
 * only install-critical shell assets (manifest, icon) and public fallback documents;
 * SHELL_CACHE therefore safely survives user sign-out without leaking authenticated data,
 * preserving offline installability without needing a full shell purge.
 */
export const SENSITIVE_PREFIXES = [
  "/admin",
  "/account",
  "/listen",
  "/login",
  "/share",
  "/feed",
  "/add",
] as const;

/**
 * Maximum total bytes retained in the offline audio cache (audio-feed-cby).
 *
 * DERIVATION:
 * 640 MiB ~ 3.9 h of audio at 48,000 B/s, ~61% of a 1 GB quota, so shell cache +
 * responses + IndexedDB fit with headroom, and even one worst-case 64-segment
 * episode cannot blow the quota.
 * NOTE: a maximum-size episode (64 segments, ~580 MB) is ~91% of the 640 MiB budget,
 * so the bound only has real headroom once an episode size cap exists.
 */
export const MAX_OFFLINE_BYTES = 640 * 1024 * 1024;

/**
 * Maximum number of episodes retained in the offline audio cache as a secondary guard.
 */
export const MAX_OFFLINE_EPISODES = 20;

export const MANIFEST = {
  name: "Audio Feed",
  short_name: "AudioFeed",
  description: "Your RSS articles, read aloud: direct reads and two-voice deep dives.",
  start_url: "/listen",
  scope: "/",
  display: "standalone",
  theme_color: "#18181b",
  background_color: "#09090b",
  icons: [
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
  ],
  shortcuts: [{ name: "Listen", url: "/listen" }],
  // TODO(baseline/app-share-targets): web app manifest share_target is supported in Chrome/Edge, awaiting Firefox/Safari for Baseline
  share_target: {
    action: "/share",
    method: "GET",
    params: {
      title: "title",
      text: "text",
      url: "url",
    },
  },
};

/** A dark, rounded podcast mark: concentric "sound" arcs over a filled circle. */
export const ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Audio Feed">
  <rect width="512" height="512" rx="112" fill="#18181b"/>
  <circle cx="256" cy="256" r="58" fill="#a78bfa"/>
  <g fill="none" stroke="#a78bfa" stroke-width="26" stroke-linecap="round" opacity="0.85">
    <path d="M150 176a150 150 0 0 0 0 160"/>
    <path d="M362 176a150 150 0 0 1 0 160"/>
  </g>
  <g fill="none" stroke="#a78bfa" stroke-width="22" stroke-linecap="round" opacity="0.5">
    <path d="M96 132a190 190 0 0 0 0 248"/>
    <path d="M416 132a190 190 0 0 1 0 248"/>
  </g>
</svg>
`;

const javascript = (body: string, cacheControl: string) =>
  new Response(body, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": cacheControl,
      // The worker is served from the root, so its default scope is already "/";
      // the header is explicit so a future move of this route cannot silently
      // narrow the scope to the script's own path.
      "service-worker-allowed": "/",
      "referrer-policy": "no-referrer",
    },
  });

/** `GET /sw.js` — served `no-cache` so a deploy's new worker is actually picked up. */
export function handleServiceWorker(_ctx: RouteContext<AppContext>): Response {
  const body = `/* Audio Feed service worker (audio-feed-4xb). Generated by src/routes/pwa.ts. */
"use strict";
const SHELL_CACHE = ${JSON.stringify(SHELL_CACHE)};
const OFFLINE_CACHE = ${JSON.stringify(OFFLINE_CACHE)};
const MAX_OFFLINE_BYTES = ${MAX_OFFLINE_BYTES};
const MAX_OFFLINE_EPISODES = ${MAX_OFFLINE_EPISODES};
const PRECACHE = ["/manifest.json", "/icon.svg"];
const SENSITIVE_PREFIXES = ${JSON.stringify(SENSITIVE_PREFIXES)};

/**
 * Bound the offline audio cache by bytes (primary, MAX_OFFLINE_BYTES) and entry count
 * (secondary guard, MAX_OFFLINE_EPISODES) so it cannot grow without limit (audio-feed-cby).
 *
 * SIZE DERIVATION:
 * 640 MiB ~ 3.9 h of audio at 48,000 B/s, ~61% of a 1 GB quota, so shell cache +
 * responses + IndexedDB fit with headroom, and even one worst-case 64-segment
 * episode cannot blow the quota.
 * NOTE: a maximum-size episode (64 segments, ~580 MB) is ~91% of the 640 MiB budget,
 * so the bound only has real headroom once an episode size cap exists.
 *
 * SIZE DETERMINATION:
 * Size is obtained from the Content-Length header on the stored response when present
 * and valid. When Content-Length is absent, we clone the response and buffer it to get
 * the body's byteLength. If the size is still indeterminable or not positive, that ONE
 * entry is dropped: an entry whose size cannot be known cannot be counted against a
 * byte budget, so it cannot be kept (charging MAX_OFFLINE_BYTES here would let a
 * single bad response evict the entire library, over and over).
 *
 * EVICTION & PROTECTION SEMANTICS:
 * Evicts oldest-first by x-stored-at timestamp header (falling back to Date header or
 * insertion order) until total bytes <= MAX_OFFLINE_BYTES and total entries <= MAX_OFFLINE_EPISODES.
 * Stops when only protected entries remain.
 *
 * Note: The service worker does not have direct access to client DOM/audio element state
 * to identify an actively playing episode, so protection is limited to the entries passed in
 * protectedUrls (the just-written entry/batch). It does not pretend to protect playing audio it cannot inspect.
 *
 * KNOWN LIMITATION OF TIMESTAMP ORDERING:
 * A future x-stored-at (clock skew or legacy entry) makes an entry sort newest and effectively
 * immortal until 20 fresher writes accumulate.
 *
 * Only touches OFFLINE_CACHE; never touches SHELL_CACHE.
 *
 * @param {Cache} cache
 * @param {string[] | Set<string> | string} [protectedUrls]
 * @param {number} [maxBytes]
 * @param {number} [maxEntries]
 */
async function boundOfflineAudio(cache, protectedUrls = [], maxBytes = MAX_OFFLINE_BYTES, maxEntries = MAX_OFFLINE_EPISODES) {
  const requests = await cache.keys();
  if (requests.length === 0) return;

  const protectedSet = new Set();
  if (protectedUrls) {
    if (typeof protectedUrls === "string") {
      protectedSet.add(protectedUrls);
    } else if (Symbol.iterator in Object(protectedUrls)) {
      for (const u of protectedUrls) if (u) protectedSet.add(u);
    }
  }

  const measured = await Promise.all(
    requests.map(async (req, index) => {
      const res = await cache.match(req);
      const url = typeof req === "string" ? req : req.url;

      const rawStored = res?.headers?.get("x-stored-at");
      const storedAt = rawStored ? Number(rawStored) : NaN;
      let timestamp = Number.isFinite(storedAt) ? storedAt : NaN;
      if (!Number.isFinite(timestamp)) {
        const rawDate = res?.headers?.get("date");
        timestamp = rawDate ? Date.parse(rawDate) : NaN;
      }

      let size = NaN;
      // LIMITATION (report-only): Content-Length is used verbatim and never cross-checked
      // against the buffered body, so an understated header understates the total and
      // silently violates the bound.
      const cl = res?.headers?.get("content-length");
      if (cl) {
        const parsed = Number(cl);
        if (Number.isFinite(parsed) && parsed >= 0) {
          size = parsed;
        }
      }
      if (!Number.isFinite(size) && res) {
        try {
          if (typeof res.clone === "function") {
            const buf = await res.clone().arrayBuffer();
            size = buf.byteLength;
          } else if (typeof res.arrayBuffer === "function") {
            const buf = await res.arrayBuffer();
            size = buf.byteLength;
          }
        } catch {
          // unable to buffer clone
        }
      }
      if (!Number.isFinite(size) || size <= 0) {
        // If its size cannot be known, it cannot be counted — drop ONLY this entry and
        // say so. Never charge MAX_OFFLINE_BYTES here: one unmeasurable entry would then
        // alone exceed the budget and each following bound would evict the whole library.
        console.warn("boundOfflineAudio: dropped unmeasurable entry (size unknown):", url);
        await cache.delete(req);
        return null;
      }

      return {
        req,
        url,
        size,
        time: Number.isFinite(timestamp) ? timestamp : index,
        index,
      };
    }),
  );
  const entries = measured.filter((entry) => entry !== null);

  let totalBytes = entries.reduce((acc, e) => acc + e.size, 0);
  let totalEntries = entries.length;

  if (totalBytes <= maxBytes && totalEntries <= maxEntries) return;

  const evictable = entries.filter((e) => !protectedSet.has(e.url));
  // Oldest first: lowest timestamp. Ties broken by insertion order (index).
  evictable.sort((a, b) => a.time - b.time || a.index - b.index);

  for (const target of evictable) {
    if (totalBytes <= maxBytes && totalEntries <= maxEntries) {
      break;
    }
    await cache.delete(target.req);
    totalBytes -= target.size;
    totalEntries -= 1;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) =>
        Promise.all(
          names
            // Only clean caches this worker owns. The CURRENT offline audio cache
            // survives an update — it is the subscriber's own downloaded library —
            // but superseded generations of either family are swept on activate, so
            // a future version bump cannot leave an old generation installed
            // forever (audio-feed-vnu4g).
            .filter((name) =>
              (name.startsWith("audio-feed-shell-") || name.startsWith("audio-feed-offline-")) &&
              name !== SHELL_CACHE && name !== OFFLINE_CACHE
            )
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Sign-out and token rotation purge the downloaded library (audio-feed-vnu4g).
  // "The offline cache must survive an update" is not "must survive sign-out": on a
  // shared device, a former subscriber's episodes must not linger after the server
  // has ended the session or rotated the feed token. The request passes through
  // untouched, and the cache is deleted only after a CONFIRMED outcome — a 2xx for
  // the JSON calls, or the no-script form logout's 303, which fetch() follows and
  // reports as a redirected response. A failed call must change nothing.
  //
  // SHELL_CACHE deliberately survives sign-out (audio-feed-9ooyy). Because the
  // admission gate below (isSensitive via SENSITIVE_PREFIXES and Cache-Control: no-store/private)
  // strictly refuses to cache any authenticated, capability-bearing, or user-specific
  // routes (/admin, /account, /listen, /login, /share, /feed, /add), SHELL_CACHE only holds
  // install-critical shell assets (manifest, icon) and unauthenticated public navigation shells.
  // Purging SHELL_CACHE on logout would unnecessarily destroy the offline app shell for
  // subsequent users on a shared device without providing any security gain.
  if (
    request.method === "POST" && url.origin === self.location.origin &&
    (url.pathname === "/api/auth/logout" || url.pathname === "/api/account/rotate-token")
  ) {
    event.respondWith(
      (async () => {
        const response = await fetch(request);
        if (response.ok || response.redirected || response.status === 303) {
          // Swallowing a failed delete is correct here, not careless: the session is
          // already ended server-side by the time this runs, so failing the
          // navigation would misreport the outcome — the user would see a network
          // error for a sign-out that WORKED. Worst case is a stale library left
          // behind until the device next connects.
          await caches.delete(OFFLINE_CACHE).catch(() => {});
        }
        return response;
      })(),
    );
    return;
  }
  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // Downloaded audio: serve from cache first, so an offline episode plays from the
  // same URL it streams from when online.
  if (url.pathname.startsWith("/audio/")) {
    event.respondWith(
      (async () => {
        const offline = await caches.open(OFFLINE_CACHE);
        const cached = await offline.match(request);
        if (cached) return cached;
        try {
          return await fetch(request);
        } catch (error) {
          // This handler used to answer EVERY failure with "not downloaded for
          // offline listening", which is a diagnosis it has no evidence for. In
          // production the real fault was a CORS block on a redirect to R2, and
          // this message sent the investigation to the offline cache instead --
          // the thing that WAS working. A fetch() here rejects for any network
          // reason: offline, DNS, TLS, a blocked cross-origin response.
          //
          // So it now reports what it knows (the request failed, and whether the
          // browser believes it is offline) rather than guessing why.
          const offlineNow = typeof navigator !== "undefined" && navigator.onLine === false;
          const detail = String((error && error.message) || error);
          return new Response(
            offlineNow
              ? "You are offline and this episode has not been downloaded. " +
                "Download it while online to listen offline."
              : "Could not load this episode's audio: " + detail +
                ". The episode is not saved on this device, so it needs the network.",
            {
              status: 503,
              headers: {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store",
              },
            },
          );
        }
      })(),
    );
    return;
  }

  // Navigations: network first so new episodes appear, cache when offline.
  // Capability-bearing URLs (e.g. /listen/:token) and authenticated views
  // (e.g. /admin, /account) carry secrets and subscriber data that must not
  // linger in Cache Storage across logout or token rotation (audio-feed-s3f0).
  // The service worker respects Cache-Control: no-store / private, alongside
  // an explicit path exclusion for capability and authenticated routes (audio-feed-9ooyy).
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok) {
            const cc = (fresh.headers.get("cache-control") || "").toLowerCase();
            const isNoStore = cc.includes("no-store") || cc.includes("private");
            const isSensitive = SENSITIVE_PREFIXES.some((prefix) =>
              url.pathname.startsWith(prefix)
            );
            if (!isNoStore && !isSensitive) {
              const shell = await caches.open(SHELL_CACHE);
              await shell.put(request, fresh.clone());
            }
          }
          return fresh;
        } catch {
          const shell = await caches.open(SHELL_CACHE);
          const cached = await shell.match(request);
          return (
            cached ||
            new Response(
              "<!doctype html><meta charset=utf-8><title>Offline</title>" +
                "<style>body{font-family:system-ui;background:#09090b;color:#fafafa;padding:2rem}</style><body>" +
                "<h1>Offline</h1><p>Open this app once while online, then use the Download button " +
                "on an episode to listen offline.</p></body></html>",
              { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
            )
          );
        }
      })(),
    );
    return;
  }

  // Install-critical, rarely changing assets.
  if (url.pathname === "/manifest.json" || url.pathname === "/icon.svg") {
    event.respondWith(
      (async () => {
        const shell = await caches.open(SHELL_CACHE);
        const cached = await shell.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        if (fresh.ok) await shell.put(request, fresh.clone());
        return fresh;
      })(),
    );
  }
});

// Background Fetch, all three events (audio-feed-rqp).
//
// audio-feed-4xb wired only the success handler and the page never started a
// fetch, because the API measured as non-functional. Re-measured against a real
// origin it works end to end, and audio-feed-98i carries the correction.
//
// An earlier version of this comment blamed headless Chrome for the original
// finding. That mechanism was wrong and is retracted: headless Chrome 152 on a
// real origin has a service worker and completes a background fetch. The API
// looks broken because getIds() is empty BOTH when nothing registered and when
// a fetch has finished, and because only the first fetch per origin is
// permitted (audio-feed-zlf) — a refused attempt resolves and never lists.
self.addEventListener("backgroundfetchsuccess", (event) => {
  event.waitUntil(
    (async () => {
      const offline = await caches.open(OFFLINE_CACHE);
      const records = await event.registration.matchAll();
      // audio-feed-i6eg: the browser downloaded these records in parallel, so resolve and
      // store them the same way instead of one at a time. The batch is bounded (and each
      // write is a local cache write): one serial responseReady await and cache write per
      // record made the notification — the only surface left once the tab is closed — wait
      // on the sum of every write. Each record still stores independently: one that did
      // not finish, or failed, contributes 0 and caches nothing.
      const STORE_BATCH = 4;
      let stored = 0;
      const storedUrls = [];
      for (let at = 0; at < records.length; at += STORE_BATCH) {
        const batch = records.slice(at, at + STORE_BATCH);
        const resolved = await Promise.all(
          batch.map(async (record) => {
            const response = await record.responseReady;
            return { record, response };
          }),
        );
        for (const { record, response } of resolved) {
          if (response && response.ok) {
            const headers = new Headers(response.headers);
            headers.set("x-stored-at", String(Date.now()));
            const stamped = new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
            await offline.put(record.request, stamped);
            storedUrls.push(
              typeof record.request === "string" ? record.request : record.request.url,
            );
            stored += 1;
          }
        }
      }
      // Bound ONCE after the whole batch, protecting EVERY URL this batch wrote. Calling
      // it per record ran a full keys()+match() pass per entry (O(N^2) over the cache) and
      // let each pass protect only its own record, so an earlier batch member could be
      // evicted by a later sibling's pass.
      if (storedUrls.length > 0) {
        await boundOfflineAudio(offline, storedUrls);
      }
      // The OS notification is the only surface a subscriber sees once the tab is
      // closed, so it states the outcome rather than staying on "downloading".
      if (event.updateUI) {
        await event.updateUI({
          title: stored === 1 ? "Episode ready offline" : stored + " episodes ready offline",
        });
      }
    })(),
  );
});

// A failed or aborted fetch caches NOTHING, deliberately. Background Fetch can
// deliver partial records, and a half-written episode would be indistinguishable
// from a complete one at playback time: the player's whole "is it downloaded?"
// test is the presence of the URL in this cache. A truncated file that plays and
// stops is worse than an absent one the page can retry in the foreground.
self.addEventListener("backgroundfetchfail", (event) => {
  event.waitUntil(
    (async () => {
      if (event.updateUI) {
        await event.updateUI({ title: "Download failed — open Audio Feed to retry" });
      }
    })(),
  );
});

// Tapping the OS download notification belongs in the player, not a new tab: an
// already-open listener is focused rather than duplicated, because two copies of
// this page means two <audio> elements and two media sessions.
self.addEventListener("backgroundfetchclick", (event) => {
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of open) {
        if (client.url.includes("/listen")) return client.focus();
      }
      return self.clients.openWindow("/listen");
    })(),
  );
});
`;
  return javascript(body, "no-cache");
}

/** `GET /manifest.json` — installability metadata. */
export function handleManifest(_ctx: RouteContext<AppContext>): Response {
  return new Response(JSON.stringify(MANIFEST, null, 2) + "\n", {
    headers: {
      "content-type": "application/manifest+json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

/** `GET /icon.svg` — the app icon, as a route so no binary lives in the repo. */
export function handleIcon(_ctx: RouteContext<AppContext>): Response {
  return new Response(ICON_SVG, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}

/**
 * `GET /robots.txt` (audio-feed-0mv, audio-feed-nnek, audio-feed-qk63, audio-feed-nyih).
 *
 * Effective deindexing: capability routes like `/feed/` and `/listen/` are NOT disallowed
 * here so that search crawlers can fetch them, observe the `X-Robots-Tag: noindex`
 * header (and HTML meta noindex), and drop the URL from search indexes completely
 * (a robots.txt Disallow prevents crawlers from reading HTTP response headers, allowing
 * bare URLs to be indexed from inbound links).
 */
export const ROBOTS_TXT = `User-agent: *
Disallow: /admin
Disallow: /api/
Allow: /
Allow: /assets/
`;

export function handleRobots(_ctx: RouteContext<AppContext>): Response {
  return new Response(ROBOTS_TXT, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
