/**
 * `GET /assets/voices/:voice` — audition samples for the account page
 * (audio-feed-msw).
 *
 * The route reads a blob this deployment generated for itself; it is not a proxy
 * for user-supplied URLs and it is not an episode enclosure (`GET /audio/:key+`
 * keeps its Range semantics — a preview is neither seekable nor an episode).
 *
 * Registering it beside the icon route is deliberate: `public/` is not served, so
 * a file dropped there does nothing, and a route is the only way a byte reaches
 * the browser.
 *
 * The order of the guards is the security story, and it is tested in that order:
 * session -> allowlist -> cache/generate. Nothing before the allowlist check reads
 * the store or constructs a client; the voice name never becomes part of a key
 * that a caller chose.
 */
import type { AppContext } from "../app.ts";
import type { Handler } from "../router.ts";
import { notFound, problem, unauthorized } from "../http.ts";
import { sessionUser } from "../auth/sessions.ts";
import { GeminiTtsClient } from "../tts/gemini.ts";
import {
  isVoiceSampleName,
  synthesizeVoiceSample,
  VOICE_SAMPLE_CONTENT_TYPE,
  type VoiceSampleClient,
  VoiceSampleError,
  voiceSampleKey,
} from "../tts/voice-samples.ts";

export interface VoiceSampleDeps {
  /** Test seam; production builds the real client from `config.geminiApiKey`. */
  client?: VoiceSampleClient;
}

const IMMUTABLE = "public, max-age=86400, immutable";

function audio(
  body: BodyInit,
  size: number,
  source: "cached" | "generated",
  etag?: string,
): Response {
  return new Response(body, {
    headers: {
      "content-type": VOICE_SAMPLE_CONTENT_TYPE,
      "content-length": String(size),
      "cache-control": IMMUTABLE,
      // `generated` is honest about the first listener paying the synthesis, and
      // it lets a test (and an operator watching logs) tell cache hits from misses
      // without calling the API twice.
      "x-voice-sample": source,
      ...(etag ? { etag } : {}),
    },
  });
}

export function createVoiceSampleHandler(
  ctx: AppContext,
  deps: VoiceSampleDeps = {},
): Handler<AppContext> {
  /**
   * In-flight generations, keyed by blob key, closed over per app instance.
   *
   * Without this, five audition buttons clicked quickly — or two people opening
   * the page at once — run the same synthesis several times: same bytes, several
   * times the bill. The second caller waits on the first promise instead.
   */
  const inFlight = new Map<string, Promise<Uint8Array>>();

  return async ({ req, params }) => {
    const user = await sessionUser(ctx.stores.metadata, req);
    if (!user) return unauthorized("Sign in to audition voices.");

    const name = params.voice ?? "";
    if (!isVoiceSampleName(name)) return notFound("Unknown voice sample.");
    const key = voiceSampleKey(name);

    const cached = await ctx.stores.blobs.get(key);
    if (cached) {
      return audio(cached.body, cached.size, "cached", cached.etag);
    }

    if (!ctx.config.geminiApiKey && !deps.client) {
      return problem({
        status: 503,
        title: "synthesis_unavailable",
        detail: "Synthesis unavailable: GEMINI_API_KEY is not configured.",
      });
    }

    let pending = inFlight.get(key);
    if (!pending) {
      const client = deps.client ?? new GeminiTtsClient({ apiKey: ctx.config.geminiApiKey });
      pending = synthesizeVoiceSample(client, name)
        .then(async (bytes) => {
          // Cache under the versioned key: a later text/model change writes a new
          // key instead of overwriting clips that this text did not produce.
          await ctx.stores.blobs.put(key, bytes, { contentType: VOICE_SAMPLE_CONTENT_TYPE });
          return bytes;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, pending);
    }

    try {
      const bytes = await pending;
      // Both paths hand the response a STREAM: the cached path already has one, and a
      // bare Uint8Array is not a BodyInit in this runtime's types (nor does it need
      // to be — a four-second clip is one chunk).
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      return audio(stream, bytes.length, "generated");
    } catch (error) {
      if (error instanceof VoiceSampleError) {
        return problem({
          status: error.status,
          title: "sample_unavailable",
          detail: error.message,
        });
      }
      return problem({
        status: 502,
        title: "sample_unavailable",
        detail: "That sample could not be generated right now.",
      });
    }
  };
}
