/**
 * The outbox for on-demand ingest notifications.
 *
 * Extracted from kv.ts (audio-feed-8r1e): the bodies are unchanged, only the receivers moved
 * (`this.#kv` -> `core.kv`, and cross-domain helpers through `core`).
 */

import type { OutboxNotification } from "../../types.ts";
import type { MetadataStore, NotificationRepository } from "../mod.ts";
import type { KvCore } from "./core.ts";

export function createNotificationsRepository(
  core: KvCore,
  _host: () => MetadataStore,
): NotificationRepository {
  return {
    // -- outbox notifications (audio-feed-np5) --------------------------------

    async queueNotification(notification: OutboxNotification): Promise<void> {
      const dedupeKey = ["outbox_dedupe", notification.episodeId, notification.status];
      const existing = await core.kv.get(dedupeKey);
      if (existing.value) return; // Deduplicate: already queued for this episode and status

      const tx = core.kv.atomic()
        .check(existing)
        .set(dedupeKey, notification.id, { expireIn: 14 * 86400 * 1000 })
        .set(["outbox", notification.id], notification, { expireIn: 14 * 86400 * 1000 })
        .set(["outbox_pending", notification.createdAt, notification.id], notification.id, {
          expireIn: 14 * 86400 * 1000,
        });
      const res = await tx.commit();
      if (!res.ok) {
        // If atomic commit failed due to race, re-check if dedupe key was set by another worker
        const raced = await core.kv.get(dedupeKey);
        if (raced.value) return;
        throw new Error(`queueNotification failed for ${notification.id}`);
      }
    },
    async listOutbox(limit = 50): Promise<OutboxNotification[]> {
      const notifications: OutboxNotification[] = [];
      for await (const entry of core.kv.list<string>({ prefix: ["outbox_pending"] }, { limit })) {
        const id = entry.value;
        const n = await core.kv.get<OutboxNotification>(["outbox", id]);
        if (n.value && !n.value.deliveredAt) notifications.push(n.value);
      }
      return notifications;
    },
    async ackNotification(id: string): Promise<boolean> {
      const entry = await core.kv.get<OutboxNotification>(["outbox", id]);
      if (!entry.value || entry.value.deliveredAt) return false;
      const n = structuredClone(entry.value);
      n.deliveredAt = new Date().toISOString();
      const tx = core.kv.atomic()
        .check(entry)
        .set(["outbox", id], n, { expireIn: 7 * 86400 * 1000 })
        .delete(["outbox_pending", n.createdAt, n.id]);
      const res = await tx.commit();
      return res.ok;
    },
  };
}
