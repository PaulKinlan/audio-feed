/**
 * The deploy fingerprint in /health (audio-feed-1552).
 *
 * Production has no other observable identity: the listen page is episode-token gated, feeds
 * are feedToken gated, admin/account need a session. /health is the one surface a lane can read
 * from outside, so it carries which revision is running.
 *
 * The route is driven through the real fetch handler (`createApp().fetch` is the same function
 * `Deno.serve` gets), so these assertions are on production dispatch, not a test double.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp, deployFingerprint } from "../src/app.ts";
import { memoryStores } from "../src/config.ts";
import type { AppConfig } from "../src/config.ts";

const config: AppConfig = {
  port: 8000,
  publicBaseUrl: "https://audio.example.com",
};

function appFetch() {
  const { fetch } = createApp({ config, stores: memoryStores() }, {});
  return fetch;
}

const get = (path: string, init?: RequestInit) =>
  new Request(`https://audio.example.com${path}`, init);

Deno.test("1552: the fingerprint prefers DENO_DEPLOYMENT_ID, then GIT_COMMIT_SHA, then dev", () => {
  const from = (values: Record<string, string | undefined>) => (name: string) => values[name];

  assertEquals(
    deployFingerprint(from({ DENO_DEPLOYMENT_ID: "dep-1", GIT_COMMIT_SHA: "sha-1" })),
    { id: "dep-1", source: "DENO_DEPLOYMENT_ID" },
  );
  assertEquals(
    deployFingerprint(from({ GIT_COMMIT_SHA: "sha-1" })),
    { id: "sha-1", source: "GIT_COMMIT_SHA" },
  );
  assertEquals(deployFingerprint(from({})), { id: "dev", source: "dev" });
  // An empty or whitespace variable is ABSENT — never an empty fingerprint that matches everything.
  assertEquals(
    deployFingerprint(from({ DENO_DEPLOYMENT_ID: "", GIT_COMMIT_SHA: "   " })),
    { id: "dev", source: "dev" },
  );
  // Values are trimmed, so a trailing newline from a shell-injected sha does not create a fake id.
  assertEquals(
    deployFingerprint(from({ GIT_COMMIT_SHA: " sha-1\n" })),
    { id: "sha-1", source: "GIT_COMMIT_SHA" },
  );
});

Deno.test("1552: /health carries deploy + deploySource alongside the existing fields", async () => {
  const res = await appFetch()(get("/health"));
  assertEquals(res.status, 200);
  const body = await res.json();

  // The pre-existing contract is unchanged.
  assertEquals(body.status, "ok");
  assertStringIncludes(body.storage, "memory");
  assert(typeof body.time === "string" && body.time.length > 0);

  // The new fingerprint is present, non-empty, and consistent with what this process can see.
  assert(typeof body.deploy === "string" && body.deploy.length > 0, "deploy is a non-empty string");
  assert(
    ["DENO_DEPLOYMENT_ID", "GIT_COMMIT_SHA", "dev"].includes(body.deploySource),
    `deploySource names a known source (got ${body.deploySource})`,
  );
  assertEquals(body.deploy, deployFingerprint().id);
  assertEquals(body.deploySource, deployFingerprint().source);
});

Deno.test("1552: a deployment id set in the environment reaches the route", async () => {
  const previous = Deno.env.get("DENO_DEPLOYMENT_ID");
  try {
    Deno.env.set("DENO_DEPLOYMENT_ID", "dep-1552-test");
    const body = await (await appFetch()(get("/health"))).json();
    assertEquals(body.deploy, "dep-1552-test");
    assertEquals(body.deploySource, "DENO_DEPLOYMENT_ID");
  } finally {
    if (previous === undefined) Deno.env.delete("DENO_DEPLOYMENT_ID");
    else Deno.env.set("DENO_DEPLOYMENT_ID", previous);
  }
});
