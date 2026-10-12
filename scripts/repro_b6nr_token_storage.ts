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
import { runProof, withChrome, writeEvidenceReadme } from "./proof-helper.ts";

const EXPECT_LEAK = Deno.args.includes("--expect-leak");
const OUT = new URL("../docs/evidence/audio-feed-b6nr/", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
await Deno.mkdir(OUT, { recursive: true });

await runProof("audio-feed-b6nr", async (checker) => {
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

  try {
    await withChrome(async (chrome) => {
      const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
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

      try {
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
        await evaluate(`(() => {
          ${
          EXPECT_LEAK ? "return true;" : `
          localStorage.setItem("audio-feed-token", ${JSON.stringify(TOKEN)});
          localStorage.setItem(${JSON.stringify(LEGACY_POSITIONS)}, ${
            JSON.stringify(savedPosition)
          });
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
          checker.check(
            "expected the old client to leave the capability in storage",
            afterLeak.length > 0,
            afterLeak.length > 0
              ? `the old client left the capability in ${afterLeak.length} key(s)`
              : "expected the old client to leave the capability in storage",
          );
          return;
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
        console.log(JSON.stringify(report, null, 2));

        // -- verdict --------------------------------------------------------------------
        checker.check(
          "no key or value in localStorage contains feed token",
          afterLeak.length === 0,
          afterLeak.length === 0
            ? "clean"
            : `the token is still readable in ${afterLeak.length} storage key(s): ${
              afterLeak.join(", ")
            }`,
        );
        checker.check(
          "legacy token-named keys removed",
          legacyGone,
          legacyGone ? "clean" : "a legacy token-named key survived the visit",
        );
        checker.check(
          "saved position adopted under subscriber ID",
          Boolean(report.afterUsingPlayer.positionMovedToUserKey),
          report.afterUsingPlayer.positionMovedToUserKey
            ? "adopted"
            : "the saved position was not adopted under the subscriber's key",
        );
        const homeScreenOk = Boolean(
          report.homeScreenLaunch.storageCleared && landedOn === `/listen/${TOKEN}`,
        );
        checker.check(
          "cold home-screen launch reaches player with empty storage",
          homeScreenOk,
          homeScreenOk
            ? `landed on ${landedOn} with empty storage`
            : `storageCleared=${report.homeScreenLaunch.storageCleared}, landedOn=${landedOn}`,
        );

        await writeEvidenceReadme({
          dir: OUT,
          title: "audio-feed-b6nr — the capability is not readable from browser storage",
          script: "scripts/repro_b6nr_token_storage.ts",
          asserts: [
            "no key or value in localStorage contains feed token",
            "legacy token-named keys removed",
            "saved position adopted under subscriber ID",
            "cold home-screen launch reaches player with empty storage",
          ],
          sections: [
            {
              heading: "The claim under test",
              body:
                `\`GET /listen/:token\` resolves the subscriber *by* the token (\`resolveTokenValue\` →
\`getUserByFeedToken\`), so the feed token is a bearer credential for one subscriber's feed and audio,
not an identifier. The player used to write it into \`localStorage\` and then embed it in four more
keys (\`audio-feed-positions:<token>\`, \`-played:\`, \`-dismissed:\`, \`-filter:\`). A key name is as
readable as a value, so that was five places to find the credential in a browser profile — reachable
by an XSS, an extension, or anyone using a shared device.

The unit tests can check what the source says and the type checker can check the contract, but the
claim is about what a browser holds after a subscriber uses the player. That only exists at runtime,
so \`scripts/repro_b6nr_token_storage.ts\` drives real Chrome over CDP against the real app.`,
            },
            {
              heading: "What was measured",
              body:
                `The script pre-seeds storage in the shape the old client wrote it (as a device that used the player
before this change would have), loads \`/listen/<token>\`, then reads **every key and value** out of
\`localStorage\`.

| | before | after |
| --- | --- | --- |
| keys or values naming the token | \`audio-feed-token\` | **none** |
| legacy token-named keys after the visit | present | adopted and removed |
| saved position | under \`audio-feed-positions:<token>\` | under \`audio-feed-positions:<subscriber id>\` |
| cold home-screen launch, storage cleared | — | lands on \`/listen/<token>\` |

\`before.json\` is the tree *without* the fix and **nothing pre-seeded**, so the entry it finds can only
have been written by the client itself. (\`legacyKeysRemoved: true\` in that file is vacuous — nothing
existed to remove. It is meaningful only in \`repro.json\`, where the pre-seeded legacy keys were
adopted and deleted.) \`repro.json\` is the fixed tree with the pre-seed in place, which is what
exercises the migration.

The four assertions the script fails on, rather than merely reporting:
no key or value contains the token; no token-named key survives the visit; the saved position is
adopted under the subscriber's key; and the player still reaches the player page from a cold
home-screen launch with storage emptied — the last one being the feature the persistence existed for.

\`\`\`bash
deno run -A scripts/repro_b6nr_token_storage.ts              # expect no leak
deno run -A scripts/repro_b6nr_token_storage.ts --expect-leak # the pre-fix tree
\`\`\``,
            },
            {
              heading: "The gap this proof found (and the unit tests could not)",
              body:
                `Removing the writer was not enough. On a device that had used an earlier version, the
\`audio-feed-token\` entry was still there: a writer that no longer runs cannot clean up after itself,
and every source-level assertion still passed while the credential sat in the profile. The proof
caught it on its first run (\`FAIL: the token is still readable in 1 storage key(s)\`), and the client
now removes that entry as well — which is why the "legacy keys after the visit" row above is an
assertion and not just a description. This is the argument for driving the real artifact: the tests
that existed checked spelling, and the thing that mattered was which bytes a browser was left with.`,
            },
            {
              heading: "What is deliberately unchanged",
              body:
                `- The capability is still in the **URL path** of the player (\`/listen/<token>\`), because that is the
  product: a podcast feed URL is a capability, and it is what makes the player work without an
  account. This change is about *persistence*.
- \`x-forwarded-host\` handling in \`src/origin.ts\` is untouched (unrelated).
- A subscriber with no session who only ever visits the landing page keeps whatever a previous
  version stored until they next open the player, which is where the cleanup runs.`,
            },
          ],
        });
      } finally {
        try {
          ws.close();
        } catch { /* ignore */ }
      }
    });
  } finally {
    await server.shutdown().catch(() => {});
    await stores.metadata.close().catch(() => {});
  }
});
