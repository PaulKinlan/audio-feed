/**
 * audio-feed-3xq part 4b — the homepage's client as a real module instead of a ~376-line string
 * inside src/routes/home.ts's template literal.
 *
 * `// @ts-check` plus `/// <reference lib="dom" />` is what makes this file visible to the gate:
 * `deno check` reads a .js file carrying @ts-check, and it reaches this one because
 * src/routes/assets.ts imports it as text.
 *
 * Served verbatim at /assets/<hash>.home.js, so: plain ESM, no TypeScript syntax, no build step.
 * Types come from JSDoc and inference.
 */
// @ts-check
/// <reference lib="dom" />

/**
 * The homepage's data, injected as JSON rather than as code (audio-feed-3xq part 4b). The only
 * server value the client ever needed was the escaped public origin, interpolated into one
 * success message; now it rides in the #home-data island like everything else on this pattern.
 * @typedef {object} HomeData
 * @property {string} base
 */
const homeDataElement = document.getElementById("home-data");
/** @type {HomeData} */
const HOME_DATA = homeDataElement ? JSON.parse(homeDataElement.textContent || "{}") : { base: "" };
const BASE = HOME_DATA.base;

/**
 * The ids the homepage always renders. Missing one is a deploy bug, not a state to recover
 * from, so it is checked once here rather than optional-chained at every use (same guard, same
 * reasoning, as admin.js and listen.js). Elements the code already guards with `if (el)` keep
 * their plain `document.getElementById` + null type.
 * @param {string} id
 */
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`homepage is missing #${id}`);
  return el;
};

const form = /** @type {HTMLFormElement} */ ($("ingest"));
const button = /** @type {HTMLButtonElement} */ ($("submit"));
const result = $("result");
const url = /** @type {HTMLInputElement} */ ($("url"));
const token = /** @type {HTMLInputElement} */ ($("token"));
/** @type {HTMLInputElement[]} */
const required = [url, token];

// :user-invalid is a visual state only. Assistive technology needs
// aria-invalid, and it has to appear on the same schedule as the styling —
// after interaction, not on page load.
const supportsUserInvalid = (() => {
  try {
    return document.querySelector(":user-invalid") !== undefined;
  } catch {
    return false;
  }
})();

/** @param {HTMLInputElement} input */
const sync = (input) => {
  const valid = input.checkValidity();
  if (valid) input.removeAttribute("aria-invalid");
  else input.setAttribute("aria-invalid", "true");
  if (!supportsUserInvalid) input.classList.toggle("is-invalid", !valid);
};

form.addEventListener("blur", (e) => {
  const target = /** @type {HTMLInputElement | null} */ (e.target);
  if (target && required.includes(target)) sync(target);
}, true);

form.addEventListener("input", (e) => {
  const target = /** @type {HTMLInputElement | null} */ (e.target);
  if (target && required.includes(target) && target.checkValidity()) {
    target.removeAttribute("aria-invalid");
    target.classList.remove("is-invalid");
  }
});

/**
 * @param {string} kind
 * @param {string} message
 * @param {string} [detail]
 * @param {string} [playerUrl]
 */
const say = (kind, message, detail, playerUrl) => {
  result.className = kind;
  result.innerHTML = "";
  const p = document.createElement("p");
  p.textContent = message;
  result.append(p);
  if (detail) {
    const d = document.createElement("p");
    d.className = "detail";
    d.textContent = detail;
    result.append(d);
  }
  if (playerUrl) {
    const linkWrap = document.createElement("p");
    linkWrap.className = "player-action";
    linkWrap.style.marginBlockStart = "var(--space-2)";
    const a = document.createElement("a");
    a.href = playerUrl;
    a.className = "player-link";
    a.style.fontWeight = "600";
    a.textContent = "Open in Web Player →";
    linkWrap.appendChild(a);
    result.append(linkWrap);
  }
};

const returningBox = /** @type {HTMLElement | null} */ (
  document.getElementById("returningSubscriber")
);
const storedToken = (() => {
  try {
    return localStorage.getItem("audio-feed-token");
  } catch {
    return null;
  }
})();
if (storedToken && returningBox) {
  returningBox.hidden = false;
  if (!token.value) token.value = storedToken;
}

const queryParams = new URLSearchParams(location.search);
const addQuery = queryParams.get("add") || queryParams.get("url");
const feedQuery = queryParams.get("feed");
const titleQuery = queryParams.get("title");

if (addQuery) {
  try {
    const parsed = new URL(addQuery);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      url.value = addQuery;
    }
  } catch { /* ignore */ }
}
if (feedQuery) {
  try {
    const parsedFeed = new URL(feedQuery);
    if (parsedFeed.protocol === "http:" || parsedFeed.protocol === "https:") {
      const feedInput = /** @type {HTMLInputElement | null} */ (
        document.getElementById("feed-url")
      );
      if (feedInput) feedInput.value = feedQuery;
    }
  } catch { /* ignore */ }
}
if (titleQuery) {
  const feedTitleInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById("feed-title")
  );
  if (feedTitleInput) feedTitleInput.value = titleQuery.slice(0, 100);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  required.forEach(sync);
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  button.setAttribute("aria-disabled", "true");
  button.textContent = "Sending…";
  say("", "Queueing the article…");

  try {
    const response = await fetch("/api/ingest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // A header, never a query parameter: a token in a URL ends up in
        // history, referrers and server logs.
        "x-feed-token": token.value.trim(),
      },
      body: JSON.stringify({
        url: url.value.trim(),
        mode: /** @type {HTMLSelectElement} */ (form.elements.namedItem("mode")).value,
      }),
    });

    const body = await response.json().catch(() => ({}));

    if (response.status === 202) {
      say(
        "ok",
        "Queued. It will appear in your feed once synthesis finishes.",
        body.article && body.article.title ? "Article: " + body.article.title : undefined,
        token.value.trim() ? "/listen/" + encodeURIComponent(token.value.trim()) : undefined,
      );

      // Clearing url.value alone is not enough, and the difference is
      // visible: an emptied required field the user has already interacted
      // with matches :user-invalid, so a red "Enter a full URL" error appeared
      // directly beneath the green success message. form.reset() is what
      // clears the browser's interaction state; the token and mode are then
      // restored because someone sending a second article wants to keep them.
      const keptToken = token.value;
      const keptMode = /** @type {HTMLSelectElement} */ (form.elements.namedItem("mode")).value;
      form.reset();
      token.value = keptToken;
      /** @type {HTMLSelectElement} */ (form.elements.namedItem("mode")).value = keptMode;
      for (const field of required) {
        field.removeAttribute("aria-invalid");
        field.classList.remove("is-invalid");
      }
      url.focus();
    } else if (response.status === 403) {
      say(
        "bad",
        "That token was not accepted, or the account is not approved yet.",
        "New accounts need admin approval before audio can be generated.",
      );
    } else {
      say("bad", body.error || "The article could not be queued.", "Status " + response.status);
    }
  } catch (error) {
    say("bad", "Could not reach the server.", String(error));
  } finally {
    button.removeAttribute("aria-disabled");
    button.textContent = "Send to Audio";
  }
});

const feedForm = /** @type {HTMLFormElement} */ ($("subscribe-source"));
const feedButton = /** @type {HTMLButtonElement} */ ($("submit-feed"));
const feedResult = $("feed-result");
const feedUrl = /** @type {HTMLInputElement} */ ($("feed-url"));
const feedTitle = /** @type {HTMLInputElement} */ ($("feed-title"));

/**
 * @param {string} kind
 * @param {string} message
 * @param {string} [detail]
 * @param {string} [playerUrl]
 */
const sayFeed = (kind, message, detail, playerUrl) => {
  feedResult.className = kind;
  feedResult.innerHTML = "";
  const p = document.createElement("p");
  p.textContent = message;
  feedResult.append(p);
  if (detail) {
    const d = document.createElement("p");
    d.className = "detail";
    d.textContent = detail;
    feedResult.append(d);
  }
  if (playerUrl) {
    const linkWrap = document.createElement("p");
    linkWrap.className = "player-action";
    linkWrap.style.marginBlockStart = "var(--space-2)";
    const a = document.createElement("a");
    a.href = playerUrl;
    a.className = "player-link";
    a.style.fontWeight = "600";
    a.textContent = "Open in Web Player →";
    linkWrap.appendChild(a);
    feedResult.append(linkWrap);
  }
};

feedUrl.addEventListener("blur", () => sync(feedUrl));
feedUrl.addEventListener("input", () => {
  if (feedUrl.checkValidity()) {
    feedUrl.removeAttribute("aria-invalid");
    feedUrl.classList.remove("is-invalid");
  }
});

feedForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  sync(feedUrl);
  sync(token);
  if (!token.value.trim()) {
    sayFeed("bad", "A feed token is required.", "Enter your feed token in the field above.");
    token.focus();
    return;
  }
  if (!feedUrl.checkValidity()) {
    feedUrl.reportValidity();
    return;
  }

  feedButton.setAttribute("aria-disabled", "true");
  feedButton.textContent = "Subscribing…";
  sayFeed("", "Checking feed and queueing posts…");

  try {
    const response = await fetch("/api/sources", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-feed-token": token.value.trim(),
      },
      body: JSON.stringify({
        feedUrl: feedUrl.value.trim(),
        title: feedTitle.value.trim() || undefined,
        modes: [/** @type {HTMLSelectElement} */ (feedForm.elements.namedItem("feedMode")).value],
      }),
    });

    const body = await response.json().catch(() => ({}));

    if (response.status === 201) {
      const count = body.poll && typeof body.poll.queued === "number" ? body.poll.queued : 0;
      const sourceTitle = body.source && body.source.title ? body.source.title : "the feed";
      const feedPath = body.feedPaths && body.feedPaths[0] ? body.feedPaths[0] : null;
      const detail = feedPath ? "Per-source feed URL: " + BASE + feedPath : undefined;
      const userToken = token.value.trim();

      sayFeed(
        "ok",
        "Subscribed to " + sourceTitle + ". " + count + " post(s) queued for synthesis.",
        detail,
        userToken ? "/listen/" + encodeURIComponent(userToken) : undefined,
      );

      const keptMode = /** @type {HTMLSelectElement} */ (feedForm.elements.namedItem("feedMode"))
        .value;
      feedForm.reset();
      /** @type {HTMLSelectElement} */ (feedForm.elements.namedItem("feedMode")).value = keptMode;
      feedUrl.removeAttribute("aria-invalid");
      feedUrl.classList.remove("is-invalid");
    } else if (response.status === 403) {
      sayFeed(
        "bad",
        "That token was not accepted, or the account is not approved yet.",
        "New accounts need admin approval before audio can be generated.",
      );
    } else {
      sayFeed(
        "bad",
        body.error || "The feed could not be subscribed.",
        "Status " + response.status,
      );
    }
  } catch (error) {
    sayFeed("bad", "Could not reach the server.", String(error));
  } finally {
    feedButton.removeAttribute("aria-disabled");
    feedButton.textContent = "Subscribe to Feed";
  }
});

const requestForm = /** @type {HTMLFormElement | null} */ (
  document.getElementById("request-access-form")
);
const requestSubmit = /** @type {HTMLButtonElement | null} */ (
  document.getElementById("request-submit")
);
const requestResult = $("request-result");
const requestEmail = /** @type {HTMLInputElement | null} */ (
  document.getElementById("request-email")
);
// Always rendered with the request form; used unguarded inside the submit handler.
const requestName = /** @type {HTMLInputElement} */ ($("request-name"));

/**
 * @param {string} kind
 * @param {string} message
 * @param {string} [detail]
 */
const sayRequest = (kind, message, detail) => {
  requestResult.className = kind;
  requestResult.innerHTML = "";
  const p = document.createElement("p");
  p.textContent = message;
  requestResult.append(p);
  if (detail) {
    const d = document.createElement("p");
    d.className = "detail";
    d.textContent = detail;
    requestResult.append(d);
  }
};

if (requestForm && requestEmail && requestSubmit) {
  requestEmail.addEventListener("blur", () => sync(requestEmail));
  requestEmail.addEventListener("input", () => {
    if (requestEmail.checkValidity()) {
      requestEmail.removeAttribute("aria-invalid");
      requestEmail.classList.remove("is-invalid");
    }
  });

  requestForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    sync(requestEmail);
    if (!requestEmail.checkValidity()) {
      requestEmail.reportValidity();
      return;
    }

    requestSubmit.setAttribute("aria-disabled", "true");
    requestSubmit.disabled = true;
    requestSubmit.textContent = "Submitting…";
    sayRequest("", "Submitting access request…");

    try {
      const response = await fetch("/api/request-access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: requestEmail.value.trim(),
          displayName: requestName.value.trim() || undefined,
        }),
      });

      const body = await response.json().catch(() => ({}));

      if (response.status === 201 || response.status === 200) {
        sayRequest(
          body.ok ? "ok" : "bad",
          body.message || "Access request received! An administrator will review your account.",
          body.ok ? "Nothing generates until an administrator approves your account." : undefined,
        );
        if (body.ok) {
          requestForm.reset();
          requestEmail.removeAttribute("aria-invalid");
          requestEmail.classList.remove("is-invalid");
        }
      } else if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const retryMsg = retryAfter
          ? "Please wait " + retryAfter + " second(s) before trying again."
          : "Please wait a while before requesting access again.";
        sayRequest(
          "bad",
          "Too many requests. " + retryMsg,
          "Rate limit exceeded.",
        );
      } else {
        sayRequest(
          "bad",
          body.error || "The access request could not be processed.",
          "Status " + response.status,
        );
      }
    } catch (error) {
      sayRequest("bad", "Could not reach the server.", String(error));
    } finally {
      requestSubmit.removeAttribute("aria-disabled");
      requestSubmit.disabled = false;
      requestSubmit.textContent = "Request access";
    }
  });
}
