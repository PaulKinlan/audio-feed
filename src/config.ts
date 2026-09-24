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

export interface AppConfig {
  port: number;
  /** Public origin, used to build absolute feed and enclosure URLs. */
  publicBaseUrl: string;
  /** Present only when TTS is configured; 65u owns its use. */
  geminiApiKey?: string;
  adminToken?: string;
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
  return {
    port,
    publicBaseUrl: (env("PUBLIC_BASE_URL") ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    geminiApiKey: env("GEMINI_API_KEY"),
    adminToken: env("ADMIN_TOKEN"),
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
  const accessKeyId = env("STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = env("STORAGE_SECRET_ACCESS_KEY");

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
