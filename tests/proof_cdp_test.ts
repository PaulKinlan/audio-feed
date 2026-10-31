/**
 * Tests for shared proof CDP client (audio-feed-t6o2).
 *
 * Verifies:
 * - connectCdp accepts either a numeric port or an object with a port property
 * - connectCdp discovers page target from /json/list and connects WebSocket
 * - cdp() dispatches requests and resolves responses matched by message id
 * - cdp() rejects when CDP response contains an error object
 * - js() sends Runtime.evaluate and extracts result.value
 * - js() throws when response includes exceptionDetails
 * - until() polls until expression evaluates truthy
 * - until() honours an explicit timeoutMs and its timeout error names what was waited for
 * - js() bounds ONE evaluate against a timer: an expression the page never answers rejects as
 *   CdpHangBoundExceeded, naming the expression, the bound in force and that it did not poll,
 *   after exactly one Runtime.evaluate reached the server (not a poll, not a retry)
 * - until() fails at ITS deadline when the poll's evaluate never answers, instead of waiting
 *   for the evaluate for ever
 * - until() still lets a thrown expression through unwrapped and unretried
 * - the exported MEASURED_STARVED_POLL_MS / HANG_BOUND_MS pair is still 8s and 15x it
 * - close() closes the WebSocket cleanly
 *
 * No Chrome is needed: the hang bound is a race against a timer over the CDP round-trip, so a
 * mock DevTools server that simply never answers one expression exercises it end to end.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  CdpHangBoundExceeded,
  connectCdp,
  HANG_BOUND_MS,
  MEASURED_STARVED_POLL_MS,
} from "../scripts/proof-cdp.ts";

Deno.test("proof-cdp: connects to mock DevTools server and handles cdp, js, until, and error cases", async () => {
  const ac = new AbortController();
  let serverPort = 0;
  // How many times each deliberately-silent expression reached the server. A poll or a retry
  // would push these above one; the assertion is what makes "exactly one evaluate" checkable.
  let neverAnswersCount = 0;
  let neverAnswersUntilCount = 0;

  const server = Deno.serve({
    port: 0,
    signal: ac.signal,
    onListen: ({ port }) => {
      serverPort = port;
    },
  }, (req: Request) => {
    const url = new URL(req.url);
    if (url.pathname === "/json/list") {
      return new Response(
        JSON.stringify([
          { type: "browser", webSocketDebuggerUrl: `ws://127.0.0.1:${serverPort}/browser` },
          { type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${serverPort}/page` },
        ]),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/page") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.method === "Page.enable") {
          socket.send(JSON.stringify({ id: msg.id, result: { enabled: true } }));
        } else if (msg.method === "Fail.method") {
          socket.send(JSON.stringify({ id: msg.id, error: { message: "method failed" } }));
        } else if (msg.method === "Runtime.evaluate") {
          if (msg.params.expression === "throw_error") {
            socket.send(
              JSON.stringify({
                id: msg.id,
                result: { exceptionDetails: { text: "uncaught error" } },
              }),
            );
          } else if (msg.params.expression === "poll_counter") {
            socket.send(
              JSON.stringify({
                id: msg.id,
                result: { result: { value: true } },
              }),
            );
          } else if (msg.params.expression === "never_ready") {
            socket.send(
              JSON.stringify({
                id: msg.id,
                result: { result: { value: false } },
              }),
            );
          } else if (msg.params.expression === "never_answers") {
            // Counted and deliberately UNANSWERED: the real failure this bound exists for is an
            // evaluate the page's main thread never gets to, so no reply is ever sent.
            neverAnswersCount++;
          } else if (msg.params.expression === "never_answers_until") {
            neverAnswersUntilCount++;
          } else {
            socket.send(
              JSON.stringify({
                id: msg.id,
                result: { result: { value: 42 } },
              }),
            );
          }
        }
      };
      return response;
    }
    return new Response("not found", { status: 404 });
  });

  try {
    const port = serverPort;

    // 1. Test connect with { port } object
    const client = await connectCdp({ port });
    try {
      // 2. Test cdp() success
      const enableRes = await client.cdp("Page.enable");
      assertEquals(enableRes, { enabled: true });

      // 3. Test js() success
      const evalVal = await client.js("21 * 2");
      assertEquals(evalVal, 42);

      // 4. Test cdp() error handling
      await assertRejects(
        async () => await client.cdp("Fail.method"),
        Error,
        'Fail.method: {"message":"method failed"}',
      );

      // 5. Test js() exceptionDetails handling
      await assertRejects(
        async () => await client.js("throw_error"),
        Error,
        'throw_error: {"text":"uncaught error"}',
      );

      // 6. Test until() success
      await client.until("poll_counter", "counter ready", 500);

      // 7. Test until() timeout: an explicit timeoutMs is HONOURED (bounded by ~150ms, not the
      // 120s derived hang bound the helper defaults to) and the error names what was waited for,
      // which expression it polled, how long it waited and how many polls it managed
      // (audio-feed-ev6wj).
      const timeoutStart = Date.now();
      await assertRejects(
        async () => await client.until("never_ready", "waiting for never", 150),
        Error,
        "until: 'waiting for never' did not hold within 150ms of entry",
      );
      const timeoutElapsed = Date.now() - timeoutStart;
      assert(
        timeoutElapsed < 4_000,
        `an explicit 150ms timeout must not wait out the helper's default; elapsed ${timeoutElapsed}ms`,
      );
      // The message carries the evidence a gate log needs: the expression, the elapsed time and
      // the poll count, so "never got a slice" and "page never got there" are distinguishable.
      const timeoutError = await client.until("never_ready", "waiting for never", 150).then(
        () => null,
        (err: Error) => err.message,
      );
      assertStringIncludes(timeoutError ?? "", "expression `never_ready`");
      assertStringIncludes(timeoutError ?? "", "polls ");
      assertStringIncludes(timeoutError ?? "", "last value false");

      // 9. The shared helper's own bounds are still the measured pair: 8s starvation floor and
      // 15x it. This is what pins the DEFAULT that js() and until() inherit; the numeric value
      // is asserted rather than waited out, because the point of the default is a two-minute
      // hang, and a test that sleeps 120s to prove it would cost a gate slot for nothing.
      assertEquals(MEASURED_STARVED_POLL_MS, 8_000);
      assertEquals(HANG_BOUND_MS, 120_000);
      assertEquals(HANG_BOUND_MS, 15 * MEASURED_STARVED_POLL_MS);
      // Both defaults are SIGNATURE defaults, so observing them through behaviour would mean
      // waiting out a two-minute hang. This is a source assertion instead, and it says so: it
      // pins the wiring (`= HANG_BOUND_MS`, never a literal like the old 8000) so a later edit
      // that quietly re-inherits a fixed default is a test failure rather than drift.
      const sharedSource = await Deno.readTextFile(
        new URL("../scripts/proof-cdp.ts", import.meta.url),
      );
      assertStringIncludes(
        sharedSource,
        "until(expr: string, desc: string, timeoutMs = HANG_BOUND_MS)",
      );
      assertStringIncludes(sharedSource, "js(expression: string, timeoutMs = HANG_BOUND_MS)");

      // 10. js() BOUNDS one evaluate: an expression the page never answers rejects as its own
      // class, inside its own bound, naming what was evaluated, the bound in force, and denying
      // that it polled - and exactly ONE Runtime.evaluate reached the server, which is the
      // difference between a bound and a retry loop.
      const jsBoundStart = Date.now();
      const jsBoundError = await client.js("never_answers", 150).then(
        () => null,
        (err: unknown) => err,
      );
      const jsBoundElapsed = Date.now() - jsBoundStart;
      assert(
        jsBoundError instanceof CdpHangBoundExceeded,
        `a starved evaluate must reject as CdpHangBoundExceeded, got ${String(jsBoundError)}`,
      );
      const jsBoundMessage = (jsBoundError as Error).message;
      assertStringIncludes(jsBoundMessage, "js: the evaluate of `never_answers`");
      assertStringIncludes(jsBoundMessage, "got no answer in 150ms");
      assertStringIncludes(jsBoundMessage, "NOT polled");
      assertStringIncludes(jsBoundMessage, "evaluated exactly once");
      assertStringIncludes(jsBoundMessage, `${HANG_BOUND_MS}ms by default`);
      assert(
        jsBoundElapsed < 5_000,
        `an explicit 150ms js() bound must fail well inside it; elapsed ${jsBoundElapsed}ms`,
      );
      assertEquals(
        neverAnswersCount,
        1,
        `the bound must leave exactly one evaluate sent, not a poll; server saw ${neverAnswersCount}`,
      );

      // 11. until() fails at ITS deadline when the poll's evaluate never answers. Before the
      // per-poll bound, a 200ms wait whose first evaluate hung was awaited for ever: the loop
      // test that enforces the deadline sat behind a promise that might never settle. The error
      // is still until()'s own (callers and their catch blocks see the same shape as any other
      // missed wait), and it names the starved poll rather than blaming the page.
      const starvedUntilStart = Date.now();
      const starvedUntil = await client.until("never_answers_until", "never answering page", 200)
        .then(() => null, (err: unknown) => err);
      const starvedUntilElapsed = Date.now() - starvedUntilStart;
      assert(
        starvedUntil instanceof Error && !(starvedUntil instanceof CdpHangBoundExceeded),
        `a starved poll must surface as until()'s deadline error, got ${String(starvedUntil)}`,
      );
      const starvedUntilMessage = (starvedUntil as Error).message;
      assertStringIncludes(
        starvedUntilMessage,
        "until: 'never answering page' did not hold within 200ms of entry",
      );
      assertStringIncludes(starvedUntilMessage, "the final poll's evaluate got no answer in");
      assertStringIncludes(starvedUntilMessage, "expression `never_answers_until`");
      assert(
        starvedUntilElapsed < 5_000,
        `until() must fail at its own 200ms deadline, not hang; elapsed ${starvedUntilElapsed}ms`,
      );
      assertEquals(
        neverAnswersUntilCount,
        1,
        `a starved poll must not be retried after the deadline; server saw ${neverAnswersUntilCount}`,
      );

      // 12. A THROWN expression is still the caller's error: it escapes until() immediately,
      // unwrapped (no `until:` prefix) and is not polled again - the per-poll bound converts
      // only CdpHangBoundExceeded into a deadline, never a real failure into a retry.
      await assertRejects(
        async () => await client.until("throw_error", "expression that throws", 500),
        Error,
        'throw_error: {"text":"uncaught error"}',
      );
    } finally {
      client.close();
    }

    // 8. Test connect with numeric port
    const client2 = await connectCdp(port);
    try {
      const res = await client2.cdp("Page.enable");
      assertEquals(res, { enabled: true });
    } finally {
      client2.close();
    }
  } finally {
    ac.abort();
    await server.finished;
  }
});
