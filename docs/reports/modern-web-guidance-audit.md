# Modern Web Guidance Audit & Roadmap: Audio Feed

**Date:** 2026-09-29  
**Target:** [audio-feed](https://github.com/PaulKinlan/audio-feed) (`main` @ `5078ae0`)  
**Scope:** Architectural audit of Modern Web Guidance adoption, standards compliance (Baseline Widely Available), and strategic opportunities roadmap.

---

## 1. Executive Summary

Audio Feed is a modern, privacy-focused personal podcast service built on Deno and Deno Deploy, transforming web articles and RSS feeds into studio-quality audio narrations and two-voice dialogue deep dives via Gemini 3.8 Flash TTS.

This audit evaluates how modern web standards and guidelines (per `web.dev`, W3C, and Web Incubator Community Group specifications) have been applied across the application, and identifies concrete, high-impact opportunities to elevate user experience, platform integration, and performance using modern web primitives.

---

## 2. Audit of Modern Web Guidance Applied to Date

### 2.1 WebAuthn & Passkeys (Zero-Password Authentication)
- **Passwordless Authentication (`audio-feed-8fc`)**: Implemented WebAuthn registration and authentication flows using `@simplewebauthn/server` (`src/auth/passkeys.ts`, `src/auth/sessions.ts`). Credential IDs and public keys are stored in Deno KV without passwords or SMS 2FA vulnerabilities.
- **AAGUID Provider Resolution & Canonical Brand SVGs (`audio-feed-25t`, `audio-feed-vgn`, `audio-feed-f6r`)**:
  - Implements guidance from `web.dev/articles/passkey-management` and the FIDO Authenticator AAGUID registry (`src/auth/aaguid.ts`).
  - Maps AAGUIDs to human-friendly provider labels (Google Password Manager, iCloud Keychain, Windows Hello, 1Password, Bitwarden, Dashlane, YubiKey).
  - Uses canonical, crisp cubic Bézier vector SVGs with official brand color palettes (`#4285F4`, `#0078D4`, `#0A85EA`, `#175DDC`, `#00A389`, `#54BA37`) and the official FIDO Alliance Passkey logo fallback.
- **RP ID Exact-Hostname Scoping & Clash Protection (`audio-feed-1o2`)**:
  - Implements guidance from `web.dev/articles/webauthn-rp-id`.
  - Pinned `rpID` strictly to the exact service hostname (e.g. `audio-feed.paulkinlan-ea.deno.net`) by default, preventing cross-app passkey clashes with other applications running under `*.paulkinlan-ea.deno.net`.
  - Added `isPublicSuffix` runtime guard refusing eTLD / Public Suffixes (`deno.net`, `pages.dev`, `github.io`, etc.) from ever being set as RP ID, eliminating browser `SecurityError` DOMExceptions.
  - Supports intentional registrable domain pins via `WEBAUTHN_RP_ID` in `AppConfig`.
- **Related Origin Requests (ROR) (`audio-feed-1o2`)**:
  - Mounted `GET /.well-known/webauthn` serving W3C Related Origin Requests JSON (`{ "origins": [...] }`).
  - Protected against Host header cache poisoning by strictly sourcing origins from operator configuration (`publicBaseUrl` and `WEBAUTHN_RELATED_ORIGINS`).
- **URL Fragment Setup Tokens**:
  - Setup links use URL fragments (`/login#setup=<token>`), ensuring one-time secrets are never transmitted in HTTP headers, queried on servers, or stored in proxy/access logs.

### 2.2 Audio Architecture & Stream Delivery
- **Audio Range Requests (RFC 7233)**: `src/routes/audio.ts` supports `Range: bytes=start-end` and returns `206 Partial Content` with `Content-Range` and `Accept-Ranges: bytes`, allowing podcast clients and HTML5 audio players to scrub and seek instantly without redownloading.
- **RIFF/WAV Stream Derivation**: `src/tts/gemini.ts` derives standard 44-byte RIFF/WAVE headers (`pcmToWav`) from raw PCM buffers, ensuring universal playback compatibility across all operating systems and browser audio decoders.
- **Single-Audio Architecture for Auditions (`audio-feed-msw`)**:
  - On `/account`, voice audition cards use a single shared `<audio id="voiceSampleAudio">` element to drive five audition buttons.
  - Guarantees structurally that exactly one sample plays at a time, eliminating concurrency bugs and race conditions.
  - In-flight request collapsing on `GET /assets/voices/:voice` ensures burst clicks result in a single upstream TTS synthesis, cached immutably in blob storage.
- **Playback Position Memory (`audio-feed-kzi`)**:
  - The web player persists playback progress per episode in client-side storage, resuming smoothly across sessions.

### 2.3 Progressive Web App (PWA) & Offline Capabilities
- **Web App Manifest (`src/routes/pwa.ts`)**:
  - Serves `GET /manifest.json` with `display: "standalone"`, `theme_color`, `background_color`, and vector icons.
- **Service Worker (`src/routes/pwa.ts:handleServiceWorker`)**:
  - Caches core app shell assets for offline access.
  - Integrates with the Background Fetch API (`background-fetch`) for reliable downloading of large audio enclosures in the background without requiring the tab to stay active.

### 2.4 Modern CSS & Design Tokens
- **Single Source of Design Tokens (`audio-feed-vpw`, `src/routes/tokens.ts`)**:
  - Unified CSS custom properties (`:root`) for colors, surfaces, borders, typography, and spacing shared across `/`, `/admin`, `/account`, and `/listen/*`.
- **Theme Adaptation & Color Scheme**:
  - Declares `color-scheme: light dark` and uses system-adaptive variables, adapting native browser controls (scrollbars, form inputs) automatically.
- **Accessibility & Contrast**:
  - Automated contrast testing verifies that muted text maintains >= 5.82:1 contrast ratio against light and dark surfaces, exceeding WCAG 2.1 AA requirements.
- **Reduced Motion Support**:
  - Media query `@media (prefers-reduced-motion: reduce)` globally disables unnecessary transitions and animations for users with vestibular sensitivities.

### 2.5 Security, SSRF & Resource Boundaries
- **Strict SSRF Protections (`src/ingest/url.ts`)**:
  - Uses `ipaddr.js` to inspect resolved DNS IP addresses before connecting, refusing loopback (`127.0.0.0/8`, `::1`), private LAN (`10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12`), link-local (`169.254.0.0/16`), carrier-grade NAT (`100.64.0.0/10`), and IPv6 transition addresses.
- **Stream Bounds & Content Types**:
  - Bounded stream reading (`readBounded`) terminates oversized streams with `413 Payload Too Large` (2 MiB cap for HTML, 10 MiB cap for PDF documents via `audio-feed-w9n`).
  - Limits redirect chains to 5 hops max, re-validating DNS and destination on every hop.
- **CSRF & Cross-Site Walls**:
  - Verifies Origin against base URL on all mutating endpoints (`POST`, `DELETE`).
  - Uses `Sec-Fetch-Site` metadata (`cross-site` and `same-site` rejection) on sensitive read endpoints (`/api/account/discover-feed`) to prevent cross-site data theft.
- **Gemini TTS Transcript Separation (`audio-feed-bjt`)**:
  - Adheres to official Gemini speech generation documentation: separates verbatim spoken transcripts (`parts.text`) from tone/style directions (`speech_metadata.style`), preventing system prompts from being rendered aloud into audio.

---

## 3. High-Value Modern Web Opportunities

Despite strong foundational adoption, several modern web capabilities can dramatically enhance Audio Feed's mobile and desktop experience. Each opportunity below is categorized by specification status (Baseline Widely Available vs. Baseline Newly Available).

### Opportunity 1: Media Session API Integration (Baseline Widely Available)
* **Problem**: When playing podcast episodes in the web player (`/listen/:token`), the browser notification, lock screen, and OS media centers show either generic browser audio or nothing. Hardware media keys (play/pause, skip backward/forward 15s) and Bluetooth headphones cannot control playback.
* **Modern Solution**: Wire `navigator.mediaSession` in `src/assets/listen.js`:
  ```js
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: activeEpisode.title,
      artist: activeEpisode.author || "Audio Feed",
      album: activeEpisode.sourceTitle || "Personal Podcast",
      artwork: [
        { src: "/icon.svg", sizes: "512x512", type: "image/svg+xml" }
      ]
    });
    navigator.mediaSession.setActionHandler("play", () => audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("seekbackward", (details) => {
      audio.currentTime = Math.max(audio.currentTime - (details.seekOffset || 15), 0);
    });
    navigator.mediaSession.setActionHandler("seekforward", (details) => {
      audio.currentTime = Math.min(audio.currentTime + (details.seekOffset || 15), audio.duration);
    });
    navigator.mediaSession.setActionHandler("previoustrack", () => playPrevious());
    navigator.mediaSession.setActionHandler("nexttrack", () => playNext());
  }
  ```
* **Impact**: Native lock-screen controls on iOS and Android, Apple Watch / Wear OS media controls, keyboard media keys, and Bluetooth headset integration.

### Opportunity 2: Cross-Document View Transitions (Baseline Newly Available)
* **Problem**: Navigating between the homepage (`/`), account dashboard (`/account`), and player (`/listen/:token`) causes full-page browser document refreshes.
* **Modern Solution**: Add declarative cross-document view transitions in `src/routes/tokens.ts`:
  ```css
  @view-transition {
    navigation: auto;
  }
  ```
  And tag persistent elements (such as `.header-wrap`, logo, and audio player bar):
  ```css
  .app-header {
    view-transition-name: app-header;
  }
  .player-dock {
    view-transition-name: player-dock;
  }
  ```
* **Impact**: Smooth, app-like morphing transitions during page navigations without adding a client-side routing framework.

### Opportunity 3: Speculation Rules API for Instant Player Navigation
* **Problem**: When a user clicks "Open the player" on `/account` or clicks an episode link, navigation latency depends on network round-trip.
* **Modern Solution**: Inject speculative prefetching/prerendering rules in `src/routes/account.ts` and `src/routes/home.ts`:
  ```html
  <script type="speculationrules">
  {
    "prefetch": [
      {
        "source": "list",
        "urls": ["/listen/${user.feedToken}"],
        "eagerness": "moderate"
      }
    ]
  }
  </script>
  ```
* **Impact**: The web player loads with near-zero latency (0ms perceived load time).

### Opportunity 4: Native `<dialog>` and Popover API for Accessible Modals
* **Problem**: Destructive or confirmation actions (regenerating episodes, rotating feed URLs, removing sources, retrying failed batches) currently call synchronous, blocking `window.confirm()`.
* **Modern Solution**: Replace `window.confirm()` with native HTML `<dialog>` elements or `popover="auto"`:
  ```html
  <dialog id="confirmDialog" class="modal-dialog">
    <form method="dialog" class="stack">
      <h3 id="dialogTitle"></h3>
      <p id="dialogMessage"></p>
      <div class="actions">
        <button value="cancel" class="btn quiet">Cancel</button>
        <button value="confirm" class="btn danger" id="dialogConfirmBtn">Confirm</button>
      </div>
    </form>
  </dialog>
  ```
* **Impact**: Accessible keyboard focus trapping, Escape-key dismissal, light-dismiss, custom styling matching design tokens, and non-blocking asynchronous interaction.

### Opportunity 5: App Badging API for Unread / Ready Episodes
* **Problem**: When Audio Feed is installed as a PWA on mobile or desktop, users have no visual cue when new episodes have finished synthesizing.
* **Modern Solution**: Use `navigator.setAppBadge()` and `navigator.clearAppBadge()`:
  ```js
  if ("setAppBadge" in navigator) {
    if (readyCount > 0) {
      navigator.setAppBadge(readyCount);
    } else {
      navigator.clearAppBadge();
    }
  }
  ```
* **Impact**: Native app-icon badge notification on Android, macOS Dock, and Windows taskbar.

### Opportunity 6: Web Share API (`navigator.share`)
* **Problem**: Sharing an episode or an article link from the player requires manual URL copying.
* **Modern Solution**: Add a "Share" action on episode rows in `src/assets/listen.js`:
  ```js
  if (navigator.share) {
    await navigator.share({
      title: episode.title,
      text: `Listen to "${episode.title}" on Audio Feed`,
      url: episode.articleUrl || window.location.href,
    });
  } else {
    await navigator.clipboard.writeText(episode.articleUrl);
  }
  ```
* **Impact**: Seamless native mobile sharing to messaging apps, social networks, and notes.

### Opportunity 7: CSS Subgrid for Tabular & List Alignment
* **Problem**: Episode rows and passkey list items contain multi-column components (icon, titles, timestamps, action buttons) that use flexbox or separate grids, meaning column widths do not align vertically across rows when titles wrap.
* **Modern Solution**: Adopt CSS `grid-template-columns: subgrid` in list layouts (`src/assets/listen.css`, `src/routes/account.ts`):
  ```css
  .rows {
    display: grid;
    grid-template-columns: auto 1fr auto auto;
  }
  .rows > li {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
    align-items: center;
  }
  ```
* **Impact**: Perfectly aligned columns across all variable-length list items with zero JavaScript overhead.

---

## 4. Prioritized Action Plan & Beads Issues

The following actionable items have been prepared for issue creation in Beads (`bd`):

| Issue Key | Title | Priority | Category | Status |
| :--- | :--- | :--- | :--- | :--- |
| `audio-feed-3jf` | feat(player): integrate Media Session API for lock-screen & headphone playback controls | P2 | Web APIs | Filed (open) |
| `audio-feed-rra` | feat(ui): add cross-document view transitions across home, account, and player | P2 | CSS / UX | Filed (open) |
| `audio-feed-nvj` | feat(perf): add Speculation Rules prefetching for instant player loading | P3 | Performance | Filed (open) |
| `audio-feed-ytl` | feat(ui): replace blocking window.confirm with native accessible `<dialog>` | P3 | Accessibility | Filed (open) |
| `audio-feed-n07` | feat(pwa): update app icon badge with unread episode count via Badging API | P3 | PWA | Filed (open) |
| `audio-feed-zcw` | feat(player): add native Web Share API support on episode rows | P3 | Web APIs | Filed (open) |
| `audio-feed-b6z` | feat(css): adopt CSS subgrid for aligned list rows on account and admin | P3 | CSS | Filed (open) |

---

## 5. Conclusion

Audio Feed already exhibits strong compliance with modern web best practices in its authentication, security boundaries, and streaming architecture. Implementing the Media Session API, View Transitions, Speculation Rules, and Native Dialogs will transform the web application into an exceptional, platform-integrated podcast experience matching or exceeding native mobile applications.
