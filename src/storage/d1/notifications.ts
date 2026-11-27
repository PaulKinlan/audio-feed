/**
 * Outbox notifications repository for Cloudflare D1.
 */

import type { OutboxNotification } from "../../types.ts";
import type { MetadataStore, NotificationRepository } from "../mod.ts";
import type { D1Core } from "./core.ts";

const FOURTEEN_DAYS_MS = 14 * 86400 * 1000;
const SEVEN_DAYS_MS = 7 * 86400 * 1000;

export function createD1NotificationsRepository(
  core: D1Core,
  _host: () => MetadataStore,
): NotificationRepository {
  return {
    async queueNotification(notification: OutboxNotification): Promise<void> {
      const now = Date.now();
      const expiresAt = now + FOURTEEN_DAYS_MS;
      // Clean expired row for same (episode_id, status) if any, then INSERT OR IGNORE.
      await core.db.batch([
        core.db.prepare(
          `DELETE FROM outbox_notifications
           WHERE episode_id = ? AND status = ? AND expires_at <= ?`,
        ).bind(notification.episodeId, notification.status, now),
        core.db.prepare(
          `INSERT OR IGNORE INTO outbox_notifications
           (id, episode_id, status, created_at, delivered_at, expires_at, data)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          notification.id,
          notification.episodeId,
          notification.status,
          notification.createdAt,
          notification.deliveredAt ?? null,
          expiresAt,
          JSON.stringify(notification),
        ),
      ]);
    },

    async listOutbox(limit = 50): Promise<OutboxNotification[]> {
      const now = Date.now();
      const res = await core.db.prepare(
        `SELECT data FROM outbox_notifications
         WHERE delivered_at IS NULL AND expires_at > ?
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      ).bind(now, limit).all<{ data: string }>();
      return res.results.map((r) => JSON.parse(r.data) as OutboxNotification);
    },

    async ackNotification(id: string): Promise<boolean> {
      const now = Date.now();
      const row = await core.db.prepare(
        `SELECT data FROM outbox_notifications
         WHERE id = ? AND delivered_at IS NULL AND expires_at > ?`,
      ).bind(id, now).first<{ data: string }>();
      if (!row) return false;
      const n = JSON.parse(row.data) as OutboxNotification;
      if (n.deliveredAt) return false;
      const deliveredAt = new Date().toISOString();
      const updated: OutboxNotification = { ...n, deliveredAt };
      const res = await core.db.prepare(
        `UPDATE outbox_notifications
         SET delivered_at = ?, expires_at = ?, data = ?
         WHERE id = ? AND delivered_at IS NULL`,
      ).bind(deliveredAt, now + SEVEN_DAYS_MS, JSON.stringify(updated), id).run();
      return (res.meta.changes ?? 0) === 1;
    },
  };
}
