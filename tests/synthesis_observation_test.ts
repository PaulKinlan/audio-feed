/**
 * audio-feed-fipl / audio-feed-kx2m - the mutant matrix for "did we actually observe a synthesis?".
 *
 * This file exists because of two review findings on the same two live TTS controls, and the second
 * one is the reason it is shaped the way it is.
 *
 * audio-feed-fipl: the controls were narrowed from a POSITIVE claim (the provider refuses raw
 * article text) to a NEGATIVE one (the provider does not refuse it), and the negative form passed on
 * observations that were not observations at all - `finishReason !== "OTHER"` is true for a 500,
 * for an empty candidate list and for a malformed body. Absence of observation is not evidence of
 * absence.
 *
 * audio-feed-kx2m: the first positive replacement then invented its own notion of "usable audio"
 * (`audioBase64Length > 0`) and a payload that CANNOT BE DECODED has a length - `data: "%%%%"` on a
 * 200 with `finishReason: STOP` passed while the application's own decoder threw
 * `InvalidCharacterError`. The audio term is therefore not a proxy any more: the observation asks
 * production's `decodeAudioResponse` what it makes of the response that was actually observed.
 *
 * Every mutant below is a shape the unguarded versions accepted, or a shape the corrected version
 * must keep accepting. All of them run offline, with no paid provider call, so this cannot regress
 * the next time a provider response shape changes.
 */
import { assertEquals } from "@std/assert";
import { decodeAudioResponse, pcmToWav, uint8ArrayToBase64 } from "../src/tts/gemini.ts";
import {
  describeSynthesis,
  observeSynthesis,
  usableDecoded,
  usableSynthesis,
} from "../scripts/synthesis_observation.ts";

/** A genuine WAV built by the production encoder - what a real accepted run hands back. */
const realWavBody = () => ({
  candidates: [{
    finishReason: "STOP",
    content: {
      parts: [{
        inlineData: {
          mimeType: "audio/wav",
          data: uint8ArrayToBase64(
            pcmToWav(new Uint8Array(2400), {
              sampleRate: 24000,
              numChannels: 1,
              bitsPerSample: 16,
            }),
          ),
        },
      }],
    },
  }],
});

const audioBody = (data: string, finishReason: string) => ({
  candidates: [{
    finishReason,
    content: { parts: [{ inlineData: { mimeType: "audio/wav", data } }] },
  }],
});

Deno.test("audio-feed-kx2m (c): audio production really decodes is observed as usable", () => {
  const wav = observeSynthesis(200, realWavBody());
  assertEquals(wav.decoder, "accepted");
  assertEquals(usableSynthesis(wav), true);

  // The previous round's small valid payload must keep passing too: a control that rejects real
  // output gets switched off by whoever is on call.
  const raw = observeSynthesis(200, audioBody("QUJD", "STOP"));
  assertEquals(raw.decoder, "accepted");
  assertEquals(usableSynthesis(raw), true);
});

Deno.test("audio-feed-kx2m (a): a non-empty but undecodable payload is NOT usable speech", () => {
  const body = audioBody("%%%%", "STOP");
  // The mutant is real: production's own decoder refuses this exact response.
  let threw = false;
  try {
    decodeAudioResponse(body);
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "the mutant must be a payload production cannot decode");

  const observation = observeSynthesis(200, body);
  assertEquals(observation.candidateCount, 1);
  assertEquals(observation.finishReason, "STOP");
  assertEquals(observation.decoder, "rejected");
  assertEquals(usableSynthesis(observation), false);
});

Deno.test("audio-feed-kx2m (b): every payload the real decoder throws on is rejected", () => {
  for (const data of ["%%%%", "@@!!", "A", "not base64!", "AAAA===="]) {
    const observation = observeSynthesis(200, audioBody(data, "STOP"));
    assertEquals(
      usableSynthesis(observation),
      false,
      `data ${JSON.stringify(data)} must not read as usable speech`,
    );
  }
});

Deno.test("audio-feed-fipl (a): HTTP 200 with candidates:[] is NOT a usable observation", () => {
  const observation = observeSynthesis(200, { candidates: [] });
  assertEquals(observation.finishReason, undefined);
  assertEquals(observation.decoder, "not-attempted");
  assertEquals(usableSynthesis(observation), false);
});

Deno.test("audio-feed-fipl (b): HTTP 500 with no candidates is NOT a usable observation", () => {
  const observation = observeSynthesis(500, { error: { code: 500, message: "boom" } });
  assertEquals(observation.decoder, "not-attempted");
  assertEquals(usableSynthesis(observation), false);
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
  assertEquals(observation.decoder, "rejected");
  assertEquals(usableSynthesis(observation), false);
});

Deno.test("audio-feed-fipl: STOP without decodable audio is NOT a usable observation", () => {
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

  const emptyAudio = observeSynthesis(200, audioBody("", "STOP"));
  assertEquals(usableSynthesis(emptyAudio), false);
});

Deno.test("describeSynthesis prints what was observed, so a failing check cannot just say false", () => {
  assertEquals(
    describeSynthesis(observeSynthesis(500, {})),
    "status=500, candidates=0, finishReason=undefined, decoder=not-attempted, decodedBytes=0",
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
