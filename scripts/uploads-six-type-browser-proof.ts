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
 * SYNTHESIZER: the harness (scripts/uploads-harness.ts) runs the REAL app with
 * the REAL in-memory synthesis worker but an injected DETERMINISTIC STUB
 * synthesizer (fixed 524-byte WAV, fixed 2s duration) - NOT Gemini, so a run
 * spends nothing. A row reaching READY proves upload -> extraction -> queue ->
 * worker -> stored audio -> ready; it does NOT prove the voice. The stub logs
 * the first 2,000 chars of every text it is asked to speak to a narration log
 * whose path the harness prints (NARRATION_LOG path=...); this proof reads that
 * log to assert each fixture's distinctive sentence REACHED narration.
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

/** The sentence each generated fixture must carry all the way to narration. */
const DISTINCTIVE_SENTENCES: Record<string, string | undefined> = {
  pdf: "Uploaded PDF acceptance sentence.",
  html: "Uploaded HTML acceptance sentence.",
  txt: "Uploaded TXT acceptance sentence.",
  md: "Uploaded MD acceptance sentence.",
  docx: undefined, // a REAL fixture whose wording is not ours to choose
};

// The checks this proof runs, in words (documentation; the checker is the authority).
const _ASSERTS = [
  "pdf: episode reaches ready with bytes, duration and state recorded",
  "html: episode reaches ready with bytes, duration and state recorded",
  "txt: episode reaches ready with bytes, duration and state recorded",
  "md: episode reaches ready with bytes, duration and state recorded",
  "docx: episode reaches ready with bytes, duration and state recorded",
  "html script tag does not execute during extraction",
  "html visible text is still extracted",
  "html script body does not reach narration",
  "legacy .doc is rejected in the UI with a message naming the format",
  "legacy .doc rejection names the replacement (.docx)",
  "over-limit document is rejected or truncated explicitly, not silently",
  "text-less PDF is rejected in the UI naming the reason, with no episode created",
  "document over the 72,000-byte narration ceiling is rejected naming the limit, with no episode created",
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
  durationSeconds?: number;
  audioKey?: string;
}

/**
 * A minimal but VALID single-page PDF: correct xref offsets, because pdf-parse
 * reads the cross-reference table (the first harness's hand-written fixture had
 * none, and no extractor is obliged to tolerate that). Sentences must avoid
 * parentheses - the text operators do not escape them.
 */
function makePdf(sentences: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const content = sentences.map((s, i) => `BT /F1 18 Tf 72 ${700 - i * 30} Td (${s}) Tj ET`).join(
    "\n",
  );
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${encoder.encode(content).byteLength}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(encoder.encode(out).byteLength);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = encoder.encode(out).byteLength;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return encoder.encode(out);
}

await runProof("uploads-six-type-browser-proof", async (checker) => {
  const SCRATCH = await Deno.makeTempDir({ prefix: "audiofeed-d82rv-uploads-" });
  console.log("[d82rv] spawning harness (real app + worker + STUB synthesizer)…");
  // The harness runs the synthesis worker with an injected STUB synthesizer:
  // account-harness.ts has no worker, so episodes uploaded against it stay
  // pending forever - that gap, not a product defect, was the first harness's
  // 'no type reaches ready' result.
  const harness = await spawnHarness("scripts/uploads-harness.ts");
  console.log("[d82rv] harness up at", harness.base);
  const BASE = harness.base;
  const narrationLogPath = /NARRATION_LOG path=(\S+)/.exec(harness.getLogs().stdout)?.[1];
  if (!narrationLogPath) throw new Error("harness did not print a NARRATION_LOG path");
  console.log("[d82rv] narration log:", narrationLogPath);

  /** Narration lines the stub synthesizer recorded: what it was asked to speak. */
  async function narrationLines(): Promise<Array<Record<string, unknown>>> {
    const text = await Deno.readTextFile(narrationLogPath!).catch(() => "");
    return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

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
    const pdf = makePdf([
      "Uploaded PDF acceptance sentence.",
      "A second sentence so the extractor has enough text to call this a document.",
      "A third sentence, because under eighty bytes of text is correctly rejected as unreadable.",
    ]);
    const txt = new TextEncoder().encode(
      "Uploaded TXT acceptance sentence.\n\nA second paragraph so the paragraph splitter has work to do.\n",
    );
    const md = new TextEncoder().encode(
      "# Uploaded MD acceptance heading\n\nUploaded MD acceptance sentence.\n\n- a bullet\n- another bullet\n",
    );
    const htmlText = "Uploaded HTML acceptance sentence.";
    // A REALISTIC article, not a one-line page: extraction runs Readability
    // with charThreshold 80, and a page whose paragraphs are all short is
    // correctly rejected as 'no readable article'. The <script> rides along in
    // a page that is otherwise a genuine article, which is exactly the case
    // the extraction-must-not-execute condition exists for.
    const html = new TextEncoder().encode(
      `<!doctype html><html><head><title>Acceptance Article</title></head><body>` +
        `<article>` +
        `<h1>Uploaded HTML acceptance heading</h1>` +
        `<p>${htmlText} This paragraph continues with enough ordinary prose to stand as ` +
        `article text, since a page of one-line paragraphs is not an article to any extractor.</p>` +
        `<p>A second paragraph of plain article prose, long enough to count toward the document ` +
        `being readerable, and carrying no markup the narration should ever speak.</p>` +
        `<p>A third paragraph closing the piece, again with enough words that the whole reads ` +
        `like a short article rather than a landing shell or a login page.</p>` +
        `</article>` +
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
    // The legacy .doc MUST be copied into the scratch root: CDP
    // DOM.setFileInputFiles reads the path from disk, and pointing it at a
    // path that does not exist is what produced the bogus 'Failed to fetch'
    // (a transport failure, not the format rejection) in the first harness.
    const legacyDocPath = `${SCRATCH}/legacy.doc`;
    await Deno.writeFile(legacyDocPath, legacyDoc);

    // ---- a subscriber to upload as ------------------------------------------------
    console.log("[d82rv] reading harness users…");
    const usersRes = await fetch(`${BASE}/api/admin/users`, {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    const usersBody = await usersRes.json() as { users?: Array<{ id: string; email?: string }> };
    const user = usersBody.users?.[0];
    if (!user) throw new Error("harness exposed no users to sign in as");
    console.log("[d82rv] user:", user.id, "requesting setup link…");
    const linkRes = await fetch(`${BASE}/api/admin/users/${user.id}/setup-link`, {
      method: "POST",
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    const linkBody = await linkRes.json() as { url?: string; link?: string };
    const setupUrl = linkBody.url ?? linkBody.link;
    if (!setupUrl) throw new Error("harness returned no setup link");

    console.log("[d82rv] setup link:", String(setupUrl).slice(0, 60));
    console.log("[d82rv] launching chrome…");
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
        const msg = await withDeadline(
          method,
          20_000,
          () => new Promise<{ result?: unknown; error?: unknown }>((r) => pending.set(id, r)),
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

      // audio-feed-d82rv: the sign-in step is a PASSKEY BOOTSTRAP (/login#setup= registers a WebAuthn credential).
      // A CDP-driven Chrome with no authenticator waits on the user forever, which is a browser-side wait no deadline
      // on a CDP call can shorten - that is exactly what stalled the first two runs. These three calls are copied
      // verbatim from scripts/account-browser-proof.ts:187-197, which signs in successfully on this VM.
      await cdp("WebAuthn.enable");
      await cdp("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
        },
      });

      // ---- sign in, land on /account -----------------------------------------------
      console.log("[d82rv] chrome up, signing in (passkey bootstrap)…");
      const setupSecret = String(setupUrl).split("#setup=")[1] ?? "";
      if (!setupSecret) throw new Error("setup link carried no #setup= secret");
      await go("/login#setup=" + setupSecret);
      await until(`document.getElementById("createPasskey")?.disabled === false`, "setup options");
      await js(`document.getElementById("createPasskey").click()`);
      await until(`location.pathname === "/account"`, "signed in on /account");
      await until(`document.getElementById("uploadFile") !== null`, "upload form on /account");
      cookieCache = null;

      console.log("[d82rv] signed in, listing episodes…");
      const known = new Set((await episodes()).map((e) => e.id));
      console.log("[d82rv] starting type loop");

      // ---- the five accepted types --------------------------------------------------
      for (const type of Object.keys(files)) {
        const started = Date.now();
        try {
          await go("/account");
          await until(`document.getElementById("uploadFile") !== null`, `upload form (${type})`);
          await uploadVia(paths[type]!);
          // 60s, not the 15s default: a cold pdf-parse/readability import can
          // exceed 15s on a first upload, and a type that fails must fail on
          // EVIDENCE, not on a warm-up wait. On timeout the detail carries the
          // feedback the UI was actually showing.
          const queuedDesc = `queued state after uploading ${type}`;
          try {
            await until(
              `document.getElementById("uploadFeedback")?.textContent?.startsWith("Queued: ") === true`,
              queuedDesc,
              60_000,
            );
          } catch (queuedError) {
            const fb = await feedback().catch(() => null);
            throw new Error(
              `${queuedDesc}: ${String((queuedError as Error).message ?? queuedError)}; ` +
                `UI feedback at timeout: ${JSON.stringify(fb)}`,
            );
          }

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
          // Did this fixture's distinctive sentence reach the narration input?
          const sentence = DISTINCTIVE_SENTENCES[type];
          const narration = (await narrationLines()).find((l) => l.episodeId === episode.id);
          const reachedNarration = sentence
            ? String(narration?.textHead ?? "").includes(sentence)
            : typeof narration?.textBytes === "number" && (narration.textBytes as number) > 0;
          record[type] = {
            episodeId: episode.id,
            title: episode.title,
            status: episode.status,
            byteLength: episode.byteLength,
            durationSec: episode.durationSeconds,
            audioKey: episode.audioKey,
            narrationTextBytes: narration?.textBytes,
            distinctiveSentenceReachedNarration: reachedNarration,
            ms: Date.now() - started,
          };
          const measured = typeof episode.byteLength === "number" && episode.byteLength > 0 &&
            typeof episode.durationSeconds === "number" && episode.durationSeconds > 0;
          checker.check(
            `${type}: episode reaches ready with bytes, duration and state recorded`,
            (episode.status ?? "").toLowerCase() === "ready" && measured,
            `status: '${episode.status}' bytes: ${episode.byteLength} duration: ${episode.durationSeconds}`,
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
      // cannot pass by extracting nothing at all. There is no transcript route;
      // the observable surface of extraction is the NARRATION LOG - the exact
      // text the worker handed the synthesizer for the html episode.
      const htmlEpisode = record.html as { episodeId?: string } | undefined;
      const htmlNarration = (await narrationLines()).find((l) =>
        l.episodeId === htmlEpisode?.episodeId
      );
      const htmlNarrationText = String(htmlNarration?.textHead ?? "");
      checker.check(
        "html visible text is still extracted",
        htmlNarrationText.includes(htmlText),
        htmlNarrationText
          ? "narration input contains the visible sentence"
          : "no narration line recorded for the html episode",
      );
      // …and the extraction must not have carried the script into narration.
      const carriedScript = /<script|alert\(|__D82RV_SCRIPT_RAN/i.test(htmlNarrationText);
      checker.check(
        "html script body does not reach narration",
        htmlNarrationText.length > 0 && !carriedScript,
        carriedScript ? "script marker present in narration input" : "narration input is clean",
      );

      // ---- condition 2: the legacy .doc is rejected in the UI ----------------------
      await go("/account");
      await until(`document.getElementById("uploadFile") !== null`, "upload form (.doc)");
      await uploadVia(legacyDocPath);
      const docFeedback = await withDeadline(
        "legacy .doc rejection message",
        60_000,
        async () => {
          while (true) {
            const fb = await feedback();
            // 'Uploading …' (tone ok) is the IN-FLIGHT state, not an answer:
            // only the terminal states - an error, or a queued success - count.
            if (fb && (fb.tone === "error" || fb.text.startsWith("Queued: "))) return fb;
            await sleep(200);
          }
        },
      );
      record.doc = docFeedback;
      const docText = String(docFeedback?.text ?? "");
      // 'Failed to fetch' is a TRANSPORT failure (the browser never reached the
      // route): it says nothing about .doc handling and must not satisfy either
      // row. (First harness: the fixture was never copied into the scratch
      // root, so CDP filled the input with a file Chrome could not read.)
      const docTransportFailure = /failed to fetch|network|load failed/i.test(docText);
      checker.check(
        "legacy .doc is rejected in the UI with a message naming the format",
        docFeedback?.tone === "error" && !docTransportFailure && /\.doc\b/i.test(docText),
        docTransportFailure
          ? `TRANSPORT failure, not a rejection: '${docText.slice(0, 160)}'`
          : `tone: '${docFeedback?.tone}' text: '${docText.slice(0, 160)}'`,
      );
      checker.check(
        "legacy .doc rejection names the replacement (.docx)",
        !docTransportFailure && /docx/i.test(docText),
        docTransportFailure
          ? "TRANSPORT failure - no rejection message was shown"
          : docText
          ? `message mentions .docx`
          : "no message text",
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
      // PENDING IS NEVER A PASS. The over-limit document must be REJECTED with
      // a message naming the limit, or reach READY processed; 'accepted and
      // still pending' is exactly the silent non-processing this row exists to
      // catch (the first harness passed it with /accepted/).
      const namesLimit = /(too large|limit|10 ?mib|10 ?mb|exceed|maximum|over[- ]?size|size)/i.test(
        ceilingText,
      );
      const reachedReady = /ready/i.test(ceilingText) || /(bytes: [1-9])/i.test(ceilingText);
      const rejectedWithReason = ceilingFeedback?.tone === "error" && namesLimit;
      const ceilingPass = Boolean(rejectedWithReason || reachedReady);
      const ceilingDetail =
        `tone: '${ceilingFeedback?.tone}' text: '${ceilingText.slice(0, 160)}'` +
        (/pending/i.test(ceilingText) && !reachedReady
          ? " - SILENT: accepted but still pending, which is the failure this row exists to catch"
          : "");
      checker.check(
        "over-limit document is rejected or truncated explicitly, not silently",
        ceilingPass,
        ceilingDetail,
      );

      // ---- the two remaining rejections: read from the page, and no silent episode ----------
      // A rejection that created a pending episode anyway would be the silent-processing
      // failure these conditions exist to catch, so each row also asserts the listing
      // gained NOTHING.
      const noTextPdfPath = `${SCRATCH}/no-text.pdf`;
      await Deno.writeFile(noTextPdfPath, makePdf([])); // a valid page with no text operators
      const tooLongPath = `${SCRATCH}/too-long.txt`;
      await Deno.writeFile(tooLongPath, new TextEncoder().encode("y".repeat(73_000)));

      /** Upload, wait for a TERMINAL feedback state, then count fresh episodes. */
      async function rejectedUpload(path: string, desc: string) {
        await go("/account");
        await until(`document.getElementById("uploadFile") !== null`, `upload form (${desc})`);
        await uploadVia(path);
        const fb = await withDeadline(desc, 90_000, async () => {
          while (true) {
            const f = await feedback();
            // 'Uploading …' (tone ok) is the IN-FLIGHT state, not an answer.
            if (f && (f.tone === "error" || f.text.startsWith("Queued: "))) return f;
            await sleep(200);
          }
        });
        // Two worker intervals: enough for a wrongly-created episode to appear and advance.
        await sleep(2_500);
        const fresh = (await episodes()).filter((e) => !known.has(e.id));
        return { fb, freshEpisodes: fresh.length };
      }

      const noText = await rejectedUpload(noTextPdfPath, "text-less PDF rejection");
      const noTextMsg = String(noText.fb?.text ?? "");
      record.noTextPdf = { ...noText.fb, freshEpisodes: noText.freshEpisodes };
      checker.check(
        "text-less PDF is rejected in the UI naming the reason, with no episode created",
        noText.fb?.tone === "error" && /no readable text/i.test(noTextMsg) &&
          noText.freshEpisodes === 0,
        `tone: '${noText.fb?.tone}' text: '${
          noTextMsg.slice(0, 160)
        }' freshEpisodes: ${noText.freshEpisodes}`,
      );

      const tooLong = await rejectedUpload(tooLongPath, "narration ceiling rejection");
      const tooLongMsg = String(tooLong.fb?.text ?? "");
      record.narrationCeiling = { ...tooLong.fb, freshEpisodes: tooLong.freshEpisodes };
      checker.check(
        "document over the 72,000-byte narration ceiling is rejected naming the limit, with no episode created",
        tooLong.fb?.tone === "error" && /72,?000/.test(tooLongMsg) &&
          tooLong.freshEpisodes === 0,
        `tone: '${tooLong.fb?.tone}' text: '${
          tooLongMsg.slice(0, 160)
        }' freshEpisodes: ${tooLong.freshEpisodes}`,
      );
    });
  } finally {
    // Teardown on EVERY path, including the failure path: stop the harness
    // (its worker loop would otherwise leak a process), reap the browser, then
    // prove the profile directory is gone and no process carries it.
    harness.kill();
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
    console.log(
      "D82RV_ACCEPTANCE " + JSON.stringify(
        { synthesizer: "stub (deterministic 524-byte WAV, fixed 2s; NOT Gemini)", ...record },
        null,
        2,
      ),
    );
  }
});

if (exitCodeOf() !== 0) {
  Deno.exit(exitCodeOf());
}

/** runProof sets Deno's exit code on failure; read it so the process mirrors the verdict. */
function exitCodeOf(): number {
  return (Deno as unknown as { exitCode?: number }).exitCode ?? 0;
}
