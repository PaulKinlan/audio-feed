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
 * audio-feed-ewpxz: the dead client wiring is GONE. Until 2026-10-19 this module also wired two forms
 * that no page renders any more, and both of their lookup guards were unreachable at runtime.
 * The MODULE itself is alive and stays: imported by src/routes/assets.ts:30, listed in the served
 * asset manifest at :82, loaded as the / page's scriptModule (src/routes/home.ts:253) - only this
 * wiring died. The ids that vanished:
 *   - the ingest form: #ingest, #submit, #result, #url, #token, plus its ?add/?url/?feed/?title
 *     prefill - the page's ingest form was replaced by the explainer home in 0bf07a7e;
 *   - the feed-subscribe form: #subscribe-source, #submit-feed, #feed-result, #feed-url, #feed-title.
 * THE SEND AND SUBSCRIBE FLOWS LIVE ON /account NOW (src/routes/account.ts: #sendForm, #sendUrl,
 * success marked data-tone="ok"), and the front door's live player links are SERVER-RENDERED markup
 * (href="/listen") - this client builds none.
 * THE LESSON, kept so the next proof is not written against vanished ids (that mistake cost
 * audio-feed-vo25h, e3bp5 and jnjh5): grepping an affordance string in src/ is NOT evidence that a
 * page renders it - locate the id in the rendered page, or the affordance in the route's markup,
 * before asserting on it.
 * The #home-data island is still server-rendered (src/routes/home.ts) and still asserted by
 * tests/home_asset_test.ts; nothing client-side reads it any more, because its only reader needed
 * BASE for a link built by the dead feed region.
 */

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

const requestForm = /** @type {HTMLFormElement | null} */ (
  document.getElementById("request-access-form")
);
const requestSubmit = /** @type {HTMLButtonElement | null} */ (
  document.getElementById("request-submit")
);
const requestResult = document.getElementById("request-result");
const requestEmail = /** @type {HTMLInputElement | null} */ (
  document.getElementById("request-email")
);
// Rendered with the request form
const requestName = /** @type {HTMLInputElement | null} */ (
  document.getElementById("request-name")
);

/**
 * @param {string} kind
 * @param {string} message
 * @param {string} [detail]
 */
const sayRequest = (kind, message, detail) => {
  if (!requestResult) return;
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

if (requestForm && requestEmail && requestSubmit && requestResult && requestName) {
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
