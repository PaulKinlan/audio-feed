/**
 * Accounts: sessions, passkey credentials, setup links and challenges.
 *
 * Split out of tests/conformance/metadata.ts (audio-feed-fydf). The cases are unchanged: each one
 * was moved here verbatim from the section it already lived in.
 */

import type { MetadataHarness } from "./harness.ts";
import { assertEquals } from "@std/assert";
import { makeUser } from "../../fixtures.ts";
import { isoAt } from "./harness.ts";
import { FUTURE } from "./harness.ts";

export function registerAuthCases(suite: MetadataHarness) {
  const { test } = suite;

  // -- accounts (audio-feed-8fc) ---------------------------------------------

  test("round-trips a session and forgets it on delete (audio-feed-8fc)", async (store) => {
    const session = {
      idHash: "a".repeat(64),
      userId: "user-1",
      createdAt: isoAt(0),
      expiresAt: FUTURE,
    };
    await store.putSession(session);
    assertEquals(await store.getSession(session.idHash), session);
    await store.deleteSession(session.idHash);
    assertEquals(await store.getSession(session.idHash), null);
    assertEquals(await store.getSession("b".repeat(64)), null);
  });

  test("stores passkeys per user and updates the counter in place (audio-feed-8fc)", async (store) => {
    const first = {
      id: "cred-1",
      userId: "user-1",
      publicKey: "pk1",
      counter: 0,
      transports: ["internal"],
      name: "Laptop",
      createdAt: isoAt(0),
      aaguid: "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4",
    };
    const second = { ...first, id: "cred-2", publicKey: "pk2", createdAt: isoAt(1) };
    const other = { ...first, id: "cred-3", userId: "user-2", createdAt: isoAt(2) };
    await store.putCredential(second);
    await store.putCredential(first);
    await store.putCredential(other);

    assertEquals((await store.listCredentials("user-1")).map((c) => c.id), ["cred-1", "cred-2"]);
    assertEquals((await store.listCredentials("user-2")).map((c) => c.id), ["cred-3"]);
    assertEquals(await store.getCredential("cred-1"), first);

    await store.putCredential({ ...first, counter: 7, lastUsedAt: isoAt(5) });
    assertEquals((await store.getCredential("cred-1"))?.counter, 7);
    assertEquals((await store.listCredentials("user-1")).length, 2);
  });

  test("a passkey can only be deleted by its owner (audio-feed-8fc)", async (store) => {
    const cred = {
      id: "cred-1",
      userId: "user-1",
      publicKey: "pk",
      counter: 0,
      name: "Phone",
      createdAt: isoAt(0),
    };
    await store.putCredential(cred);
    await store.putCredential({ ...cred, id: "cred-2", createdAt: isoAt(1) });
    assertEquals(await store.deleteCredential("user-2", "cred-1"), "missing");
    assertEquals((await store.getCredential("cred-1"))?.userId, "user-1");
    assertEquals(await store.deleteCredential("user-1", "cred-1"), "deleted");
    assertEquals(await store.getCredential("cred-1"), null);
    assertEquals((await store.listCredentials("user-1")).map((c) => c.id), ["cred-2"]);
    assertEquals(await store.deleteCredential("user-1", "cred-1"), "missing");
  });

  test("a user's last passkey is never deleted, even by concurrent deletes (audio-feed-8fc)", async (store) => {
    const cred = {
      id: "cred-1",
      userId: "user-1",
      publicKey: "pk",
      counter: 0,
      name: "Phone",
      createdAt: isoAt(0),
    };
    await store.putCredential(cred);
    await store.putCredential({ ...cred, id: "cred-2", createdAt: isoAt(1) });

    const results = await Promise.all([
      store.deleteCredential("user-1", "cred-1"),
      store.deleteCredential("user-1", "cred-2"),
    ]);
    assertEquals(results.filter((r) => r === "deleted").length, 1, `results ${results}`);
    assertEquals(results.filter((r) => r === "last").length, 1, `results ${results}`);
    assertEquals((await store.listCredentials("user-1")).length, 1);
  });

  test("setAdminRole records who changed which role, and never leaves zero admins (audio-feed-8fc)", async (store) => {
    await store.putUser(makeUser({ id: "a1", email: "a1@example.com", isAdmin: true }));
    await store.putUser(makeUser({ id: "a2", email: "a2@example.com", isAdmin: true }));
    await store.putUser(makeUser({ id: "u1", email: "u1@example.com" }));
    const by = (adminId: string, index: number) => ({ adminId, at: isoAt(index) });

    assertEquals(await store.setAdminRole("u1", true, by("a1", 0)), "changed");
    assertEquals((await store.getUser("u1"))?.isAdmin, true);
    assertEquals(await store.setAdminRole("u1", true, by("a1", 1)), "unchanged");
    assertEquals(await store.setAdminRole("nope", true, by("a1", 1)), "missing");
    assertEquals(await store.setAdminRole("u1", false, by("admin-token", 2)), "changed");

    // The last two admins demote each other at once: exactly one may win.
    const results = await Promise.all([
      store.setAdminRole("a1", false, by("a2", 3)),
      store.setAdminRole("a2", false, by("a1", 3)),
    ]);
    assertEquals(results.toSorted(), ["changed", "last-admin"], `results ${results}`);
    const admins = (await store.listUsers()).filter((u) => u.isAdmin);
    assertEquals(admins.length, 1);

    const log = (await store.listApprovalLog()).filter((r) => r.action === "role");
    assertEquals(
      log.map((r) => [r.userId, r.adminId, r.fromRole, r.toRole, r.at]),
      [
        ["u1", "a1", "user", "admin", isoAt(0)],
        ["u1", "admin-token", "admin", "user", isoAt(2)],
        [admins[0]!.id === "a1" ? "a2" : "a1", admins[0]!.id, "admin", "user", isoAt(3)],
      ],
    );
  });

  test("a suspended admin does not count toward the last active admin (audio-feed-8fc)", async (store) => {
    await store.putUser(makeUser({ id: "a1", email: "a1@example.com", isAdmin: true }));
    await store.putUser(
      makeUser({ id: "a2", email: "a2@example.com", isAdmin: true, status: "suspended" }),
    );
    const by = { adminId: "admin-token", at: isoAt(0) };
    assertEquals(await store.setAdminRole("a1", false, by), "last-admin");
    assertEquals((await store.getUser("a1"))?.isAdmin, true);
    assertEquals(await store.setAdminRole("a2", false, by), "changed");
  });

  test("a setup link is readable, then consumable exactly once (audio-feed-8fc)", async (store) => {
    const link = {
      tokenHash: "c".repeat(64),
      userId: "user-1",
      createdAt: isoAt(0),
      expiresAt: FUTURE,
      issuedBy: "admin",
    };
    await store.putSetupLink(link);
    assertEquals(await store.getSetupLink(link.tokenHash), link);

    const [a, b] = await Promise.all([
      store.consumeSetupLink(link.tokenHash),
      store.consumeSetupLink(link.tokenHash),
    ]);
    assertEquals([a, b].filter(Boolean).length, 1, "exactly one concurrent consumer wins");
    assertEquals(a ?? b, link);
    assertEquals(await store.getSetupLink(link.tokenHash), null);
    assertEquals(await store.consumeSetupLink(link.tokenHash), null);
  });

  test("a WebAuthn challenge is consumable exactly once (audio-feed-8fc)", async (store) => {
    const challenge = {
      challenge: "chal-1",
      purpose: "register" as const,
      userId: "user-1",
      expiresAt: FUTURE,
    };
    await store.putChallenge(challenge);
    const [a, b] = await Promise.all([
      store.consumeChallenge("chal-1"),
      store.consumeChallenge("chal-1"),
    ]);
    assertEquals([a, b].filter(Boolean).length, 1, "exactly one concurrent consumer wins");
    assertEquals(a ?? b, challenge);
    assertEquals(await store.consumeChallenge("chal-1"), null);
    assertEquals(await store.consumeChallenge("never-issued"), null);
  });

  test("account records never appear as users (audio-feed-8fc)", async (store) => {
    // KV prefix scans: a session key under ["user", ...] would surface in listUsers.
    await store.putUser(makeUser());
    await store.putSession({
      idHash: "d".repeat(64),
      userId: "user-1",
      createdAt: isoAt(0),
      expiresAt: FUTURE,
    });
    await store.putCredential({
      id: "cred-1",
      userId: "user-1",
      publicKey: "pk",
      counter: 0,
      name: "x",
      createdAt: isoAt(0),
    });
    assertEquals((await store.listUsers()).map((u) => u.id), ["user-1"]);
  });
}
