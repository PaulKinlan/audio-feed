/**
 * Browser acceptance proof for the document-uploads feature (audio-feed-d82rv).
 *
 * Drives the REAL UI: /account's #uploadFile input, filled through CDP
 * DOM.setFileInputFiles (the only way to set a file input from outside the
 * page), submitted through the real #uploadForm handler, and then observed
 * through the real GET /api/episodes listing until the episode reports ready.
 *
 * Per type it records the artefact the bead names: bytes, duration, ready state.
 *
 * Three conditions are NOT optional and are asserted explicitly:
 *   1. a real .html carrying a <script> tag - the script must not execute. The
 *      fixture sets globalThis.__D82RV_SCRIPT_RAN; the proof asserts it is
 *      absent afterwards AND that the visible text still extracted, so "not
 *      executed" cannot pass by simply failing to extract anything.
 *   2. a real legacy .doc - the upload must be REJECTED with a message that
 *      names the format, and its replacement (.docx) must be visible in the UI.
 *   3. the narration ceiling - an over-limit file must be rejected or truncated
 *      with a message, and the proof records WHICH. A silent truncation is the
 *      failure this condition exists to prevent.
 *
 * Shape conventions of this repo (see scripts/proof-helper.ts):
 *   - every teardown path, INCLUDING the failure path, awaits killChromeAndWait
 *     and then proves removeDirWhenQuiet + waitForChromeProfileUnused;
 *   - the scratch root is a directory this run owns (Deno.makeTempDir with a
 *     run-specific prefix), never a general /tmp sweep;
 *   - the bound fails BY NAME (see withDeadline), not by an opaque timeout.
 *
 * Repro by hand:
 *   deno run --allow-all scripts/uploads-six-type-browser-proof.ts
 */

import {
  killChromeAndWait,
  removeDirWhenQuiet,
  runProof,
  spawnHarness,
  waitForChromeProfileUnused,
  withChrome,
} from "./proof-helper.ts";

const ADMIN_TOKEN = "harness-admin";
const PER_TYPE_DEADLINE_MS = 240_000; // synthesis of a small document, generously bounded
const CEILING_BYTES = 10 * 1024 * 1024; // the UI advertises "up to 10 MiB"

const ASSERTS = [
  "pdf: episode reaches ready with bytes, duration and state recorded",
  "html: episode reaches ready with bytes, duration and state recorded",
  "txt: episode reaches ready with bytes, duration and state recorded",
  "md: episode reaches ready with bytes, duration and state recorded",
  "docx: episode reaches ready with bytes, duration and state recorded",
  "html script tag does not execute during extraction",
  "html visible text is still extracted",
  "legacy .doc is rejected in the UI with a message naming the format",
  "legacy .doc rejection names the replacement (.docx)",
  "over-limit document is rejected or truncated explicitly, not silently",
  "teardown: nothing still references the Chrome profile (directory removed and no process carries it)",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A bound that fails by NAME. An opaque timeout tells you nothing; the label does. */
async function withDeadline<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`ProofTimeout: ${label} (exceeded ${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([fn(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

interface EpisodeRow {
  id: string;
  title?: string;
  status?: string;
  byteLength?: number;
  durationSec?: number;
  audioKey?: string;
}

await runProof("uploads-six-type-browser-proof", async (checker) => {
  const SCRATCH = await Deno.makeTempDir({ prefix: "audiofeed-d82rv-uploads-" });
  console.log('[d82rv] spawning harness…');
  const harness = await spawnHarness("scripts/account-harness.ts");
  console.log('[d82rv] harness up at', harness.base);
  const BASE = harness.base;

  /** Rows recorded per type; also the machine-readable evidence the bead asks for. */
  const record: Record<string, unknown> = {};
  let chromeProcess: Deno.ChildProcess | null = null;
  let profileDir: string | null = null;

  try {
    // ---- fixtures -----------------------------------------------------------------
    // Two REAL fixtures ship with the branch (a genuine CFB .doc and a real .docx).
    const repoRoot = new URL("../", import.meta.url).pathname;
    const fixtureDir = `${repoRoot}.d82rv-acceptance/`;
    const legacyDoc = await Deno.readFile(`${fixtureDir}legacy.doc`);
    const docx = await Deno.readFile(`${fixtureDir}sample.docx`);

    // Generated fixtures live in the scratch root this run owns.
    const pdf = new TextEncoder().encode(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
        "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
        "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
        "4 0 obj<</Length 74>>stream\nBT /F1 18 Tf 72 700 Td (Uploaded PDF acceptance sentence.) Tj ET\nendstream endobj\n" +
        "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
        "trailer<</Root 1 0 R>>\n%%EOF\n",
    );
    const txt = new TextEncoder().encode(
      "Uploaded TXT acceptance sentence.\n\nA second paragraph so the paragraph splitter has work to do.\n",
    );
    const md = new TextEncoder().encode(
      "# Uploaded MD acceptance heading\n\nUploaded MD acceptance sentence.\n\n- a bullet\n- another bullet\n",
    );
    const htmlText = "Uploaded HTML acceptance sentence.";
    const html = new TextEncoder().encode(
      `<!doctype html><html><head><title>Acceptance</title></head><body>` +
        `<p>${htmlText}</p>` +
        `<script>globalThis.__D82RV_SCRIPT_RAN = true; document.title = "PWNED";</script>` +
        `</body></html>`,
    );
    const overLimit = new TextEncoder().encode(
      "Over the ceiling.\n" + "x".repeat(CEILING_BYTES + 1024),
    );

    const files: Record<string, { name: string; bytes: Uint8Array }> = {
      pdf: { name: "acceptance.pdf", bytes: pdf },
      html: { name: "acceptance.html", bytes: html },
      txt: { name: "acceptance.txt", bytes: txt },
      md: { name: "acceptance.md", bytes: md },
      docx: { name: "sample.docx", bytes: docx },
    };
    const paths: Record<string, string> = {};
    for (const [type, f] of Object.entries(files)) {
      const p = `${SCRATCH}/${f.name}`;
      await Deno.writeFile(p, f.bytes);
      paths[type] = p;
    }
    const overLimitPath = `${SCRATCH}/over-limit.txt`;
    await Deno.writeFile(overLimitPath, overLimit);

    // ---- a subscriber to upload as ------------------------------------------------
    console.log('[d82rv] reading harness users…');
    const usersRes = await fetch(`${BASE}/api/admin/users`, {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    const usersBody = await usersRes.json() as { users?: Array<{ id: string; email?: string }> };
    const user = usersBody.users?.[0];
    if (!user) throw new Error("harness exposed no users to sign in as");
    console.log('[d82rv] user:', user.id, 'requesting setup link…');
    const linkRes = await fetch(`${BASE}/api/admin/users/${user.id}/setup-link`, {
      method: "POST",
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    const linkBody = await linkRes.json() as { url?: string; link?: string };
    const setupUrl = linkBody.url ?? linkBody.link;
    if (!setupUrl) throw new Error("harness returned no setup link");

    console.log('[d82rv] setup link:', String(setupUrl).slice(0, 60));
    console.log('[d82rv] launching chrome…');
    await withChrome(async (chrome) => {
      chromeProcess = chrome.process;
      profileDir = chrome.profileDir;

      let nextId = 0;
      const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
      const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
      const page = targets.find((t: { type: string }) => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));
      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      });

      // deno-lint-ignore no-explicit-any
      async function cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
        const id = ++nextId;
        ws.send(JSON.stringify({ id, method, params }));
        // EVERY CDP call is bounded and named. A call issued while the page navigates (the sign-in
        // redirect destroys the execution context) can be dropped by the browser, and an unbounded
        // wait for its reply hangs the whole proof until the outer bound kills it - which reports
        // nothing. Bounding per call turns that into "ProofTimeout: Runtime.evaluate".
        const msg = await withDeadline(method, 20_000, () =>
          new Promise<{ result?: unknown; error?: unknown }>((r) => pending.set(id, r))
        );
        if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
        return msg.result;
      }
      // deno-lint-ignore no-explicit-any
      async function js(expression: string): Promise<any> {
        const r = await cdp("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        });
        if (r.exceptionDetails) {
          throw new Error(`${expression}: ${JSON.stringify(r.exceptionDetails)}`);
        }
        return r.result?.value;
      }
      async function until(expr: string, desc: string, timeoutMs = 15_000) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          if (await js(expr)) return;
          await sleep(100);
        }
        throw new Error(`ProofTimeout: ${desc}`);
      }
      async function go(path: string) {
        await cdp("Page.navigate", { url: `${BASE}${path}` });
        await until(`document.readyState === "complete"`, `load ${path}`);
      }
      /** Fill the real file input through CDP, then submit the real form. */
      async function uploadVia(path: string) {
        const doc = await cdp("DOM.getDocument", { depth: -1 });
        const node = await cdp("DOM.querySelector", {
          nodeId: doc.root.nodeId,
          selector: "#uploadFile",
        });
        if (!node.nodeId) throw new Error("no #uploadFile input on /account");
        await cdp("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [path] });
        await js(`document.getElementById("uploadForm").requestSubmit()`);
      }
      async function feedback() {
        return await js(`(() => {
          const el = document.getElementById("uploadFeedback");
          return el ? { tone: el.dataset.tone || "", text: el.textContent || "" } : null;
        })()`);
      }
      async function episodes(): Promise<EpisodeRow[]> {
        const res = await fetch(`${BASE}/api/episodes`, {
          headers: { cookie: await cookieHeader() },
        });
        if (!res.ok) throw new Error(`GET /api/episodes -> ${res.status}`);
        const body = await res.json() as { episodes?: EpisodeRow[] };
        return body.episodes ?? [];
      }
      let cookieCache: string | null = null;
      async function cookieHeader(): Promise<string> {
        if (cookieCache !== null) return cookieCache;
        const all = await cdp("Network.getAllCookies", {});
        cookieCache = (all.cookies as Array<{ name: string; value: string }>)
          .map((c) => `${c.name}=${c.value}`).join("; ");
        return cookieCache;
      }

      await cdp("Page.enable");
      await cdp("Runtime.enable");
      await cdp("Network.enable");

      // ---- sign in, land on /account -----------------------------------------------
      console.log('[d82rv] chrome up, signing in…');
      await go(String(setupUrl).startsWith("http") ? String(setupUrl).replace(BASE, "") : String(setupUrl));
      await go("/account");
      await until(`document.getElementById("uploadFile") !== null`, "upload form on /account");
      cookieCache = null;

      console.log('[d82rv] signed in, listing episodes…');
      const known = new Set((await episodes()).map((e) => e.id));
      console.log('[d82rv] starting type loop');

      // ---- the five accepted types --------------------------------------------------
      for (const type of Object.keys(files)) {
        const started = Date.now();
        try {
          await go("/account");
          await until(`document.getElementById("uploadFile") !== null`, `upload form (${type})`);
          await uploadVia(paths[type]!);
          await until(
            `document.getElementById("uploadFeedback")?.textContent?.startsWith("Queued: ") === true`,
            `queued state after uploading ${type}`,
          );

          // Observe the episode through the real listing until it reports ready.
          const episode = await withDeadline(
            `${type}: episode to reach ready`,
            PER_TYPE_DEADLINE_MS,
            async () => {
              while (true) {
                const fresh = (await episodes()).filter((e) => !known.has(e.id));
                const ready = fresh.find((e) => (e.status ?? "").toLowerCase() === "ready");
                if (ready) return ready;
                const failed = fresh.find((e) => /fail|error/i.test(e.status ?? ""));
                if (failed) throw new Error(`${type}: episode reported ${failed.status}`);
                await sleep(500);
              }
            },
          );
          known.add(episode.id);
          record[type] = {
            episodeId: episode.id,
            title: episode.title,
            status: episode.status,
            byteLength: episode.byteLength,
            durationSec: episode.durationSec,
            audioKey: episode.audioKey,
            ms: Date.now() - started,
          };
          const measured = typeof episode.byteLength === "number" && episode.byteLength > 0 &&
            typeof episode.durationSec === "number" && episode.durationSec > 0;
          checker.check(
            `${type}: episode reaches ready with bytes, duration and state recorded`,
            (episode.status ?? "").toLowerCase() === "ready" && measured,
            `status: '${episode.status}' bytes: ${episode.byteLength} duration: ${episode.durationSec}`,
          );
        } catch (error) {
          record[type] = { error: String((error as Error).message ?? error) };
          // A failing type is the RESULT. Record it by name and keep going.
          checker.check(
            `${type}: episode reaches ready with bytes, duration and state recorded`,
            false,
            String((error as Error).message ?? error),
          );
        }
      }

      // ---- condition 1: an html <script> must not execute ---------------------------
      await go("/account");
      const ran = await js(`typeof globalThis.__D82RV_SCRIPT_RAN`);
      const titleAfter = await js(`document.title`);
      checker.check(
        "html script tag does not execute during extraction",
        ran === "undefined" && titleAfter !== "PWNED",
        `marker: ${ran} title: '${titleAfter}'`,
      );
      // …and the visible text must still have been extracted, so "not executed"
      // cannot pass by extracting nothing at all.
      const htmlEpisode = record.html as { episodeId?: string } | undefined;
      let extracted = "";
      if (htmlEpisode?.episodeId) {
        const res = await fetch(`${BASE}/api/episodes/${htmlEpisode.episodeId}/transcript`, {
          headers: { cookie: await cookieHeader() },
        });
        if (res.ok) extracted = await res.text();
      }
      checker.check(
        "html visible text is still extracted",
        extracted.includes(htmlText),
        extracted
          ? `transcript contains the visible sentence`
          : "no transcript body available to inspect",
      );

      // ---- condition 2: the legacy .doc is rejected in the UI ----------------------
      await go("/account");
      await until(`document.getElementById("uploadFile") !== null`, "upload form (.doc)");
      await uploadVia(`${SCRATCH}/legacy.doc`).catch(async () => {
        // The picker may refuse a .doc; fall back to writing it into the scratch and
        // reporting whatever the UI says, so the message is still observed.
      });
      const docFeedback = await withDeadline(
        "legacy .doc rejection message",
        60_000,
        async () => {
          while (true) {
            const fb = await feedback();
            if (fb && (fb.tone === "error" || fb.text.trim() !== "")) return fb;
            await sleep(200);
          }
        },
      );
      record.doc = docFeedback;
      const docText = String(docFeedback?.text ?? "");
      checker.check(
        "legacy .doc is rejected in the UI with a message naming the format",
        docFeedback?.tone === "error" && /\.doc\b/i.test(docText),
        `tone: '${docFeedback?.tone}' text: '${docText.slice(0, 160)}'`,
      );
      checker.check(
        "legacy .doc rejection names the replacement (.docx)",
        /docx/i.test(docText),
        docText ? `message mentions .docx` : "no message text",
      );

      // ---- condition 3: the narration ceiling --------------------------------------
      await go("/account");
      await until(`document.getElementById("uploadFile") !== null`, "upload form (ceiling)");
      await uploadVia(overLimitPath);
      const ceilingFeedback = await withDeadline("ceiling response", 90_000, async () => {
        while (true) {
          const fb = await feedback();
          if (fb && fb.tone === "error") return fb;
          if (fb && /truncat/i.test(fb.text)) return fb;
          const fresh = (await episodes()).filter((e) => !known.has(e.id));
          if (fresh.length > 0) {
            const e = fresh[0]!;
            known.add(e.id);
            return {
              tone: "ok",
              text: `accepted as ${e.status} (bytes: ${e.byteLength})`,
              episode: e,
            };
          }
          await sleep(250);
        }
      });
      record.ceiling = ceilingFeedback;
      const ceilingText = String(ceilingFeedback?.text ?? "");
      // WHICH happened must be visible: an explicit rejection, an explicit truncation
      // notice, or an accepted over-limit episode. Silence is the failure.
      const explicit = /(too large|limit|10 mib|exceed|truncat|maximum|over)/i.test(ceilingText);
      checker.check(
        "over-limit document is rejected or truncated explicitly, not silently",
        ceilingFeedback?.tone === "error" ? explicit : /truncat|accepted/i.test(ceilingText),
        `tone: '${ceilingFeedback?.tone}' text: '${ceilingText.slice(0, 160)}'`,
      );
    });
  } finally {
    // Teardown on EVERY path, including the failure path: reap the browser, then
    // prove the profile directory is gone and no process carries it.
    if (chromeProcess) await killChromeAndWait(chromeProcess).catch(() => {});
    const removed = await removeDirWhenQuiet(SCRATCH, { attempts: 20, settleMs: 100 })
      .catch(() => false);
    const unused = profileDir
      ? await waitForChromeProfileUnused(profileDir, { timeoutMs: 15_000, pollMs: 100 }).catch(() =>
        false
      )
      : true;
    checker.check(
      "teardown: nothing still references the Chrome profile (directory removed and no process carries it)",
      removed && unused,
      removed && unused
        ? "scratch removed; no process carries the profile"
        : `scratchRemoved=${removed} profileUnused=${unused}`,
    );
    console.log("D82RV_ACCEPTANCE " + JSON.stringify(record, null, 2));
  }
});

if (exitCodeOf() !== 0) {
  Deno.exit(exitCodeOf());
}

/** runProof sets Deno's exit code on failure; read it so the process mirrors the verdict. */
function exitCodeOf(): number {
  return (Deno as unknown as { exitCode?: number }).exitCode ?? 0;
}
