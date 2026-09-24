import { deepStrictEqual, equal, match, rejects, throws } from "node:assert/strict";
import { request as httpRequest } from "node:http";
import {
  articleUrl,
  audioPayload,
  createUrlIngestHandler,
  extractArticle,
  fetchArticle,
  IngestError,
  isPublicAddress,
  publicLookup,
} from "../src/ingest/url.ts";
import type { AudioMode, User } from "../src/types.ts";

const fixture = (name: string) =>
  Deno.readTextFile(new URL(`./fixtures/${name}.html`, import.meta.url));
const html = await fixture("article");
const source = "https://example.com/article";
const approved: User = {
  id: "approved-user",
  email: "listener@example.com",
  displayName: "Listener",
  status: "approved",
  isAdmin: false,
  createdAt: "2026-09-24T00:00:00Z",
  feedToken: "token-approved-user",
};
const article = extractArticle(html, source);
const htmlResponse = (body = html) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const post = (body: unknown) =>
  new Request("http://localhost/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

Deno.test("extracts title, author, date, actual lead and complete clean body", () => {
  equal(article.title, "Why small libraries last");
  equal(article.author, "Alex Reader");
  equal(article.publishedAt, "2026-09-23T08:30:00.000Z");
  match(article.lead, /^Small libraries earn trust/);
  match(article.body, /Tom & Jerry/);
  match(article.body, /Full reads should include/);
  match(article.body, /Keep the result readable/);
  match(article.body, /\n\n/);
  for (
    const noise of [
      "SPONSOR",
      "tracking cookies",
      "Subscribe",
      "RELATED STORY",
      "HIDDEN",
      "Privacy policy",
      "__articleScriptRan",
      "<p>",
    ]
  ) {
    equal(article.body.includes(noise), false, noise);
  }
  equal("__articleScriptRan" in globalThis, false);
});

Deno.test("source wrapping and inline links do not become spurious paragraph breaks", () => {
  const wrapped = html.replace("Small libraries", "Small\n libraries")
    .replace("trust", "<a href='/trust'>trust</a>");
  equal(wrapped === html, false);
  const result = extractArticle(wrapped, source);
  equal(result.lead, article.lead);
  equal(result.body, article.body);
});

Deno.test("a section h1 cannot replace the article metadata title", () => {
  const result = extractArticle(html.replace("<article>", "<article><h1>LTS</h1>"), source);
  equal(result.title, article.title);
});

Deno.test("JSON-LD supplies metadata but description is not substituted for the lead", async () => {
  const result = extractArticle(await fixture("structured-article"), source);
  equal(result.title, "A useful discovery");
  equal(result.author, "Sam Writer, Jo Editor");
  equal(result.publishedAt, "2026-09-22");
  match(result.lead, /^The first real paragraph/);
  match(result.body, /its caveats/);
});

Deno.test("missing metadata stays unknown; malformed date is not narrated", () => {
  const result = extractArticle(
    html.replace(/<meta name="author"[^>]+>/, "").replace(/<p class="byline">.*?<\/p>/, "").replace(
      "2026-09-23T09:30:00+01:00",
      "not-a-date",
    ),
    source,
  );
  equal(result.author, null);
  equal(result.publishedAt, null);
});

Deno.test("paywall-only and script-only pages fail rather than narrating chrome", () => {
  throws(
    () =>
      extractArticle(
        "<html><head><title>App</title></head><body><script>loadArticle()</script></body></html>",
        source,
      ),
    IngestError,
  );
  throws(
    () =>
      extractArticle(
        Deno.readTextFileSync(new URL("./fixtures/paywall.html", import.meta.url)),
        source,
      ),
    IngestError,
  );
});

Deno.test("direct payload includes full article once; deep dive preserves grounded input", () => {
  const direct = audioPayload(article, "direct");
  if (direct.mode !== "direct") throw new Error("wrong mode");
  match(direct.narration, /By Alex Reader/);
  match(direct.narration, /Published 2026/);
  equal(direct.narration.split(article.lead).length, 2);
  equal(direct.narration.endsWith(article.body), true);
  deepStrictEqual(audioPayload(article, "deepdive"), { mode: "deepdive", article });
});

Deno.test("rejects non-web, credentialed, unusual-port and local literal URL forms", () => {
  for (
    const url of [
      "file:///etc/passwd",
      "ftp://example.com/a",
      "data:text/html,hello",
      "https://user:pass@example.com/a",
      "http://example.com:8080/",
      "http://localhost/",
      "http://localhost./",
      "http://app.local/",
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://169.254.169.254/",
      "http://10.0.0.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "not a URL",
    ]
  ) {
    throws(() => articleUrl(url), IngestError, url);
  }
  equal(articleUrl(`${source}#section`).href, source);
  equal(articleUrl("https://example.com:443/a").href, "https://example.com/a");
});

Deno.test("public-address policy refuses non-global ranges, including IPv6 transition networks", () => {
  for (
    const address of [
      "0.0.0.0",
      "10.2.3.4",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.0.1",
      "192.0.2.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "::ffff:8.8.8.8",
      "64:ff9b::a00:1",
      "2002:7f00:1::",
      "2001:db8::1",
    ]
  ) {
    equal(isPublicAddress(address), false, address);
  }
  equal(isPublicAddress("8.8.8.8"), true);
  equal(isPublicAddress("2606:4700:4700::1111"), true);
});

Deno.test("socket DNS callback validates every address and pins the returned results", async () => {
  let calls = 0;
  const addresses = [{ address: "8.8.8.8", family: 4 }, {
    address: "2606:4700:4700::1111",
    family: 6,
  }];
  const safe = publicLookup(() => {
    calls++;
    return Promise.resolve(addresses);
  });
  const actual = await new Promise((resolve, reject) =>
    safe("example.com", { all: true }, (error, address) => error ? reject(error) : resolve(address))
  );
  deepStrictEqual(actual, addresses);
  equal(calls, 1);
  for (
    const values of [[], [{ address: "127.0.0.1", family: 4 }], [...addresses, {
      address: "fc00::1",
      family: 6,
    }]]
  ) {
    const lookup = publicLookup(() => Promise.resolve(values));
    await rejects(
      () =>
        new Promise((resolve, reject) =>
          lookup(
            "example.com",
            { all: true },
            (error, address) => error ? reject(error) : resolve(address),
          )
        ),
      IngestError,
    );
  }
});

Deno.test("Deno node:http honors lookup on the actual connection (no silent native re-resolution)", async () => {
  let connections = 0;
  let calls = 0;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () => {
    connections++;
    return new Response("lookup honored");
  });
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const request = httpRequest(`http://lookup-probe.invalid:${server.addr.port}`, {
        agent: false,
        lookup: (_hostname, options, callback) => {
          calls++;
          if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        },
      }, (response) => {
        let text = "";
        response.on("data", (chunk) => text += chunk);
        response.on("end", () => resolve(text));
      });
      request.on("error", reject);
      request.end();
    });
    equal(body, "lookup honored");
    equal(calls, 1);
    equal(connections, 1);
    await rejects(() =>
      new Promise((resolve, reject) => {
        const request = httpRequest(`http://blocked-probe.invalid:${server.addr.port}`, {
          agent: false,
          lookup: publicLookup(() => Promise.resolve([{ address: "127.0.0.1", family: 4 }])),
        }, resolve);
        request.on("error", reject);
        request.end();
      }), /public addresses/);
    equal(connections, 1, "rejected DNS results must not create a second connection");
  } finally {
    await server.shutdown();
  }
});

Deno.test("fetch follows a relative redirect and records the final public URL", async () => {
  const visits: string[] = [];
  const result = await fetchArticle(source, {
    transport: (url) => {
      visits.push(url.href);
      return Promise.resolve(
        visits.length === 1
          ? new Response(null, { status: 302, headers: { location: "/final" } })
          : htmlResponse(),
      );
    },
  });
  deepStrictEqual(visits, [source, "https://example.com/final"]);
  equal(result.url, "https://example.com/final");
});

Deno.test("fetch refuses redirect-to-private before a second request and bounds loops", async () => {
  let calls = 0;
  await rejects(() =>
    fetchArticle(source, {
      transport: () => {
        calls++;
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          }),
        );
      },
    }), IngestError);
  equal(calls, 1);
  calls = 0;
  await rejects(() =>
    fetchArticle(source, {
      transport: () => {
        calls++;
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: "/again" } }),
        );
      },
    }), /redirect chain/);
  equal(calls, 6);
});

Deno.test("fetch refuses upstream errors, non-HTML, compression and oversize bodies", async () => {
  for (
    const response of [
      new Response("private", { status: 403 }),
      new Response("pdf", { headers: { "content-type": "application/pdf" } }),
      new Response("gzip", {
        headers: { "content-type": "text/html", "content-encoding": "gzip" },
      }),
      new Response(html, { headers: { "content-type": "text/html", "content-length": "3000000" } }),
      htmlResponse("x".repeat(2 * 1024 * 1024 + 1)),
    ]
  ) {
    await rejects(
      () => fetchArticle(source, { transport: () => Promise.resolve(response) }),
      IngestError,
    );
  }
});

Deno.test("fetch deadline cancels a slow transport", async () => {
  await rejects(
    () =>
      fetchArticle(source, {
        timeoutMs: 10,
        transport: (_url, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          ),
      }),
    (error: unknown) => error instanceof IngestError && error.status === 504,
  );
});

Deno.test("endpoint returns 202 only after queueing to authenticated user in either mode", async () => {
  const queued: { article: typeof article; mode: AudioMode; user: User }[] = [];
  const handler = createUrlIngestHandler({
    authorize: () => Promise.resolve(approved),
    fetchArticle: (url) => {
      equal(url, source);
      return Promise.resolve(article);
    },
    enqueue: (input) => {
      queued.push(input);
      return Promise.resolve({ articleId: "article-1", episodeId: "episode-1" });
    },
  });
  for (const mode of ["direct", "deepdive"] as const) {
    const response = await handler(post({ url: source, mode, userId: "attacker" }));
    equal(response.status, 202);
    const data = await response.json();
    equal(data.status, "queued");
    equal(data.episodeId, "episode-1");
    equal(data.articleId, "article-1");
    equal(data.mode, mode);
    equal(queued.at(-1)?.user.id, "approved-user");
    equal(queued.at(-1)?.mode, mode);
  }
  equal(queued.length, 2);
});

Deno.test("authorization refusal occurs before fetch and enqueue", async () => {
  let touched = false;
  const handler = createUrlIngestHandler({
    authorize: () => Promise.resolve(new Response("approval required", { status: 403 })),
    fetchArticle: () => {
      touched = true;
      return Promise.resolve(article);
    },
    enqueue: () => {
      touched = true;
      return Promise.resolve({ articleId: "not-allowed", episodeId: "not-allowed" });
    },
  });
  equal((await handler(post({ url: source }))).status, 403);
  equal(touched, false);
});

Deno.test("pending and suspended users are refused even when identity resolver succeeds", async () => {
  let touched = false;
  for (const status of ["pending", "suspended"] as const) {
    for (const role of ["admin", "user"] as const) {
      const handler = createUrlIngestHandler({
        authorize: () => Promise.resolve({ ...approved, status, role }),
        fetchArticle: () => {
          touched = true;
          return Promise.resolve(article);
        },
        enqueue: () => {
          touched = true;
          return Promise.resolve({ articleId: "bad", episodeId: "bad" });
        },
      });
      equal((await handler(post({ url: source }))).status, 403);
    }
  }
  equal(touched, false);
});

Deno.test("aborting a stalled request body releases its reader without fetching or queueing", async () => {
  const controller = new AbortController();
  let cancelled = false;
  let touched = false;
  const handler = createUrlIngestHandler({
    authorize: () => Promise.resolve(approved),
    fetchArticle: () => {
      touched = true;
      return Promise.resolve(article);
    },
    enqueue: () => {
      touched = true;
      return Promise.resolve({ articleId: "bad", episodeId: "bad" });
    },
  });
  const request = new Request("http://localhost/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: controller.signal,
    body: new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  });
  const response = handler(request);
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    equal((await response).status, 408);
    equal(cancelled, true);
    equal(touched, false);
  } finally {
    clearTimeout(timer);
  }
});

Deno.test("fetch deadline also cancels a stalled response body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  await rejects(() =>
    fetchArticle(source, {
      timeoutMs: 10,
      transport: () =>
        Promise.resolve(new Response(body, { headers: { "content-type": "text/html" } })),
    }), (error: unknown) => error instanceof IngestError && error.status === 504);
  equal(cancelled, true);
});

Deno.test("request cancellation after extraction prevents enqueue", async () => {
  const controller = new AbortController();
  let queued = false;
  const handler = createUrlIngestHandler({
    authorize: () => Promise.resolve(approved),
    fetchArticle: () => {
      controller.abort();
      return Promise.resolve(article);
    },
    enqueue: () => {
      queued = true;
      return Promise.resolve({ articleId: "bad", episodeId: "bad" });
    },
  });
  const request = new Request(post({ url: source }), { signal: controller.signal });
  equal((await handler(request)).status, 503);
  equal(queued, false);
});

Deno.test("bad methods, JSON, modes, private URLs and large request bodies cannot enqueue", async () => {
  let touched = false;
  const handler = createUrlIngestHandler({
    authorize: () => Promise.resolve(approved),
    fetchArticle: () => {
      touched = true;
      return Promise.resolve(article);
    },
    enqueue: () => {
      touched = true;
      return Promise.resolve({ articleId: "not-allowed", episodeId: "not-allowed" });
    },
  });
  const cases: [Request, number][] = [
    [new Request("http://localhost/api/ingest"), 405],
    [post(null), 400],
    [post([]), 400],
    [post({ url: source, mode: "other" }), 400],
    [post({ url: "file:///etc/passwd" }), 400],
    [post({ url: "http://127.0.0.1/" }), 400],
    [post({ url: source, padding: "x".repeat(9000) }), 413],
    [new Request("http://localhost/api/ingest", { method: "POST", body: "oops" }), 415],
    [
      new Request("http://localhost/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      400,
    ],
  ];
  for (const [request, status] of cases) equal((await handler(request)).status, status);
  equal(touched, false);
});

Deno.test("queue failure is not reported as success and does not leak internal errors", async () => {
  const handler = createUrlIngestHandler({
    authorize: () => Promise.resolve(approved),
    fetchArticle: () => Promise.resolve(article),
    enqueue: () => Promise.reject(new Error("private backend credential")),
  });
  const response = await handler(post({ url: source }));
  equal(response.status, 503);
  equal((await response.text()).includes("credential"), false);
});
