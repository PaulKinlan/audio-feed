/**
 * The admin console's destructive actions are guarded by `confirm()`
 * (audio-feed-2dt). These tests check the guard, not its appearance.
 *
 * The test this replaces asserted:
 *
 *     assertStringIncludes(html, "confirm(");
 *
 * which passes whether the dialog guards anything or not. Mutating
 * `src/routes/admin.ts` so both dialogs still SHOW but their return value is
 * discarded -- so clicking Cancel rotates the token anyway and deletes the feed
 * anyway -- left every test green. The mutant was exactly the bug the feature
 * exists to prevent (audio-feed-05b).
 *
 * So each test drives the real shipped client through `tests/admin_script.ts`,
 * answers the dialog, and then asserts on the REQUEST: dismissing must send
 * nothing, accepting must send exactly one. A request going out is what actually
 * destroys a subscriber's feed, so a request is what the test watches.
 *
 * audio-feed-3xq part 4a: the client moved from an inline page string to the
 * content-addressed module src/assets/admin.js. The property under test is
 * unchanged -- the harness still runs the exact shipped bytes -- but the guard
 * that proves WHICH artifact runs now checks the island and the module link
 * instead of counting inline blocks.
 *
 * Owned by: audio-feed-05b, audio-feed-3xq.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { adminClient, adminClientFromHtml, runAdminScript } from "./admin_script.ts";
import type { AdminHarness } from "./admin_script.ts";
import { assetUrl } from "../src/routes/assets.ts";

const USER = {
  id: "u1",
  email: "sub@example.com",
  displayName: "Sub Scriber",
  status: "approved",
  feedToken: "tok-original",
};

const SOURCE = {
  id: "src-strat",
  title: "Stratechery",
  feedUrl: "https://stratechery.com/feed",
  modes: ["direct"],
};

/** A console already open on one subscriber with one subscribed feed. */
async function openConsole(): Promise<AdminHarness> {
  const harness = await runAdminScript({
    storedToken: "admin-secret",
    respond: (method, path) => {
      if (method === "GET" && path === "/api/admin/users") return { users: [USER] };
      if (method === "GET" && path === `/api/admin/users/${USER.id}/sources`) {
        return { feedToken: USER.feedToken, sources: [SOURCE] };
      }
      if (method === "POST" && path === `/api/admin/users/${USER.id}/rotate-token`) {
        return { feedToken: "tok-rotated" };
      }
      if (method === "DELETE" && path === `/api/admin/users/${USER.id}/sources/${SOURCE.id}`) {
        return { ok: true, deleted: SOURCE.id, cancelledPending: 0, retainedEpisodes: 0 };
      }
      return { ok: true };
    },
  });

  const manage = harness.buttons(harness.byId("usersBody"), "Manage");
  assertEquals(manage.length, 1, "the subscriber row must offer a Manage button");
  manage[0]!.click();
  await harness.flush();
  return harness;
}

const deletes = (h: AdminHarness) => h.requests.filter((r) => r.method === "DELETE");
const rotations = (h: AdminHarness) =>
  h.requests.filter((r) => r.method === "POST" && r.path.endsWith("/rotate-token"));

Deno.test("the harness refuses to guess which artifact is the console's (audio-feed-euq, re-pointed by audio-feed-3xq part 4a)", () => {
  // These tests are worth something only if they run what ships. When the client was an
  // inline block, the danger was a second <script> being run instead; the extractor refused
  // ambiguous pages. Now the client is a content-addressed module fed by a JSON island, so
  // the ambiguities that matter are: no island, two islands, no module link, or a link whose
  // hash does not match what the server serves -- a stale link 404s in production, and a
  // harness that ran some other bytes would stay green while doing it.
  //
  // The real page passes every guard, so each one gets a decoy page it must refuse.
  const island = `<script type="application/json" id="admin-data">{}</script>`;
  const module_ = `<script type="module" src="${assetUrl("admin.js")}"></script>`;

  assertThrows(
    () => adminClientFromHtml(`<html><body>${module_}</body></html>`),
    Error,
    "no #admin-data",
    "a page without the data island must be refused, not run with empty data",
  );

  assertThrows(
    () => adminClientFromHtml(`<html><body>${island}${island}${module_}</body></html>`),
    Error,
    "2 #admin-data documents",
    "a decoy island must be refused, not one-of-two picked silently",
  );

  assertThrows(
    () => adminClientFromHtml(`<html><body>${island}</body></html>`),
    Error,
    "exactly one client module",
    "a page that links no module would never run a client; refuse it",
  );

  assertThrows(
    () =>
      adminClientFromHtml(
        `<html><body>${island}<script type="module" src="/assets/deadbeef.admin.js"></script>` +
          `</body></html>`,
      ),
    Error,
    "stale or wrong asset link",
    "a module link whose hash does not match the served bytes must be refused",
  );

  // And the page as it actually renders still resolves to the console's client and data.
  const client = adminClient();
  assert(client.source.includes("rotateManageToken"), "must be the console client");
  const data = JSON.parse(client.data);
  assertEquals(data.origin, "https://audio.example.com");
  assertEquals(data.signedIn, true);
});

Deno.test("dismissing the Remove dialog sends no DELETE (audio-feed-05b)", async () => {
  const harness = await openConsole();
  const remove = harness.buttons(harness.byId("manageSourcesBody"), "Remove");
  assertEquals(remove.length, 1, "the feed row must offer a Remove button");

  harness.setConfirmAnswer(false);
  remove[0]!.click();
  await harness.flush();

  // The dialog must actually have been raised, or this test proves nothing:
  // a handler that never asks would also send no request.
  assertEquals(harness.confirms.length, 1, "Remove must ask before deleting");
  assertEquals(
    deletes(harness).length,
    0,
    "Cancel must not delete the feed -- the whole point of the guard",
  );
});

Deno.test("accepting the Remove dialog sends exactly one DELETE for that feed (audio-feed-05b)", async () => {
  const harness = await openConsole();
  const remove = harness.buttons(harness.byId("manageSourcesBody"), "Remove");

  harness.setConfirmAnswer(true);
  remove[0]!.click();
  await harness.flush();

  assertEquals(harness.confirms.length, 1);
  const sent = deletes(harness);
  assertEquals(sent.length, 1, "OK must delete, and delete once");
  assertEquals(sent[0]!.path, `/api/admin/users/${USER.id}/sources/${SOURCE.id}`);
  assertEquals(
    sent[0]!.adminToken,
    null,
    "the session cookie is used rather than a token header (audio-feed-0jp)",
  );
});

Deno.test("the Remove dialog names the feed it is about to delete (audio-feed-05b)", async () => {
  const harness = await openConsole();
  const remove = harness.buttons(harness.byId("manageSourcesBody"), "Remove");

  harness.setConfirmAnswer(false);
  remove[0]!.click();
  await harness.flush();

  // On a list of several feeds the dialog is the last thing an admin reads
  // before deleting, and it is the one place the feed must be identified.
  assert(
    harness.confirms[0]!.message.includes(SOURCE.title),
    `dialog must name the feed, got: ${harness.confirms[0]!.message}`,
  );
});

Deno.test("dismissing the Rotate dialog sends no rotate request (audio-feed-05b)", async () => {
  const harness = await openConsole();

  harness.setConfirmAnswer(false);
  harness.byId("rotateManageToken").click();
  await harness.flush();

  assertEquals(harness.confirms.length, 1, "Rotate must ask before revoking");
  assertEquals(
    rotations(harness).length,
    0,
    "Cancel must not rotate -- rotating silently breaks every podcast app subscription",
  );
  // And nothing may look as though it happened.
  assertEquals(
    harness.byId("manageFeedUrl").value,
    `https://audio.example.com/feed/${USER.feedToken}/master.xml`,
    "the displayed feed URL must still be the original",
  );
});

Deno.test("accepting the Rotate dialog rotates once and shows the new URL (audio-feed-05b)", async () => {
  const harness = await openConsole();

  harness.setConfirmAnswer(true);
  harness.byId("rotateManageToken").click();
  await harness.flush();

  assertEquals(harness.confirms.length, 1);
  assertEquals(rotations(harness).length, 1, "OK must rotate, and rotate once");
  assertEquals(
    harness.byId("manageFeedUrl").value,
    "https://audio.example.com/feed/tok-rotated/master.xml",
    "the console must show the rotated URL, not the revoked one",
  );
});

Deno.test("the Rotate dialog warns that existing subscriptions break (audio-feed-05b)", async () => {
  const harness = await openConsole();

  harness.setConfirmAnswer(false);
  harness.byId("rotateManageToken").click();
  await harness.flush();

  // Rotation is irreversible from the subscriber's side: their podcast app just
  // stops updating. The dialog is the only warning they get.
  const message = harness.confirms[0]!.message.toLowerCase();
  assert(
    message.includes("subscription") || message.includes("stop working"),
    `dialog must say what rotation costs, got: ${harness.confirms[0]!.message}`,
  );
});

Deno.test("a dismissed dialog leaves the button usable (audio-feed-05b)", async () => {
  const harness = await openConsole();

  // A guard that disables the button before asking would strand the admin on
  // Cancel: the action they declined would also be the last one they could take.
  harness.setConfirmAnswer(false);
  harness.byId("rotateManageToken").click();
  await harness.flush();
  assertEquals(harness.byId("rotateManageToken").disabled, false, "Rotate must stay clickable");

  const remove = harness.buttons(harness.byId("manageSourcesBody"), "Remove");
  remove[0]!.click();
  await harness.flush();
  assertEquals(remove[0]!.disabled, false, "Remove must stay clickable");

  // Proof it is still usable: accept this time and the request goes out.
  harness.setConfirmAnswer(true);
  remove[0]!.click();
  await harness.flush();
  assertEquals(deletes(harness).length, 1);
});

Deno.test("clicking Poll Feeds Now triggers POST /api/admin/poll-now and updates feedback (audio-feed-dsn)", async () => {
  const harness = await runAdminScript({
    storedToken: "admin-secret",
    respond: (method, path) => {
      if (method === "POST" && path === "/api/admin/poll-now") {
        return { ok: true, polled: 3, queued: 5, failed: 0 };
      }
      return { ok: true };
    },
  });

  const btn = harness.byId("pollNowBtn");
  assertEquals(btn.disabled, false, "button must be enabled when token is saved");
  btn.click();
  await harness.flush();

  const pollRequests = harness.requests.filter((r) =>
    r.method === "POST" && r.path === "/api/admin/poll-now"
  );
  assertEquals(pollRequests.length, 1);
  assertEquals(btn.disabled, false, "button must be re-enabled after response");
  assertStringIncludes(
    harness.byId("triggersFeedback").textContent,
    "Polled 3 feeds: 5 queued, 0 failed.",
  );
});

Deno.test("clicking Synthesize Queue Now triggers POST /api/admin/synthesize-now and updates feedback (audio-feed-dsn)", async () => {
  const harness = await runAdminScript({
    storedToken: "admin-secret",
    respond: (method, path) => {
      if (method === "POST" && path === "/api/admin/synthesize-now") {
        return { ok: true, ready: 4, failed: 1, deferred: 0 };
      }
      return { ok: true };
    },
  });

  const btn = harness.byId("synthesizeNowBtn");
  assertEquals(btn.disabled, false);
  btn.click();
  await harness.flush();

  const synthRequests = harness.requests.filter((r) =>
    r.method === "POST" && r.path === "/api/admin/synthesize-now"
  );
  assertEquals(synthRequests.length, 1);
  assertEquals(btn.disabled, false);
  assertStringIncludes(
    harness.byId("triggersFeedback").textContent,
    "Synthesis batch: 4 ready, 1 failed, 0 deferred.",
  );
});

Deno.test("manage sources renders status and error details for failing feed (audio-feed-dcj)", async () => {
  const harness = await runAdminScript({
    storedToken: "admin-secret",
    respond: (method, path) => {
      if (method === "GET" && path === "/api/admin/users") return { users: [USER] };
      if (method === "GET" && path === `/api/admin/users/${USER.id}/sources`) {
        return {
          feedToken: USER.feedToken,
          sources: [{
            ...SOURCE,
            lastPolledAt: "2026-09-25T08:00:00.000Z",
            lastPollError: "HTTP 403 Forbidden Cloudflare",
          }],
        };
      }
      return { ok: true };
    },
  });

  const manage = harness.buttons(harness.byId("usersBody"), "Manage");
  manage[0]!.click();
  await harness.flush();

  const tbody = harness.byId("manageSourcesBody");
  const text = tbody.descendants().map((d) => d.textContent).join(" ");
  assertStringIncludes(text, "Error");
  assertStringIncludes(text, "HTTP 403 Forbidden Cloudflare");
});

Deno.test("manage episodes renders Retry button on failed episode and Retry failed button in header (audio-feed-6y9)", async () => {
  const harness = await runAdminScript({
    storedToken: "admin-secret",
    respond: (method, path) => {
      if (method === "GET" && path === "/api/admin/users") return { users: [USER] };
      if (method === "GET" && path === `/api/admin/users/${USER.id}/sources`) {
        return { feedToken: USER.feedToken, sources: [] };
      }
      if (method === "GET" && path === `/api/admin/users/${USER.id}/episodes`) {
        return {
          promptVersion: "abc123abc123",
          counts: { outdated: 0, all: 2, failed: 1 },
          episodes: [
            { id: "ep-ready", title: "Playable", mode: "direct", status: "ready", outdated: false },
            {
              id: "ep-fail",
              title: "Broken Synth",
              mode: "direct",
              status: "failed",
              error: "LLM quota error",
            },
          ],
        };
      }
      if (method === "POST" && path.includes("/episodes/ep-fail/regenerate")) {
        return { ok: true, queued: 1 };
      }
      if (method === "POST" && path.includes("/regenerate")) {
        return { ok: true, queued: 1 };
      }
      return { ok: true };
    },
  });

  const manage = harness.buttons(harness.byId("usersBody"), "Manage");
  manage[0]!.click();
  await harness.flush();

  // 1. Verify "Retry failed (1)" button in header
  const retryFailedBtn = harness.byId("regenFailed");
  assertEquals(retryFailedBtn.textContent, "Retry failed (1)");
  assertEquals(retryFailedBtn.disabled, false);

  // 2. Verify table rows: "Playable" gets "Regenerate", "Broken Synth" gets "Retry"
  const tbody = harness.byId("manageEpisodesBody");
  const retryButtons = harness.buttons(tbody, "Retry");
  assertEquals(retryButtons.length, 1, "failed episode must have an inline Retry button");
  assertEquals(retryButtons[0]!.attributes["aria-label"], "Retry Broken Synth");

  const regenButtons = harness.buttons(tbody, "Regenerate");
  assertEquals(regenButtons.length, 1, "ready episode must have Regenerate button");

  // 3. Status column shows error detail
  const text = tbody.descendants().map((d) => d.textContent).join(" ");
  assertStringIncludes(text, "failed");
  assertStringIncludes(text, "LLM quota error");

  // 4. Click Retry -> confirms and sends POST
  harness.setConfirmAnswer(true);
  retryButtons[0]!.click();
  await harness.flush();

  const retryReq = harness.requests.find((r) =>
    r.path === `/api/admin/users/${USER.id}/episodes/ep-fail/regenerate`
  );
  assert(retryReq, "POST to regenerate/retry episode must be sent");

  // 5. Click "Retry failed (1)" -> confirms and sends POST with { scope: "failed" }
  retryFailedBtn.click();
  await harness.flush();

  const bulkRetryReq = harness.requests.find((r) =>
    r.path === `/api/admin/users/${USER.id}/regenerate`
  );
  assert(bulkRetryReq, "POST to regenerate feed must be sent");
  assertEquals(bulkRetryReq.body, { scope: "failed" });
});
