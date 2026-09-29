/**
 * Browser proof for the regenerate button (audio-feed-8oz).
 *
 * Starts scripts/regenerate-harness.ts in-process (stub synthesizer, no spend),
 * drives the real admin console in headless Chrome for Testing over raw CDP, and
 * checks the feed and /audio at each step:
 *   click Regenerate -> confirm -> the feed still serves the OLD key, also while the
 *   new audio is being synthesised -> release -> the feed serves a NEW key, the old
 *   blob 404s, the new one plays.
 *
 *   deno run --allow-all --unstable-kv scripts/regenerate-browser-proof.ts <chrome> <profileDir> <outDir>
 *
 * Writes screenshots and evidence.json to <outDir>. Exits non-zero if a check fails.
 */
import {
  HARNESS_ADMIN_TOKEN,
  HARNESS_FEED_TOKEN,
  OLD_KEY,
  startRegenerateHarness,
} from "./regenerate-harness.ts";

const [chromePath, profileDir, outDir] = Deno.args;
if (!chromePath || !profileDir || !outDir) {
  throw new Error("usage: regenerate-browser-proof.ts <chrome> <profileDir> <outDir>");
}
await Deno.mkdir(outDir, { recursive: true });
await Deno.remove(profileDir, { recursive: true }).catch(() => {});
await Deno.mkdir(profileDir, { recursive: true });

const h = await startRegenerateHarness(0);
const feedUrl = `${h.base}/feed/${HARNESS_FEED_TOKEN}/master.xml`;
const checks: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail: string) => {
  checks.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}: ${detail}`);
};

// Chrome's helpers inherit stdio: never "piped", or this script hangs on exit.
const chrome = new Deno.Command(chromePath, {
  args: [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ],
  stdout: "null",
  stderr: "null",
}).spawn();

async function devtoolsEndpoint(): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      const [port, path] = (await Deno.readTextFile(`${profileDir}/DevToolsActivePort`)).split(
        "\n",
      );
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Chrome did not write DevToolsActivePort");
}

const ws = new WebSocket(await devtoolsEndpoint());
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 1;
const pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
const dialogs: string[] = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Page.javascriptDialogOpening") {
    dialogs.push(msg.params.message);
    void send("Page.handleJavaScriptDialog", { accept: true }, msg.sessionId);
  }
};
// deno-lint-ignore no-explicit-any
async function send(method: string, params: unknown = {}, sessionId?: string): Promise<any> {
  const id = nextId++;
  const reply = new Promise<{ result?: unknown; error?: unknown }>((r) => pending.set(id, r));
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  const msg = await reply;
  if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}

async function openTab(url: string): Promise<string> {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  }, sessionId);
  await navigate(sessionId, url);
  return sessionId;
}

async function navigate(session: string, url: string) {
  await send("Page.navigate", { url }, session);
  await waitFor(session, "document.readyState === 'complete'");
}

// deno-lint-ignore no-explicit-any
async function evaluate(session: string, expression: string): Promise<any> {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, session);
  if (exceptionDetails) throw new Error(`evaluate failed: ${JSON.stringify(exceptionDetails)}`);
  return result.value;
}

async function waitFor(session: string, expression: string, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await evaluate(session, `!!(${expression})`)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${expression}`);
}

async function screenshot(session: string, name: string) {
  const { data } = await send("Page.captureScreenshot", { format: "png" }, session);
  await Deno.writeFile(
    `${outDir}/${name}.png`,
    Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
  );
  console.log(`screenshot ${name}.png`);
}

const status = async (key: string) => {
  const res = await fetch(`${h.base}/${key}`);
  await res.body?.cancel();
  return res.status;
};
const feed = async () => await (await fetch(feedUrl)).text();

const episodeRow = (title: string) =>
  `[...document.querySelectorAll('#manageEpisodesBody tr')].find(tr => tr.cells[0].textContent === ${
    JSON.stringify(title)
  })`;
const OLD_TITLE = "Made with the old prompts";

async function openManage(admin: string) {
  await evaluate(
    admin,
    `[...document.querySelectorAll('#usersBody button')].find(b => b.textContent === 'Manage').click()`,
  );
  await waitFor(admin, `${episodeRow(OLD_TITLE)}`);
  await evaluate(admin, `document.getElementById('manageEpisodesHelp').scrollIntoView()`);
}

try {
  // 1. Log in to the real console and open the subscriber.
  const admin = await openTab(`${h.base}/admin`);
  await evaluate(
    admin,
    `document.getElementById('adminToken').value = ${JSON.stringify(HARNESS_ADMIN_TOKEN)};
     document.getElementById('saveToken').click();`,
  );
  await waitFor(
    admin,
    `[...document.querySelectorAll('#usersBody button')].some(b => b.textContent === 'Manage')`,
  );
  await openManage(admin);
  const before = await evaluate(
    admin,
    `({ outdated: document.getElementById('regenOutdated').textContent,
        all: document.getElementById('regenAll').textContent,
        row: [...${episodeRow(OLD_TITLE)}.cells].map(c => c.textContent) })`,
  );
  check(
    "before: counts",
    before.outdated === "Regenerate outdated (1)" && before.all === "Regenerate all (2)",
    `${before.outdated} / ${before.all}; row ${before.row.join(" | ")}`,
  );
  const feedBefore = await feed();
  check("before: feed serves the old key", feedBefore.includes(`${h.base}/${OLD_KEY}`), OLD_KEY);
  await screenshot(admin, "01-before");
  const feedTab = await openTab(feedUrl);
  await screenshot(feedTab, "02-feed-before");

  // 2. Click Regenerate on the outdated episode; the confirm dialog is accepted.
  await evaluate(admin, `${episodeRow(OLD_TITLE)}.querySelector('button').click()`);
  await waitFor(admin, `${episodeRow(OLD_TITLE)}?.cells[2].textContent === 'regenerating'`);
  check(
    "confirm dialog raised and states the spend",
    dialogs.length === 1 && /billed TTS/.test(dialogs[0] ?? ""),
    dialogs[0] ?? "(none)",
  );
  const queued = await feed();
  check(
    "queued: feed still serves the old key, old audio plays",
    queued.includes(`${h.base}/${OLD_KEY}`) && (await status(OLD_KEY)) === 200,
    `old key in feed, GET ${OLD_KEY} -> ${await status(OLD_KEY)}`,
  );
  await screenshot(admin, "03-queued");

  // 3. Synthesize Queue Now; the stub blocks mid-synthesis.
  await evaluate(admin, `document.getElementById('synthesizeNowBtn').click()`);
  await h.synthesisStarted;
  const during = await h.stores.metadata.getEpisode("sub-1", "ep-old");
  const feedDuring = await feed();
  check(
    "during synthesis: old audio still served",
    during?.status === "synthesizing" && feedDuring.includes(`${h.base}/${OLD_KEY}`) &&
      (await status(OLD_KEY)) === 200,
    `episode status ${during?.status}, feed enclosure ${OLD_KEY}`,
  );
  await navigate(feedTab, feedUrl);
  await screenshot(feedTab, "04-feed-during-synthesis");
  await openManage(admin);
  await screenshot(admin, "05-admin-during-synthesis");

  // 4. Release the stub: the worker swaps the key.
  h.release();
  const end = Date.now() + 10_000;
  let after = await h.stores.metadata.getEpisode("sub-1", "ep-old");
  while (after?.status !== "ready" && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    after = await h.stores.metadata.getEpisode("sub-1", "ep-old");
  }
  const newKey = after?.audioKey ?? "";
  const feedAfter = await feed();
  check(
    "after: feed serves a NEW key, same GUID",
    newKey !== OLD_KEY && newKey.startsWith("audio/sub-1/direct/ep-old-") &&
      feedAfter.includes(`${h.base}/${newKey}`) && !feedAfter.includes(`${h.base}/${OLD_KEY}`) &&
      feedAfter.includes(`<guid isPermaLink="false">ep-old</guid>`),
    `new key ${newKey}`,
  );
  check(
    "after: old blob is gone",
    (await status(OLD_KEY)) === 404,
    `GET ${OLD_KEY} -> ${await status(OLD_KEY)}`,
  );
  check(
    "after: new audio plays",
    (await status(newKey)) === 200,
    `GET ${newKey} -> ${await status(newKey)}`,
  );
  check(
    "stub synthesizer called once",
    h.synthesizerCalls() === 1,
    `${h.synthesizerCalls()} call(s)`,
  );
  await openManage(admin);
  await waitFor(admin, `${episodeRow(OLD_TITLE)}?.cells[3].textContent === 'current'`);
  const afterUi = await evaluate(
    admin,
    `({ outdated: document.getElementById('regenOutdated').textContent,
        row: [...${episodeRow(OLD_TITLE)}.cells].map(c => c.textContent) })`,
  );
  check(
    "after: console shows it current",
    afterUi.outdated === "Regenerate outdated (0)",
    `${afterUi.outdated}; row ${afterUi.row.join(" | ")}`,
  );
  await screenshot(admin, "06-after");
  await navigate(feedTab, feedUrl);
  await screenshot(feedTab, "07-feed-after");

  await Deno.writeTextFile(
    `${outDir}/evidence.json`,
    JSON.stringify({ chrome: chromePath, oldKey: OLD_KEY, newKey, dialogs, checks }, null, 2) +
      "\n",
  );
} finally {
  ws.close();
  try {
    chrome.kill("SIGKILL");
  } catch { /* already gone */ }
  await chrome.status;
  await h.shutdown();
}

const failed = checks.filter((c) => !c.ok);
console.log(
  failed.length ? `FAILED ${failed.length} check(s)` : `ALL ${checks.length} CHECKS PASSED`,
);
Deno.exit(failed.length ? 1 : 0);
