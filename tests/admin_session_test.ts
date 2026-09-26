/**
 * The admin console's real inline script on an admin SESSION (audio-feed-8fc).
 *
 * Runs through tests/admin_script.ts, so these exercise the script that ships,
 * not an extracted helper.
 */
import { assert, assertEquals } from "@std/assert";
import { runAdminScript } from "./admin_script.ts";

const USERS = {
  users: [{
    id: "u1",
    email: "reader@example.com",
    displayName: "Reader",
    status: "approved",
    isAdmin: false,
    createdAt: "2026-09-01T00:00:00.000Z",
  }],
};

function respond(method: string, path: string) {
  if (method === "GET" && path === "/api/admin/users") return USERS;
  if (method === "GET" && path === "/api/admin/stats") return null;
  if (method === "POST" && path === "/api/admin/users/u1/setup-link") {
    return {
      userId: "u1",
      url: "https://audio.example.com/login#setup=abc",
      expiresAt: "2026-10-03T00:00:00.000Z",
    };
  }
  if (method === "POST" && path === "/api/admin/users/u1/role") return { id: "u1", isAdmin: true };
  return null;
}

Deno.test("a signed-in admin's console loads with no token at all (audio-feed-8fc)", async () => {
  const page = await runAdminScript({ respond, signedIn: true });
  const list = page.requests.find((r) => r.path === "/api/admin/users");
  assert(list, "the subscriber list loads on the session");
  assertEquals(list.adminToken, "", "no token is sent, only the cookie");
  assertEquals(page.byId("usersBody").children.length, 1);
});

// Regression guard, not new behaviour: this already held on main (cd92a70). It
// keeps the session work from making a signed-out console call the API.
Deno.test("REGRESSION GUARD: a signed-out console without a token still waits for one (audio-feed-8fc)", async () => {
  const page = await runAdminScript({ respond });
  assertEquals(page.requests.length, 0);
});

Deno.test("Setup link issues a one-time link and shows it once (audio-feed-8fc)", async () => {
  const page = await runAdminScript({ respond, signedIn: true });
  const [button] = page.buttons(page.byId("usersBody"), "Setup link");
  assert(button, "every row offers a setup link");
  button.click();
  await page.flush();
  assert(page.requests.some((r) => r.method === "POST" && r.path.endsWith("/setup-link")));
  assertEquals(page.byId("setupLinkUrl").value, "https://audio.example.com/login#setup=abc");
  assertEquals(page.byId("setupLinkBox").hidden, false);
});

Deno.test("Make admin posts the role change (audio-feed-8fc)", async () => {
  const page = await runAdminScript({ respond, signedIn: true });
  const [button] = page.buttons(page.byId("usersBody"), "Make admin");
  assert(button);
  button.click();
  await page.flush();
  const call = page.requests.find((r) => r.path === "/api/admin/users/u1/role");
  assertEquals(call?.body, { isAdmin: true });
});
