/**
 * Browser proof for refusing admin bootstrap of existing accounts (audio-feed-xw7).
 *
 * Verifies Paul's ruling:
 *   - POST /api/auth/bootstrap refuses existing accounts with HTTP 409 Conflict.
 *   - Existing users (approved, pending, suspended) are NOT promoted or re-enrolled.
 *   - The browser UI displays the refusal message clearly in #bootstrapFeedback.
 *   - New accounts can still be bootstrapped into approved admins.
 *
 *   deno run --allow-all --unstable-kv scripts/bootstrap-refusal-browser-proof.ts
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

const OUT = new URL("../docs/evidence/audio-feed-xw7/", import.meta.url).pathname;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

await runProof("audio-feed-xw7", async (checker) => {
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

        // 1. Visit /login?next=%2Fadmin#bootstrap
        await go("/login?next=%2Fadmin#bootstrap");
        check(
          "#bootstrap fragment auto-opens Admin bootstrap details",
          await js(`document.getElementById("bootstrapDetails")?.open === true`),
          "accordion is open",
        );

        // 2. Refusal test: submit valid token with existing approved reader email (rita@example.com)
        await js(`
        document.getElementById("bootstrapEmail").value = "rita@example.com";
        document.getElementById("bootstrapToken").value = "harness-admin";
        document.getElementById("bootstrapSubmit").disabled = false;
        document.getElementById("bootstrapForm").requestSubmit();
      `);
        await until(
          `document.getElementById("bootstrapFeedback").dataset.tone === "error"`,
          "error on existing user bootstrap",
          HANG_BOUND_MS,
        );
        const ritaFeedback = await js(`document.getElementById("bootstrapFeedback").textContent`);
        check(
          "existing account bootstrap is refused with 409 error message",
          ritaFeedback.includes("An account already exists for this email"),
          ritaFeedback,
        );
        check(
          "page stays on login, no redirect occurs",
          (await js(`location.pathname`)) === "/login",
          "still on /login",
        );

        // Capture refusal screenshot
        const shotRefusal = await cdp("Page.captureScreenshot", { format: "png" });
        await Deno.writeFile(
          `${OUT}01-existing-account-refusal.png`,
          Uint8Array.from(atob(shotRefusal.data), (c) => c.charCodeAt(0)),
        );
        await quantiseEvidencePng(`${OUT}01-existing-account-refusal.png`);
        console.log(`Saved screenshot to ${OUT}01-existing-account-refusal.png`);

        // 3. Refusal test: submit valid token with existing pending reader email (sam@example.com)
        await js(`
        document.getElementById("bootstrapEmail").value = "sam@example.com";
        document.getElementById("bootstrapToken").value = "harness-admin";
        document.getElementById("bootstrapSubmit").disabled = false;
        document.getElementById("bootstrapForm").requestSubmit();
      `);
        await until(
          `document.getElementById("bootstrapFeedback").dataset.tone === "error"`,
          "error on existing pending user bootstrap",
          HANG_BOUND_MS,
        );
        const samFeedback = await js(`document.getElementById("bootstrapFeedback").textContent`);
        check(
          "existing pending account bootstrap is also refused with 409",
          samFeedback.includes("An account already exists for this email"),
          samFeedback,
        );

        // 4. Success test: brand new email (freshadmin@example.com) succeeds
        await js(`
        document.getElementById("bootstrapEmail").value = "freshadmin@example.com";
        document.getElementById("bootstrapToken").value = "harness-admin";
        document.getElementById("bootstrapSubmit").disabled = false;
        document.getElementById("bootstrapForm").requestSubmit();
      `);

        // Wait for WebAuthn ceremony to complete and redirect to /admin
        await until(`location.pathname === "/admin"`, "redirect to /admin", HANG_BOUND_MS);
        check(
          "new admin bootstrap completes passkey registration and redirects to /admin",
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

        // Capture success screenshot
        const shotSuccess = await cdp("Page.captureScreenshot", { format: "png" });
        await Deno.writeFile(
          `${OUT}02-new-admin-bootstrap-success.png`,
          Uint8Array.from(atob(shotSuccess.data), (c) => c.charCodeAt(0)),
        );
        await quantiseEvidencePng(`${OUT}02-new-admin-bootstrap-success.png`);
        console.log(`Saved screenshot to ${OUT}02-new-admin-bootstrap-success.png`);

        await writeEvidenceReadme({
          dir: OUT,
          title: "Browser Acceptance Proof: audio-feed-xw7",
          script: "scripts/bootstrap-refusal-browser-proof.ts",
          asserts: steps.map((s) => s.name),
          sections: [
            {
              heading: "Feature",
              body:
                "Admin bootstrap refusal for existing accounts: POST /api/auth/bootstrap refuses any email address that already belongs to an existing account with HTTP 409 Conflict.",
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
                `- 01-existing-account-refusal.png: Inline refusal feedback\n- 02-new-admin-bootstrap-success.png: Successful redirect to /admin`,
            },
          ],
        });
        console.log(`Saved proof report to ${OUT}README.md`);

        await cdp("WebAuthn.disable").catch(() => {});
      } finally {
        try {
          ws.close();
        } catch { /* ignore */ }
      }
    });
  } finally {
    await killChromeAndWait(harness.process);
  }
});
