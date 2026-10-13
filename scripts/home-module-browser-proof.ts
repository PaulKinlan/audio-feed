/**
 * Browser proof for audio-feed-3xq part 4b: the homepage's CSS and client are
 * content-addressed assets, and the page still works.
 *
 * 1. /assets/<hash>.home.js and /assets/<hash>.home.css fetch 200 with the
 *    immutable cache headers and the right content types.
 * 2. The #home-data island carries the server's escaped origin.
 * 3. The module executes: validation styling appears on interaction (blur an
 *    invalid URL -> aria-invalid="true"; type a valid one -> removed). That
 *    schedule is the whole point of the :user-invalid work (audio-feed home
 *    tests), and only the client can produce it.
 * 4. Zero console errors/warnings/exceptions at 1280x900 and 390x844.
 *
 *   deno run --allow-all --unstable-kv scripts/home-module-browser-proof.ts
 *
 * Not part of the gate (it launches Chrome).
 */

import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import type { AppConfig, Stores } from "../src/config.ts";
import { runProof, withChrome } from "./proof-helper.ts";
import { quantiseEvidencePng } from "./evidence-png.ts";

const OUT = new URL("../docs/evidence/audio-feed-3xq/", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

const stores: Stores = memoryStores();
const config: AppConfig = { port: 0 };
const ctx = { config, stores };
const { fetch: appFetch } = createApp(ctx, createHandlers(ctx));
const server = Deno.serve({ port: 0, onListen: () => {} }, (req, info) => appFetch(req, info));
const PORT = (server.addr as Deno.NetAddr).port;
const BASE = `http://localhost:${PORT}`;
config.port = PORT;
config.publicBaseUrl = BASE;

await runProof("audio-feed-3xq", async (checker) => {
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
    checker.check(name, pass, detail);
  };

  try {
    await withChrome(async (chrome) => {
      const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
      const page = targets.find((t: { type: string }) => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));

      let nextId = 0;
      const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
      interface CdpEvent {
        method: string;
        params: {
          response?: { url?: string; status?: number; headers?: Record<string, string> };
          type?: string;
          entry?: { level?: string };
        };
      }
      const events: CdpEvent[] = [];
      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        } else if (msg.method) {
          events.push({ method: msg.method, params: msg.params });
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

      async function until(expr: string, desc = expr, timeout = 15_000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          if (await js(`Boolean(${expr})`)) return;
          await sleep(50);
        }
        throw new Error(`Timeout waiting for: ${desc}`);
      }

      const consoleBad = () =>
        events.filter((e) =>
          (e.method === "Runtime.consoleAPICalled" &&
            ["error", "warning"].includes(e.params.type ?? "")) ||
          e.method === "Runtime.exceptionThrown" ||
          (e.method === "Log.entryAdded" && e.params.entry?.level === "error")
        );

      try {
        await cdp("Page.enable");
        await cdp("Network.enable");
        await cdp("Log.enable");
        await cdp("Runtime.enable");

        await cdp("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });

        await cdp("Page.navigate", { url: BASE });
        await until(`document.readyState === "complete"`, "home page loaded");

        // audio-feed-dc2y: compiled once per distinct suffix instead of once per captured CDP event
        const assetPatterns = new Map<string, RegExp>();
        const assetResponse = (suffix: string) => {
          const pattern = assetPatterns.get(suffix) ??
            assetPatterns.set(suffix, new RegExp(`/assets/[0-9a-f]+\\.${suffix}$`)).get(suffix)!;
          return events.find(
            (e) =>
              e.method === "Network.responseReceived" &&
              pattern.test(e.params.response?.url ?? ""),
          )?.params.response;
        };

        const jsRes = assetResponse("home\\.js");
        check(
          "home.js fetched content-addressed, immutable, text/javascript",
          jsRes?.status === 200 &&
            jsRes.headers?.["content-type"]?.startsWith("text/javascript") === true &&
            jsRes.headers?.["cache-control"] === "public, max-age=31536000, immutable",
          jsRes ? `/assets/<hash>.home.js -> ${jsRes.status}` : "no response seen",
        );
        const cssRes = assetResponse("home\\.css");
        check(
          "home.css fetched content-addressed, immutable, text/css",
          cssRes?.status === 200 &&
            cssRes.headers?.["content-type"]?.startsWith("text/css") === true &&
            cssRes.headers?.["cache-control"] === "public, max-age=31536000, immutable",
          cssRes ? `/assets/<hash>.home.css -> ${cssRes.status}` : "no response seen",
        );

        const island = await js(`JSON.parse(document.getElementById("home-data").textContent)`) as {
          base?: string;
        };
        check(
          "#home-data island carries the server origin",
          island?.base === BASE,
          JSON.stringify({ base: island?.base ? "<origin>" : undefined }),
        );

        // The module's validation schedule: aria-invalid only AFTER interaction.
        const before = await js(`document.getElementById("url")?.getAttribute("aria-invalid")`);
        await js(`
          (() => {
            const u = document.getElementById("url");
            u.value = "not a url";
            u.dispatchEvent(new Event("blur"));
          })()
        `);
        await sleep(100);
        const afterInvalid = await js(
          `document.getElementById("url")?.getAttribute("aria-invalid")`,
        );
        await js(`
          (() => {
            const u = document.getElementById("url");
            u.value = "https://example.com/article";
            u.dispatchEvent(new Event("input", { bubbles: true }));
          })()
        `);
        await sleep(100);
        const afterValid = await js(`document.getElementById("url")?.getAttribute("aria-invalid")`);
        check(
          "client applies validation styling on interaction only",
          before === null && afterInvalid === "true" && afterValid === null,
          `before=${before} invalid=${afterInvalid} valid=${afterValid}`,
        );

        check(
          "no console errors/warnings/exceptions at 1280x900",
          consoleBad().length === 0,
          consoleBad().slice(0, 2).map((e) => JSON.stringify(e.params).slice(0, 160)).join(" | ") ||
            "clean",
        );
        const shot1 = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
        const shot1Path = `${OUT}part4b-home-1280x900.png`;
        await Deno.writeFile(
          shot1Path,
          Uint8Array.from(atob(shot1.data), (c) => c.charCodeAt(0)),
        );
        await quantiseEvidencePng(shot1Path);

        events.length = 0;
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          mobile: true,
        });
        await cdp("Page.navigate", { url: BASE });
        await until(`document.readyState === "complete"`, "home page reloaded at 390x844");
        await until(
          `document.getElementById("url") !== null`,
          "home form present at 390x844",
        );
        check(
          "no console errors/warnings/exceptions at 390x844",
          consoleBad().length === 0,
          consoleBad().slice(0, 2).map((e) => JSON.stringify(e.params).slice(0, 160)).join(" | ") ||
            "clean",
        );
        const shot2 = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
        const shot2Path = `${OUT}part4b-home-390x844.png`;
        await Deno.writeFile(
          shot2Path,
          Uint8Array.from(atob(shot2.data), (c) => c.charCodeAt(0)),
        );
        await quantiseEvidencePng(shot2Path);
        console.log(`Screenshots quantised and saved in ${OUT}`);
      } finally {
        try {
          ws.close();
        } catch { /* already closed */ }
      }
    });
  } finally {
    await server.shutdown().catch(() => {});
  }
});
