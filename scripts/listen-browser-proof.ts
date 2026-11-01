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

/**
 * Wait bound for every `until` in this proof, DERIVED rather than left at the 8s default
 * (same class of fix as fleet/anchor-wait's fade row, audio-feed-ev6wj).
 *
 * What the three waits actually wait for, and how long that can legitimately take:
 * - `document.readyState === "complete"`: the harness-served player page finishing its HTML
 *   parse plus the listen.js module load, all on localhost - tens of ms nominal.
 * - 5 episode rows rendered: boot()'s async prefix (a CacheStorage open + key scan, no
 *   network) before a synchronous render() of the 5 server-seeded episodes - a few ms.
 * - #audio src loaded: a synchronous `audio.src = ...` assignment inside the play click
 *   handler (select() assigns before its first await) - ~0ms once the click task runs.
 * The page was never what could take 8s; nominal page work is tens of milliseconds in total.
 *
 * What CAN take 8s is the poll itself: `until` evaluates over a CDP round-trip, and on a
 * loaded host the navigation, the first evaluate and every later poll queue behind other
 * work. This repo has MEASURED that stretch: under eight-way CPU saturation a bare
 * `document.readyState === "complete"` poll legitimately exceeded 8s (audio-feed-6gst1),
 * which is why verify_main_l7m1_e2e.ts's copy of `until` runs with 120s.
 *
 * 120s = 15x that measured starved-poll floor, and >1000x this page's tens-of-ms timeline.
 * It is a HANG bound, not a latency bound: a page that never renders still fails, in two
 * minutes instead of eight seconds.
 */
const MEASURED_STARVED_POLL_MS = 8_000;
const LOAD_AND_RENDER_WAIT_MS = 15 * MEASURED_STARVED_POLL_MS;

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
    /**
     * DETERMINISTIC RASTERISATION, and the one place this proof does not take withChrome's default
     * launch (audio-feed-xsvti).
     *
     * With playback frozen and transitions finished, this capture was still not byte-stable: two
     * runs matched exactly, and a third differed by 27 pixels at no more than 10 levels of one
     * channel, scattered along the 1px borders of the round buttons - anti-aliasing on curved
     * edges, not page state (every text row, date and the player row itself were identical).
     * Chrome rasterises those edges in tiles across several threads, and under `--disable-gpu` the
     * AA of a path that straddles a tile boundary is computed from a different clip, which rounds
     * differently. One raster thread and no partial raster removes the tile split, so the same
     * state produces the same pixels every run.
     *
     * The flag list is withChrome's own default list plus those two: `args` REPLACES the defaults
     * rather than extending them, so omitting one here would silently change the launch for this
     * proof alone. That duplication is deliberate and is the cost of not widening the shared
     * `withChrome` seam in a bug fix about a screenshot.
     */
    const DETERMINISTIC_RASTER_ARGS = [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--remote-debugging-port=0",
      "--num-raster-threads=1",
      "--disable-partial-raster",
      "about:blank",
    ];
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
        await until(`document.readyState === "complete"`, "load page", LOAD_AND_RENDER_WAIT_MS);
        await until(
          `document.querySelectorAll("#episodes .episode").length === 5`,
          "5 episode rows rendered",
          LOAD_AND_RENDER_WAIT_MS,
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

        // Mute #audio BEFORE the click, and this is the determinism, not a convenience.
        //
        // The row handler calls `select(episode, true, 0)`, which ends in `await audio.play()`.
        // Headless Chrome decides whether that promise resolves: MEASURED across three runs of
        // this tree, two played and one was rejected by the autoplay policy even with
        // `userGesture: true` on the evaluate. The rejected run then painted "Press play to
        // start — the browser blocked autoplay." into #playerNotice and the accepted ones did
        // not, so the still depended on a coin flip (audio-feed-xsvti). Chrome's policy permits
        // muted playback without activation, so muting settles the outcome where the proof can
        // see it, and the assertion below fails fast by name if that ever stops being true.
        // Muting changes nothing the still shows: #audio is not rendered (the visible player is
        // the .dock), and this player has no mute control.
        await js(`(() => {
          const a = document.getElementById("audio");
          a.muted = true;
          return a.muted;
        })()`);

        // Click the first episode's play button, as a user gesture: the same click a listener
        // makes, so the page runs its real play path rather than a stubbed one.
        await cdp("Runtime.evaluate", {
          expression:
            `document.querySelector("#episodes .episode button[data-action='play']")?.click()`,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        });
        await until(
          `!!document.getElementById("audio")?.src`,
          "audio src loaded",
          LOAD_AND_RENDER_WAIT_MS,
        );

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

        // Freeze playback before the capture, so the still shows a state instead of an instant.
        //
        // The play click above runs the page's real play path: the row handler calls
        // `select(episode, true, 0)`, which sets #audio.src and then `await audio.play()`. The
        // element is therefore PLAYING while the proof works, and every `timeupdate` moves the
        // seek thumb (`setProgress` writes --progress) and the elapsed label. So the screenshot
        // recorded whatever moment the capture happened to land on: two green runs of the same
        // tree differed by 175 px, bounding box 668x64+305+770 - the player row - with the thumb
        // ~6px further along and all text and dates identical (audio-feed-xsvti).
        //
        // The capture is now taken of a PAUSED element at currentTime 0, and the stillness is
        // guaranteed, not hoped for: the `until` below does not pass until the element itself
        // reports paused at 0, and the check after the shot re-reads it to show it did not move
        // while the shot was taken. Zero is exact, so --progress is a fixed 0 and nothing here
        // depends on duration metadata or on where a seek rounds to.
        //
        // Seeking to 0 BEFORE pausing also keeps the page's own pause handler - which persists a
        // resume position and repaints the row when `audio.currentTime > 2` - from observing
        // whatever fraction of a second playback had reached, which would have put a varying
        // resume marker in the playlist rows instead of the player row.
        //
        // The wait below is for playback to be ACTUALLY RUNNING - unpaused, HAVE_CURRENT_DATA, and
        // a currentTime that has moved off zero - and not merely for `paused === false`. That
        // distinction is not pedantry: pausing while the element's play() promise is still pending
        // makes that promise reject with AbortError, and select()'s catch reports it as "Press play
        // to start — the browser blocked autoplay." An early pause therefore painted that line into
        // #playerNotice on some runs and not others - MEASURED here, as the failure of exactly that
        // repaint check before this wait existed. Real playback means the promise has settled, so
        // the pause cannot interrupt it and the notice never appears. HAVE_CURRENT_DATA is also
        // what turns #nowDuration from the served "0:00" placeholder into the real duration and
        // enables #seek, so the row cannot be captured half-loaded either.
        const started: { paused: boolean; notice: string } = await js(`(() => {
          const a = document.getElementById("audio");
          return {
            paused: a.paused,
            notice: document.getElementById("playerNotice")?.textContent ?? "",
          };
        })()`);
        check(
          "the row play button starts real playback (element muted, so the autoplay policy permits it)",
          started.paused === false && started.notice === "",
          `paused ${started.paused}, notice '${started.notice}'`,
        );
        await until(
          `(() => {
            const a = document.getElementById("audio");
            return !!a && a.paused === false && a.readyState >= 2 && a.currentTime > 0;
          })()`,
          "playback is actually running",
          LOAD_AND_RENDER_WAIT_MS,
        );
        const STILL_AT_SECONDS = 0;
        await js(`(() => {
          const a = document.getElementById("audio");
          a.currentTime = ${STILL_AT_SECONDS};
          a.pause();
          a.currentTime = ${STILL_AT_SECONDS};
          return true;
        })()`);
        await until(
          `(() => {
            const a = document.getElementById("audio");
            return !!a && a.paused === true && a.currentTime === ${STILL_AT_SECONDS} &&
              a.readyState >= 1;
          })()`,
          "audio paused at the still position",
          LOAD_AND_RENDER_WAIT_MS,
        );
        // The click also starts the row's own paint transitions (li.episode background, .ep-play
        // border/colour, 0.18s each). A still taken mid-transition is an instant again, so the
        // finite ones are finished - jumped to the state the page settles in anyway - rather than
        // waited out with a sleep, and the wait after it is for the page to report NO animation
        // still running. That wait is a state condition, not a delay: a mid-transition still would
        // differ from a settled one by a few levels of anti-aliasing on the round button edges,
        // which is what the last measurable variance in this capture was.
        await js(`(() => {
          for (const a of document.getAnimations()) {
            try {
              a.finish();
            } catch { /* infinite or already finished: leave it */ }
          }
          return true;
        })()`);
        await until(
          `document.getAnimations().every((x) => x.playState !== "running")`,
          "paint transitions settled",
          LOAD_AND_RENDER_WAIT_MS,
        );

        // Take screenshot
        const shot = await cdp("Page.captureScreenshot", { format: "png" });
        const raw = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
        await Deno.writeFile(`${OUT}01-listen-harness-5-episodes.png`, raw);
        await quantiseEvidencePng(`${OUT}01-listen-harness-5-episodes.png`);
        console.log(`Saved screenshot to ${OUT}01-listen-harness-5-episodes.png`);

        // Read the element back AFTER the shot: if the page had resumed playback or repainted the
        // notice, the still would be an instant again and this proof must be red rather than
        // quietly unreproducible.
        const stillAfter: {
          paused: boolean;
          currentTime: number;
          readyState: number;
          duration: number;
          notice: string;
          runningAnimations: number;
        } = await js(`(() => {
          const a = document.getElementById("audio");
          return {
            paused: a.paused,
            currentTime: a.currentTime,
            readyState: a.readyState,
            duration: a.duration,
            notice: document.getElementById("playerNotice")?.textContent ?? "",
            runningAnimations:
              document.getAnimations().filter((x) => x.playState === "running").length,
          };
        })()`);
        check(
          "capture is playback-invariant: the audio element was paused at 0s across the shot",
          stillAfter.paused === true &&
            stillAfter.currentTime === STILL_AT_SECONDS &&
            stillAfter.readyState >= 1,
          `paused ${stillAfter.paused}, currentTime ${stillAfter.currentTime}s, ` +
            `readyState ${stillAfter.readyState}, duration ${stillAfter.duration}s`,
        );
        check(
          "capture is repaint-invariant: no transition or autoplay notice is mid-flight across the shot",
          stillAfter.notice === "" && stillAfter.runningAnimations === 0,
          `notice '${stillAfter.notice}', ${stillAfter.runningAnimations} animation(s) still running`,
        );

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
                "- 01-listen-harness-5-episodes.png: Screenshot of /listen/harness-token rendered in real headless Chrome showing 5 episode rows. Taken with #audio paused at 0s (asserted before and after the capture) so the player row is a fixed state rather than an instant of playback - the element would otherwise advance the seek thumb between runs (audio-feed-xsvti).",
            },
          ],
        });
        console.log(`Saved report to ${OUT}README.md`);
      } finally {
        try {
          ws.close();
        } catch { /* ignore */ }
      }
    }, { args: DETERMINISTIC_RASTER_ARGS });
  } finally {
    await killChromeAndWait(harness.process);
  }
});
