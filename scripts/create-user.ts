/**
 * CLI tool to provision an approved user in the metadata store.
 *
 * Usage:
 *   deno run -A scripts/create-user.ts <email> [displayName]
 *
 * To connect to remote Deno Deploy KV:
 *   DENO_KV_ACCESS_TOKEN=... deno run -A scripts/create-user.ts <email> [displayName] --kv https://api.deno.com/databases/<db-id>/connect
 */

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { KvMetadataStore } from "../src/storage/kv.ts";
import { approveUser, createUser } from "../src/auth/users.ts";

const args = parseArgs(Deno.args, {
  string: ["kv", "origin"],
  default: {
    origin: Deno.env.get("PUBLIC_BASE_URL") ?? "https://audio-feed.paulkinlan-ea.deno.net",
  },
});

const email = args._[0]?.toString();
const displayName = args._[1]?.toString();

if (!email) {
  console.error(
    "Usage: deno run -A scripts/create-user.ts <email> [displayName] [--kv <path_or_url>]",
  );
  Deno.exit(1);
}

const store = await KvMetadataStore.open(args.kv);

try {
  console.log(`Creating user: ${email}...`);
  const user = await createUser(store, { email, displayName });
  const approved = await approveUser(store, user.id, "admin");

  const base = args.origin.replace(/\/+$/, "");
  console.log("\n✅ User created and approved successfully!\n");
  console.log(`User ID:        ${approved.id}`);
  console.log(`Email:          ${approved.email}`);
  console.log(`Display Name:   ${approved.displayName}`);
  console.log(`Status:         ${approved.status}`);
  console.log(`Feed Token:     ${user.feedToken}`);
  console.log("\n--- Podcast RSS Feed URLs ---");
  console.log(`Master Feed:    ${base}/feed/${user.feedToken}/master.xml`);
  console.log("\n--- Send-to-Audio Ingest ---");
  console.log(`Bearer Token:   ${user.feedToken}`);
  console.log(`Web UI:         ${base}/`);
  console.log(`CURL example:`);
  console.log(`  curl -X POST ${base}/api/ingest \\`);
  console.log(`    -H "content-type: application/json" \\`);
  console.log(`    -H "x-feed-token: ${user.feedToken}" \\`);
  console.log(`    -d '{"url":"https://example.com/article","mode":"dialogue"}'\n`);
} catch (err) {
  console.error(`❌ Failed: ${(err as Error).message}`);
  Deno.exit(1);
}
