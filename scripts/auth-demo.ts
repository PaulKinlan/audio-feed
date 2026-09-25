/**
 * End-to-end harness for the admin-approval gate.
 *
 *   deno run -A --unstable-kv scripts/auth-demo.ts [port]
 *
 * Verification surface only: it exercises the real gate through real HTTP so
 * the browser (or curl) can prove that unapproved users cannot reach synthesis.
 * The production routes belong to the server lane and replace this.
 */
import {
  approveUser,
  assertAuthorizedForAudio,
  createUser,
  isAuthorizedForAudio,
  listUsers,
  NotAuthorizedError,
  redactUser,
  rejectUser,
  requireAdminToken,
  suspendUser,
} from "../src/auth/users.ts";
import { KvMetadataStore } from "../src/storage/kv.ts";

const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN") ?? "test-admin-token";
const store = await KvMetadataStore.open(":memory:");
const admin = await createUser(store, {
  email: "admin@example.com",
  displayName: "Admin",
  isAdmin: true,
});

// Refuse to serve if the gate is ever open on a cold start.
for (const status of ["pending", "rejected", "suspended"] as const) {
  const probe = await createUser(store, { email: `probe-${status}@example.com` });
  if (status === "rejected") await rejectUser(store, probe.id, admin.id);
  if (status === "suspended") {
    await approveUser(store, probe.id, admin.id);
    await suspendUser(store, probe.id, admin.id);
  }
  if (await isAuthorizedForAudio(store, probe.id)) {
    throw new Error(`gate open for ${status} user — refusing to serve`);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      // The admin token travels in a header, so browsers must be allowed to
      // preflight it before the real request ever leaves the page.
      "access-control-allow-headers": "content-type, x-admin-token",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });

const port = Number(Deno.args[0] ?? 8942);
const origin = `http://localhost:${port}`;

Deno.serve({ port }, async (request) => {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    // 204 must be bodiless, so CORS headers are set directly here.
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, x-admin-token",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      },
    });
  }
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const token = request.headers.get("x-admin-token");

  try {
    switch (`${request.method} ${url.pathname}`) {
      // Public signup: always lands in the approval queue.
      case "POST /signup": {
        const user = await createUser(store, { email: body.email, displayName: body.displayName });
        return json({ id: user.id, status: user.status, email: user.email }, 201);
      }

      // Admin queue. Requires the admin token.
      //
      // `redactUser` is not decoration: `listUsers` returns the full record,
      // and serialising it directly would hand every pending user's feed
      // capability to anyone who can reach this endpoint. The feed token is a
      // bearer credential — a leaked one grants read access to that user's feed
      // until it is rotated, and rotation breaks every subscribed client.
      case "GET /pending": {
        await requireAdminToken(token, ADMIN_TOKEN);
        const pending = await listUsers(store, "pending");
        return json({ pending: pending.map(redactUser), adminId: admin.id });
      }

      case "POST /approve": {
        await requireAdminToken(token, ADMIN_TOKEN);
        const updated = await approveUser(store, body.userId, admin.id);
        return json({ id: updated.id, status: updated.status });
      }

      case "POST /suspend": {
        await requireAdminToken(token, ADMIN_TOKEN);
        const updated = await suspendUser(store, body.userId, admin.id, body.reason);
        return json({ id: updated.id, status: updated.status });
      }

      // The money path: refuses anything that is not an approved user.
      case "POST /synthesize": {
        const user = await assertAuthorizedForAudio(store, body.userId);
        return json({ queued: true, userId: user.id, voice: user.voice ?? "Aoede" });
      }

      case "GET /": {
        return new Response(
          `auth harness up at ${origin} (admin token: ${ADMIN_TOKEN})`,
          { headers: { "content-type": "text/plain" } },
        );
      }

      default:
        return json({ error: "not found" }, 404);
    }
  } catch (error) {
    const unauthorized = error instanceof NotAuthorizedError;
    return json(
      {
        error: unauthorized ? "not_authorized" : "forbidden",
        message: String(error instanceof Error ? error.message : error),
        status: unauthorized ? "blocked" : undefined,
      },
      unauthorized ? 403 : 401,
    );
  }
});

console.log(`auth harness listening on ${origin}`);
