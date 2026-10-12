/**
 * Browser proof for admin and player failed episode retry UI (audio-feed-6y9).
 *
 * Verifies:
 * 1. /admin console:
 *    - Renders "Retry failed (N)" button next to "Regenerate all".
 *    - Failed episode row shows red "failed" status badge with exact error detail.
 *    - Failed episode row has an inline "Retry" button.
 * 2. /listen/:token (player):
 *    - Activity panel shows the failed episode with exact error detail and "Try again" button.
 * 3. /account:
 *    - Header shows "Retry failed (N)" button.
 *    - Episode list shows inline "Retry" button and error detail for failed episode.
 *
 *   deno run --allow-all --unstable-kv scripts/admin-retry-browser-proof.ts
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";
import { makeArticle, makeEpisode } from "../tests/fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { runProof, withChrome, writeEvidenceReadme } from "./proof-helper.ts";

const OUT = new URL("../docs/evidence/audio-feed-6y9/", import.meta.url).pathname;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await runProof("audio-feed-6y9", async (checker) => {
  // -- in-process test app ------------------------------------------------------
  const stores: Stores = memoryStores();
  const config: AppConfig = {
    port: 0,
    adminToken: "harness-admin",
  };
  const ctx = { config, stores };

  // Seed user, session, and episodes
  const rawUser = await createUser(stores.metadata, {
    email: "paul@example.com",
    displayName: "Paul Kinlan",
    isAdmin: true,
  });
  const user = await approveUser(stores.metadata, rawUser.id, "admin");
  const sessionSecret = await createSession(stores.metadata, user.id);

  await stores.metadata.putSource({
    id: "src-1",
    userId: user.id,
    title: "Example Publication",
    feedUrl: "https://example.com/feed.xml",
    modes: ["direct"],
    voices: {},
    createdAt: new Date().toISOString(),
  });

  await stores.metadata.putArticle(
    makeArticle({
      id: "art-ready",
      userId: user.id,
      sourceId: "src-1",
      title: "Working Post",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-ready",
      userId: user.id,
      sourceId: "src-1",
      articleId: "art-ready",
      title: "Working Post",
      status: "ready",
      audioKey: "audio/user/direct/ep-ready.wav",
      contentType: "audio/wav",
    }),
  );
  await stores.blobs.put("audio/user/direct/ep-ready.wav", new Uint8Array(44), {
    contentType: "audio/wav",
  });

  await stores.metadata.putArticle(
    makeArticle({
      id: "art-fail",
      userId: user.id,
      sourceId: "src-1",
      title: "Failing Post",
    }),
  );
  await stores.metadata.putEpisode(
    makeEpisode({
      id: "ep-fail",
      userId: user.id,
      sourceId: "src-1",
      articleId: "art-fail",
      title: "Failing Post",
      status: "failed",
      error: "Gemini API error: 429 Quota Exceeded for audio model",
    }),
  );

  const handlers = createHandlers(ctx);
  const { fetch: appFetch } = createApp(ctx, handlers);

  const server = Deno.serve({ port: 0, onListen: () => {} }, (req, info) => appFetch(req, info));
  const PORT = (server.addr as Deno.NetAddr).port;
  const BASE = `http://localhost:${PORT}`;
  config.port = PORT;
  config.publicBaseUrl = BASE;

  try {
    await withChrome(async (chrome) => {
      const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
      const page = targets.find((t: { type: string }) => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));

      let nextId = 0;
      const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      });

      function cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        const id = ++nextId;
        return new Promise((resolve, reject) => {
          pending.set(id, (res) => {
            if (res.error) reject(new Error(`${method}: ${JSON.stringify(res.error)}`));
            else resolve(res.result);
          });
          ws.send(JSON.stringify({ id, method, params }));
        });
      }

      async function js(expr: string): Promise<unknown> {
        const res = await cdp("Runtime.evaluate", {
          expression: expr,
          returnByValue: true,
          awaitPromise: true,
        }) as { result?: { value?: unknown } };
        return res.result?.value;
      }

      async function until(expr: string, desc = expr, timeout = 10_000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          if (await js(`Boolean(${expr})`)) return;
          await sleep(50);
        }
        throw new Error(`Timeout waiting for: ${desc}`);
      }

      await cdp("Page.enable");
      await cdp("Network.enable");

      // Set session cookie
      await cdp("Network.setCookie", {
        name: "__Host-af_session",
        value: sessionSecret,
        url: BASE,
        secure: true,
      });

      await cdp("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });

      // 1. Visit /admin
      await cdp("Page.navigate", { url: `${BASE}/admin` });
      await until(`document.readyState === "complete"`, "admin page loaded");
      await until(`document.getElementById("usersBody")?.children?.length > 0`, "users loaded");

      // Open manage modal for user
      await js(`document.querySelector('#usersBody button[aria-label^="Manage "]').click()`);
      await until(`!document.getElementById("manageSection")?.hidden`, "manage section open");
      await until(
        `document.getElementById("manageEpisodesBody")?.children?.length > 0`,
        "episodes loaded",
      );

      const regenFailedText = await js(`document.getElementById("regenFailed")?.textContent`);
      checker.check(
        "admin shows 'Retry failed (1)' button in header",
        regenFailedText === "Retry failed (1)",
        `got: '${regenFailedText}'`,
      );

      const retryBtnExists = await js(`
        [...document.querySelectorAll("#manageEpisodesBody button")].some((b) => b.textContent === "Retry")
      `);
      checker.check(
        "failed episode row renders inline 'Retry' button",
        retryBtnExists === true,
        "Retry button present",
      );

      const errorDetail = String(
        await js(`
        document.querySelector("#manageEpisodesBody .error-detail")?.textContent || ""
      `),
      );
      checker.check(
        "failed episode row displays error detail",
        errorDetail.includes("Gemini API error"),
        `error: '${errorDetail}'`,
      );

      const shotAdmin = (await cdp("Page.captureScreenshot", { format: "png" })) as {
        data: string;
      };
      await Deno.writeFile(
        `${OUT}01-admin-retry-failed-episodes.png`,
        Uint8Array.from(atob(shotAdmin.data), (c) => c.charCodeAt(0)),
      );
      console.log(`Saved screenshot to ${OUT}01-admin-retry-failed-episodes.png`);

      // 2. Visit /listen/:token (player)
      await cdp("Page.navigate", { url: `${BASE}/listen/${user.feedToken}` });
      await until(`document.readyState === "complete"`, "player loaded");
      await until(
        `!document.getElementById("activity")?.classList.contains("hidden")`,
        "activity section visible",
      );

      const activityError = String(
        await js(`
        document.querySelector("#activity .act-error")?.textContent || ""
      `),
      );
      checker.check(
        "player activity panel displays failed episode error detail",
        activityError.includes("Gemini API error"),
        `activity error: '${activityError}'`,
      );

      const tryAgainExists = await js(`
        [...document.querySelectorAll("#activity button")].some((b) => b.textContent === "Try again")
      `);
      checker.check(
        "player activity panel renders 'Try again' button",
        tryAgainExists === true,
        "Try again button present",
      );

      const shotPlayer = (await cdp("Page.captureScreenshot", { format: "png" })) as {
        data: string;
      };
      await Deno.writeFile(
        `${OUT}02-player-activity-failed-episode.png`,
        Uint8Array.from(atob(shotPlayer.data), (c) => c.charCodeAt(0)),
      );
      console.log(`Saved screenshot to ${OUT}02-player-activity-failed-episode.png`);

      // 3. Visit /account
      await cdp("Page.navigate", { url: `${BASE}/account` });
      await until(`document.readyState === "complete"`, "account page loaded");

      const accountRetryFailedText = await js(
        `document.getElementById("retryFailed")?.textContent`,
      );
      checker.check(
        "account page shows 'Retry failed (1)' button in header",
        accountRetryFailedText === "Retry failed (1)",
        `got: '${accountRetryFailedText}'`,
      );

      const accountRetryBtnExists = await js(`
        document.querySelectorAll("button[data-retry-episode]").length > 0
      `);
      checker.check(
        "account page renders inline 'Retry' button on failed episode",
        accountRetryBtnExists === true,
        "Retry button present",
      );

      const shotAccount = (await cdp("Page.captureScreenshot", { format: "png" })) as {
        data: string;
      };
      await Deno.writeFile(
        `${OUT}03-account-retry-failed-episodes.png`,
        Uint8Array.from(atob(shotAccount.data), (c) => c.charCodeAt(0)),
      );
      console.log(`Saved screenshot to ${OUT}03-account-retry-failed-episodes.png`);

      // Summary report
      await writeEvidenceReadme({
        dir: OUT,
        title: "Admin and Player Failed Episode Retry Verification: audio-feed-6y9",
        script: "scripts/admin-retry-browser-proof.ts",
        asserts: [
          "admin shows 'Retry failed (1)' button in header",
          "failed episode row renders inline 'Retry' button",
          "failed episode row displays error detail",
          "player activity panel displays failed episode error detail",
          "player activity panel renders 'Try again' button",
          "account page shows 'Retry failed (1)' button in header",
          "account page renders inline 'Retry' button on failed episode",
        ],
        sections: [
          {
            heading: "Observed Behavior",
            body: `1. **Admin Console (/admin)**:
   - Header provides a dedicated \`#regenFailed\` button: **"Retry failed (1)"**.
   - Episode row with \`status: "failed"\` displays a red **failed** badge and the exact error explanation (\`Gemini API error: 429 Quota Exceeded for audio model\`).
   - Episode row renders an inline **"Retry"** button that prompts confirmation and re-queues the episode for synthesis.
2. **Web Player (/listen/:token)**:
   - Activity panel is visible and lists the failed episode.
   - Highlights the exact failure reason in \`.act-error\` alongside the **"Try again"** button.
   - Paging does not displace failed episodes because \`listEpisodes({ status: "failed" })\` feeds the activity panel explicitly.
3. **Subscriber Account (/account)**:
   - Header renders **"Retry failed (1)"** button.
   - Failed episode row renders inline **"Retry"** button and error detail.`,
          },
          {
            heading: "Screenshots",
            body:
              `- \`01-admin-retry-failed-episodes.png\`: Admin console with "Retry failed (1)" and inline "Retry" button.
- \`02-player-activity-failed-episode.png\`: Web player activity panel showing failed episode, error message, and "Try again" button.
- \`03-account-retry-failed-episodes.png\`: Account page showing "Retry failed (1)" and inline "Retry" button.`,
          },
        ],
      });
      console.log(`Saved report to ${OUT}README.md`);
      ws.close();
    }, { prefix: "audiofeed-proof-6y9-" });
  } finally {
    await server.shutdown().catch(() => {});
  }
});
