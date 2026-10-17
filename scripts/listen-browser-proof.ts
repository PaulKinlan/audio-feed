/**
 * Browser proof for the listen harness and episode listing (audio-feed-py5).
 *
 * Starts scripts/listen-harness.ts, drives real headless Chrome
 * over raw CDP, and asserts:
 *   1. /listen/harness-token renders 5 episode rows in the playlist (not 0).
 *   2. #episodeCount displays "5 episodes" and #empty is hidden.
 *   3. Clicking an episode row / play button loads a real audio URL into #audio.
 *   4. The audio URL fetches 200 audio/wav bytes from the blob store.
 *   5. Saves screenshot to docs/evidence/audio-feed-py5/01-listen-harness-5-episodes.png.
 *
 *   deno run --allow-all --unstable-kv scripts/listen-browser-proof.ts
 */

import {
  killChromeAndWait,
  runProof,
  spawnHarness,
  withChrome,
  writeEvidenceReadme,
} from "./proof-helper.ts";
import { connectCdp } from "./proof-cdp.ts";
import { quantiseEvidencePng } from "./evidence-png.ts";

const OUT = new URL("../docs/evidence/audio-feed-py5/", import.meta.url).pathname;

await Deno.mkdir(OUT, { recursive: true });

await runProof("audio-feed-py5", async (checker) => {
  const harness = await spawnHarness("scripts/listen-harness.ts");
  const BASE = harness.base;
  const TOKEN = "harness-token";
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail = "") => {
    checks.push({ name, pass, detail });
    checker.check(name, pass, detail);
  };

  try {
    await withChrome(async (chrome) => {
      const { cdp, js, until, ws } = await connectCdp(chrome.port);

      try {
        await cdp("Page.enable");
        await cdp("Runtime.enable");

        // Set desktop viewport (1280x900)
        await cdp("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });

        // Navigate to player
        await cdp("Page.navigate", { url: `${BASE}/listen/${TOKEN}` });
        await until(`document.readyState === "complete"`, "load page");
        await until(
          `document.querySelectorAll("#episodes .episode").length === 5`,
          "5 episode rows rendered",
        );

        const rowCount = await js(`document.querySelectorAll("#episodes .episode").length`);
        check("rendered episode row count is 5", rowCount === 5, `found ${rowCount} rows`);

        const countText = await js(`document.getElementById("episodeCount")?.textContent`);
        check(
          "header count text displays '5 episodes'",
          countText === "5 episodes",
          `got '${countText}'`,
        );

        const emptyHidden = await js(
          `document.getElementById("empty")?.classList.contains("hidden")`,
        );
        check("empty state is hidden", emptyHidden === true, `empty hidden: ${emptyHidden}`);

        // Click the first episode's play button
        await js(
          `document.querySelector("#episodes .episode button[data-action='play']")?.click()`,
        );
        await until(`!!document.getElementById("audio")?.src`, "audio src loaded");

        const audioSrc = await js(`document.getElementById("audio")?.src`);
        check(
          "play button loads audio URL into #audio element",
          typeof audioSrc === "string" && audioSrc.includes("/audio/"),
          `audio src endpoint: ${audioSrc.replace(/^https?:\/\/[^\/]+/, "")}`,
        );

        // Fetch the audio URL to verify it resolves with real wav bytes
        const audioRes = await fetch(audioSrc);
        const audioBytes = new Uint8Array(await audioRes.arrayBuffer());
        const isRiffWav = audioBytes.length >= 12 &&
          String.fromCharCode(...audioBytes.slice(0, 4)) === "RIFF" &&
          String.fromCharCode(...audioBytes.slice(8, 12)) === "WAVE";
        check(
          "enclosure audio URL returns 200 with non-empty RIFF/WAVE bytes",
          audioRes.status === 200 &&
            audioRes.headers.get("content-type")?.includes("audio/wav") === true &&
            isRiffWav,
          `status ${audioRes.status}, size ${audioBytes.length} bytes, format: ${
            isRiffWav ? "RIFF/WAVE" : "invalid"
          }`,
        );

        // Take screenshot
        const shot = await cdp("Page.captureScreenshot", { format: "png" });
        const raw = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
        await Deno.writeFile(`${OUT}01-listen-harness-5-episodes.png`, raw);
        await quantiseEvidencePng(`${OUT}01-listen-harness-5-episodes.png`);
        console.log(`Saved screenshot to ${OUT}01-listen-harness-5-episodes.png`);

        await writeEvidenceReadme({
          dir: OUT,
          title: "Browser Acceptance Proof: audio-feed-py5",
          script: "scripts/listen-browser-proof.ts",
          asserts: checks.map((c) => c.name),
          sections: [
            {
              heading: "Problem & Solution",
              body:
                "listen-harness was omitting contentType on seeded episodes, filtering out episodes. Fixed by ensuring contentType: 'audio/wav', self-verifying harness startup, and asserting playlist rendering.",
            },
            {
              heading: "Execution Log",
              body: `\`\`\`\n${
                checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  ${c.detail}`).join("\n")
              }\n\`\`\``,
            },
            {
              heading: "Evidence Artifacts",
              body:
                "- 01-listen-harness-5-episodes.png: Screenshot of /listen/harness-token rendered in real headless Chrome showing 5 episode rows.",
            },
          ],
        });
        console.log(`Saved report to ${OUT}README.md`);
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
