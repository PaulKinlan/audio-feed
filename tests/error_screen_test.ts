/**
 * The screen that stands between an unhandled error's message and the durable log store (audio-feed-sw1r).
 *
 * The property under test is NOT "the message looks clean". It is that the stored value is drawn from a
 * CLOSED SET this codebase authors, because that is the only property strong enough to make the canary
 * assertion in tests/log_request_surface_invariant_test.ts mean anything: a client-chosen string that happens
 * to be spelled with word characters survives any character filter or length bound, and the arriving string is
 * chosen by the attacker.
 */

import { assert, assertEquals } from "@std/assert";
import {
  isScreenOutput,
  KNOWN_ERROR_NAMES,
  KNOWN_ERROR_PHRASES,
  screenErrorForLogging,
  screenErrorMessage,
  screenErrorName,
  SUPPRESSED_MESSAGE,
} from "../src/observability/error_screen.ts";

const CANARY = "qV7z52CapSECRETfd39Nd";

Deno.test("audio-feed-sw1r: a client-chosen message is suppressed, not shortened", () => {
  // The whole point: a canary made of word characters and mixed case, which no character filter removes.
  assertEquals(screenErrorMessage(new Error(`test throw: ${CANARY}`)), SUPPRESSED_MESSAGE);
  assertEquals(screenErrorMessage(new Error(`${CANARY}`)), SUPPRESSED_MESSAGE);
  assertEquals(
    screenErrorMessage(new Error(`invalid host: ${CANARY}.example`)),
    SUPPRESSED_MESSAGE,
  );
  // Encoded and embedded variants are the same story: they are not authored here.
  assertEquals(screenErrorMessage(`m=${encodeURIComponent(CANARY)}`), SUPPRESSED_MESSAGE);
  // Not an Error at all, and nothing at all.
  assertEquals(screenErrorMessage({ message: CANARY }), SUPPRESSED_MESSAGE);
  assertEquals(screenErrorMessage(undefined), SUPPRESSED_MESSAGE);
});

Deno.test("audio-feed-sw1r: a phrase this codebase throws survives, and its TAIL is discarded", () => {
  const phrase = "Unauthorized: admin token required";
  assertEquals(screenErrorMessage(new Error(phrase)), phrase);
  // The tail is where a request gets quoted, so it is dropped rather than stored - the stored value is the
  // recognisable part, and nothing else.
  const withTail = new Error(`${phrase}: token=${CANARY}`);
  const screened = screenErrorMessage(withTail);
  assertEquals(screened, phrase);
  assertEquals(screened.includes(CANARY), false);
});

Deno.test("audio-feed-sw1r: the screen's output is CLOSED - only its own phrases or the suppression", () => {
  // This is the invariant the canary test leans on: no input can produce a value outside this set, so a
  // stored value that contains a canary is impossible rather than unlikely.
  const hostile: unknown[] = [
    new Error(`${CANARY}`),
    new Error(`Synthesis segment cannot fit in byte budget ${CANARY}`),
    new Error("x".repeat(5000) + CANARY),
    new Error("<script>alert('" + CANARY + "')</script>"),
    new Error(`${CANARY}\n${CANARY}\r\n${encodeURIComponent(CANARY)}`),
    new Error(""),
    new Error("Unauthorized: admin token required"),
    `raw string ${CANARY}`,
    { message: CANARY },
    null,
    undefined,
    42,
  ];
  for (const input of hostile) {
    const out = screenErrorMessage(input);
    assert(isScreenOutput(out), `the screen produced a value outside its closed set: ${out}`);
    assert(!out.includes(CANARY), `the canary survived the screen: ${out}`);
  }
});

Deno.test("audio-feed-sw1r: every phrase in the list has a throw site in this codebase", async () => {
  // A closed list is only honest while its members are real: a phrase nobody throws is dead weight that
  // makes the list look broader than the code, and this is the test that stops the list from rotting. It
  // also documents the rule for adding one - the phrase and its throw site land together.
  const sources: string[] = [];
  const walk = async (dir: string) => {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.name.endsWith(".ts")) sources.push(await Deno.readTextFile(path));
    }
  };
  await walk(new URL("../src", import.meta.url).pathname.replace(/\/$/, ""));
  const all = sources.join("\n");
  for (const phrase of KNOWN_ERROR_PHRASES) {
    assert(
      all.includes(`"${phrase}`),
      `no throw site in src/ contains the phrase: ${phrase}`,
    );
  }
});

Deno.test("audio-feed-ahx5: error name is screened to a closed set", () => {
  // A hostile custom name carrying a client token falls back to "Error"
  const hostile = new Error("msg");
  hostile.name = `CanaryName_${CANARY}`;
  assertEquals(screenErrorName(hostile), "Error");
  assertEquals(screenErrorName(new Error()), "Error");
  assertEquals(screenErrorName(new TypeError()), "TypeError");
  assertEquals(screenErrorName({ name: CANARY }), "Error");
  assertEquals(screenErrorName(null), "Error");

  // Standard and codebase error names survive
  for (const name of KNOWN_ERROR_NAMES) {
    const err = new Error("test");
    err.name = name;
    assertEquals(screenErrorName(err), name);
  }
});

Deno.test("audio-feed-ahx5: screenErrorForLogging eliminates canaries from message, name, and stack frames/locations", () => {
  // Error with client canaries in message, name, dynamic stack frame, and stack file location
  const err = new Error(`test throw: ${CANARY}`);
  err.name = `AttackerError_${CANARY}`;
  err.stack = `AttackerError_${CANARY}: test throw: ${CANARY}
    at Object.canaryDynamicFunction_${CANARY} (file:///app/${CANARY}/router.ts:100:20)
    at async handler_${CANARY} (file:///app/src/${CANARY}.ts:200:15)
    at ext:deno_http/00_serve.ts:1:500
    at maliciousStackTextWithoutLocation_${CANARY}`;

  const sanitized = screenErrorForLogging(err);

  // Name and message are screened
  assertEquals(sanitized.name, "Error");
  assertEquals(sanitized.message, SUPPRESSED_MESSAGE);

  // Stack contains only screened name and message; untrusted stack frames and locations are completely omitted
  assertEquals(sanitized.stack, `Error: ${SUPPRESSED_MESSAGE}`);
  assert(!String(sanitized.stack).includes(CANARY), `canary survived in stack: ${sanitized.stack}`);
});
