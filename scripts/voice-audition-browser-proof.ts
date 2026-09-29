/**
 * Browser proof for voice audition samples (audio-feed-msw).
 *
 * Drives real headless Chrome against a real app server whose TTS client is STUBBED
 * (a generated tone, so the proof never spends) and asserts the two acceptance
 * criteria that only exist in a browser:
 *   · each of the five voices has an audition player with an accessible name;
 *   · EXACTLY ONE sample plays at a time — starting another stops the first, and
 *     there is one <audio> element for all five buttons rather than five that have
 *     to be kept in step;
 *   · choosing a voice and saving updates the preference (read back after reload);
 *   · HEAD over real HTTP carries the headers and no body;
 *   · the grid survives 390x844 without horizontal overflow.
 *
 *   deno run --allow-all --unstable-kv scripts/voice-audition-browser-proof.ts
 */
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { approveUser, createUser } from "../src/auth/users.ts";
import { createSession } from "../src/auth/sessions.ts";
import { pcmToWav } from "../src/tts/gemini.ts";
import type { AppConfig, Stores } from "../src/config.ts";

const OUT = new URL("../docs/evidence/audio-feed-msw/", import.meta.url).pathname;
const HOME = Deno.env.get("HOME")!;
const PROFILE = await Deno.makeTempDir({ prefix: "audiofeed-proof-msw-" });
const VOICES = ["Aoede", "Charon", "Fenrir", "Kore", "Puck"];

function newestChrome(): string {
  const root = `${HOME}/.cache/puppeteer/chrome`;
  const dirs = [...Deno.readDirSync(root)]
    .filter((d) => d.isDirectory)
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return `${root}/${dirs.at(-1)}/chrome-linux64/chrome`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

// -- in-process app with a stubbed TTS client ---------------------------------
const stores: Stores = memoryStores();
const config: AppConfig = { port: 0, adminToken: "harness-admin" };
const ctx = { config, stores };

const rawUser = await createUser(stores.metadata, {
  email: "ada@example.com",
  displayName: "Ada Lovelace",
});
const user = await approveUser(stores.metadata, rawUser.id, "admin");
const sessionSecret = await createSession(stores.metadata, user.id);

/** 1.2 s of 24 kHz mono tone: long enough to observe playback, never billed. */
function toneWav(): Uint8Array {
  const samples = 28_800;
  const pcm = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((i / 24_000) * 2 * Math.PI * 220) * 8000);
    pcm[i * 2] = value & 0xff;
    pcm[i * 2 + 1] = (value >> 8) & 0xff;
  }
  return pcmToWav(pcm, { sampleRate: 24_000, numChannels: 1, bitsPerSample: 16 });
}

const synthesized: string[] = [];
const handlers = createHandlers(ctx, {
  ttsClient: {
    synthesizeNarration: (input) => {
      synthesized.push(String(input.voice));
      const rawBytes = toneWav();
      return Promise.resolve({
        rawBytes,
        mimeType: "audio/wav",
        format: "wav" as const,
        sampleRate: 24_000,
        channels: 1,
        bitsPerSample: 16,
        durationSeconds: 1.2,
        finishReason: "STOP",
        truncated: false,
        toWav: () => rawBytes,
      });
    },
  },
});
const { fetch: appFetch } = createApp(ctx, handlers);
const server = Deno.serve({ port: 0, onListen: () => {} }, (req, info) => appFetch(req, info));
const PORT = (server.addr as Deno.NetAddr).port;
const BASE = `http://localhost:${PORT}`;
config.port = PORT;
config.publicBaseUrl = BASE;

// -- chrome over raw CDP ------------------------------------------------------
const chrome = new Deno.Command(newestChrome(), {
  args: [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    // Headless Chrome has no speaker and the clicks are synthesized, so the
    // autoplay policy would otherwise reject play() and hide real failures.
    "--autoplay-policy=no-user-gesture-required",
    "--remote-debugging-port=0",
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
  stdout: "null",
  stderr: "null",
}).spawn();

let debugPort = "";
for (let i = 0; i < 100 && !debugPort; i++) {
  await sleep(100);
  debugPort = (await Deno.readTextFile(`${PROFILE}/DevToolsActivePort`).catch(() => "")).split(
    "\n",
  )[0]!;
}
const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
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
  const msg = await new Promise<{ result?: unknown; error?: unknown }>((r) => pending.set(id, r));
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
  if (r.exceptionDetails) throw new Error(`${expression}: ${JSON.stringify(r.exceptionDetails)}`);
  return r.result?.value;
}

const checks: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail = "") {
  checks.push({ name, pass, detail });
  const tag = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`${tag}  ${name}  ${detail}`);
  if (!pass) throw new Error(`step failed: ${name}`);
}
async function until(expr: string, desc: string, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await js(expr)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${desc}`);
}
/**
 * Screenshots must SHOW what the check asserted. The voice grid sits below the
 * send panel and the feeds panel, so a viewport capture at scroll 0 proves nothing
 * about the audition cards — a defect I had just filed against another proof
 * (audio-feed-vgn), so it gets fixed here rather than repeated.
 */
const shot = async (name: string) => {
  await js(`document.querySelector('[data-voice-sample]')?.scrollIntoView({ block: "center" })`);
  await sleep(120);
  const image = await cdp("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(`${OUT}${name}`, Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0)));
};

let exitCode = 0;
try {
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp("Network.setCookie", {
    name: "__Host-af_session",
    value: sessionSecret,
    url: `${BASE}/`,
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });

  await cdp("Page.navigate", { url: `${BASE}/account` });
  await until(`document.readyState === "complete"`, "account loaded");
  await until(
    `document.querySelectorAll("[data-voice-sample]").length === 5`,
    "five audition buttons",
  );

  // 1. Every voice has a named player, and there is ONE audio element.
  const players = await js(
    `Array.from(document.querySelectorAll("[data-voice-sample]")).map((b) => ({
    voice: b.dataset.voiceSample,
    label: b.getAttribute("aria-label"),
    pressed: b.getAttribute("aria-pressed"),
    tag: b.tagName,
  }))`,
  );
  check(
    "each of the five voices has a real button with an accessible name",
    players.length === 5 &&
      players.every((p: { tag: string; label: string }) => p.tag === "BUTTON") &&
      VOICES.every((v) =>
        players.some((p: { voice: string; label: string }) =>
          p.voice === v && p.label === `Play a sample of ${v}`
        )
      ),
    players.map((p: { voice: string }) => p.voice).join(", "),
  );
  check(
    "one audio element drives all five players",
    (await js(`document.querySelectorAll("audio").length`)) === 1,
    `audio elements: ${await js(`document.querySelectorAll("audio").length`)}`,
  );
  await shot("01-audition-grid.png");

  // 2. Play Aoede: the shared element is playing, the button knows it.
  await js(`document.querySelector('[data-voice-sample="Aoede"]').click()`);
  await until(
    `document.getElementById("voiceSampleAudio")?.paused === false && document.getElementById("voiceSampleAudio")?.currentTime > 0.05`,
    "Aoede sample playing",
  );
  const first = await js(`(() => {
    const audio = document.getElementById("voiceSampleAudio");
    const button = document.querySelector('[data-voice-sample="Aoede"]');
    return {
      src: audio.src,
      duration: audio.duration,
      currentTime: audio.currentTime,
      paused: audio.paused,
      pressed: button.getAttribute("aria-pressed"),
      label: button.getAttribute("aria-label"),
      text: button.textContent.trim(),
    };
  })()`);
  check(
    "the Aoede sample actually plays audio bytes",
    first.duration > 1 && first.currentTime > 0.05,
    `duration ${first.duration}s, t=${first.currentTime.toFixed(2)}s`,
  );
  check(
    "the sample comes from the route, not a file in the repo",
    String(first.src).endsWith("/assets/voices/Aoede"),
    `src: ${first.src}`,
  );
  check(
    "its button reports that it is playing",
    first.pressed === "true" && first.label === "Stop the sample of Aoede",
    `aria-pressed=${first.pressed}, "${first.label}", "${first.text}"`,
  );
  await shot("02-aoede-playing.png");

  // 3. Start Kore: Aoede stops, Kore plays, still exactly one playing.
  await js(`document.querySelector('[data-voice-sample="Kore"]').click()`);
  await until(
    `document.querySelector('[data-voice-sample="Kore"]')?.getAttribute("aria-pressed") === "true" &&
     document.querySelector('[data-voice-sample="Aoede"]')?.getAttribute("aria-pressed") === "false"`,
    "Kore took over from Aoede",
  );
  const second = await js(`(() => {
    const audio = document.getElementById("voiceSampleAudio");
    const pressed = Array.from(document.querySelectorAll("[data-voice-sample]")).filter((b) => b.getAttribute("aria-pressed") === "true");
    return {
      pressedCount: pressed.length,
      pressedVoice: pressed[0]?.dataset.voiceSample,
      src: audio.src,
      paused: audio.paused,
      currentTime: audio.currentTime,
      audioCount: document.querySelectorAll("audio").length,
      aoedeLabel: document.querySelector('[data-voice-sample="Aoede"]').getAttribute("aria-label"),
    };
  })()`);
  check(
    "starting a second sample stops the first",
    second.pressedCount === 1 && second.pressedVoice === "Kore",
    `playing: ${second.pressedVoice ?? "none"} (${second.pressedCount})`,
  );
  check(
    "still exactly one audio element, and it carries Kore",
    second.audioCount === 1 && String(second.src).endsWith("/assets/voices/Kore"),
    `audio elements ${second.audioCount}, src ${second.src}`,
  );
  check(
    "the stopped voice's button is back to Play",
    second.aoedeLabel === "Play a sample of Aoede",
    `label: ${second.aoedeLabel}`,
  );
  check(
    "the new sample is really playing, not just selected",
    second.paused === false,
    `paused: ${second.paused}, t=${Number(second.currentTime).toFixed(2)}`,
  );
  await shot("03-kore-replaced-aoede.png");

  // 4. Clicking the playing sample stops it.
  await js(`document.querySelector('[data-voice-sample="Kore"]').click()`);
  await until(`document.getElementById("voiceSampleAudio")?.paused === true`, "Kore stopped");
  const stopped = await js(`(() => ({
    pressed: Array.from(document.querySelectorAll("[data-voice-sample]")).filter((b) => b.getAttribute("aria-pressed") === "true").length,
    label: document.querySelector('[data-voice-sample="Kore"]').getAttribute("aria-label"),
  }))()`);
  check(
    "clicking the playing sample pauses it and clears every pressed state",
    stopped.pressed === 0 && stopped.label === "Play a sample of Kore",
    `pressed ${stopped.pressed}, "${stopped.label}"`,
  );

  // 5. HEAD over real HTTP: headers present, body dropped by the runtime.
  const head = await js(`(async () => {
    const res = await fetch("/assets/voices/Puck", { method: "HEAD" });
    return { status: res.status, type: res.headers.get("content-type"), length: Number(res.headers.get("content-length")), body: (await res.text()).length };
  })()`);
  check(
    "HEAD carries the sample headers and no body over real HTTP",
    head.status === 200 && head.type === "audio/wav" && head.length > 44 && head.body === 0,
    `status ${head.status}, ${head.type}, ${head.length} bytes promised, ${head.body} bytes sent`,
  );

  // 6. Choosing a voice and saving updates the preference (acceptance).
  await js(`(() => {
    const radio = document.querySelector('input[name=voice][value="Kore"]');
    radio.checked = true;
    document.getElementById("profileForm").requestSubmit();
  })()`);
  await until(
    `document.getElementById("profileFeedback")?.textContent.includes("Saved")`,
    "profile saved",
  );
  await cdp("Page.navigate", { url: `${BASE}/account` });
  await until(
    `document.readyState === "complete" && !!document.querySelector('input[name=voice]:checked')`,
    "account reloaded",
  );
  const saved = await js(`document.querySelector('input[name=voice]:checked')?.value`);
  check(
    "the chosen voice persists as the preference",
    saved === "Kore",
    `checked on reload: ${saved}`,
  );
  // Three voices: Aoede and Kore were PLAYED, and Puck was the HEAD probe above —
  // a HEAD on a cold voice goes through the same "make sure it exists" path, which
  // is deliberate (a player that checks before fetching must not be told 404) and
  // is pinned in tests/voice_samples_test.ts. Each voice appears once: the page
  // reloads and the second play came from the cache, not the API.
  check(
    "each sample was synthesised once, and only for the voices touched",
    synthesized.length === new Set(synthesized).size &&
      ["Aoede", "Kore", "Puck"].every((v) => synthesized.includes(v)) &&
      synthesized.length === 3,
    `synthesized: ${synthesized.join(",")}`,
  );

  // 7. Mobile pass.
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await cdp("Page.navigate", { url: `${BASE}/account` });
  await until(
    `document.querySelectorAll("[data-voice-sample]").length === 5`,
    "mobile audition grid loaded",
  );
  const mobile = await js(`({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    buttons: document.querySelectorAll("[data-voice-sample]").length,
    audio: document.querySelectorAll("audio").length,
  })`);
  check(
    "mobile keeps the five players with no horizontal overflow",
    mobile.overflow === false && mobile.buttons === 5 && mobile.audio === 1,
    `overflow ${mobile.overflow}, ${mobile.buttons} buttons, ${mobile.audio} audio`,
  );
  await shot("04-audition-mobile-390.png");

  const failed = checks.filter((c) => !c.pass).length;
  const summary = `# Voice audition samples (audio-feed-msw)

Generated by \`scripts/voice-audition-browser-proof.ts\` against an in-process app
whose TTS client is stubbed with a generated 1.2 s tone: the proof exercises the
route, the cache, the page and the player, and never calls (or bills) the API.

## Execution log
\`\`\`
${checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}  ${c.detail}`).join("\n")}
\`\`\`

Screenshots: \`01-audition-grid.png\`, \`02-aoede-playing.png\`,
\`03-kore-replaced-aoede.png\`, \`04-audition-mobile-390.png\`.
`;
  await Deno.writeTextFile(`${OUT}README.md`, summary);
  console.log(`Saved report to ${OUT}README.md`);
  if (failed > 0) exitCode = 1;
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  try {
    chrome.kill();
  } catch { /* ignore */ }
  await server.shutdown().catch(() => {});
  await Deno.remove(PROFILE, { recursive: true }).catch(() => {});
}

Deno.exit(exitCode);
