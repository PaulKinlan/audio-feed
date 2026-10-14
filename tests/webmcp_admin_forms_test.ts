import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";
import { makeUser } from "./fixtures.ts";

const BASE = "https://audio.example.test";

async function setup() {
  const stores = memoryStores();
  const admin = makeUser({
    id: "webmcp-admin",
    email: "admin@example.test",
    status: "approved",
    isAdmin: true,
  });
  await stores.metadata.putUser(admin);
  await stores.metadata.putUser(makeUser({
    id: "webmcp-alpha",
    email: "alpha@example.test",
    displayName: "Alpha Person",
    status: "approved",
  }));
  await stores.metadata.putUser(makeUser({
    id: "webmcp-beta",
    email: "beta@example.test",
    displayName: "Beta Person",
    status: "pending",
  }));
  const ctx = {
    config: { port: 8000, publicBaseUrl: BASE, adminToken: "local-admin" },
    stores,
  };
  const fetch = createApp(ctx, createHandlers(ctx)).fetch;
  const cookie = `${SESSION_COOKIE}=${await createSession(stores.metadata, admin.id)}`;
  const adminGet = (path: string) => fetch(new Request(`${BASE}${path}`, { headers: { cookie } }));
  return { stores, fetch, cookie, adminGet };
}

function formTag(html: string, action: string): string {
  const tag = html.match(/<form\b[^>]*>/g)?.find((form) => form.includes(`action="${action}"`));
  assert(tag, `the real rendered page must contain a form with action ${action}`);
  return tag;
}

Deno.test("u462: observability issues GET filter is a WebMCP tool and still filters for a human", async () => {
  const { stores, adminGet } = await setup();
  await stores.metadata.appendLog({
    time: "2026-10-14T00:00:00.000Z",
    severity: "error",
    type: "webmcp.error.sample",
    process: "worker",
    message: "Error sample",
  });
  await stores.metadata.appendLog({
    time: "2026-10-14T00:00:01.000Z",
    severity: "warn",
    type: "webmcp.warning.sample",
    process: "worker",
    message: "Warning sample",
  });
  const response = await adminGet("/admin/observability/issues");
  assertEquals(response.status, 200);
  const html = await response.text();
  const form = formTag(html, "/admin/observability/issues");
  assertStringIncludes(form, 'method="GET"');
  assertStringIncludes(form, 'toolname="filter_observability_issues"');
  assertStringIncludes(
    form,
    'tooldescription="Filter observability issues by severity, event type, route, correlation ID or episode ID."',
  );
  assert(/\btoolautosubmit\b/.test(form), "read-only filter permits agent submission");
  const filtered = await adminGet("/admin/observability/issues?severity=error");
  assertEquals(filtered.status, 200);
  const results = await filtered.text();
  assertStringIncludes(results, "webmcp.error.sample");
  assertEquals(results.includes("webmcp.warning.sample"), false);
});

Deno.test("py9r: subscriber directory GET filter is a WebMCP tool and still filters for a human", async () => {
  const { adminGet } = await setup();
  const response = await adminGet("/admin/subscribers");
  assertEquals(response.status, 200);
  const html = await response.text();
  const form = formTag(html, "/admin/subscribers");
  assertStringIncludes(form, 'method="GET"');
  assertStringIncludes(form, 'toolname="filter_subscribers"');
  assertStringIncludes(
    form,
    'tooldescription="Search the subscriber directory by email or name and filter by account status."',
  );
  assert(/\btoolautosubmit\b/.test(form), "read-only filter permits agent submission");
  assertStringIncludes(html, 'name="q"');
  assertStringIncludes(
    html,
    'toolparamdescription="Subscriber email address or display name to search for"',
  );
  assertStringIncludes(html, 'toolparamdescription="Account status to include in the directory"');
  const filtered = await adminGet("/admin/subscribers?q=alpha&status=approved");
  assertEquals(filtered.status, 200);
  const results = await filtered.text();
  assertStringIncludes(results, "Alpha Person");
  assertEquals(results.includes("Beta Person"), false);
});

Deno.test("y3tz: header sign-out is discoverable but needs review and its plain POST still ends the session", async () => {
  const { fetch, cookie, adminGet } = await setup();
  const response = await adminGet("/admin/subscribers");
  assertEquals(response.status, 200);
  const html = await response.text();
  const form = formTag(html, "/api/auth/logout");
  assertStringIncludes(form, 'method="post"');
  assertStringIncludes(form, 'toolname="sign_out"');
  assertStringIncludes(form, 'tooldescription="Sign out of the current Audio Feed session."');
  assertEquals(/\btoolautosubmit\b/.test(form), false, "account action requires user review");
  assertStringIncludes(html, ">Sign out</button>");
  const signedOut = await fetch(
    new Request(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: {
        cookie,
        origin: BASE,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
    }),
  );
  assertEquals(signedOut.status, 303, "plain form submission keeps its redirect");
  assertEquals(signedOut.headers.get("location"), "/");
  assertStringIncludes(signedOut.headers.get("set-cookie") ?? "", "Max-Age=0");
  assertEquals((await adminGet("/admin/subscribers")).status, 403);
});
