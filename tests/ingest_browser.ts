/** Local acceptance harness only: synthetic users + in-memory jobs, no synthesis or secrets. */
import { createUrlIngestHandler, extractArticle, fetchArticle } from "../src/ingest/url.ts";
import type { User } from "../src/types.ts";

const fixture = await Deno.readTextFile(new URL("./fixtures/article.html", import.meta.url));
const page = await Deno.readTextFile(new URL("./fixtures/ingest-browser.html", import.meta.url));
const jobs: unknown[] = [];
const handler = createUrlIngestHandler({
  authorize: (request) =>
    Promise.resolve(
      {
        id: "fixture-user",
        email: "fixture@example.com",
        displayName: "Fixture",
        isAdmin: false,
        status: request.headers.get("x-fixture-status") === "approved" ? "approved" : "pending",
        createdAt: "2026-09-24T00:00:00Z",
        feedToken: "token-fixture-user",
      } satisfies User,
    ),
  fetchArticle: (url, signal) =>
    url === "https://example.com/article"
      ? Promise.resolve(extractArticle(fixture, url))
      : fetchArticle(url, { signal }),
  enqueue: (job) => {
    jobs.push(job);
    return Promise.resolve({
      articleId: `article-${jobs.length}`,
      episodeId: `episode-${jobs.length}`,
    });
  },
});

const script = `const form = document.querySelector('form');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const values = new FormData(form);
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/api/ingest', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fixture-status': values.get('status') },
      body: JSON.stringify({ url: values.get('url'), mode: values.get('mode') }) });
    const data = await response.json();
    document.querySelector('#result').textContent = 'HTTP ' + response.status + '\\n' + JSON.stringify(data, null, 2);
    const queue = await fetch('/jobs').then(response => response.json());
    document.querySelector('#jobs').textContent = 'Queued fixture jobs: ' + queue.count;
  } catch (error) { document.querySelector('#result').textContent = error.message; }
  finally { button.disabled = false; }
});`;

Deno.serve({ hostname: "127.0.0.1", port: 0 }, (request) => {
  switch (new URL(request.url).pathname) {
    case "/":
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    case "/client.js":
      return new Response(script, { headers: { "content-type": "text/javascript" } });
    case "/api/ingest":
      return handler(request);
    case "/jobs":
      return Response.json({ count: jobs.length });
    default:
      return new Response("Not found", { status: 404 });
  }
});
