/**
 * Accounts storage: sessions, passkey credentials, setup links and challenges.
 *
 * Extracted from kv.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#kv` -> `core.kv`, and cross-domain helpers through `core`).
 */

import type { AuthChallenge, PasskeyCredential, Session, SetupLink } from "../../types.ts";
import type { AuthRepository, MetadataStore } from "../mod.ts";
import type { KvCore } from "./core.ts";
import { expireInMs } from "./core.ts";

/**
 * Read and delete in one compare-and-swap: of two concurrent consumers the
 * second commit fails its check, so exactly one gets the value.
 */
async function consume<T>(core: KvCore, key: Deno.KvKey): Promise<T | null> {
  const entry = await core.kv.get<T>(key);
  if (entry.value === null) return null;
  const result = await core.kv.atomic().check(entry).delete(key).commit();
  return result.ok ? entry.value : null;
}
export function createAuthRepository(core: KvCore, host: () => MetadataStore): AuthRepository {
  return {
    // -- accounts (audio-feed-8fc) --------------------------------------------

    async putSession(session: Session): Promise<void> {
      await core.kv.set(["session", session.idHash], session, {
        expireIn: expireInMs(session.expiresAt),
      });
    },
    async getSession(idHash: string): Promise<Session | null> {
      return (await core.kv.get<Session>(["session", idHash])).value;
    },
    async deleteSession(idHash: string): Promise<void> {
      await core.kv.delete(["session", idHash]);
    },
    async putCredential(credential: PasskeyCredential): Promise<void> {
      const result = await core.kv.atomic()
        .set(["passkey", credential.id], credential)
        .set(
          ["passkey_by_user", credential.userId, credential.createdAt, credential.id],
          credential.id,
        )
        .commit();
      if (!result.ok) throw new Error(`putCredential failed for ${credential.id}`);
    },
    async getCredential(id: string): Promise<PasskeyCredential | null> {
      return (await core.kv.get<PasskeyCredential>(["passkey", id])).value;
    },
    async listCredentials(userId: string): Promise<PasskeyCredential[]> {
      const out: PasskeyCredential[] = [];
      for await (const entry of core.kv.list<string>({ prefix: ["passkey_by_user", userId] })) {
        const credential = await host().getCredential(entry.value);
        if (credential && credential.userId === userId) out.push(credential);
      }
      return out;
    },
    /**
     * The count and the delete are one commit: every index row the count read is
     * `check`ed, so a concurrent delete of a sibling fails this commit and the
     * retry sees the smaller count.
     */
    async deleteCredential(userId: string, id: string): Promise<"deleted" | "last" | "missing"> {
      while (true) {
        const entry = await core.kv.get<PasskeyCredential>(["passkey", id]);
        if (!entry.value || entry.value.userId !== userId) return "missing";
        const index: Deno.KvEntry<string>[] = [];
        for await (const row of core.kv.list<string>({ prefix: ["passkey_by_user", userId] })) {
          index.push(row);
        }
        if (new Set(index.map((row) => row.value)).size <= 1) return "last";
        const tx = core.kv.atomic().check(entry);
        for (const row of index) tx.check(row);
        const result = await tx
          .delete(["passkey", id])
          .delete(["passkey_by_user", userId, entry.value.createdAt, id])
          .commit();
        if (result.ok) return "deleted";
      }
    },
    async putSetupLink(link: SetupLink): Promise<void> {
      await core.kv.set(["setup_link", link.tokenHash], link, {
        expireIn: expireInMs(link.expiresAt),
      });
    },
    async getSetupLink(tokenHash: string): Promise<SetupLink | null> {
      return (await core.kv.get<SetupLink>(["setup_link", tokenHash])).value;
    },
    consumeSetupLink(tokenHash: string): Promise<SetupLink | null> {
      return consume<SetupLink>(core, ["setup_link", tokenHash]);
    },
    async putChallenge(challenge: AuthChallenge): Promise<void> {
      await core.kv.set(["auth_challenge", challenge.challenge], challenge, {
        expireIn: expireInMs(challenge.expiresAt),
      });
    },
    consumeChallenge(challenge: string): Promise<AuthChallenge | null> {
      return consume<AuthChallenge>(core, ["auth_challenge", challenge]);
    },
  };
}
