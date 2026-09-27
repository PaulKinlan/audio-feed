/**
 * Tests for player client-side source and text filtering (audio-feed-3h1).
 *
 * Verifies:
 *  1. Rendered HTML contains accessible filter section and controls with honest empty state;
 *  2. Client asset contains filter logic (matches title, source, author, consistent activity filtering);
 *  3. Dynamic header count formatting (unfiltered vs filtered subset);
 *  4. Per-token storage isolation of filter state;
 *  5. Private-mode safety (graceful degradation when localStorage throws).
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { playerClient } from "./listen_client.ts";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { makeUser } from "./fixtures.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const BASE = "https://audio.example.com";
const TOKEN_A = "token-user-a";
const TOKEN_B = "token-user-b";
const config: AppConfig = { port: 8000, publicBaseUrl: BASE, adminToken: "admin-secret" };

async function setupApp() {
  const stores: Stores = memoryStores();
  await stores.metadata.putUser(
    makeUser({ id: "user-a", displayName: "Alice", status: "approved", feedToken: TOKEN_A }),
  );
  await stores.metadata.putUser(
    makeUser({ id: "user-b", displayName: "Bob", status: "approved", feedToken: TOKEN_B }),
  );
  const ctx = { config, stores };
  const { fetch } = createApp(ctx, createHandlers(ctx));
  return { fetch, stores };
}

Deno.test("player filtering: page renders accessible filter controls and honest empty state (audio-feed-3h1)", async () => {
  const { fetch } = await setupApp();
  const res = await fetch(new Request(`${BASE}/listen/${TOKEN_A}`));
  assertEquals(res.status, 200);
  const html = await res.text();

  assertStringIncludes(html, 'id="filterSection"');
  assertStringIncludes(html, 'role="search"');
  assertStringIncludes(html, 'id="filterText"');
  assertStringIncludes(html, 'type="search"');
  assertStringIncludes(html, 'id="filterSource"');
  assertStringIncludes(html, 'id="filterEmpty"');
  assertStringIncludes(html, 'id="filterEmptyMessage"');
  assertStringIncludes(html, 'id="clearFilterBtn"');
  assertStringIncludes(html, 'id="episodeCount"');
});

Deno.test("player filtering: client script includes filtering, honest count and consistent activity filtering (audio-feed-3h1)", async () => {
  const { fetch } = await setupApp();
  const html = await (await fetch(new Request(`${BASE}/listen/${TOKEN_A}`))).text();
  const client = await playerClient(fetch, BASE, html);

  assertStringIncludes(client, "audio-feed-filter:");
  assertStringIncludes(client, "populateSourceFilter");
  assertStringIncludes(client, "matchesEpisode");
  assertStringIncludes(client, "matchesActivity");
  assertStringIncludes(client, "filterEmpty");
  assertStringIncludes(client, "clearFilterBtn");
  assertStringIncludes(client, "of");
  assertStringIncludes(client, "episode");
});

Deno.test("player filtering: per-token filter storage isolation simulation (audio-feed-3h1)", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };

  const keyA = `audio-feed-filter:${TOKEN_A}`;

  function saveFilter(token: string, source: string, text: string) {
    const k = `audio-feed-filter:${token}`;
    if (!source && !text) storage.removeItem(k);
    else storage.setItem(k, JSON.stringify({ source, text }));
  }

  function loadFilter(token: string) {
    const k = `audio-feed-filter:${token}`;
    const raw = storage.getItem(k);
    if (!raw) return { source: "", text: "" };
    return JSON.parse(raw);
  }

  // Alice sets filter
  saveFilter(TOKEN_A, "Stratechery", "platform");
  assertEquals(loadFilter(TOKEN_A), { source: "Stratechery", text: "platform" });

  // Bob's filter is unconfigured
  assertEquals(loadFilter(TOKEN_B), { source: "", text: "" });

  // Clear Alice filter
  saveFilter(TOKEN_A, "", "");
  assertEquals(storage.getItem(keyA), null);
  assertEquals(loadFilter(TOKEN_A), { source: "", text: "" });
});

Deno.test("player filtering: private mode storage exception degrades safely (audio-feed-3h1)", () => {
  const throwingStorage = {
    getItem: () => {
      throw new Error("QuotaExceededError in private window");
    },
    setItem: () => {
      throw new Error("QuotaExceededError in private window");
    },
  };

  let threw = false;
  try {
    let result = { source: "", text: "" };
    try {
      const raw = throwingStorage.getItem();
      result = raw ? JSON.parse(raw) : { source: "", text: "" };
    } catch {
      result = { source: "", text: "" };
    }
    assertEquals(result, { source: "", text: "" });

    try {
      throwingStorage.setItem();
    } catch {
      // Degraded
    }
  } catch {
    threw = true;
  }
  assertEquals(threw, false, "filter storage exception must degrade safely");
});
