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
 * - withHangBound() bounds ONE raw cdp reply that never arrives as CdpHangBoundExceeded, naming
 *   the command, and passes a real reply's value - or its own error - through unchanged
 * - REAL CLOCK: a raw cdp reply that never answers still SETTLES as CdpHangBoundExceeded when
 *   the real deadline (the measured starved floor) fires over a real round trip - asserting
 *   settlement, deliberately never speed, and failing in bounded time on the row's own deadline
 *   if that deadline never fires at all
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
  withHangBound,
} from "../scripts/proof-cdp.ts";

Deno.test(
  "proof-cdp: withHangBound bounds ONE raw cdp reply that never arrives as a named failure, and passes real replies and errors through unchanged",
  async () => {
    // The failure the bound exists for: the command was sent, the reply never comes. A promise
    // that never settles is exactly that reply; the race must reject inside the bound with the
    // SAME class js() uses, naming the command, so a sweep's screenshot stall is actionable
    // instead of a silent hang past the last PASS (measured on account-browser-proof).
    const never = new Promise<unknown>(() => {});
    const start = Date.now();
    const err = await withHangBound("Page.captureScreenshot", never, 150).then(
      () => null,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - start;
    assert(
      err instanceof CdpHangBoundExceeded,
      `a never-answered raw reply must reject as CdpHangBoundExceeded, got ${String(err)}`,
    );
    const message = (err as Error).message;
    assertStringIncludes(
      message,
      "cdp: the `Page.captureScreenshot` reply never arrived within 150ms",
    );
    assertStringIncludes(message, `${HANG_BOUND_MS}ms by default`);
    assertStringIncludes(message, "sent exactly once");
    assert(
      elapsed < 5_000,
      `an explicit 150ms raw-reply bound must fail well inside it; elapsed ${elapsed}ms`,
    );

    // A reply that DOES arrive passes through unchanged, value and type.
    const value = await withHangBound("Page.enable", Promise.resolve({ enabled: true }), 150);
    assertEquals(value, { enabled: true });

    // A reply that arrives as an ERROR keeps its own error unwrapped - the bound converts only
    // a reply that never comes into CdpHangBoundExceeded, never a real failure into a hang.
    await assertRejects(
      async () =>
        await withHangBound("Fail.method", Promise.reject(new Error("method failed")), 150),
      Error,
      "method failed",
    );
    const realError = await withHangBound("Fail.method", Promise.reject(new Error("boom")), 150)
      .then(() => null, (e: unknown) => e);
    assert(
      !(realError instanceof CdpHangBoundExceeded),
      "a real reply error must not be reclassified as a hang",
    );
  },
);

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

      // 9b. Browser-boot waits consume the SAME derived pair rather than a bare count. The
      // css_escape_guard row used to hand-roll a fixed 50x100ms DevToolsActivePort wait, which
      // reddened a healthy launch on the loaded gate host (union gate, loadavg 5-10) while the
      // same tree passed in isolation - a fixed window is a coin flip under load. It now
      // launches through proof-helper's launchChrome with portTimeoutMs: HANG_BOUND_MS, so the
      // failure names the owner ("exited prematurely" = never started vs "Timed out after
      // <waited>ms" = started slowly). Source-pinned, not waited out: the point is the wiring,
      // not the wall time.
      const guardSource = await Deno.readTextFile(
        new URL("./css_escape_guard_test.ts", import.meta.url),
      );
      assertStringIncludes(guardSource, "portTimeoutMs: HANG_BOUND_MS");
      assert(
        !guardSource.includes("i < 50"),
        "css_escape_guard must not return to the fixed 50-poll boot wait",
      );

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

Deno.test(
  "proof-cdp: REAL CLOCK - a raw cdp reply that never answers still settles as CdpHangBoundExceeded when the real deadline fires, with no upper bound on delivery",
  async () => {
    // WHY THIS ROW EXISTS: the rows above pin WHAT the bound says (class, message, sent-once)
    // with 150-500ms waits. This row proves the wait actually SETTLES on the real clock at a
    // ceiling scaled from the measured floor, end to end over a REAL raw cdp round trip: the
    // command reaches the mock server, no reply is ever sent, and the only thing that can end
    // the wait is proof-cdp.ts's real setTimeout firing. An implementation whose real timer
    // never fires while a race is armed cannot pass here, whatever it claims about arithmetic.
    //
    // WHY NO UPPER BOUND ON REAL TIME IS DELIBERATE: the property under test is SETTLEMENT,
    // not speed. A loaded host scheduler delivers a ready timer late in wall time, and the
    // host scheduler is not the subject - an upper wall-clock assertion here would
    // re-introduce exactly the load flake the derived bounds in this file exist to remove.
    // This row can only fail if the wait never settles at all.
    //
    // WHY THE CEILING IS THE MEASURED FLOOR, NOT TWICE IT: this row asserts SETTLEMENT and
    // deliberately asserts NOTHING about elapsed time, so the ceiling cannot change whether the
    // row passes - it can only change how long the row takes on every single run of this file.
    // The ceiling is therefore HEADROOM for proof-cdp.ts's real setTimeout to fire over a real
    // round trip, not a threshold anything has to clear, and it is sized for COST, not for a
    // measurement. One MEASURED_STARVED_POLL_MS - 8s, the starved-poll floor MEASURED on this
    // fleet's host under eight-way saturation (audio-feed-6gst1) - is the single measured number
    // in here and stays single-sourced; doubling it bought no proof and 8s of wall time on every
    // run of the file.
    const realClockCeilingMs = MEASURED_STARVED_POLL_MS;

    const ac = new AbortController();
    let serverPort = 0;
    let silentCount = 0;
    let resolveListening!: () => void;
    const listening = new Promise<void>((resolve) => resolveListening = resolve);
    const server = Deno.serve({
      port: 0,
      signal: ac.signal,
      onListen: ({ port }) => {
        serverPort = port;
        resolveListening();
      },
    }, (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/json/list") {
        return new Response(
          JSON.stringify([
            { type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${serverPort}/page` },
          ]),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname === "/page") {
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.method === "Silent.method") {
            // Counted and deliberately UNANSWERED: the raw reply this row waits for is one
            // the server never sends, exactly the reply-never-comes hang the bound exists
            // for (measured: a proof printed 11/11 PASS and never exited).
            silentCount++;
          }
        };
        return response;
      }
      return new Response("not found", { status: 404 });
    });

    try {
      await listening;
      const client = await connectCdp({ port: serverPort });
      // Declared outside the try so the finally below can always clear it.
      let guardTimer: ReturnType<typeof setTimeout> | 0 = 0;
      try {
        // ONE raw command, ONE real-clock deadline. The row records elapsed only so a failure
        // message could carry it; nothing asserts how fast the host delivered the deadline.
        //
        // THE ROW'S OWN DEADLINE, because the failure this row exists to catch is the one it
        // could not previously report: a bound whose real timer NEVER fires does not fail here,
        // it hangs the whole test runner until the lane's killer arrives - which is exactly why
        // the never-firing half of the mutation was unprovable. 2s past the ceiling is past any
        // deadline the bound could legitimately deliver late, so settling after that is not a
        // late timer, it is a timer that did not fire. Cleared in the finally so no timer outlives
        // the row.
        const startedAt = Date.now();
        const err = await Promise.race([
          withHangBound("Silent.method", client.cdp("Silent.method"), realClockCeilingMs),
          new Promise<void>((resolve) => {
            guardTimer = setTimeout(resolve, realClockCeilingMs + 2_000);
          }).then(() => {
            throw new Error(
              "the row never settled: withHangBound's real deadline did not fire",
            );
          }),
        ]).then(() => null, (e: unknown) => e);
        const elapsed = Date.now() - startedAt;
        assert(
          err instanceof CdpHangBoundExceeded,
          `a never-answered raw reply must SETTLE as CdpHangBoundExceeded when the real ` +
            `${realClockCeilingMs}ms deadline fires (elapsed ${elapsed}ms), got ${String(err)}`,
        );
        assertStringIncludes((err as Error).message, "never arrived within 8000ms");
        assertEquals(
          silentCount,
          1,
          `the raw command must have been sent exactly once; server saw ${silentCount}`,
        );
      } finally {
        if (guardTimer) clearTimeout(guardTimer);
        client.close();
      }
    } finally {
      ac.abort();
      await server.finished;
    }
  },
);
