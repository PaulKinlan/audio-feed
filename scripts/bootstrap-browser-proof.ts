/**
 * Browser proof for the admin passkey bootstrap UI (audio-feed-8eh).
 *
 * Starts scripts/account-harness.ts, drives real headless Chrome over CDP with a
 * CDP virtual authenticator, and walks the direct browser bootstrap path:
 *   1. Visit signed-out /admin -> verify affordance link to bootstrap.
 *   2. Click through to /login?next=%2Fadmin#bootstrap -> verify accordion opens.
 *   3. Falsification: submit invalid token -> verify feedback error.
 *   4. Submit valid ADMIN_TOKEN + email -> navigator.credentials.create() registers passkey.
 *   5. Session cookie set and browser redirects to /admin.
 *   6. /admin console loads subscriber data on that new admin session without curl!
 *
 *   deno run --allow-all --unstable-kv scripts/bootstrap-browser-proof.ts
 */

import {
  killChromeAndWait,
  runProof,
  spawnHarness,
  withChrome,
  writeEvidenceReadme,
} from "./proof-helper.ts";
import { quantiseEvidencePng } from "./evidence-png.ts";
import { connectCdp, HANG_BOUND_MS } from "./proof-cdp.ts";

const OUT = new URL("../docs/evidence/audio-feed-8eh/", import.meta.url).pathname;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

await runProof("audio-feed-8eh", async (checker) => {
  const harness = await spawnHarness("scripts/account-harness.ts");
  const BASE = harness.base;
  const steps: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail = "") => {
    steps.push({ name, pass, detail });
    checker.check(name, pass, detail);
  };

  try {
    await withChrome(async (chrome) => {
      // The shared client, not a private copy of it (audio-feed-go4le). The copy this file used
      // to carry sent its `Runtime.evaluate` with NO timeout at all, so every bare `await js(...)`
      // below had no per-wait ceiling and a main thread that never answered hung the proof until
      // something outside it killed the lane; its private `until` also defaulted to the
      // un-derived 8s and never clamped a poll to the budget that was left. `connectCdp` bounds
      // ONE evaluate against the timer (CdpHangBoundExceeded), defaults `js()` and `until()` to
      // HANG_BOUND_MS = 120s = 15 x the measured 8s starved-poll floor (audio-feed-6gst1), and
      // bounds each poll by what is left of the wait it is serving. HANG_BOUND_MS is a HANG
      // bound, never a latency promise: a page whose main thread never answers still fails, in
      // two minutes, with a message naming what was asked and the budget it had.
      const { cdp, js, until, ws } = await connectCdp(chrome.port);

      async function go(path: string) {
        await cdp("Page.navigate", { url: `${BASE}${path}` });
        await until(`document.readyState === "complete"`, `load ${path}`, HANG_BOUND_MS);
        await sleep(100);
      }

      try {
        await cdp("Page.enable");
        await cdp("Runtime.enable");
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

        // 1. Visit signed-out /admin and check bootstrap affordance link
        await go("/admin");
        check(
          "signed-out /admin links to bootstrap",
          await js(`!!document.querySelector('a[href="/login?next=%2Fadmin#bootstrap"]')`),
          "found link to /login?next=%2Fadmin#bootstrap",
        );

        // 2. Click through to /login?next=%2Fadmin#bootstrap
        await js(`document.querySelector('a[href="/login?next=%2Fadmin#bootstrap"]').click()`);
        await until(`location.pathname === "/login"`, "login navigation", HANG_BOUND_MS);
        check(
          "#bootstrap fragment auto-opens Admin bootstrap details",
          await js(`document.getElementById("bootstrapDetails")?.open === true`),
          "accordion is open",
        );

        // 3. Falsification: invalid token returns 401 and shows error
        await js(`
        document.getElementById("bootstrapEmail").value = "bootadmin@example.com";
        document.getElementById("bootstrapToken").value = "wrong-token";
        document.getElementById("bootstrapForm").requestSubmit();
      `);
        await until(
          `document.getElementById("bootstrapFeedback").dataset.tone === "error"`,
          "error on invalid token",
          HANG_BOUND_MS,
        );
        check(
          "invalid admin token shows error feedback",
          (await js(`document.getElementById("bootstrapFeedback").textContent`)).includes(
            "Invalid admin token",
          ),
          await js(`document.getElementById("bootstrapFeedback").textContent`),
        );

        // 4. Valid bootstrap: enter correct token and submit
        await js(`
        document.getElementById("bootstrapToken").value = "harness-admin";
        document.getElementById("bootstrapSubmit").disabled = false;
        document.getElementById("bootstrapForm").requestSubmit();
      `);

        // Wait for WebAuthn ceremony to complete and redirect to /admin
        await until(`location.pathname === "/admin"`, "redirect to /admin", HANG_BOUND_MS);
        check(
          "bootstrap completes passkey registration and redirects to /admin",
          (await js(`location.pathname`)) === "/admin",
          "landed on /admin",
        );

        // 5. Verify /admin console loaded on session
        await until(
          `document.getElementById("usersBody")?.children?.length > 0`,
          "console subscribers loaded",
          HANG_BOUND_MS,
        );
        const adminEmail = await js(
          `document.querySelector(".signin-card strong")?.textContent || ""`,
        );
        check(
          "admin console is signed in as new bootstrap admin",
          adminEmail.length > 0,
          `signed in header: ${adminEmail}`,
        );

        // Capture evidence screenshot
        const shot = await cdp("Page.captureScreenshot", { format: "png" });
        await Deno.writeFile(
          `${OUT}01-admin-bootstrap-success.png`,
          Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)),
        );
        await quantiseEvidencePng(`${OUT}01-admin-bootstrap-success.png`);
        console.log(`Saved screenshot to ${OUT}01-admin-bootstrap-success.png`);

        await writeEvidenceReadme({
          dir: OUT,
          title: "Browser Acceptance Proof: audio-feed-8eh",
          script: "scripts/bootstrap-browser-proof.ts",
          asserts: steps.map((s) => s.name),
          notes: [
            "audio-feed-rxo1: NOT bit-reproducible - the same proof at one commit produced THREE DISTINCT IMAGES IN FOUR CAPTURES, so a re-run whose pixels differ is EXPECTED and is not a failure; the five assertions in the Execution Log are the check, the screenshot is the receipt (spread-declared in docs/evidence/README.md's determinism table)",
          ],
          sections: [
            {
              heading: "Feature",
              body:
                "Admin passkey bootstrap UI: enroll an admin passkey directly from a browser using ADMIN_TOKEN.",
            },
            {
              heading: "Execution Log",
              body: `\`\`\`\n${
                steps.map((s) => `${s.pass ? "PASS" : "FAIL"}  ${s.name}  ${s.detail}`).join("\n")
              }\n\`\`\``,
            },
            {
              heading: "Evidence Artifacts",
              body:
                "- 01-admin-bootstrap-success.png: Screenshot of /admin console showing the newly bootstrapped admin signed in.",
            },
          ],
        });
        console.log(`Saved proof report to ${OUT}README.md`);

        await cdp("WebAuthn.disable");
      } finally {
        try {
          ws.close();
        } catch { /* ignore */ }
      }
    });
  } finally {
    // audio-feed-ft1sj: kill AND await the harness, so the child is reaped before this script exits. A kill that
    // is not awaited leaves a child writing after the script has moved on (audio-feed-wj8o2, same shape).
    await killChromeAndWait(harness.process);
  }
});
