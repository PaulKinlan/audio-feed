/**
 * Evidence for audio-feed-b6nr: the capability is not readable from browser storage.
 *
 * The unit tests can assert what the source does, and `deno check` can assert the contract, but the
 * claim under test is about what a BROWSER ends up holding after a subscriber uses the player. That
 * only exists at runtime, so this drives real Chrome over CDP:
 *
 *   1. pre-seed storage in the shape the old client wrote it (a capability entry and a
 *      token-named positions key), as a device that used the player before this fix would have;
 *   2. visit `/listen/<token>` and let the page run;
 *   3. read every key and value out of localStorage and assert the token appears in none of them,
 *      and that the legacy keys were adopted and removed rather than left behind;
 *   4. clear storage entirely and navigate to the bare `/listen` — the home-screen launch — to show
 *      the player is still reached with nothing stored, because the session does it server-side.
 *
 * Run against a tree WITHOUT the fix to see the leak (--expect-leak), which is how before.json was
 * produced. Exits non-zero when the measured outcome disagrees with the expectation, so it is usable
 * as a gate rather than a report.
 *
 *   deno run -A scripts/repro_b6nr_token_storage.ts             # expect no leak
 *   deno run -A scripts/repro_b6nr_token_storage.ts --expect-leak
 */
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { newestChrome } from "./proof-helper.ts";

const EXPECT_LEAK = Deno.args.includes("--expect-leak");
const OUT = new URL("../docs/evidence/audio-feed-b6nr/", import.meta.url).pathname;
const PROFILE = await Deno.makeTempDir({ prefix: "audiofeed-proof-b6nr-" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
await Deno.mkdir(OUT, { recursive: true });

// -- the app, seeded ----------------------------------------------------------
const stores: Stores = memoryStores();
const config: AppConfig = { port: 0, adminToken: "harness-admin" };
const ctx = { config, stores };

const raw = await createUser(stores.metadata, {
  email: "probe@example.com",
  displayName: "Probe",
});
// The capability is whatever approval mints — the proof does not get to choose it.
const subscriber = await approveUser(stores.metadata, raw.id, "b6nr-probe");
const USER_ID = subscriber.id;
const TOKEN = subscriber.feedToken;
const session = await createSession(stores.metadata, USER_ID);

const { fetch: appFetch } = createApp(ctx, createHandlers(ctx));
const server = Deno.serve({ port: 0, onListen: () => {} }, (req, info) => appFetch(req, info));
const PORT = (server.addr as Deno.NetAddr).port;
const BASE = `http://localhost:${PORT}`;

// -- chrome + CDP -------------------------------------------------------------
const chrome = new Deno.Command(newestChrome(), {
  args: [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--remote-debugging-port=0",
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
  stdout: "null",
  stderr: "null",
}).spawn();

let debugPort = "";
for (let i = 0; i < 100 && !debugPort; i++) {
  await sleep(100);
  debugPort = (await Deno.readTextFile(`${PROFILE}/DevToolsActivePort`).catch(() => "")).split(
    "\n",
  )[0]!;
}
if (!debugPort) throw new Error("Chrome did not open a debug port");

const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const page = targets.find((t: { type: string }) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));

let nextId = 0;
const pending = new Map<number, (value: { result?: unknown; error?: unknown }) => void>();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
});
const send = (method: string, params: Record<string, unknown> = {}) => {
  const id = ++nextId;
  return new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
};
const evaluate = async (expression: string): Promise<unknown> => {
  const reply = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const result = reply.result as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (result.exceptionDetails) throw new Error(expression + " threw");
  return result.result?.value;
};
const navigate = async (url: string) => {
  await send("Page.navigate", { url });
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    if (await evaluate("document.readyState") === "complete") return;
  }
  throw new Error(`did not finish loading ${url}`);
};
/** Every localStorage entry, so the assertions can look at names AND values. */
const storageDump = () =>
  evaluate(`(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      out[key] = localStorage.getItem(key);
    }
    return out;
  })()`);

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Network.setCookie", {
  name: SESSION_COOKIE,
  value: session,
  url: BASE,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
});

// -- 1. a device that used the player before this fix ------------------------
await navigate(`${BASE}/`);
const LEGACY_POSITIONS = `audio-feed-positions:${TOKEN}`;
const LEGACY_PLAYED = `audio-feed-played:${TOKEN}`;
const savedPosition = JSON.stringify([{ id: "ep-1", position: 42, updatedAt: 1 }]);
// In leak mode nothing is pre-seeded: whatever the token appears in afterwards can only have been
// written by the client under test, which is the difference between measuring the old client and
// measuring this script.
await evaluate(`(() => {
  ${
  EXPECT_LEAK ? "return true;" : `
  localStorage.setItem("audio-feed-token", ${JSON.stringify(TOKEN)});
  localStorage.setItem(${JSON.stringify(LEGACY_POSITIONS)}, ${JSON.stringify(savedPosition)});
  localStorage.setItem(${JSON.stringify(LEGACY_PLAYED)}, "[]");`
}
  return true;
})()`);
const before = await storageDump();

// -- 2. use the player ---------------------------------------------------------
await navigate(`${BASE}/listen/${TOKEN}`);
await sleep(500);
const after = await storageDump();

// -- 3. what the storage holds now --------------------------------------------
const occurrences = (dump: Record<string, string>) =>
  Object.entries(dump)
    .filter(([key, value]) => key.includes(TOKEN) || (value ?? "").includes(TOKEN))
    .map(([key]) => key);

const afterLeak = occurrences(after as Record<string, string>);
const beforeLeak = occurrences(before as Record<string, string>);
const adopted = Object.entries(after as Record<string, string>).find(([key]) =>
  key === `audio-feed-positions:${USER_ID}`
);
const legacyGone = !Object.keys(after as Record<string, string>).some((key) =>
  key.endsWith(`:${TOKEN}`)
);

// -- 4. the home-screen launch, with storage emptied ---------------------------
// Skipped in leak mode: the old tree has no session redirect, so its launch path is the stored
// capability this script is measuring the presence of.
await evaluate("localStorage.clear()");
if (EXPECT_LEAK) {
  const leakReport = {
    bead: "audio-feed-b6nr",
    measuredAt: new Date().toISOString(),
    note:
      "the tree WITHOUT the fix, nothing pre-seeded: the old client writes the capability itself",
    entriesAfterUsingPlayer: after,
    keysNamingTheToken: afterLeak,
    legacyKeysRemoved: legacyGone,
  };
  await Deno.writeTextFile(`${OUT}before.json`, JSON.stringify(leakReport, null, 2) + "\n");
  console.log(JSON.stringify(leakReport, null, 2));
  chrome.kill("SIGKILL");
  ws.close();
  await server.shutdown();
  await Deno.remove(PROFILE, { recursive: true }).catch(() => {});
  if (afterLeak.length === 0) {
    console.error("FAIL: expected the old client to leave the capability in storage");
    Deno.exit(1);
  }
  console.log(`OK (as expected): the old client left the capability in ${afterLeak.length} key(s)`);
  Deno.exit(0);
}
await sleep(0);
await navigate(`${BASE}/listen`);
await sleep(500);
const landedOn = await evaluate("location.pathname");
const afterClear = await storageDump();

const report = {
  bead: "audio-feed-b6nr",
  measuredAt: new Date().toISOString(),
  token: TOKEN,
  expectation: EXPECT_LEAK
    ? "the old client leaves the capability in storage"
    : "no capability at rest",
  beforeUsingPlayer: { entries: before, keysNamingTheToken: beforeLeak },
  afterUsingPlayer: {
    entries: after,
    keysNamingTheToken: afterLeak,
    legacyKeysRemoved: legacyGone,
    positionMovedToUserKey: Boolean(adopted) && adopted![1] === savedPosition,
  },
  homeScreenLaunch: {
    storageCleared: Object.keys(afterClear as Record<string, string>).length === 0,
    landedOn,
  },
};

await Deno.writeTextFile(
  `${OUT}${EXPECT_LEAK ? "before" : "repro"}.json`,
  JSON.stringify(report, null, 2) + "\n",
);

// -- verdict --------------------------------------------------------------------
const problems: string[] = [];
if (EXPECT_LEAK) {
  if (beforeLeak.length === 0 || afterLeak.length === 0) {
    problems.push("expected the old client to leave the token in storage, but it did not");
  }
} else {
  if (afterLeak.length > 0) {
    problems.push(
      `the token is still readable in ${afterLeak.length} storage key(s): ${afterLeak}`,
    );
  }
  if (!legacyGone) problems.push("a legacy token-named key survived the visit");
  if (!report.afterUsingPlayer.positionMovedToUserKey) {
    problems.push("the saved position was not adopted under the subscriber's key");
  }
  if (!report.homeScreenLaunch.storageCleared) {
    problems.push("the player stored something even though nothing is required to be stored");
  }
  if (landedOn !== `/listen/${TOKEN}`) {
    problems.push(`the home-screen launch landed on ${landedOn}, not the player`);
  }
}

try {
  console.log(JSON.stringify(report, null, 2));
  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL: ${problem}`);
    Deno.exit(1);
  }
  console.log(
    EXPECT_LEAK
      ? `OK (as expected): the old client left the token in ${afterLeak.length} storage key(s)`
      : "OK: no capability in storage, legacy keys adopted and removed, and the session still " +
        "reaches the player from a cold home-screen launch",
  );
} finally {
  chrome.kill("SIGKILL");
  ws.close();
  await server.shutdown();
  await Deno.remove(PROFILE, { recursive: true }).catch(() => {});
}
