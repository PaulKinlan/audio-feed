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
 * So each test drives the real shipped script through `tests/admin_script.ts`,
 * answers the dialog, and then asserts on the REQUEST: dismissing must send
 * nothing, accepting must send exactly one. A request going out is what actually
 * destroys a subscriber's feed, so a request is what the test watches.
 *
 * Owned by: audio-feed-05b.
 */
import { assert, assertEquals } from "@std/assert";
import { runAdminScript } from "./admin_script.ts";
import type { AdminHarness } from "./admin_script.ts";

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
  assertEquals(sent[0]!.adminToken, "admin-secret", "the admin token must travel with it");
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
