# Send-to-Audio URL ingest

`src/ingest/url.ts` exports a request handler for `POST /api/ingest`, a public-URL fetcher, an
article extractor, and synthesis input builders. The application router, identity resolver,
persistence and synthesis worker are separate integrations; importing this module does not start a
server or generate audio.

## HTTP contract

Send JSON with `url` and optional `mode` (`direct`, the default, or `deepdive`):

```json
{ "url": "https://example.com/article", "mode": "direct" }
```

Construct `createUrlIngestHandler` with:

- `authorize(request): Promise<User | Response>` — resolve a verified user or return an
  authentication refusal. The handler independently requires the shared
  `isSynthesisAuthorized(user)` approval gate before reading, fetching or queueing anything. A
  pending or suspended admin is refused too. Never derive identity from this request's JSON body.
- `enqueue({article, mode, user}): Promise<{articleId, episodeId}>` — persist the article and
  synthesis job before resolving. Deduplication, per-user inbox mapping, storage IDs and retry
  policy belong here. Recheck the current approval state in the synthesis worker before spending
  money; an approved user may be suspended after queueing.
- Optional `fetchArticle(url, signal)` — a **trusted application/test injection**, not a user
  setting. Omit it to use the public-only transport. A custom implementation is responsible for
  equivalent URL/transport safeguards.

Successful responses are `202` with `{articleId, episodeId, status:"queued", mode, article}`. This
means the queue accepted the job, **not** that audio exists. Errors return `{error}` without backend
exception details. Statuses: `400` invalid input/private URL, `403` unapproved user, `405` wrong
method, `408` interrupted request body, `413` oversized body, `415` non-JSON request, `422`
unsupported/unreadable article, `502` upstream transport failure, `503` authentication/queue
infrastructure failure, `504` fetch deadline/cancellation. Authentication may return its own
`401`/`403` response.

## Extraction and presentation

`ExtractedArticle` contains `url`, `title`, nullable `author` and `publishedAt`, `lead`, and
paragraph-separated plain-text `body`. The URL is the last fetched URL, not an untrusted
canonical-link override. Publication dates come from page metadata, JSON-LD or a `<time datetime>`;
missing/invalid metadata is left unknown.

Linkedom parses inert HTML; Mozilla Readability selects article content and metadata. Explicit
navigation, advertising, subscription/paywall banners, hidden elements and visible byline chrome are
removed. No page script, iframe or resource is executed/fetched by the parser. HTML source line
wrapping is collapsed without splitting actual paragraphs.

`audioPayload(article, "direct")` returns title/author/date context followed by the complete
extracted body, without repeating the lead. `audioPayload(article, "deepdive")` returns the full
source article as grounded input for a dialogue generator. It does **not** invent research, speakers
or conversation. Article text remains untrusted source material; downstream prompting must not treat
its instructions as system authority.

This is a server-rendered, accessible-HTML reader, not a paywall bypass or headless browser.
Login-only, script-rendered and short/empty pages may return `422`. Readability is heuristic:
extraction quality varies by site, and accessible excerpts cannot be assumed to be full subscription
articles. Pages that ignore `Accept-Encoding: identity` and still send compressed content are
refused rather than decompressed without bounds.

## Network and resource boundary

- HTTP/HTTPS only, standard ports only; no URL credentials.
- Deny non-global IP literals, including abbreviated/encoded IPv4, IPv6 local addresses, mapped
  addresses and transition ranges.
- Use `node:http`/`node:https` with a custom `lookup` callback that validates **every** resolved
  address and hands those exact addresses to the socket. There is no DNS preflight followed by an
  independently resolving `fetch()`.
- Follow at most five redirects, validating the URL and using the same DNS-checked transport anew at
  every hop. No incoming cookies, authorization headers or user-supplied headers are forwarded.
- Bound the request body to 8 KiB and five seconds; bound the total fetch to 15 seconds, headers to
  16 KiB, HTML to 2 MiB and Readability processing to 20,000 elements. Cancel bodies on
  refusal/timeout. The application still needs per-user concurrency/rate controls.

**Runtime evidence is local Deno 2.9 only.** A real-socket test proves that Deno's Node
compatibility layer honors `lookup`, including a refused lookup that never reaches a local sentinel.
A real HTTPS article was fetched and extracted. Deno Deploy and remote IPv6 connectivity have not
been driven; the IPv6 address policy is unit-tested. Do not describe this as Deploy-verified until
equivalent hosted checks pass. The socket layer must not be replaced with bare `fetch()`.

## Reproduce

```sh
deno test --allow-read=tests/fixtures --allow-net=127.0.0.1 tests/ingest_test.ts
deno run --allow-read=tests/fixtures --allow-net tests/ingest_browser.ts
```

The second command prints an ephemeral localhost URL. The browser page explicitly uses synthetic
users and an in-memory queue: no credentials or Gemini calls. Submit `https://example.com/article`
in both modes, switch to Pending and confirm `403` without another job, then try
`http://169.254.169.254/` and confirm `400`. For a real transport drive, switch to Approved and
submit `https://deno.com/blog/v2.0`; inspect the extracted article, not just the HTTP status. Stop
the harness afterwards. See [acceptance observations](evidence/ingest/acceptance.md).
