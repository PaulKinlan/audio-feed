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
import { createApp, DEPLOY_COMMIT_ENV_VARS, deployFingerprint } from "../src/app.ts";
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
    { id: "dep-1", source: "DENO_DEPLOYMENT_ID", commit: "sha-1" },
  );
  assertEquals(
    deployFingerprint(from({ GIT_COMMIT_SHA: "sha-1" })),
    { id: "sha-1", source: "GIT_COMMIT_SHA", commit: "sha-1" },
  );
  assertEquals(deployFingerprint(from({})), { id: "dev", source: "dev", commit: null });
  // An empty or whitespace variable is ABSENT — never an empty fingerprint that matches everything.
  assertEquals(
    deployFingerprint(from({ DENO_DEPLOYMENT_ID: "", GIT_COMMIT_SHA: "   " })),
    { id: "dev", source: "dev", commit: null },
  );
  // Values are trimmed, so a trailing newline from a shell-injected sha does not create a fake id.
  assertEquals(
    deployFingerprint(from({ GIT_COMMIT_SHA: " sha-1\n" })),
    { id: "sha-1", source: "GIT_COMMIT_SHA", commit: "sha-1" },
  );
});

Deno.test("ciia/34bo: deployFingerprint supports alias commit env vars, reports exact variable name, and preserves commit when deploy is present", () => {
  const from = (values: Record<string, string | undefined>) => (name: string) => values[name];

  // Aliases for commit variable: audio-feed-34bo pins exact alias variable name in source
  assertEquals(
    deployFingerprint(from({ GIT_COMMIT: "sha-alias-1" })),
    { id: "sha-alias-1", source: "GIT_COMMIT", commit: "sha-alias-1" },
  );
  assertEquals(
    deployFingerprint(from({ DENO_DEPLOY_GIT_COMMIT: "sha-alias-2" })),
    { id: "sha-alias-2", source: "DENO_DEPLOY_GIT_COMMIT", commit: "sha-alias-2" },
  );
  assertEquals(
    deployFingerprint(from({ COMMIT_SHA: "sha-alias-3" })),
    { id: "sha-alias-3", source: "COMMIT_SHA", commit: "sha-alias-3" },
  );

  // Both deploy ID and commit are retained (commit is NOT masked)
  assertEquals(
    deployFingerprint(from({ DENO_DEPLOYMENT_ID: "deploy-42", COMMIT_SHA: "sha-42" })),
    { id: "deploy-42", source: "DENO_DEPLOYMENT_ID", commit: "sha-42" },
  );

  // Deploy ID present without commit cleanly sets commit: null
  assertEquals(
    deployFingerprint(from({ DENO_DEPLOYMENT_ID: "deploy-no-commit" })),
    { id: "deploy-no-commit", source: "DENO_DEPLOYMENT_ID", commit: null },
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

  // The fingerprint is present, non-empty, and consistent with what this process can see.
  assert(typeof body.deploy === "string" && body.deploy.length > 0, "deploy is a non-empty string");
  assert(
    ["DENO_DEPLOYMENT_ID", ...DEPLOY_COMMIT_ENV_VARS, "dev"].includes(body.deploySource),
    `deploySource names a known source (got ${body.deploySource})`,
  );
  assertEquals(body.deploy, deployFingerprint().id);
  assertEquals(body.deploySource, deployFingerprint().source);
  // audio-feed-ciia: commit is present and matches deployFingerprint().commit
  assertEquals(body.commit, deployFingerprint().commit);
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

Deno.test("ciia/nqhg: /health exposes commit when set in env and degrades cleanly to null when unset", async () => {
  const envVars = [
    "DENO_DEPLOYMENT_ID",
    ...DEPLOY_COMMIT_ENV_VARS,
  ] as const;
  const previous = new Map<string, string | undefined>();
  for (const name of envVars) {
    previous.set(name, Deno.env.get(name));
  }

  const clearAll = () => {
    for (const name of envVars) {
      Deno.env.delete(name);
    }
  };

  try {
    // 1. When unset, commit degrades cleanly to null (audio-feed-nqhg: all alias vars isolated)
    clearAll();
    const body1 = await (await appFetch()(get("/health"))).json();
    assertEquals(body1.commit, null);
    assertEquals(body1.deploy, "dev");

    // 2. When GIT_COMMIT_SHA is set alone, commit is exposed and deploySource is GIT_COMMIT_SHA
    clearAll();
    Deno.env.set("GIT_COMMIT_SHA", "commit-sha-ciia-1");
    const body2 = await (await appFetch()(get("/health"))).json();
    assertEquals(body2.commit, "commit-sha-ciia-1");
    assertEquals(body2.deploy, "commit-sha-ciia-1");
    assertEquals(body2.deploySource, "GIT_COMMIT_SHA");

    // 3. When both DENO_DEPLOYMENT_ID and GIT_COMMIT_SHA are set, both are visible
    clearAll();
    Deno.env.set("DENO_DEPLOYMENT_ID", "deploy-id-ciia-2");
    Deno.env.set("GIT_COMMIT_SHA", "commit-sha-ciia-1");
    const body3 = await (await appFetch()(get("/health"))).json();
    assertEquals(body3.commit, "commit-sha-ciia-1");
    assertEquals(body3.deploy, "deploy-id-ciia-2");
    assertEquals(body3.deploySource, "DENO_DEPLOYMENT_ID");

    // 4. audio-feed-likz: table-driven verification that every supported commit variable
    // reports its exact variable name as deploySource and carries commit/deploy to the /health route.
    for (const varName of DEPLOY_COMMIT_ENV_VARS) {
      clearAll();
      const testVal = `sha-test-${varName.toLowerCase().replace(/_/g, "-")}`;
      Deno.env.set(varName, testVal);
      const body = await (await appFetch()(get("/health"))).json();
      assertEquals(body.commit, testVal, `commit matches for ${varName}`);
      assertEquals(body.deploy, testVal, `deploy matches for ${varName}`);
      assertEquals(body.deploySource, varName, `deploySource accurately names ${varName}`);
    }

    // 5. When DENO_DEPLOYMENT_ID is set alone without commit, deploySource is DENO_DEPLOYMENT_ID and commit is null
    clearAll();
    Deno.env.set("DENO_DEPLOYMENT_ID", "deploy-id-only-test");
    const body5 = await (await appFetch()(get("/health"))).json();
    assertEquals(body5.commit, null);
    assertEquals(body5.deploy, "deploy-id-only-test");
    assertEquals(body5.deploySource, "DENO_DEPLOYMENT_ID");
  } finally {
    for (const name of envVars) {
      const val = previous.get(name);
      if (val === undefined) Deno.env.delete(name);
      else Deno.env.set(name, val);
    }
  }
});

Deno.test("likz/lq6c: AGENTS.md documents exactly the set of DEPLOY_COMMIT_ENV_VARS with no duplicate enumerations", async () => {
  const agentsDoc = await Deno.readTextFile(new URL("../AGENTS.md", import.meta.url));

  // 1. Extract all backticked names in the single authoritative injection clause in AGENTS.md
  // e.g. "when injected (`GIT_COMMIT_SHA`, `GIT_COMMIT`, `DENO_DEPLOY_GIT_COMMIT`, or `COMMIT_SHA`)"
  const match = agentsDoc.match(/when injected \(([^)]+)\)/);
  assert(match && match[1], "AGENTS.md must document the injected commit variables clause");
  const documentedVars = Array.from(match[1].matchAll(/`([^`]+)`/g)).map((m) => m[1]);

  assertEquals(
    documentedVars,
    [...DEPLOY_COMMIT_ENV_VARS],
    "AGENTS.md documentation must match DEPLOY_COMMIT_ENV_VARS exactly",
  );

  // 2. audio-feed-lq6c: Ensure no unverified duplicate enumerations exist elsewhere in AGENTS.md.
  // Each variable name (as a backticked identifier) must appear in AGENTS.md exactly once (in the checked injection clause above).
  for (const varName of DEPLOY_COMMIT_ENV_VARS) {
    const token = `\`${varName}\``;
    const occurrences = agentsDoc.split(token).length - 1;
    assertEquals(
      occurrences,
      1,
      `AGENTS.md must not contain duplicate enumerations of ${token} (expected 1, found ${occurrences})`,
    );
  }
});
