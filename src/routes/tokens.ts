/**
 * Unified design tokens for Audio Feed (audio-feed-vpw).
 *
 * Single source of truth for:
 *   - Spacing scale (--space-1 to --space-12)
 *   - Color roles (light and dark mode)
 *   - Radii (--radius, --radius-sm, --radius-lg, --radius-full)
 *   - Typography (--font, --mono, --measure, --page, --ease)
 *   - Backward-compatible role aliases (--text-muted, --surface-sunken, --accent-text)
 *   - prefers-reduced-motion suppression
 */

export const DESIGN_TOKENS = `
:root {
  color-scheme: light dark;

  /* Surfaces & Backgrounds */
  --bg: #f7f6fb;
  --surface: #ffffff;
  --surface-2: #efedf6;
  --surface-3: #e3e0ee;

  /* Text & legibility: contrast verified against background and surface */
  --text: #17151f;
  --text-2: #3d3a4a;
  --muted: #5c586a;

  /* Borders */
  --border: #dcd8e8;
  --border-2: #c7c2d9;

  /* Accents */
  --accent: #5b3fc4;
  --accent-2: #4a31a8;
  --accent-dim: #7a63d2;
  --accent-ink: #ffffff;

  /* Status */
  --ok: #17703d;
  --danger: #b3261e;

  /* Spacing Scale (8pt grid basis with 4pt steps) */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.25rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-10: 2.5rem;
  --space-12: 3rem;

  /* Shape & Radii */
  --radius-sm: 8px;
  --radius: 12px;
  --radius-lg: 16px;
  --radius-full: 9999px;

  /* Typography & Layout */
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI Variable Text",
          "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --page: 58rem;
  --measure: 68ch;

  /* Component layout dimensions */
  --dock-h: 13.5rem;

  /* Legacy component aliases (one value, two names, zero drift) */
  --text-muted: var(--muted);
  --surface-sunken: var(--surface-2);
  --accent-text: var(--accent-ink);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0a0a0c;
    --surface: #131317;
    --surface-2: #1c1c22;
    --surface-3: #26262e;
    --text: #f4f4f5;
    --text-2: #b4b4bd;
    --muted: #9a9aa4;
    --border: #24242b;
    --border-2: #34343e;
    --accent: #a78bfa;
    --accent-2: #c4b5fd;
    --accent-dim: #6d5bb0;
    --accent-ink: #14121c;
    --ok: #86efac;
    --danger: #fca5a5;
  }
}

/* Explicit dark theme for the web player or dark mode override */
:root[data-theme="dark"], html[data-theme="dark"], [data-theme="dark"], .theme-dark {
  color-scheme: dark;
  --bg: #0a0a0c;
  --surface: #131317;
  --surface-2: #1c1c22;
  --surface-3: #26262e;
  --text: #f4f4f5;
  --text-2: #b4b4bd;
  --muted: #9a9aa4;
  --border: #24242b;
  --border-2: #34343e;
  --accent: #a78bfa;
  --accent-2: #c4b5fd;
  --accent-dim: #6d5bb0;
  --accent-ink: #14121c;
  --ok: #86efac;
  --danger: #fca5a5;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* Cross-Document View Transitions (audio-feed-rra) per Modern Web Guidance:
   Enables smooth app-like transitions across same-origin navigations.
   Respects user's reduced-motion preference. */
@media (prefers-reduced-motion: no-preference) {
  @view-transition {
    navigation: auto;
  }
}
`;
