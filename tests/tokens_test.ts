import { assert, assertEquals } from "@std/assert";
import { DESIGN_TOKENS } from "../src/routes/tokens.ts";
import { SHELL_TOKENS } from "../src/routes/shell.ts";
import { renderHomePage } from "../src/routes/home.ts";
import { renderAdminPage } from "../src/routes/admin.ts";
import { renderListenLanding } from "../src/routes/listen.ts";
import type { RouteContext } from "../src/router.ts";

/** Calculate relative luminance according to WCAG 2.1 specs */
function sRgbLuminance(r: number, g: number, b: number): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").trim();
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = sRgbLuminance(...hexToRgb(hex1));
  const l2 = sRgbLuminance(...hexToRgb(hex2));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

Deno.test("single token definition: :root blocks exist ONLY in src/routes/tokens.ts (audio-feed-vpw)", async () => {
  const rootFiles: string[] = [];
  for await (const entry of Deno.readDir("src")) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      const content = await Deno.readTextFile(`src/${entry.name}`);
      if (content.includes(":root")) rootFiles.push(`src/${entry.name}`);
    }
  }
  for await (const entry of Deno.readDir("src/routes")) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      const content = await Deno.readTextFile(`src/routes/${entry.name}`);
      if (content.includes(":root")) rootFiles.push(`src/routes/${entry.name}`);
    }
  }
  for await (const entry of Deno.readDir("src/assets")) {
    if (entry.isFile && entry.name.endsWith(".css")) {
      const content = await Deno.readTextFile(`src/assets/${entry.name}`);
      if (content.includes(":root")) rootFiles.push(`src/assets/${entry.name}`);
    }
  }

  // Exactly one source file defines :root tokens
  assertEquals(rootFiles, ["src/routes/tokens.ts"]);
});

Deno.test("single token definition: token variables are declared only in src/routes/tokens.ts (audio-feed-vpw)", async () => {
  const tokenNames = [
    "--space-1:",
    "--space-4:",
    "--space-8:",
    "--space-12:",
    "--radius:",
    "--radius-sm:",
    "--radius-lg:",
    "--accent-dim:",
    "--dock-h:",
  ];

  for (const token of tokenNames) {
    const declaringFiles: string[] = [];
    const checkFile = async (path: string) => {
      const content = await Deno.readTextFile(path);
      if (content.includes(token)) declaringFiles.push(path);
    };

    for await (const entry of Deno.readDir("src/routes")) {
      if (entry.isFile && entry.name.endsWith(".ts")) {
        await checkFile(`src/routes/${entry.name}`);
      }
    }
    for await (const entry of Deno.readDir("src/assets")) {
      if (entry.isFile && entry.name.endsWith(".css")) {
        await checkFile(`src/assets/${entry.name}`);
      }
    }

    assertEquals(
      declaringFiles,
      ["src/routes/tokens.ts"],
      `Token ${token} declared in ${declaringFiles.join(", ")}`,
    );
  }
});

Deno.test("unification: home, admin, listen landing, and player stylesheet share identical token definitions (audio-feed-vpw)", async () => {
  // Shell tokens matches design tokens
  assertEquals(SHELL_TOKENS, DESIGN_TOKENS);

  // Home page includes DESIGN_TOKENS
  const homeHtml = renderHomePage({
    publicBaseUrl: "https://audio.example.com",
    synthesisConfigured: true,
    defaultVoice: "Charon",
  });
  assert(homeHtml.includes("--space-12: 3rem"));
  assert(homeHtml.includes("--radius: 12px"));

  // Admin page includes DESIGN_TOKENS
  const adminHtml = renderAdminPage({
    publicBaseUrl: "https://audio.example.com",
    adminConfigured: true,
  });
  assert(adminHtml.includes("--space-12: 3rem"));
  assert(adminHtml.includes("--radius: 12px"));

  // Listen landing links its stylesheet; DESIGN_TOKENS are composed into it
  // (audio-feed-3xq part 4c — the tokens no longer ride in the page's HTML).
  const listenLandingHtml = renderListenLanding("https://audio.example.com");
  const landingCss = (await import("../src/routes/assets.ts")).assetBody("listen-landing.css") ??
    "";
  assert(listenLandingHtml.includes("listen-landing.css"), "landing must link its stylesheet");
  assert(landingCss.includes("--space-12: 3rem"));
  assert(landingCss.includes("--radius: 12px"));

  // Content-addressed player stylesheet includes DESIGN_TOKENS
  const assetModule = await import("../src/routes/assets.ts");
  const url = assetModule.assetUrl("listen.css");
  const fileName = url.replace("/assets/", "");
  const res = assetModule.handleAsset(
    { params: { name: fileName } } as unknown as RouteContext<unknown>,
  );
  assertEquals(res.status, 200);
  const css = await res.text();
  assert(css.includes("--space-12: 3rem"));
  assert(css.includes("--radius: 12px"));
  assert(css.includes("--dock-h: 13.5rem"));
});

Deno.test("contrast measurement: smallest muted text holds >= 5.82:1 floor across all surfaces (audio-feed-vpw)", () => {
  // Dark mode surfaces (used by Web Player and dark theme)
  const darkBg = "#0a0a0c";
  const darkSurface = "#131317";
  const darkSurface2 = "#1c1c22";
  const darkMuted = "#9a9aa4";

  const darkBgRatio = contrastRatio(darkMuted, darkBg);
  const darkSurfaceRatio = contrastRatio(darkMuted, darkSurface);
  const darkSurface2Ratio = contrastRatio(darkMuted, darkSurface2);

  // Floor is 5.82:1
  assert(darkBgRatio >= 5.82, `dark bg ratio ${darkBgRatio.toFixed(2)} must be >= 5.82`);
  assert(
    darkSurfaceRatio >= 5.82,
    `dark surface ratio ${darkSurfaceRatio.toFixed(2)} must be >= 5.82`,
  );
  assert(
    darkSurface2Ratio >= 5.82,
    `dark surface2 ratio ${darkSurface2Ratio.toFixed(2)} must be >= 5.82`,
  );

  // Light mode surfaces (used by Home, Admin, Account)
  const lightBg = "#f7f6fb";
  const lightSurface = "#ffffff";
  const lightMuted = "#5c586a";

  const lightBgRatio = contrastRatio(lightMuted, lightBg);
  const lightSurfaceRatio = contrastRatio(lightMuted, lightSurface);

  assert(lightBgRatio >= 5.82, `light bg ratio ${lightBgRatio.toFixed(2)} must be >= 5.82`);
  assert(
    lightSurfaceRatio >= 5.82,
    `light surface ratio ${lightSurfaceRatio.toFixed(2)} must be >= 5.82`,
  );
});

Deno.test("prefers-reduced-motion suppresses animations and transitions in unified tokens (audio-feed-vpw)", () => {
  assert(DESIGN_TOKENS.includes("@media (prefers-reduced-motion: reduce)"));
  assert(DESIGN_TOKENS.includes("animation-duration: 0.01ms !important"));
  assert(DESIGN_TOKENS.includes("transition-duration: 0.01ms !important"));
});
