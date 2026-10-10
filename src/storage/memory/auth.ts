/**
 * Accounts storage: sessions, passkey credentials, setup links and challenges.
 *
 * Extracted from memory.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#<field>` -> `state.<field>`).
 */

import type { AuthChallenge, PasskeyCredential, Session, SetupLink } from "../../types.ts";
import { type MetadataStore } from "../mod.ts";
import type { AuthRepository } from "../mod.ts";
import type { MemoryState } from "./state.ts";
import { byCreatedThenId } from "./state.ts";

export function createAuthRepository(
  state: MemoryState,
  _host: () => MetadataStore,
): AuthRepository {
  return {
    // -- accounts (audio-feed-8fc) --------------------------------------------

    putSession(session: Session): Promise<void> {
      state.sessions.set(session.idHash, structuredClone(session));
      return Promise.resolve();
    },
    getSession(idHash: string): Promise<Session | null> {
      const found = state.sessions.get(idHash);
      return Promise.resolve(found ? structuredClone(found) : null);
    },
    deleteSession(idHash: string): Promise<void> {
      state.sessions.delete(idHash);
      return Promise.resolve();
    },
    putCredential(credential: PasskeyCredential): Promise<void> {
      state.credentials.set(credential.id, structuredClone(credential));
      return Promise.resolve();
    },
    getCredential(id: string): Promise<PasskeyCredential | null> {
      const found = state.credentials.get(id);
      return Promise.resolve(found ? structuredClone(found) : null);
    },
    listCredentials(userId: string): Promise<PasskeyCredential[]> {
      return Promise.resolve(
        [...state.credentials.values()]
          .filter((c) => c.userId === userId)
          .sort(byCreatedThenId)
          .map((c) => structuredClone(c)),
      );
    },
    // Single-threaded: the count and the delete cannot interleave with another call.
    deleteCredential(userId: string, id: string): Promise<"deleted" | "last" | "missing"> {
      const found = state.credentials.get(id);
      if (!found || found.userId !== userId) return Promise.resolve("missing");
      const owned = [...state.credentials.values()].filter((c) => c.userId === userId).length;
      if (owned <= 1) return Promise.resolve("last");
      state.credentials.delete(id);
      return Promise.resolve("deleted");
    },
    putSetupLink(link: SetupLink): Promise<void> {
      state.setupLinks.set(link.tokenHash, structuredClone(link));
      return Promise.resolve();
    },
    getSetupLink(tokenHash: string): Promise<SetupLink | null> {
      const found = state.setupLinks.get(tokenHash);
      return Promise.resolve(found ? structuredClone(found) : null);
    },
    consumeSetupLink(tokenHash: string): Promise<SetupLink | null> {
      // Single-threaded: read and delete cannot interleave with another consumer.
      const found = state.setupLinks.get(tokenHash);
      state.setupLinks.delete(tokenHash);
      return Promise.resolve(found ?? null);
    },
    putChallenge(challenge: AuthChallenge): Promise<void> {
      state.challenges.set(challenge.challenge, structuredClone(challenge));
      return Promise.resolve();
    },
    consumeChallenge(challenge: string): Promise<AuthChallenge | null> {
      const found = state.challenges.get(challenge);
      state.challenges.delete(challenge);
      return Promise.resolve(found ?? null);
    },
  };
}
