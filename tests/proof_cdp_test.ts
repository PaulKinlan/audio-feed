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
 * - until() honours an explicit timeoutMs and its timeout error names what was waited for.
 *   The deadline is measured on a FAKE clock: it is arithmetic on Date.now(), and wall-clock
 *   promptness says nothing about the loop on a shared host
 * - js() bounds ONE evaluate against a timer: an expression the page never answers rejects as
 *   CdpHangBoundExceeded, naming the expression, the bound in force and that it did not poll,
 *   after exactly one Runtime.evaluate reached the server (not a poll, not a retry)
 * - until() fails at ITS deadline when the poll's evaluate never answers, instead of waiting
 *   for the evaluate for ever. Also on the FAKE clock: the starved evaluate is the mock's, not
 *   the host's, so virtual time is the whole of the loop's input
 * - until() still lets a thrown expression through unwrapped and unretried
 * - withHangBound() bounds ONE raw cdp reply that never arrives as CdpHangBoundExceeded, naming
 *   the command and the bound it was given, and passes a real reply's value - or its own error -
 *   through unchanged. The bound is measured on a FAKE clock: what it must react to is virtual
 *   time elapsing, and wall-clock promptness is not a property of this function on a shared host
 * - REAL CLOCK: a raw cdp reply that never answers still SETTLES as CdpHangBoundExceeded when
 *   the real deadline (the measured starved floor) fires over a real round trip - asserting
 *   settlement, deliberately never speed, and failing in bounded time on the row's own deadline
 *   if that deadline never fires at all
 * - the exported MEASURED_STARVED_POLL_MS / HANG_BOUND_MS pair is still 8s and 15x it
 * - the product-budget GUARD is pinned, not only the budgets it accepts: the exported
 *   assertBudgetBelowHang THROWS for a budget at or above the ceiling (checked at the ceiling
 *   and above it, naming the budget and the ceiling) and does not throw for the real budgets, and
 *   the import-time loop still applies it. Ceiling as a parameter is what lets the row drive a
 *   budget over the bound without mutating a source constant at test time (audio-feed-zkto5)
 * - close() closes the WebSocket cleanly
 *
 * No Chrome is needed: the hang bound is a race against a timer over the CDP round-trip, so a
 * mock DevTools server that simply never answers one expression exercises it end to end.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
  CdpHangBoundExceeded,
  connectCdp,
  HANG_BOUND_MS,
  MEASURED_STARVED_POLL_MS,
  withHangBound,
} from "../scripts/proof-cdp.ts";
import {
  assertBudgetBelowHang,
  BOOTSTRAP_REDIRECT_LATENCY_MS,
  PLAYBACK_ADVANCE_SAMPLE_BUDGET_MS,
  PLAYBACK_ADVANCE_SAMPLE_MS,
  PLAYBACK_ADVANCE_WAIT_MS,
} from "../scripts/proof-latency-budgets.ts";

Deno.test(
  "proof-cdp: withHangBound bounds ONE raw cdp reply that never arrives as a named failure, and passes real replies and errors through unchanged",
  async () => {
    // The failure the bound exists for: the command was sent, the reply never comes. A promise
    // that never settles is exactly that reply; the race must reject at the bound with the SAME
    // class js() uses, naming the command and the bound in force, so a sweep's screenshot stall
    // is actionable instead of a silent hang past the last PASS (measured on
    // account-browser-proof).
    //
    // The bound is driven by a FAKE clock, not by the stopwatch this row used to hold. Wall-clock
    // promptness is NOT a property of withHangBound on a shared host: its timer fires only when
    // the event loop is scheduled, and a starved lane can be seconds late (this repo's own
    // measured starved-poll floor is MEASURED_STARVED_POLL_MS = 8s). The old `elapsed < 5_000`
    // consequently asserted the health of the BOX, not the function - it reddened a healthy bound
    // at 6000ms on the loaded gate host. Advancing virtual time is deterministic on any host and
    // is the only input the function is allowed to depend on.
    const never = new Promise<unknown>(() => {});
    let settled = false;
    let err: unknown = null;
    let elapsed = -1;
    {
      const fakeTime = new FakeTime();
      try {
        const start = Date.now();
        void withHangBound("Page.captureScreenshot", never, 150).then(
          () => {
            settled = true;
          },
          (e: unknown) => {
            settled = true;
            err = e;
          },
        );
        // Exactly the bound the caller passed, on the clock. An implementation that ignored
        // `timeoutMs` and armed HANG_BOUND_MS instead would still be pending here, so this
        // catches the same regression the stopwatch was reaching for - without the box.
        await fakeTime.tick(150);
        await fakeTime.runMicrotasks();
        elapsed = Date.now() - start;
      } finally {
        fakeTime.restore();
      }
    }
    assert(
      settled,
      "the 150ms bound must fire at 150ms of clock time: the reply never arrived, so the race " +
        "had to have settled - it was still pending after the bound elapsed",
    );
    assertEquals(
      elapsed,
      150,
      "the bound must fire at the bound it was given, not at the 120s default",
    );
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

    // A reply that DOES arrive passes through unchanged, value and type.
    const value = await withHangBound("Page.enable", Promise.resolve({ enabled: true }), 150);
    assertEquals(value, { enabled: true });

    // The (reply, what) order is also accepted (audio-feed-hibea).
    const valueReversed = await withHangBound(Promise.resolve({ ok: true }), "Page.enable", 150);
    assertEquals(valueReversed, { ok: true });

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
  let neverAnswersDefaultCount = 0;

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
          } else if (msg.params.expression === "never_answers_default") {
            // Counted and deliberately UNANSWERED, like `never_answers`: the difference is only
            // that the CALLER passes no bound, so the wait must end at the shared default.
            neverAnswersDefaultCount++;
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

      // 6. Test until() success. The budget is DERIVED, not a fixed 500: this is the success
      // path against the in-process mock, so the only thing that must fit is one evaluate -
      // and under gate load even a mock round-trip starves past a fraction of a second
      // (measured in a loaded fast gate: elapsed 799ms, polls 0, the evaluate never answered
      // inside 500ms). Two x the imported MEASURED_STARVED_POLL_MS floor accommodates one full
      // starved evaluate and still leaves the poll cycle room to observe the truthy result.
      // The deliberate SHORT probe is test 7 below: an explicit 150ms timeout must be
      // honoured, and that one keeps its 150.
      await client.until("poll_counter", "counter ready", 2 * MEASURED_STARVED_POLL_MS);

      // 7. Test until() timeout: an explicit timeoutMs is HONOURED (the deadline fires at the
      // 150ms it was given, not at the 120s derived hang bound the helper defaults to) and the
      // error names what was waited for, which expression it polled, how long it waited and how
      // many polls it managed (audio-feed-ev6wj).
      //
      // The deadline is measured on a FAKE clock, not by the stopwatch this row used to hold.
      // `timeoutElapsed < 4_000` asserted the HOST's scheduler kept up: the loop's deadline is
      // arithmetic on Date.now(), and on a starved lane a 150ms budget can sit behind seconds of
      // event-loop backlog (this repo's measured starved-poll floor is MEASURED_STARVED_POLL_MS
      // = 8s), so the row could redden a correct wait. Virtual time is deterministic on any host
      // and is the only input the loop is allowed to depend on - and it still has to fire at
      // exactly the 150ms asked for, which a wait that re-inherited HANG_BOUND_MS could not do.
      const timeoutClock = new FakeTime();
      let timeoutSettled = false;
      let timeoutDeadlineError: unknown = null;
      let timeoutElapsed = -1;
      try {
        const timeoutStart = Date.now();
        void client.until("never_ready", "waiting for never", 150).then(
          () => {
            timeoutSettled = true;
          },
          (err: unknown) => {
            timeoutSettled = true;
            timeoutDeadlineError = err;
          },
        );
        await timeoutClock.tickAsync(150);
        await timeoutClock.runMicrotasks();
        timeoutElapsed = Date.now() - timeoutStart;
      } finally {
        timeoutClock.restore();
      }
      assert(
        timeoutSettled,
        "an explicit 150ms timeout must fire at 150ms of clock time: the page never held, so " +
          "the wait had to have failed - it was still pending after the budget elapsed",
      );
      assertEquals(
        timeoutElapsed,
        150,
        "the deadline must fire at the timeoutMs it was given, not at the 120s derived default",
      );
      assert(timeoutDeadlineError !== null, "the wait must reject, not resolve");
      assertStringIncludes(
        (timeoutDeadlineError as Error).message,
        "until: 'waiting for never' did not hold within 150ms of entry",
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
      // The bound is driven by a FAKE clock, not by the stopwatch this row used to hold:
      // `jsBoundElapsed < 5_000` asserted that the HOST gave the timer a slice promptly, and on a
      // starved lane (measured starved-poll floor MEASURED_STARVED_POLL_MS = 8s) a healthy 150ms
      // bound reddens. Virtual time is deterministic on any host, and asserting the bound fires at
      // exactly the 150ms asked for is STRONGER than the upper bound it replaces: an
      // implementation that ignored timeoutMs and armed HANG_BOUND_MS would still be pending.
      const jsBoundClock = new FakeTime();
      let jsBoundError: unknown = null;
      let jsBoundSettled = false;
      let jsBoundElapsed = -1;
      try {
        const jsBoundStart = Date.now();
        void client.js("never_answers", 150).then(
          () => {
            jsBoundSettled = true;
          },
          (err: unknown) => {
            jsBoundSettled = true;
            jsBoundError = err;
          },
        );
        await jsBoundClock.tickAsync(150);
        await jsBoundClock.runMicrotasks();
        jsBoundElapsed = Date.now() - jsBoundStart;
      } finally {
        jsBoundClock.restore();
      }
      assert(
        jsBoundSettled,
        "the 150ms js() bound must fire at 150ms of clock time: the evaluate was never answered, " +
          "so the race had to have settled - it was still pending after the bound elapsed",
      );
      assertEquals(
        jsBoundElapsed,
        150,
        "the js() bound must fire at the bound it was given, not at the 120s default",
      );
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
      // The evaluate was SENT inside the fake clock but delivered on the real event loop, so wait
      // out one REAL round-trip before counting: socket ordering guarantees the server saw the
      // evaluate before it can answer this.
      await client.cdp("Page.enable");
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
      //
      // THIS ROW IS ABOUT STARVATION, and it is still not a stopwatch. The starvation is in the
      // FIXTURE - the mock server receives `never_answers_until` and deliberately never replies,
      // which is exactly the evaluate a starved renderer leaves outstanding - and the property is
      // that until()'s OWN 200ms deadline becomes a deadline for it. `starvedUntilElapsed < 5_000`
      // (25x the deadline) did not assert that: it asserted the host resumed this lane inside 5s,
      // and on a starved box (floor MEASURED_STARVED_POLL_MS = 8s) it reddens a wait that behaved
      // perfectly. What the loop can legitimately depend on is the 200ms on the clock, so the
      // clock is what the row drives: the fake timer armed with exactly the `remainingMs` left of
      // the budget must fire at 200, and the loop must convert it into its own deadline error
      // rather than retrying or hanging. That is the same property, minus the host - and it fails
      // an implementation that re-inherited HANG_BOUND_MS instead of bounding the poll by what is
      // left of the budget.
      const starvedClock = new FakeTime();
      let starvedUntilSettled = false;
      let starvedUntil: unknown = null;
      let starvedUntilElapsed = -1;
      try {
        const starvedUntilStart = Date.now();
        void client.until("never_answers_until", "never answering page", 200).then(
          () => {
            starvedUntilSettled = true;
          },
          (err: unknown) => {
            starvedUntilSettled = true;
            starvedUntil = err;
          },
        );
        await starvedClock.tickAsync(200);
        await starvedClock.runMicrotasks();
        starvedUntilElapsed = Date.now() - starvedUntilStart;
      } finally {
        starvedClock.restore();
      }
      assert(
        starvedUntilSettled,
        "until() must fail at its own 200ms deadline when the poll never answers: it was still " +
          "pending after the deadline elapsed, which is the hang the per-poll bound removed",
      );
      assertEquals(
        starvedUntilElapsed,
        200,
        "the starved poll must be bounded by what is left of the wait's budget, not by the " +
          "120s derived default",
      );
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
      // Real round-trip before counting, for the same reason as the js() row above: socket
      // ordering says the server received the starved poll before it answers this command.
      await client.cdp("Page.enable");
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

      // 13. js()'s DEFAULT is a bound too: a call site that states no budget inherits
      // HANG_BOUND_MS, and an evaluate the page never answers must reject as CdpHangBoundExceeded
      // at exactly that default instead of waiting for the lane's killer (audio-feed-go4le).
      //
      // This is the row the swept bootstrap proofs lean on: `bootstrap-browser-proof.ts` and
      // `bootstrap-refusal-browser-proof.ts` used to carry a private `js()` with NO timeout at
      // all, so every bare `await js(...)` in them was unbounded. They now call the shared client
      // with no third argument, which is only safe if the DEFAULT is a real deadline. Driven on
      // the fake clock for the same reason as row 10: the property is that the armed timer fires
      // at HANG_BOUND_MS, and asserting host promptness would only measure the box.
      //
      // THE MUTANT: delete the timer race in `js()` (leave the bare `await cdp(...)`) and this row
      // never settles - it hangs until the test runner's own timeout kills it rather than passing,
      // which is the difference between a bound and no bound.
      const jsDefaultClock = new FakeTime();
      let jsDefaultSettled = false;
      let jsDefaultError: unknown = null;
      let jsDefaultElapsed = -1;
      try {
        const jsDefaultStart = Date.now();
        void client.js("never_answers_default").then(
          () => {
            jsDefaultSettled = true;
          },
          (err: unknown) => {
            jsDefaultSettled = true;
            jsDefaultError = err;
          },
        );
        await jsDefaultClock.tickAsync(HANG_BOUND_MS);
        await jsDefaultClock.runMicrotasks();
        jsDefaultElapsed = Date.now() - jsDefaultStart;
      } finally {
        jsDefaultClock.restore();
      }
      assert(
        jsDefaultSettled,
        "a bare js() call must inherit the 120s hang bound: the evaluate was never answered, so " +
          "the race had to have settled - it was still pending after the default elapsed",
      );
      assertEquals(
        jsDefaultElapsed,
        HANG_BOUND_MS,
        "a js() call with no explicit bound must fire at HANG_BOUND_MS, not at a fixed 8s or never",
      );
      assert(
        jsDefaultError instanceof CdpHangBoundExceeded,
        `a starved unbounded-by-the-caller evaluate must reject as CdpHangBoundExceeded, got ${
          String(jsDefaultError)
        }`,
      );
      assertStringIncludes(
        (jsDefaultError as Error).message,
        `got no answer in ${HANG_BOUND_MS}ms`,
      );
      // Real round-trip before counting, for the same reason as rows 10 and 11.
      await client.cdp("Page.enable");
      assertEquals(
        neverAnswersDefaultCount,
        1,
        `the default bound must leave exactly one evaluate sent, not a poll; server saw ${
          String(neverAnswersDefaultCount)
        }`,
      );

      // 14. The swept proofs carry NO private copy of the client any more (audio-feed-go4le). A
      // private `js()` is how the unbounded evaluate came back the first time: the copy sent
      // `Runtime.evaluate` with no timeout and no race, so a main thread that never answered had
      // no ceiling. Source-pinned, because the wiring is the property - the behaviour it buys is
      // rows 10, 11 and 13 above, and those test the shared helper the swept files now call.
      // The paths are LITERAL, one read per swept file: a template-built path here derived a
      // directory relation on `scripts/`, which widened the fast gate's selection for every script
      // change (pinned by tests/fast_gate_subset_test.ts, and it said so by name on the first run
      // of this gate). Two literal reads name exactly the two files this row is about.
      const sweptProofs: [string, string][] = [
        [
          "bootstrap-browser-proof.ts",
          await Deno.readTextFile(
            new URL("../scripts/bootstrap-browser-proof.ts", import.meta.url),
          ),
        ],
        [
          "bootstrap-refusal-browser-proof.ts",
          await Deno.readTextFile(
            new URL("../scripts/bootstrap-refusal-browser-proof.ts", import.meta.url),
          ),
        ],
      ];
      for (const [swept, sweptSource] of sweptProofs) {
        assertStringIncludes(sweptSource, "connectCdp(chrome.port)");
        assert(
          !sweptSource.includes("async function js(") &&
            !sweptSource.includes("async function until("),
          `${swept} must not re-declare a private js()/until(): the private js() had no timeout ` +
            "and the private until() defaulted to an un-derived 8s",
        );
        assert(
          !/until\([^)]*,\s*(8000|10000|15_000|15000)\s*,?\s*\)/u.test(sweptSource),
          `${swept} must pass the derived HANG_BOUND_MS, not a bare literal count`,
        );
      }

      // 15. Product-latency budgets are derived from the behaviour they measure, never from the
      // hang ceiling (audio-feed-c0l7b). fleet/until-4 tied both the `/admin` redirect waits and
      // the playback start wait to HANG_BOUND_MS, so moving the starved-poll floor silently
      // reshaped a product budget - a redirect merely SLOW by 60s passed where a 10s literal had
      // failed. The numbers themselves are derived in scripts/proof-latency-budgets.ts; these
      // rows pin the derivation, the ordering against the hang bound, and the call sites, because
      // the property is the WIRING: a proof that goes back to a hang fraction looks identical at
      // the `until(` call site.
      assertEquals(
        PLAYBACK_ADVANCE_WAIT_MS,
        MEASURED_STARVED_POLL_MS + PLAYBACK_ADVANCE_SAMPLE_MS,
        "the playback start budget is one measured starved poll plus the advance sample window",
      );
      assertEquals(
        PLAYBACK_ADVANCE_SAMPLE_MS,
        1_200,
        "the advance sample window the assertion uses",
      );
      // 15a. Each budget's arithmetic NAMES the waits its span encloses (audio-feed-v9uz5). The
      // row above counted one starved poll, but the assertion judges playback by reading the page
      // TWICE, so that stage encloses two - and one starved poll would have bounded the first read
      // while leaving the second to the 120s hang ceiling, which is a sum of two waits reported as
      // a hang. The count is derived, so a host as starved as the measurement still fits both.
      assertEquals(
        PLAYBACK_ADVANCE_SAMPLE_BUDGET_MS,
        2 * MEASURED_STARVED_POLL_MS + PLAYBACK_ADVANCE_SAMPLE_MS,
        "PLAYBACK_ADVANCE_SAMPLE_BUDGET_MS must be TWO measured starved polls (the two currentTime " +
          "reads) plus the 1.2s window between them, not one",
      );
      assert(
        PLAYBACK_ADVANCE_SAMPLE_BUDGET_MS < HANG_BOUND_MS,
        "the sample budget is a product budget, so it stays under the hang ceiling",
      );
      assertEquals(BOOTSTRAP_REDIRECT_LATENCY_MS, 10_000, "the redirect budget is its own literal");

      // 15b. The GUARD is pinned, not only the constants it happens to accept (audio-feed-zkto5).
      // Every row above stays green when the ceiling check is deleted, because with the current
      // budgets nothing observable changes - the previous gate proved exactly that ("deleting the
      // import guard with sane budgets stays green"). So the rule is exercised directly: the
      // exported guard, handed an over-ceiling budget, must THROW, and handed each real budget it
      // must NOT. `ceilMs` is a parameter for this row only, so a budget can be driven over the
      // ceiling without a source constant being mutated at test time - a mutant that changes a
      // source line is the same edit the guard exists to catch, not a test of it.
      for (
        const [name, budgetMs] of Object.entries({
          PLAYBACK_ADVANCE_WAIT_MS,
          PLAYBACK_ADVANCE_SAMPLE_BUDGET_MS,
          BOOTSTRAP_REDIRECT_LATENCY_MS,
        })
      ) {
        assertBudgetBelowHang(name, budgetMs);
      }
      for (const overCeilingMs of [HANG_BOUND_MS, HANG_BOUND_MS + 60_000]) {
        const overCeiling = assertThrows(
          () => assertBudgetBelowHang("PLAYBACK_ADVANCE_WAIT_MS", overCeilingMs),
          Error,
          undefined,
          `${overCeilingMs}ms is at or above the ${HANG_BOUND_MS}ms ceiling, so the guard must ` +
            "reject it rather than let a product wait outlive the bound it fails under",
        );
        // The failure has to be actionable in a gate log: the budget by name and value, and the
        // ceiling it was judged against.
        assertStringIncludes(overCeiling.message, "PLAYBACK_ADVANCE_WAIT_MS");
        assertStringIncludes(overCeiling.message, `${overCeilingMs}ms`);
        assertStringIncludes(overCeiling.message, `${HANG_BOUND_MS}ms`);
      }
      // The rule is only enforced where it is APPLIED. The import-time loop is what makes a bad
      // constant fail at import instead of at a browser row nobody re-derives, and deleting the
      // loop while keeping the function would leave every suite green again.
      const budgetsSource = await Deno.readTextFile(
        new URL("../scripts/proof-latency-budgets.ts", import.meta.url),
      );
      assertStringIncludes(budgetsSource, "assertBudgetBelowHang(name, budgetMs);");
      const playbackProof = await Deno.readTextFile(
        new URL("../scripts/playback-csp-browser-proof.ts", import.meta.url),
      );
      // 15c. Both stages CLAMP the evaluate they enclose to what is left of their budget
      // (audio-feed-v9uz5). A total deadline tested only between awaits is not a bound on the
      // evaluate in flight: the poll that starts 1ms before the deadline may still run to the 120s
      // hang ceiling, so a starved host reds the row for a press it answered. Source-pinned because
      // the property is the clamp at the call site, which no unit row can see.
      assert(
        /while \(Date\.now\(\) < startDeadline\)/u.test(playbackProof) &&
          /const startDeadline = Date\.now\(\) \+ PLAYBACK_ADVANCE_WAIT_MS;/u.test(playbackProof),
        "the playback START poll loop must run to a deadline derived from PLAYBACK_ADVANCE_WAIT_MS",
      );
      assert(
        playbackProof.includes("const remainingMs = Math.max(1, startDeadline - Date.now());") &&
          playbackProof.includes("remainingMs,"),
        "each START poll's evaluate must be clamped to what is left of PLAYBACK_ADVANCE_WAIT_MS",
      );
      assert(
        playbackProof.includes(
          "const sampleDeadline = Date.now() + PLAYBACK_ADVANCE_SAMPLE_BUDGET_MS;",
        ) &&
          playbackProof.split("Math.max(1, sampleDeadline - Date.now())").length === 3,
        "both currentTime sample reads must be clamped to PLAYBACK_ADVANCE_SAMPLE_BUDGET_MS",
      );
      assert(
        !playbackProof.includes("HANG_BOUND_MS /") &&
          !playbackProof.includes("HANG_BOUND_MS/"),
        "playback-csp-browser-proof.ts must not derive a product budget from HANG_BOUND_MS",
      );
      assert(
        // The start budget is only measured if the loop's own result is judged: `advanced` is what
        // reds the row when the press takes longer than the budget, so a check that omits it makes
        // the budget decorative (this row reddened with the field removed - the mutant in
        // audio-feed-c0l7b).
        /check\(\s*"the audio element reached a PLAYING state[^"]*",\s*advanced && /u.test(
          playbackProof,
        ),
        "the PLAYING check must require `advanced`, so a start slower than the budget reds the row",
      );
      for (const [swept, bootstrapProof] of sweptProofs) {
        assertStringIncludes(bootstrapProof, "BOOTSTRAP_REDIRECT_LATENCY_MS,");
        assert(
          /"redirect to \/admin",\s*BOOTSTRAP_REDIRECT_LATENCY_MS,/u.test(bootstrapProof),
          `${swept} /admin redirect wait must carry the product budget, not HANG_BOUND_MS`,
        );
      }
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

Deno.test(
  "proof-cdp: cdp() bounds its OWN reply - a command the browser never answers fails at the shared default naming the method and the line that sent it, with the command sent once",
  async () => {
    // WHY THIS ROW EXISTS (audio-feed-54f8j): cdp() awaited a promise only a WebSocket reply could
    // settle, with no timer. Every raw command a proof sends - Page.navigate,
    // Page.captureScreenshot, WebAuthn.* - was therefore unbounded for the proof that awaited it,
    // and a browser that never answered parked the proof until the lane's killer arrived. The
    // bound now lives INSIDE the client, so this row is about the DEFAULT a call site inherits by
    // saying nothing: it must fire at HANG_BOUND_MS, not never, and the message must name the
    // command and the proof line that sent it rather than the wrapper that bounded it.
    //
    // Driven on the FAKE clock for the same reason as the js()/until() defaults above: a row that
    // waited out a two-minute hang would cost a gate slot for nothing, and host promptness is not
    // a property of the bound.
    const ac = new AbortController();
    let serverPort = 0;
    const silent = new Map<string, number>();
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
          if (msg.method === "Page.enable") {
            socket.send(JSON.stringify({ id: msg.id, result: { enabled: true } }));
            return;
          }
          // Counted and deliberately UNANSWERED: the reply never comes, which is the hang.
          silent.set(msg.method, (silent.get(msg.method) ?? 0) + 1);
        };
        return response;
      }
      return new Response("not found", { status: 404 });
    });

    try {
      await listening;
      const client = await connectCdp({ port: serverPort });
      try {
        // 1. NO budget stated: the inherited default is HANG_BOUND_MS.
        const defaultClock = new FakeTime();
        let defaultError: unknown = null;
        let defaultSettled = false;
        let defaultElapsed = -1;
        try {
          const start = Date.now();
          void client.cdp("Page.captureScreenshot").then(
            () => {
              defaultSettled = true;
            },
            (err: unknown) => {
              defaultSettled = true;
              defaultError = err;
            },
          );
          await defaultClock.tickAsync(HANG_BOUND_MS);
          await defaultClock.runMicrotasks();
          defaultElapsed = Date.now() - start;
        } finally {
          defaultClock.restore();
        }
        assert(
          defaultSettled,
          "a cdp() call with no budget must settle at HANG_BOUND_MS: the screenshot was never " +
            "answered, so the race had to have settled - it was still pending after the default",
        );
        assertEquals(
          defaultElapsed,
          HANG_BOUND_MS,
          "cdp() must inherit HANG_BOUND_MS, not wait for ever and not a fixed 8s",
        );
        assert(
          defaultError instanceof CdpHangBoundExceeded,
          `a never-answered command must reject as CdpHangBoundExceeded, got ${
            String(defaultError)
          }`,
        );
        const message = (defaultError as Error).message;
        // Names the METHOD ...
        assertStringIncludes(message, "cdp: the `Page.captureScreenshot` reply never arrived");
        assertStringIncludes(message, `within ${HANG_BOUND_MS}ms`);
        // ... and the CALL SITE: this file, at a line, never the wrapper in scripts/proof-cdp.ts.
        assert(
          /tests\/proof_cdp_test\.ts:\d+:\d+/u.test(message),
          `the failure must name the proof line that sent the command, got: ${message}`,
        );
        assert(
          !message.includes("scripts/proof-cdp.ts"),
          `the failure must name the call site, not the wrapper that bounded it: ${message}`,
        );

        // 2. A CALLER OPTS INTO A LONGER BOUND (the genuinely-slow method case, e.g.
        // Page.navigate): the budget it states is the budget that fires, and it is still one
        // command, named.
        const slowClock = new FakeTime();
        let slowError: unknown = null;
        let slowSettled = false;
        let slowElapsed = -1;
        const slowBudgetMs = 2 * HANG_BOUND_MS;
        try {
          const start = Date.now();
          void client.cdp("Page.navigate", { url: "http://127.0.0.1:1/never" }, slowBudgetMs).then(
            () => {
              slowSettled = true;
            },
            (err: unknown) => {
              slowSettled = true;
              slowError = err;
            },
          );
          await slowClock.tickAsync(slowBudgetMs);
          await slowClock.runMicrotasks();
          slowElapsed = Date.now() - start;
        } finally {
          slowClock.restore();
        }
        assert(
          slowSettled,
          "an explicitly stated budget must be the deadline in force: the navigate was never " +
            "answered, so the race had to have settled",
        );
        assertEquals(
          slowElapsed,
          slowBudgetMs,
          "the bound must fire at the budget the caller stated, not at the shared default",
        );
        assert(
          slowError instanceof CdpHangBoundExceeded,
          `a never-answered navigate must reject as CdpHangBoundExceeded, got ${String(slowError)}`,
        );
        assertStringIncludes(
          (slowError as Error).message,
          `cdp: the \`Page.navigate\` reply never arrived within ${slowBudgetMs}ms`,
        );

        // 3. The client still works after a bound fired, and each command was sent exactly once -
        // a bound, not a retry loop, and not a dead socket.
        await client.cdp("Page.enable");
        assertEquals(silent.get("Page.captureScreenshot"), 1);
        assertEquals(silent.get("Page.navigate"), 1);

        // 4. THE WIRING, pinned as a source assertion the way this file already pins the other
        // two defaults: the bound is a SIGNATURE default on cdp(), so a new call site cannot be
        // written unbounded by omission. Reading the file is what makes that checkable without
        // waiting out a two-minute hang.
        const sharedSource = await Deno.readTextFile(
          new URL("../scripts/proof-cdp.ts", import.meta.url),
        );
        assert(
          /params: Record<string, unknown> = \{\},\s*timeoutMs = HANG_BOUND_MS,/u.test(
            sharedSource,
          ),
          "cdp() must carry `timeoutMs = HANG_BOUND_MS` as a signature default",
        );
        assertStringIncludes(
          sharedSource,
          "msg = await boundedCdpReply(method, reply, cdp, timeoutMs)",
        );
      } finally {
        client.close();
      }
    } finally {
      ac.abort();
      await server.finished;
    }
  },
);

Deno.test(
  "proof-cdp: REAL CLOCK - cdp() settles as a named CdpHangBoundExceeded naming the method when the browser never answers, instead of hanging the row",
  async () => {
    // This is the reproduction the bug was filed from: a browser that never answers a raw
    // command used to park the proof past its last PASS (measured: 11/11 PASS printed and never
    // exiting). The bound is stated SMALL here because the property is that the wait ENDS, and
    // the row carries its own guard deadline so a fix whose timer never fires fails the row in
    // bounded time rather than hanging the runner. `deno test` for this file is run under a hard
    // `timeout` for the same reason.
    const boundMs = 400;
    const guardMs = 2_000;
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
        socket.onmessage = () => {
          // Received and never answered: exactly a screenshot the browser's main thread never
          // serves. Nothing but the cdp() bound can end the wait.
          silentCount++;
        };
        return response;
      }
      return new Response("not found", { status: 404 });
    });

    let guardTimer: ReturnType<typeof setTimeout> | 0 = 0;
    try {
      await listening;
      const client = await connectCdp({ port: serverPort });
      try {
        const startedAt = Date.now();
        const err = await Promise.race([
          client.cdp("Page.captureScreenshot", { format: "png" }, boundMs),
          new Promise<void>((resolve) => {
            guardTimer = setTimeout(resolve, guardMs);
          }).then(() => {
            throw new Error(
              `the row never settled: cdp()'s ${boundMs}ms bound did not fire within ${guardMs}ms`,
            );
          }),
        ]).then(() => null, (e: unknown) => e);
        const elapsed = Date.now() - startedAt;
        assert(
          err instanceof CdpHangBoundExceeded,
          `a never-answered command must SETTLE as CdpHangBoundExceeded (elapsed ${elapsed}ms), ` +
            `got ${String(err)}`,
        );
        const message = (err as Error).message;
        assertStringIncludes(message, "`Page.captureScreenshot` reply never arrived");
        assertStringIncludes(message, `within ${boundMs}ms`);
        assert(
          /tests\/proof_cdp_test\.ts:\d+:\d+/u.test(message),
          `the failure must name the proof line that sent the command, got: ${message}`,
        );
        assertEquals(
          silentCount,
          1,
          `the command must have been sent exactly once; server saw ${silentCount}`,
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

/** `scripts/` and `tests/`: the two roots a DevTools client can live in. */
const SCRIPTS_DIR = new URL("../scripts/", import.meta.url);
const TESTS_DIR = new URL("../tests/", import.meta.url);

/** The shared client - the one file that opens a DevTools socket without being classified below. */
const SHARED_CLIENT = "proof-cdp.ts";

/**
 * What a client that MUST hang says so with (audio-feed-9go2t), and what has to follow it: a
 * reason. An unannotated unbounded await is indistinguishable from the bug, so the annotation is
 * only worth anything if the NEXT reader can tell why it is deliberate.
 */
const DELIBERATE_ANNOTATION = "DELIBERATELY unbounded";

/**
 * The vocabulary of a DevTools endpoint: the target's own `webSocketDebuggerUrl`, the helper that
 * reads DevToolsActivePort, or the /json endpoints that hand that URL out.
 *
 * A HINT, never a filter (audio-feed-h8cam review, P1). The census derives on ANY
 * `new WebSocket(` because filtering on THIS vocabulary is exactly the blind spot a one-variable
 * refactor defeats: a client that binds `const ep = await devtoolsEndpoint(); new WebSocket(ep)`,
 * or inlines `ws://127.0.0.1:<port>/devtools/browser/...`, names none of these strings in its
 * socket argument and so escaped the census silently - dodging all four rules with no message.
 * The vocabulary is now read for one thing only: which classification the FAILURE MESSAGE should
 * suggest to the operator.
 */
const DEVTOOLS_VOCABULARY = [
  "webSocketDebuggerUrl",
  "devtoolsEndpoint",
  "DevToolsActivePort",
  "/json/list",
  "/json/new",
] as const;

/** Which DevTools vocabulary this text names, in the order above - empty means none of it. */
function devtoolsVocabularyIn(text: string): string[] {
  return DEVTOOLS_VOCABULARY.filter((word) => text.includes(word));
}

/** `scripts/foo.ts` -> `foo.ts`: how the lists below name a file, and how the census reads it out
 * of a path it computed rather than spelled. */
function baseNameOf(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * The reason after a DELIBERATELY-unbounded annotation, or null when there is no annotation or no
 * reason. Ten characters is not a style rule: it is enough that "- it hangs" cannot pass as one.
 */
function deliberateReason(source: string): string | null {
  const at = source.indexOf(DELIBERATE_ANNOTATION);
  if (at === -1) return null;
  const tail = source.slice(at + DELIBERATE_ANNOTATION.length).split("\n")[0] ?? "";
  const match = /^\s*[-:\u2013]\s*(\S.{9,})/u.exec(tail);
  return match?.[1]?.trim() ?? null;
}

/** One line with its `//` comment removed - `://` is a URL, not a comment. */
function cutLineComment(line: string): string {
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] === "/" && line[i + 1] === "/" && line[i - 1] !== ":") return line.slice(0, i);
  }
  return line;
}

/**
 * Source with comments removed, so the census sees CODE. Comment lines are not cosmetic here:
 * `new WebSocket(page.webSocketDebuggerUrl)` appears inside a comment in this very file, and a
 * matcher that counted it would demand a bound from a file that opens no socket at all.
 */
function codeOnly(source: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const line of source.split("\n")) {
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      inBlock = false;
      kept.push(line.slice(end + 2));
      continue;
    }
    const start = line.indexOf("/*");
    if (start !== -1 && line.indexOf("*/", start) === -1) {
      inBlock = true;
      kept.push(line.slice(0, start));
      continue;
    }
    kept.push(cutLineComment(line));
  }
  return kept.join("\n");
}

/** The argument text of every `new WebSocket(...)` in `code`, paren-balanced because one of them
 * (scripts/playback-position-browser-proof.ts) spans lines and contains its own calls. */
function socketArguments(code: string): string[] {
  const open = "new WebSocket(";
  const args: string[] = [];
  for (let at = code.indexOf(open); at !== -1; at = code.indexOf(open, at + 1)) {
    let depth = 0;
    let i = at + open.length - 1;
    for (; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) {
        i++;
        break;
      }
    }
    args.push(code.slice(at + open.length, i - 1));
  }
  return args;
}

/**
 * The socket arguments this source dials - EMPTY means it opens no socket at all, and nothing else
 * excludes it. Deriving on the presence of `new WebSocket(` rather than on what its argument names
 * is what closes the blind spot: the argument can be a variable, an awaited helper or an inline
 * URL, and every one of those is still a socket this census has to see.
 */
function socketArgumentsOf(source: string): string[] {
  return socketArguments(codeOnly(source));
}

/**
 * What the unclassified failure says AFTER naming the file: which classification it most likely
 * wants. It is derived from the file's own text, read for the vocabulary only, and it decides
 * nothing.
 *
 * Three cases, because the blind spot this bead closed is one of them: an argument that names a
 * DevTools endpoint is almost certainly a client; an argument that names NONE while the file names
 * one elsewhere is the variable-bound shape (`const ep = await devtoolsEndpoint(); new
 * WebSocket(ep)`), which must not be nudged towards `nonDevtoolsClients`; and a file with no
 * vocabulary anywhere is the only case where a non-DevTools socket is the likely answer.
 */
function classificationHint(args: string[], source: string): string {
  const inArgument = devtoolsVocabularyIn(args.join("\n"));
  if (inArgument.length > 0) {
    return `its socket argument names ${inArgument.join(" / ")}, so it is almost certainly a ` +
      `DevTools client: bound its reply, annotate it "${DELIBERATE_ANNOTATION} - <reason>", or ` +
      "prove its own bound";
  }
  const inFile = devtoolsVocabularyIn(source);
  if (inFile.length > 0) {
    return `its socket argument names no DevTools endpoint, but the file names ${
      inFile.join(" / ")
    } - a client that binds the endpoint to a variable first looks exactly like this, so bound its ` +
      `reply or annotate it "${DELIBERATE_ANNOTATION} - <reason>"; if it is not a DevTools client ` +
      "at all, list it in nonDevtoolsClients with a one-line reason";
  }
  return "neither its socket argument nor the rest of the file names any DevTools vocabulary, so " +
    "if it is not a DevTools client at all, list it in nonDevtoolsClients with a one-line reason";
}

/** Every `.ts` file under `dir`, recursively - a census that stopped at the top level would miss
 * `tests/auth/`, and the same hole would reopen one directory down. The name is COMPUTED from the
 * readDir entry, never a literal, so the walk derives no read relation on the directory. */
async function* typeScriptFiles(
  dir: URL,
  prefix: string,
): AsyncGenerator<{ name: string; url: URL }> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) {
      if (entry.name.startsWith(".")) continue;
      yield* typeScriptFiles(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      yield { name: `${prefix}${entry.name}`, url: new URL(entry.name, dir) };
    }
  }
}

/**
 * The clients that bound their OWN `cdp()` reply (audio-feed-9go2t), and the ones that hang on
 * purpose. These lists are the ASSERTION PAYLOAD - what each named file must carry. They are NOT
 * the population: the census below derives that by walking scripts/ and tests/, so a file added
 * tomorrow cannot be unlisted and a file listed here that stops being a client is caught too.
 *
 * The paths are LITERAL URLs, one per client. A template-built path here would derive a
 * directory relation on `scripts/` and widen the fast gate's selection for every script change -
 * the same reason the swept-proof row above spells its two paths out.
 */
const boundedClients = [
  new URL("../scripts/account-mobile-layout-proof.ts", import.meta.url),
  new URL("../scripts/csp-nonce-browser-proof.ts", import.meta.url),
  new URL("../scripts/exww-live-claims-browser-proof.ts", import.meta.url),
  new URL("../scripts/failure-diagnostics-browser-proof.ts", import.meta.url),
  new URL("../scripts/home-module-browser-proof.ts", import.meta.url),
  new URL("../scripts/landing-tooltip-browser-proof.ts", import.meta.url),
  new URL("../scripts/passkey-provider-browser-proof.ts", import.meta.url),
  new URL("../scripts/playback-position-browser-proof.ts", import.meta.url),
  new URL("../scripts/repro_b6nr_token_storage.ts", import.meta.url),
  new URL("../scripts/request-access-browser-proof.ts", import.meta.url),
  new URL("../scripts/spend-visibility-browser-proof.ts", import.meta.url),
  new URL("../scripts/tokens-browser-proof.ts", import.meta.url),
  new URL("../scripts/verify_3asd_bookmarklet_browser.ts", import.meta.url),
  new URL("../scripts/verify_dfbu_pagehide_browser.ts", import.meta.url),
  new URL("../scripts/verify_ieek_canonical_urls.ts", import.meta.url),
  new URL("../scripts/verify_kvnw_account_bookmarklet_browser.ts", import.meta.url),
  new URL("../scripts/verify_main_l7m1_e2e.ts", import.meta.url),
  new URL("../tests/listen_activity_test.ts", import.meta.url),
  new URL("../tests/sticky_scroll_state_test.ts", import.meta.url),
  new URL("../tests/view_transitions_test.ts", import.meta.url),
];

/**
 * The clients that were already bounded before the shared helper existed: `send()`'s signature
 * defaults `timeoutMs` and its expiry RESOLVES with an error (then throws at the call site), which
 * is the same guarantee in a different shape, so it cannot satisfy the boundedClients assertions.
 * The census is what found it: it dials the DevTools endpoint directly and was unlisted while the
 * hand list was the population. Its claim is checkable, so it is CHECKED rather than annotated.
 */
const selfBoundedClients = [new URL("../scripts/regenerate-browser-proof.ts", import.meta.url)];

/**
 * The clients that must stay UNBOUNDED, because they are the fixture for the hang: a client that
 * never resolves, or resolves only on demand, is what proves a hung navigation is a named, bounded
 * failure while the navigate is still in flight. Bounding one of these would manufacture an
 * unhandled rejection, so each carries the DELIBERATE annotation and a reason instead.
 */
const deliberateClients = [
  new URL("../tests/css_escape_guard_test.ts", import.meta.url),
  new URL("../scripts/verify_i7vi_browser.ts", import.meta.url),
  new URL("../scripts/verify_s3uk_real_browser.ts", import.meta.url),
];

/**
 * The fifth classification (audio-feed-h8cam review, P1): files that open a `new WebSocket(` and
 * are NOT DevTools clients at all, so none of the four rules above can be what they satisfy. Each
 * carries a one-line reason, because an exclusion nobody wrote down is the same failure as a
 * socket nobody listed - the census derived it, so the census has to account for it out loud.
 *
 * NAMES, not literal URLs: the reason IS the payload, so there is nothing to read back from the
 * file, and a literal `new URL("../tests/...")` here would derive a self-read relation on
 * tests/proof_cdp_test.ts and move the selection audit for a suite that is already selected by
 * being the changed file. The STALE check below keeps each name honest against the derived
 * population, and the census rejects a name whose socket argument or file text DOES name DevTools
 * vocabulary - otherwise this classification would be a bypass of all four rules, not a record of
 * an exclusion.
 */
const nonDevtoolsClients: { name: string; reason: string }[] = [
  {
    name: "proof_cdp_test.ts",
    reason: "the only `new WebSocket(` in its CODE is this census's own needle string " +
      '(`const open = "new WebSocket("`); its mock servers FABRICATE DevTools endpoints with ' +
      "upgradeWebSocket(req) and dial none",
  },
];

Deno.test(
  "proof-cdp: every private DevTools client bounds its OWN cdp() reply, and the clients that hang on purpose say so (audio-feed-9go2t)",
  async () => {
    // audio-feed-54f8j bounded the SHARED client. The proofs below open their own socket
    // (`new WebSocket(page.webSocketDebuggerUrl)` + a pending map) and awaited a reply only a
    // WebSocket frame could settle, so `Page.navigate`, `Page.captureScreenshot` and
    // `WebAuthn.*` were unbounded for whichever proof awaited them. The fix is a signature
    // default on each file's OWN `cdp()` - the one place its call sites go through - so a new
    // call site cannot be written unbounded by omission, exactly as the shared client's row
    // above pins it. Source-pinned for the same reason: the behaviour the bound buys is the
    // shared client's own rows, and waiting out a two-minute hang is not a test.
    for (const url of boundedClients) {
      const name = url.pathname.split("/").pop() ?? url.pathname;
      const source = await Deno.readTextFile(url);
      assert(
        source.includes("boundedCdpReply(method, reply,") ||
          source.includes("boundedCdpReply(method, reply, "),
        `${name} opens its own DevTools socket, so its own cdp() must bound the reply it awaits`,
      );
      assert(
        /timeoutMs = HANG_BOUND_MS/u.test(source),
        `${name}: the bound must be a signature default on cdp(), not something a caller passes`,
      );
    }

    // The other side of the same rule: a client that never resolves, or resolves only on demand,
    // is the FIXTURE for the hang case (the row that proves a hung navigation is a named,
    // bounded failure while the navigate is still in flight). It must stay unbounded - and it
    // must SAY so, because an unannotated unbounded await is indistinguishable from the bug
    // above and the next sweep would "fix" it.
    for (const url of deliberateClients) {
      const name = url.pathname.split("/").pop() ?? url.pathname;
      const source = await Deno.readTextFile(url);
      assertStringIncludes(source, "audio-feed-9go2t: DELIBERATELY unbounded");
      assert(
        !source.includes("boundedCdpReply(method, reply,"),
        `${name}: its client resolves on demand with no reject path, so bounding it would ` +
          "manufacture an unhandled rejection - leave it unbounded and annotated",
      );
    }
    // listen_activity holds BOTH kinds in one file: two bounded clients and the hung-navigation
    // row's deliberate one, so it is checked for both rather than listed on one side.
    const listenSource = await Deno.readTextFile(
      new URL("../tests/listen_activity_test.ts", import.meta.url),
    );
    assertStringIncludes(listenSource, "audio-feed-9go2t: DELIBERATELY unbounded");
  },
);

Deno.test(
  "proof-cdp: the DevTools-client census DERIVES its population from scripts/ and tests/, so an unlisted socket or a removed annotation reds it (audio-feed-h8cam)",
  async () => {
    // WHY THIS ROW EXISTS: the row above is source-pinned against a HAND LIST, so it guards the
    // clients someone remembered to type. A twenty-fifth proof script could open its own
    // `new WebSocket(page.webSocketDebuggerUrl)` tomorrow and nothing redded - the same
    // vocabulary failure as the bare-literal and fixture gaps before it. The population here is
    // DERIVED (readDir + a computed name, so it leaves no read relation and does not widen the
    // fast gate's selection - tests/css_escape_guard_test.ts made the same call), and the lists
    // above stay as the assertion payload.
    //
    // WHAT IT DERIVES ON IS THE POINT (audio-feed-h8cam review, P1). ANY `new WebSocket(` counts,
    // whatever its argument says. The first cut required one of four DevTools vocabulary strings
    // INSIDE the argument, so a client that binds `const ep = await devtoolsEndpoint(); new
    // WebSocket(ep)` - or inlines `ws://127.0.0.1:<port>/devtools/browser/...` - derived nothing
    // at all and dodged every rule below in silence. Every file that opens a socket is now
    // derived and has to be classified one of five ways:
    //
    //   1. the SHARED client, scripts/proof-cdp.ts;
    //   2. BOUNDED - its own cdp() bounds its reply (the row above asserts that payload);
    //   3. DELIBERATE - annotated "DELIBERATELY unbounded - <reason>" AND carries the reason;
    //   4. SELF-BOUNDED - can prove the bound: a signature default on `timeoutMs` and a
    //      pending-map entry removed on the timeout path (a claim without the timer behind it is
    //      the unbounded await with a nicer comment);
    //   5. NON-DEVTOOLS - not a DevTools client at all, listed in nonDevtoolsClients with a
    //      one-line reason, so the exclusion is explicit and reviewable rather than invisible.
    //      A name whose socket argument or file text DOES name DevTools vocabulary is rejected:
    //      without that, this classification would be a bypass of all four rules instead of an
    //      exclusion.
    //
    // A derived file in none of those is NAMED, and the DevTools vocabulary is only a hint in that
    // message: it says which classification the file most likely wants and decides nothing.
    //
    // The rules fail in both directions: deleting the annotation from a deliberate client reds (a
    // deliberate hang turned back into the bug), and so does a listed name that stops opening a
    // socket - a stale entry keeps asserting a shape about a file that no longer has a client,
    // which is how a list rots into decoration.
    const bounded = new Set(boundedClients.map((url) => baseNameOf(url.pathname)));
    const deliberate = new Set(deliberateClients.map((url) => baseNameOf(url.pathname)));
    const selfBounded = new Set(selfBoundedClients.map((url) => baseNameOf(url.pathname)));
    const nonDevtools = new Map(nonDevtoolsClients.map((client) => [client.name, client.reason]));

    const unclassified: string[] = [];
    const unannotated: string[] = [];
    const unreasoned: string[] = [];
    const misclassified: string[] = [];
    const unproven: string[] = [];
    const derived: string[] = [];
    const roots: [URL, string][] = [[SCRIPTS_DIR, "scripts/"], [TESTS_DIR, "tests/"]];
    for (const [dir, prefix] of roots) {
      for await (const file of typeScriptFiles(dir, prefix)) {
        const source = await Deno.readTextFile(file.url);
        const args = socketArgumentsOf(source);
        if (args.length === 0) continue;
        const name = baseNameOf(file.name);
        derived.push(name);
        if (name === SHARED_CLIENT) continue;
        if (bounded.has(name)) continue;
        if (deliberate.has(name)) {
          if (deliberateReason(source) === null) {
            unannotated.push(
              `${file.name}: listed as a DELIBERATE hanger, but it carries no ` +
                `"${DELIBERATE_ANNOTATION} - <reason>" annotation`,
            );
          }
          continue;
        }
        if (selfBounded.has(name)) {
          if (!/timeoutMs = \d[\d_]*/u.test(source)) {
            unproven.push(
              `${file.name}: listed as self-bounded, but no \`timeoutMs = <ms>\` default`,
            );
          } else if (!/pending\.delete\(/u.test(source)) {
            unproven.push(
              `${file.name}: listed as self-bounded, but its timeout path leaves the pending ` +
                "entry in the map",
            );
          }
          continue;
        }
        if (nonDevtools.has(name)) {
          const inArgument = devtoolsVocabularyIn(args.join("\n"));
          // tests/proof_cdp_test.ts defines DEVTOOLS_VOCABULARY itself; any other file in
          // nonDevtoolsClients that names DevTools vocabulary anywhere in source is a DevTools
          // client (or variable-bound one) trying to hide behind a reason string.
          const inFile = name === "proof_cdp_test.ts" ? [] : devtoolsVocabularyIn(source);
          if (inArgument.length > 0) {
            misclassified.push(
              `${file.name}: listed as a non-DevTools socket, but its socket argument names ${
                inArgument.join(" / ")
              } - that is a DevTools client, so bound its reply, annotate it ` +
                `"${DELIBERATE_ANNOTATION} - <reason>", or prove its own bound`,
            );
          } else if (inFile.length > 0) {
            misclassified.push(
              `${file.name}: listed as a non-DevTools socket, but the file names ${
                inFile.join(" / ")
              } - that is a DevTools client (likely variable-bound), so bound its reply, annotate ` +
                `it "${DELIBERATE_ANNOTATION} - <reason>", or prove its own bound`,
            );
          } else if ((nonDevtools.get(name) ?? "").trim().length < 10) {
            unreasoned.push(
              `${file.name}: listed as a non-DevTools socket, but its reason is too short to ` +
                "explain the exclusion",
            );
          }
          continue;
        }
        unclassified.push(
          `${file.name}: opens a WebSocket via \`new WebSocket(...)\` and is none of the shared ` +
            `client (scripts/${SHARED_CLIENT}), a bounded client, a DELIBERATE hanger, a ` +
            `self-bounded one, or a listed non-DevTools socket - ${
              classificationHint(args, source)
            }`,
        );
      }
    }

    const stale = [...bounded, ...deliberate, ...selfBounded, ...nonDevtools.keys()].filter(
      (name) => !derived.includes(name),
    );

    // A low absolute sanity floor for a broken walk (a broken readDir finding nothing or almost
    // nothing), not a pin on today's population: a handful is enough to prove the walk traversed
    // the tree, while legitimate client removals clear it. The population itself is enforced in
    // both directions by the per-file classification (no unlisted additions) and the stale rule
    // below (no unlisted removals).
    assert(
      derived.length >= 5,
      `the census derived only ${derived.length} file(s) opening a WebSocket in scripts/ and ` +
        "tests/; the walk is broken, not the tree (expected at least a handful of clients)",
    );
    assert(unclassified.length === 0, unclassified.join("\n"));
    assert(unannotated.length === 0, unannotated.join("\n"));
    assert(unreasoned.length === 0, unreasoned.join("\n"));
    assert(misclassified.length === 0, misclassified.join("\n"));
    assert(unproven.length === 0, unproven.join("\n"));
    assert(
      stale.length === 0,
      `the population shrank - recount it and update the list (or fix the matcher): ` +
        `these are listed as socket-openers but no longer open one: ${stale.join(", ")}`,
    );
  },
);
