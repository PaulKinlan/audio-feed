/**
 * The outbox for on-demand ingest notifications.
 *
 * Extracted from memory.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#<field>` -> `state.<field>`).
 */

import type { OutboxNotification } from "../../types.ts";
import { type MetadataStore } from "../mod.ts";
import type { NotificationRepository } from "../mod.ts";
import type { MemoryState } from "./state.ts";

export function createNotificationsRepository(
  state: MemoryState,
  _host: () => MetadataStore,
): NotificationRepository {
  return {
    // -- outbox notifications (audio-feed-np5) --------------------------------

    queueNotification(notification: OutboxNotification): Promise<void> {
      // Deduplicate: skip if an entry for the same episodeId and status already exists
      const duplicate = state.outbox.some(
        (n) => n.episodeId === notification.episodeId && n.status === notification.status,
      );
      if (duplicate) return Promise.resolve();

      state.outbox.push(structuredClone(notification));
      // Keep outbox bounded in memory to 500 items, pruning delivered items first
      if (state.outbox.length > 500) {
        const deliveredIdx = state.outbox.findIndex((n) => n.deliveredAt);
        if (deliveredIdx >= 0) {
          state.outbox.splice(deliveredIdx, 1);
        } else {
          state.outbox.shift();
        }
      }
      return Promise.resolve();
    },
    listOutbox(limit = 50): Promise<OutboxNotification[]> {
      return Promise.resolve(
        state.outbox
          .filter((n) => !n.deliveredAt)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(0, limit)
          .map((n) => structuredClone(n)),
      );
    },
    ackNotification(id: string): Promise<boolean> {
      const found = state.outbox.find((n) => n.id === id);
      if (!found || found.deliveredAt) return Promise.resolve(false);
      found.deliveredAt = new Date().toISOString();
      return Promise.resolve(true);
    },
  };
}
