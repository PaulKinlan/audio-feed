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
  rejectUser,
  requireAdminToken,
  suspendUser,
} from "../src/auth/users.ts";

const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN") ?? "test-admin-token";
const kv = await Deno.openKv(":memory:");
const admin = await createUser(kv, { email: "admin@example.com", displayName: "Admin", isAdmin: true });

// Refuse to serve if the gate is ever open on a cold start.
for (const status of ["pending", "rejected", "suspended"] as const) {
  const probe = await createUser(kv, { email: `probe-${status}@example.com` });
  if (status === "rejected") await rejectUser(kv, probe.id, admin.id);
  if (status === "suspended") {
    await approveUser(kv, probe.id, admin.id);
    await suspendUser(kv, probe.id, admin.id);
  }
  if (await isAuthorizedForAudio(kv, probe.id)) {
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
        const user = await createUser(kv, { email: body.email, displayName: body.displayName });
        return json({ id: user.id, status: user.status, email: user.email }, 201);
      }

      // Admin queue. Requires the admin token.
      case "GET /pending": {
        await requireAdminToken(token, ADMIN_TOKEN);
        return json({ pending: await listUsers(kv, "pending"), adminId: admin.id });
      }

      case "POST /approve": {
        await requireAdminToken(token, ADMIN_TOKEN);
        const updated = await approveUser(kv, body.userId, admin.id);
        return json({ id: updated.id, status: updated.status });
      }

      case "POST /suspend": {
        await requireAdminToken(token, ADMIN_TOKEN);
        const updated = await suspendUser(kv, body.userId, admin.id, body.reason);
        return json({ id: updated.id, status: updated.status });
      }

      // The money path: refuses anything that is not an approved user.
      case "POST /synthesize": {
        const user = await assertAuthorizedForAudio(kv, body.userId);
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
