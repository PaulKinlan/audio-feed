/**
 * Repro and regression harness for audio-feed-0rmn — the script stage's two body-read catches
 * swallow an abort, so a deadline-killed read (or a caller cancel) reads back as a provider verdict.
 *
 * Run: timeout -k 30 300 deno run -A --config ./deno.json scripts/repro_0rmn_script_body_read.ts
 *
 * Everything is local: a scripted fetchFn returns a response whose body never arrives, so no
 * network call and no spend. Cases A/B are the deadline firing mid-body; C/D are the caller's lease
 * aborting mid-body; E are the two regression guards (an unreadable body and malformed JSON with no
 * abort at all must keep their original wording and, for a refusal, their status).
 *
 * The stages it drives are the real ones: createGroundedScriptGenerator, the same object the worker
 * runs before synthesis, with the same caller signal shape the worker passes.
 */
import { createGroundedScriptGenerator, GroundedScriptError } from "../src/worker/script.ts";

const OUT = new URL("../docs/evidence/audio-feed-0rmn/repro.json", import.meta.url);
const DEADLINE_MS = 200;
const STAGE_BOUND_MS = 10 * 60_000;

const ARTICLE = {
  title: "The Case Against Silent Defaults",
  author: "A. Writer",
  summary: "Defaults decide more than debate does.",
  body: "The article argues that defaults do the deciding, with three worked examples.",
};
const SPEAKERS = [
  { name: "Alex", role: "expert", voice: "Kore" },
  { name: "Sam", role: "curious_foil", voice: "Puck" },
] as const;

/** Headers arrive, the body never does: only the deadline (or a caller cancel) ends the read. */
const hangingBody = (status: number, statusText: string): typeof fetch =>
  ((_input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const signal = init?.signal;
            if (signal?.aborted) {
              controller.error(signal.reason);
              return;
            }
            signal?.addEventListener("abort", () => controller.error(signal.reason));
          },
        }),
        { status, statusText },
      ),
    )) as typeof fetch;

/** The caller's signal aborts one macrotask after the headers land, so the abort hits the read. */
const cancelDuringBody = (status: number, statusText: string, controller: AbortController) =>
  ((_input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            init?.signal?.addEventListener(
              "abort",
              () => streamController.error(init.signal?.reason),
            );
            setTimeout(() => controller.abort(new Error("lease expired")), 0);
          },
        }),
        { status, statusText },
      ),
    )) as typeof fetch;

interface Observed {
  message: string;
  status: number | undefined;
  type: string;
}

async function observe(
  fetchFn: typeof fetch,
  options: { timeoutMs: number; caller?: AbortSignal },
): Promise<Observed> {
  const generator = createGroundedScriptGenerator({
    apiKey: "unused",
    timeoutMs: options.timeoutMs,
    fetchFn,
  });
  try {
    await generator({ article: ARTICLE, speakers: [...SPEAKERS] }, { signal: options.caller });
    return { message: "(no error thrown)", status: undefined, type: "none" };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      status: error instanceof GroundedScriptError ? error.status : undefined,
      type: error instanceof Error ? error.constructor.name : typeof error,
    };
  }
}

const lease = AbortSignal.timeout(STAGE_BOUND_MS);
const cancelledRefusal = new AbortController();
const cancelledOk = new AbortController();

const caseDeadlineRefusal = await observe(hangingBody(503, "Service Unavailable"), {
  timeoutMs: DEADLINE_MS,
  caller: lease,
});
const caseDeadlineOk = await observe(hangingBody(200, "OK"), {
  timeoutMs: DEADLINE_MS,
  caller: lease,
});
const caseCancelRefusal = await observe(
  cancelDuringBody(503, "Service Unavailable", cancelledRefusal),
  { timeoutMs: 5_000, caller: cancelledRefusal.signal },
);
const caseCancelOk = await observe(cancelDuringBody(200, "OK", cancelledOk), {
  timeoutMs: 5_000,
  caller: cancelledOk.signal,
});
const caseUnreadableRefusal = await observe(
  () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
        { status: 502, statusText: "Bad Gateway" },
      ),
    ),
  { timeoutMs: 5_000 },
);
const caseMalformedJson = await observe(() => Promise.resolve(new Response("{not json")), {
  timeoutMs: 5_000,
});

const report = {
  bead: "audio-feed-0rmn",
  ranAt: new Date().toISOString(),
  runtime: `deno ${Deno.version.deno}`,
  property:
    "A body read that our deadline killed (or that the caller cancelled) must say so, instead of " +
    "reading back as an ordinary provider verdict; the refusal's status must survive it.",
  beforeFix: {
    measuredAt:
      "326e294 (origin/main before this branch; the fix reverted in src/worker/script.ts)",
    how: "deno test -A tests/grounded_script_test.ts --filter 0rmn, reading the assertion output",
    caseDeadlineRefusal: "script request was refused with 503",
    caseDeadlineOk: "script response was not JSON",
    caseCancelRefusal: "script request was refused with 503",
    caseCancelOk: "script response was not JSON",
    note:
      "No deadline value, no cancellation, and — for the two cancel cases — a lease expiry reported " +
      "as a provider refusal.",
  },
  afterFix: {
    caseDeadlineRefusal,
    caseDeadlineOk,
    caseCancelRefusal,
    caseCancelOk,
    caseUnreadableRefusal,
    caseMalformedJson,
  },
};
await Deno.mkdir(new URL(".", OUT), { recursive: true });
await Deno.writeTextFile(OUT, JSON.stringify(report, null, 2) + "\n");
console.error(`[0rmn] wrote ${OUT.pathname}`);

const ok = caseDeadlineRefusal.message.includes("refused with 503") &&
  caseDeadlineRefusal.message.includes(`timed out after ${DEADLINE_MS}ms`) &&
  caseDeadlineRefusal.status === 503 &&
  caseDeadlineOk.message.includes(
    `timed out after ${DEADLINE_MS}ms while reading the response body`,
  ) &&
  caseDeadlineOk.status === undefined &&
  caseCancelRefusal.message.includes("cancelled by the caller") &&
  caseCancelRefusal.status === undefined &&
  caseCancelOk.message.includes("cancelled by the caller") &&
  caseCancelOk.status === undefined &&
  caseUnreadableRefusal.message.includes("refused with 502") &&
  !caseUnreadableRefusal.message.includes("timed out") &&
  caseUnreadableRefusal.status === 502 &&
  caseMalformedJson.message.includes("was not JSON");
console.error(ok ? "[0rmn] PASS" : "[0rmn] FAIL");
if (!ok) Deno.exit(1);
