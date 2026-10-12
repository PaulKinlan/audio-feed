/**
 * audio-feed-fipl - the mutant matrix for "did we actually observe a synthesis?".
 *
 * This file exists because of a review finding on audio-feed-zrx9. The live TTS controls were
 * narrowed from a POSITIVE claim (the provider refuses raw article text: 200 + OTHER + no audio) to
 * a NEGATIVE one (the provider does not refuse it), and the negative form passed on observations
 * that were not observations at all - `finishReason !== "OTHER"` is true when the response is a
 * 500, when the candidate list is empty and when the body is malformed. The reviewer's one-liner -
 * `node -e "const x=undefined; console.log(200===200 && x!==\"OTHER\")"` printing `true` - IS the
 * defect: absence of observation rendered as evidence of absence.
 *
 * So the live checks now require usable speech to have been OBSERVED before they say anything about
 * a refusal, and the predicate they call is the one under test here. Each mutant below is a shape
 * that the unguarded check accepted; every one of them must stay FALSE, offline and with no paid
 * provider call, so this cannot regress the next time a provider response shape changes.
 */
import { assertEquals } from "@std/assert";
import {
  describeSynthesis,
  observeSynthesis,
  usableDecoded,
  usableSynthesis,
} from "../scripts/synthesis_observation.ts";

/** A complete, usable synthesis: the only shape that may conclude "the provider did not refuse". */
const usableBody = {
  candidates: [{
    finishReason: "STOP",
    content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "QUJD" } }] },
  }],
};

Deno.test("a completed synthesis is observed as usable", () => {
  const observation = observeSynthesis(200, usableBody);
  assertEquals(usableSynthesis(observation), true);
  assertEquals(observation.candidateCount, 1);
  assertEquals(observation.finishReason, "STOP");
  assertEquals(observation.audioBase64Length, 4);
});

Deno.test("audio-feed-fipl (a): HTTP 200 with candidates:[] is NOT a usable observation", () => {
  const observation = observeSynthesis(200, { candidates: [] });
  assertEquals(observation.finishReason, undefined);
  assertEquals(
    usableSynthesis(observation),
    false,
    "an empty candidate list is 'we did not get an answer', not 'the provider did not refuse'",
  );
});

Deno.test("audio-feed-fipl (b): HTTP 500 with no candidates is NOT a usable observation", () => {
  const observation = observeSynthesis(500, { error: { code: 500, message: "boom" } });
  assertEquals(
    usableSynthesis(observation),
    false,
    "a 500 is 'we did not get an answer', not 'the provider did not refuse'",
  );
});

Deno.test("audio-feed-fipl (c): a malformed or empty body is NOT a usable observation", () => {
  for (const body of [null, undefined, {}, [], "", "not json at all", 42]) {
    const observation = observeSynthesis(200, body);
    assertEquals(
      usableSynthesis(observation),
      false,
      `body ${JSON.stringify(body) ?? String(body)} must not read as a completed synthesis`,
    );
  }
});

Deno.test("audio-feed-fipl: a genuine OTHER refusal is NOT a usable observation", () => {
  const observation = observeSynthesis(200, {
    candidates: [{
      finishReason: "OTHER",
      finishMessage: "The generated content was filtered because it may contain material that " +
        "resembles existing copyrighted works.",
    }],
  });
  assertEquals(observation.finishReason, "OTHER");
  assertEquals(usableSynthesis(observation), false);
});

Deno.test("audio-feed-fipl: STOP without audio is NOT a usable observation", () => {
  const noParts = observeSynthesis(200, { candidates: [{ finishReason: "STOP" }] });
  assertEquals(usableSynthesis(noParts), false);

  const emptyParts = observeSynthesis(200, {
    candidates: [{ finishReason: "STOP", content: { parts: [] } }],
  });
  assertEquals(usableSynthesis(emptyParts), false);

  const textOnly = observeSynthesis(200, {
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "no audio here" }] } }],
  });
  assertEquals(usableSynthesis(textOnly), false);

  const emptyAudio = observeSynthesis(200, {
    candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { data: "" } }] } }],
  });
  assertEquals(usableSynthesis(emptyAudio), false);
});

Deno.test("describeSynthesis prints what was observed, so a failing check cannot just say false", () => {
  assertEquals(
    describeSynthesis(observeSynthesis(500, {})),
    "status=500, candidates=0, finishReason=undefined, audioBase64Length=0",
  );
});

Deno.test("usableDecoded requires the production client to return complete audio", () => {
  assertEquals(usableDecoded({ rawBytes: new Uint8Array([1, 2, 3]), finishReason: "STOP" }), true);
  assertEquals(usableDecoded({ rawBytes: new Uint8Array(0), finishReason: "STOP" }), false);
  assertEquals(
    usableDecoded({ rawBytes: new Uint8Array([1, 2, 3]), finishReason: "OTHER" }),
    false,
  );
  assertEquals(usableDecoded({ rawBytes: new Uint8Array([1, 2, 3]) }), false);
  assertEquals(usableDecoded(null), false);
});
