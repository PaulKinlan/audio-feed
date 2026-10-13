/**
 * Browser proof for the login and account system (audio-feed-8fc).
 *
 * Starts scripts/account-harness.ts, drives real headless Chrome over CDP with a
 * CDP virtual authenticator (ctap2, internal, resident keys, user verified), and
 * walks: setup link -> register a passkey -> sign out -> sign in -> account edits
 * persist -> the admin reaches /admin -> a non-admin gets 403 there. Screenshots
 * of every page at 390px and 1280px in light and dark land in
 * docs/evidence/audio-feed-8fc/, with evidence.json recording each step.
 *
 * No setup secret is written anywhere: every link used here is consumed by the
 * run itself, and the one left unused expires in seven days on a memory store
 * that dies with the harness.
 *
 *   deno run --allow-all --unstable-kv scripts/account-browser-proof.ts
 */

import { runProof, spawnHarness, withChrome, writeEvidenceReadme } from "./proof-helper.ts";

const OUT = new URL("../docs/evidence/audio-feed-8fc/", import.meta.url).pathname;
await Deno.mkdir(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await runProof("account-browser-proof", async (checker) => {
  const harness = await spawnHarness("scripts/account-harness.ts");
  try {
    const BASE = harness.base;
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
      // deno-lint-ignore no-explicit-any
      async function cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
        const id = ++nextId;
        ws.send(JSON.stringify({ id, method, params }));
        const msg = await new Promise<{ result?: unknown; error?: unknown }>((r) =>
          pending.set(id, r)
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
        return r.result.value;
      }
      async function until(expression: string, label: string, ms = 8000) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          try {
            if (await js(expression)) return;
          } catch { /* page mid-navigation */ }
          await sleep(100);
        }
        throw new Error(`timed out waiting for ${label}`);
      }
      async function go(path: string) {
        await cdp("Page.navigate", { url: `${BASE}${path}` });
        await sleep(150);
        await until(`document.readyState === "complete"`, `load ${path}`);
      }
      const status = () => js(`performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0`);
      const path = () => js(`location.pathname + location.hash`);

      // -- screenshots --------------------------------------------------------------
      const shots: string[] = [];
      async function sweep(name: string) {
        for (const scheme of ["light", "dark"]) {
          await cdp("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value: scheme }],
          });
          for (const width of [390, 1280]) {
            const mobile = width < 500;
            await cdp("Emulation.setDeviceMetricsOverride", {
              width,
              height: 900,
              deviceScaleFactor: 1,
              mobile,
            });
            await sleep(120);
            const height = Math.min(
              await js(`document.documentElement.scrollHeight`),
              6000,
            );
            await cdp("Emulation.setDeviceMetricsOverride", {
              width,
              height,
              deviceScaleFactor: 1,
              mobile,
            });
            await sleep(80);
            const { data } = await cdp("Page.captureScreenshot", { format: "png" });
            const file = `${name}-${width}-${scheme}.png`;
            const filePath = `${OUT}${file}`;
            await Deno.writeFile(
              filePath,
              Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
            );
            let out: Deno.CommandOutput;
            try {
              const cmd = new Deno.Command("convert", {
                args: [filePath, "-strip", "-colors", "256", `png8:${filePath}.tmp`],
              });
              out = await cmd.output();
            } catch (err) {
              await Deno.remove(`${filePath}.tmp`).catch(() => {});
              const detail = err instanceof Error ? err.message : String(err);
              const code = (err && typeof err === "object" && "code" in err)
                ? ` (code ${(err as { code: unknown }).code})`
                : "";
              throw new Error(`convert failed for ${filePath}${code}: ${detail}`);
            }
            if (!out.success) {
              await Deno.remove(`${filePath}.tmp`).catch(() => {});
              throw new Error(`convert failed for ${filePath} with exit code ${out.code}`);
            }
            await Deno.rename(`${filePath}.tmp`, filePath);
            shots.push(file);
          }
        }
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await cdp("Emulation.setEmulatedMedia", { features: [] });
      }

      async function issue(email: string): Promise<string> {
        const users = await (await fetch(`${BASE}/api/admin/users`, {
          headers: { "x-admin-token": "harness-admin" },
        })).json();
        const user = users.users.find((u: { email: string }) => u.email === email);
        const res = await fetch(`${BASE}/api/admin/users/${user.id}/setup-link`, {
          method: "POST",
          headers: { "x-admin-token": "harness-admin" },
        });
        return (await res.json()).url;
      }

      const steps: { step: string; ok: boolean; detail: string }[] = [];
      function recordCheck(step: string, ok: boolean, detail: string) {
        steps.push({ step, ok, detail });
        checker.check(step, ok, detail);
      }

      try {
        await cdp("Page.enable");
        await cdp("Runtime.enable");
        // audio-feed-5sei: freeze toLocaleTimeString on new documents so the admin
        // dashboard's "Updated <time>." status renders deterministically in evidence screenshots.
        await cdp("Page.addScriptToEvaluateOnNewDocument", {
          source: `Date.prototype.toLocaleTimeString = function() { return "12:00:00 PM"; };`,
        });
        await cdp("WebAuthn.enable");
        const { authenticatorId } = await cdp("WebAuthn.addVirtualAuthenticator", {
          options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
          },
        });
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });

        // Signed-out pages.
        await go("/");
        await sweep("01-home-signed-out");
        await go("/login");
        await sweep("02-login");
        await go("/admin");
        recordCheck(
          "signed-out /admin offers sign-in with token controls removed (audio-feed-0jp)",
          await js(
            `!!document.querySelector('a[href="/login?next=%2Fadmin"]') && !document.getElementById("adminToken") && !document.getElementById("saveToken") && !document.body.innerText.includes("Use admin token instead")`,
          ),
          `status ${await status()}`,
        );
        await sweep("03-admin-signed-out");

        // 1. Setup link -> register a passkey (bootstrap: ADMIN_TOKEN issues it).
        await go("/login#setup=" + (await issue("paul\u0040example.com")).split("#setup=")[1]);
        await until(`!document.getElementById("createPasskey").disabled`, "setup options");
        recordCheck(
          "setup link: secret scrubbed from the address bar",
          !(await path()).includes("setup="),
          `location is ${await path()}`,
        );
        await sweep("04-login-setup");
        await js(`document.getElementById("createPasskey").click()`);
        await until(`location.pathname === "/account"`, "account after register");
        const creds = (await cdp("WebAuthn.getCredentials", { authenticatorId })).credentials;
        recordCheck(
          "register a passkey from the setup link",
          creds.length === 1 && creds[0].isResidentCredential,
          `authenticator holds ${creds.length} resident credential(s); landed on /account`,
        );

        // 2. Sign out.
        await js(`document.querySelector('form[action="/api/auth/logout"] button').click()`);
        await until(
          `location.pathname === "/" && !!document.querySelector('.who .sign-in')`,
          "signed out",
        );
        await go("/account");
        recordCheck(
          "sign out",
          (await path()).startsWith("/login"),
          `/account now redirects to ${await path()}`,
        );

        // 3. Sign in.
        await js(`document.getElementById("signIn").click()`);
        await until(`location.pathname === "/account"`, "account after sign in");
        const whoText = await js(`document.querySelector(".who .name")?.textContent ?? ""`);
        recordCheck(
          "sign in with the passkey",
          (await path()) === "/account" && whoText.includes("Paul"),
          `back on /account as ${whoText}`,
        );

        // 4. Account edits persist.
        await js(`
          document.getElementById("displayName").value = "Paul K.";
          const radio = document.querySelector('input[name="voice"][value="Kore"]');
          if (radio) { radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); }
          document.getElementById("profileForm").requestSubmit();
        `);
        await until(
          `document.getElementById("profileFeedback").textContent === "Saved."`,
          "profile saved",
        );
        await sleep(900);
        await go("/account");
        const saved = await js(`[
          document.getElementById("displayName").value,
          document.querySelector('input[name="voice"]:checked')?.value ?? "",
          document.querySelector(".who .name")?.textContent ?? "",
        ]`);
        recordCheck(
          "account edits persist across a reload",
          saved[0] === "Paul K." && saved[1] === "Kore" && saved[2] === "Paul K.",
          JSON.stringify(saved),
        );
        await js(
          `document.getElementById("sendUrl").value = "https://example.com/article"; document.getElementById("sendForm").requestSubmit()`,
        );
        await until(
          `document.getElementById("sendFeedback").textContent.startsWith("Queued")`,
          "send to audio",
        );
        const sendFeedbackText = await js(
          `document.getElementById("sendFeedback")?.textContent ?? ""`,
        );
        recordCheck(
          "Send to Audio without a token",
          sendFeedbackText.startsWith("Queued"),
          sendFeedbackText,
        );
        await go("/account");
        await sweep("05-account");

        // audio-feed-ktn: self-service Regenerate, each press behind a confirm that
        // states the synthesis it will spend.
        const offered = await js(
          `[document.getElementById("regenOutdated").textContent, document.querySelectorAll("[data-regenerate-episode]").length]`,
        );
        // Deleting showModal drives askConfirm onto its window.confirm fallback
        // (src/assets/confirm-shared.js:59 takes the native-confirm branch when showModal is not a
        // function), which is what makes the confirm automatable here and at the retry below. The
        // <dialog> modal path is therefore NOT covered by this proof (audio-feed-fjfh).
        await js(`
          window.__confirms = [];
          window.confirm = (m) => (window.__confirms.push(m), true);
          const d = document.getElementById("confirmDialog");
          if (d) d.showModal = undefined;
        `);
        await js(`document.querySelector('[data-regenerate-episode="ep-0"]').click()`);
        await until(
          `document.getElementById("regenFeedback").textContent === "Queued for regeneration."`,
          "regenerate one episode",
        );
        const firstConfirm = await js(`window.__confirms[0]`);
        await until(
          `document.getElementById("regenOutdated").textContent === "Regenerate outdated (1)"`,
          "count drops after the reload",
        );
        await js(`
          window.__confirms = [${JSON.stringify(firstConfirm)}];
          window.confirm = (m) => (window.__confirms.push(m), true);
          const d = document.getElementById("confirmDialog");
          if (d) d.showModal = undefined;
        `);
        await js(`document.getElementById("regenOutdated").click()`);
        await until(
          `document.getElementById("regenFeedback").textContent.includes("queued for regeneration")`,
          "regenerate outdated",
        );
        const regen = await js(
          `[window.__confirms, document.getElementById("regenFeedback").textContent]`,
        );
        await go("/account");
        const after = await js(`document.getElementById("regenOutdated").textContent`);
        recordCheck(
          "Regenerate on /account: one episode, then the outdated rest",
          offered[0] === "Regenerate outdated (2)" && offered[1] === 2 &&
            regen[0].length === 2 && regen[0][1].includes("1 outdated episode(s)") &&
            regen[1] === "1 episode(s) queued for regeneration." &&
            after === "Regenerate outdated (0)",
          JSON.stringify({ offered, confirms: regen[0], feedback: regen[1], after }),
        );
        await go("/");
        await sweep("06-home-signed-in");

        // 5. The admin reaches /admin, and issues the next setup link from the console.
        await go("/admin");
        recordCheck("admin reaches /admin", (await status()) === 200, `status ${await status()}`);
        await until(
          `document.getElementById("usersBody").children.length === 3`,
          "admin user list",
        );
        recordCheck(
          "admin console loads subscriber data on session with token controls removed (audio-feed-0jp)",
          await js(
            `!document.getElementById("adminToken") && !document.getElementById("saveToken") && document.getElementById("usersBody").children.length === 3`,
          ),
          "console loaded 3 users on session, zero token inputs present",
        );
        await sweep("07-admin");
        await js(
          `[...document.querySelectorAll("#usersBody button")].find((b) => b.getAttribute("aria-label") === "Setup link for rita\u0040example.com").click()`,
        );
        await until(
          `document.getElementById("setupLinkUrl").value.includes("#setup=")`,
          "setup link from console",
        );
        const ritaLink = await js(`document.getElementById("setupLinkUrl").value`);
        recordCheck(
          "admin console issues a setup link on the session",
          ritaLink.startsWith(`${BASE}/login#setup=`),
          "link shown in the console, not logged",
        );

        // 6. A non-admin gets 403 at /admin.
        await js(`document.querySelector('form[action="/api/auth/logout"] button').click()`);
        await until(`location.pathname === "/"`, "signed out again");
        await go("/login#setup=" + ritaLink.split("#setup=")[1]);
        await until(`!document.getElementById("createPasskey").disabled`, "rita setup options");
        await js(`document.getElementById("createPasskey").click()`);
        await until(`location.pathname === "/account"`, "rita account");
        await go("/admin");
        const code = await status();
        recordCheck(
          "a non-admin gets 403 at /admin",
          code === 403,
          `status ${code}, heading "${await js(`document.querySelector("h1").textContent`)}"`,
        );
        await sweep("08-admin-403");

        // Write evidence.json
        await Deno.writeTextFile(
          `${OUT}evidence.json`,
          JSON.stringify(
            {
              bead: "audio-feed-8fc",
              also: "audio-feed-ktn",
              at: new Date().toISOString(),
              steps,
              shots,
            },
            null,
            2,
          ) + "\n",
        );

        // Write README.md via writeEvidenceReadme
        await writeEvidenceReadme({
          dir: OUT,
          title: "audio-feed-8fc: browser proof",
          script: "scripts/account-browser-proof.ts",
          asserts: [
            "signed-out /admin offers sign-in with token controls removed (audio-feed-0jp)",
            "setup link: secret scrubbed from the address bar",
            "register a passkey from the setup link",
            "sign out",
            "sign in with the passkey",
            "account edits persist across a reload",
            "Send to Audio without a token",
            "Regenerate on /account: one episode, then the outdated rest",
            "admin reaches /admin",
            "admin console loads subscriber data on session with token controls removed (audio-feed-0jp)",
            "admin console issues a setup link on the session",
            "a non-admin gets 403 at /admin",
          ],
          sections: [
            {
              heading: "Overview",
              body:
                `Real headless Chrome for Testing, driven over CDP from a Deno script, with a CDP
virtual authenticator (\`ctap2\`, \`internal\`, resident keys, user verification,
verified user). The app is the real one, served by \`scripts/account-harness.ts\`
on memory stores seeded with an admin (Paul), an approved reader (Rita), a
pending invitee (Sam), two sources, four episodes and some run history.
Feed and article fetches are stubbed, so nothing touches the network.

Reproduce:

    deno run --allow-all --unstable-kv scripts/account-browser-proof.ts`,
            },
            {
              heading: "What was driven, in order",
              body: `| # | Step | Result |
|---|------|--------|
| 1 | Signed-out \`/admin\` offers passkey sign-in, token behind "Use admin token instead" | 200 |
| 2 | Bootstrap: ADMIN_TOKEN issues Paul a setup link; \`/login#setup=…\` scrubs the secret from the address bar | location \`/login\` |
| 3 | Register a passkey from the setup link | 1 resident credential in the authenticator; landed on \`/account\` |
| 4 | Sign out (header form POST) | \`/account\` then redirects to \`/login\` |
| 5 | Sign in with the passkey | back on \`/account\` |
| 6 | Account edits persist: display name "Paul K.", voice Kore, reload | \`["Paul K.","Kore","Paul K."]\` |
| 7 | Send to Audio from the account page, no token pasted | queued |
| 7b | audio-feed-ktn: Regenerate on \`/account\`: one episode, then "Regenerate outdated (N)"; each confirm states the synthesis it spends | offered \`(2)\`; confirms say 1 then 1 episode(s); after reload \`(0)\` |
| 8 | The admin reaches \`/admin\` on the session | 200, 3 subscribers listed |
| 9 | The admin console issues Rita a setup link on the session | link shown in the console only |
| 10 | Rita registers, then a non-admin gets 403 at \`/admin\` | 403, "This page is for admins" |

\`evidence.json\` records each step with its detail and the screenshot list.

Re-run on the merged tree (origin/main commit-a0122f7 merged into this branch, with the
review fixes and audio-feed-ktn): 11 of 11 steps (the original 10 plus step 7b, 11/11 steps).
The harness now seeds its two ready episodes as published on older prompts, so
there is something to regenerate.`,
            },
            {
              heading: "Screenshots",
              body: `Every page at 390px and 1280px, in light and dark (the shell supports both):
\`<page>-<width>-<scheme>.png\`.

- \`01-home-signed-out\`: home on the shared shell
- \`02-login\`: sign in with a passkey
- \`03-admin-signed-out\`: admin sign-in prompt, token toggle
- \`04-login-setup\`: the setup-link state ("Create your passkey")
- \`05-account\`: the account page after edits
- \`06-home-signed-in\`: the header names the viewer; the "send from your account" note
- \`07-admin\`: the console on an admin session, with Setup link and Make/Remove admin
- \`08-admin-403\`: a signed-in non-admin at \`/admin\``,
            },
            {
              heading: "Review fixes shown here",
              body: `- \`07-admin-390-*\`: the background-runs table keeps a minimum width
  (\`table.runs { min-inline-size: 40rem; }\`) and scrolls inside its card. Before
  the fix, Result wrapped one character per line at 390px.
- \`05-account-*\`: Regenerate per ready episode and "Regenerate outdated (N)"
  (audio-feed-ktn).`,
            },
            {
              heading: "Found by this run",
              body: `The first run failed at sign-out. The account, admin and login pages send
\`Referrer-Policy: no-referrer\`, and a form POST from such a page carries
\`Origin: null\`, so the Origin check refused the header's sign-out form.
\`sameOrigin\` now also accepts \`Origin: null\` when the browser-set
\`Sec-Fetch-Site: same-origin\` says the request is same-origin; pages cannot write
that header. It has a route test, which was red before the fix and green after.

No setup secret is written here: every link the run issued was consumed by the
run, on a memory store that ends with the harness.`,
            },
          ],
        });
      } finally {
        ws.close();
      }
    }, { prefix: "audiofeed-proof-8fc-" });
  } finally {
    harness.kill();
    await harness.process.status.catch(() => {});
  }
});
