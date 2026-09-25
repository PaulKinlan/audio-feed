/**
 * Environment configuration and store selection.
 *
 * Fails loudly at boot when a production backend is half-configured. A server
 * that silently falls back to an in-memory store in production loses every
 * episode on the next deploy, and looks healthy while doing it.
 *
 * Owned by: audio-feed-0h8.
 */

import type { BlobStore, MetadataStore } from "./storage/mod.ts";
import { MemoryBlobStore, MemoryMetadataStore } from "./storage/memory.ts";
import { KvMetadataStore } from "./storage/kv.ts";
import { S3BlobStore } from "./storage/s3.ts";
import { GEMINI_TTS_VOICES, type GeminiTtsVoice } from "./tts/gemini.ts";

export interface AppConfig {
  port: number;
  /**
   * Explicit public origin. OPTIONAL, and optional on purpose (audio-feed-0k3).
   *
   * This used to default to `http://localhost:<port>`, which meant a deployment
   * that set nothing believed its own origin was loopback — and told visitors to
   * subscribe to `http://localhost:8000/feed/...`. A guess is worse than an
   * absence here, because an absence can be resolved from the request that
   * actually arrived. See `src/origin.ts`.
   *
   * Set it when something upstream rewrites Host, or to pin a canonical domain.
   */
  publicBaseUrl?: string;
  /**
   * Trust `x-forwarded-proto` / `x-forwarded-host` when deriving the origin.
   *
   * Off unless an operator opts in, because those headers are hop-by-hop: any
   * client can set them, and only the operator knows whether a proxy in front
   * overwrites client-supplied values.
   */
  trustProxyHeaders?: boolean;
  /** Present only when TTS is configured; 65u owns its use. */
  geminiApiKey?: string;
  adminToken?: string;
  /**
   * System default voice, from DEFAULT_VOICE (audio-feed-4xt).
   *
   * Unset means "no system preference", which is different from Charon: the chain
   * still falls through to DEFAULT_NARRATION_VOICE, but a source or user voice set
   * later is not shadowed by a value invented here.
   *
   * Validated at load, not at synthesis time. An invalid name throws rather than
   * falling back, because a typo in DEFAULT_VOICE silently reading every article in
   * a different voice is the kind of wrong that looks healthy — the same reason this
   * file refuses a half-configured blob store instead of defaulting to memory.
   */
  defaultVoice?: GeminiTtsVoice;
}

function env(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value && value.trim() !== "" ? value.trim() : undefined;
}

export function loadConfig(): AppConfig {
  const port = Number(env("PORT") ?? 8000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env("PORT")}`);
  }
  const trust = env("TRUST_PROXY_HEADERS")?.toLowerCase();

  const defaultVoice = env("DEFAULT_VOICE")?.trim();
  if (defaultVoice) {
    // Fail closed at boot. Every voice actually used is validated downstream too,
    // but catching it here means an operator learns at deploy time, not after the
    // first paid synthesis of the day sounded wrong.
    if (!(GEMINI_TTS_VOICES as readonly string[]).includes(defaultVoice)) {
      throw new Error(
        `Invalid DEFAULT_VOICE: "${defaultVoice}". Expected one of: ${
          GEMINI_TTS_VOICES.join(", ")
        }.`,
      );
    }
  }

  return {
    port,
    // No localhost fallback. An unset value means "resolve it from the request",
    // which is the only thing that knows the real origin.
    publicBaseUrl: env("PUBLIC_BASE_URL")?.replace(/\/+$/, ""),
    trustProxyHeaders: trust === "1" || trust === "true" || trust === "yes",
    geminiApiKey: env("GEMINI_API_KEY"),
    adminToken: env("ADMIN_TOKEN"),
    defaultVoice: defaultVoice as GeminiTtsVoice | undefined,
  };
}

export interface Stores {
  metadata: MetadataStore;
  blobs: BlobStore;
  /** What was actually selected — logged at boot so prod misconfig is visible. */
  describe: string;
}

/**
 * Blob backend selection.
 *
 * All-or-nothing: either every S3 variable is present, or none are. A partial
 * set is a configuration error, never a silent downgrade to memory.
 */
export function selectBlobStore(): { store: BlobStore; describe: string } {
  const bucket = env("STORAGE_BUCKET");
  const endpoint = env("STORAGE_ENDPOINT");
  const accessKeyId = env("STORAGE_ACCESS_KEY_ID") ?? env("STORAGE_ACCESS_KEY");
  const secretAccessKey = env("STORAGE_SECRET_ACCESS_KEY") ?? env("STORAGE_SECRET_KEY");

  const provided = [bucket, endpoint, accessKeyId, secretAccessKey].filter(Boolean).length;

  if (provided === 0) {
    return { store: new MemoryBlobStore(), describe: "blobs=memory" };
  }
  if (provided < 4) {
    throw new Error(
      "Incomplete blob storage configuration. Set all of STORAGE_BUCKET, " +
        "STORAGE_ENDPOINT, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY, or none of them.",
    );
  }

  return {
    store: new S3BlobStore({
      bucket: bucket!,
      endpoint: endpoint!,
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      region: env("STORAGE_REGION"),
      publicBaseUrl: env("STORAGE_PUBLIC_BASE_URL"),
    }),
    describe: `blobs=s3(${bucket})`,
  };
}

export async function openStores(opts?: { kvPath?: string }): Promise<Stores> {
  const blob = selectBlobStore();
  const metadata = await KvMetadataStore.open(opts?.kvPath);
  return {
    metadata,
    blobs: blob.store,
    describe: `metadata=kv ${blob.describe}`,
  };
}

/** Fully in-memory stores, for tests and offline dev. */
export function memoryStores(): Stores {
  return {
    metadata: new MemoryMetadataStore(),
    blobs: new MemoryBlobStore(),
    describe: "metadata=memory blobs=memory",
  };
}
