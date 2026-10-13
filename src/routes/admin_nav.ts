/**
 * Shared admin sub-navigation bar across /admin/* sub-pages (audio-feed-1tj2).
 */

import { esc } from "./html.ts";

export type AdminTab = "operations" | "subscribers" | "observability" | "issues" | "telemetry";

export interface NavItem {
  id: AdminTab;
  label: string;
  href: string;
}

export const ADMIN_NAV_ITEMS: readonly NavItem[] = [
  { id: "operations", label: "Operations", href: "/admin" },
  { id: "subscribers", label: "Subscribers", href: "/admin/subscribers" },
  { id: "observability", label: "Queue & Claims", href: "/admin/observability" },
  { id: "issues", label: "Issues & Dead Letters", href: "/admin/observability/issues" },
  { id: "telemetry", label: "Telemetry & Outbox", href: "/admin/observability/telemetry" },
] as const;

export const ADMIN_NAV_CSS = `
  .admin-subnav {
    margin-block: var(--space-4) var(--space-6);
    border-block-end: 1px solid var(--border);
    padding-block-end: var(--space-3);
  }
  .admin-subnav-list {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .admin-subnav-link {
    display: inline-flex;
    align-items: center;
    padding: 0.45rem 0.9rem;
    border-radius: var(--radius-sm, 6px);
    text-decoration: none;
    color: var(--text-muted);
    font-weight: 500;
    font-size: 0.95rem;
    transition: background 0.15s, color 0.15s;
  }
  .admin-subnav-link:hover {
    background: var(--surface);
    color: var(--text);
  }
  .admin-subnav-link.is-active {
    background: var(--accent);
    color: var(--accent-ink, #000);
    font-weight: 600;
  }
`;

export function renderAdminNav(activeTab: AdminTab): string {
  return `<nav class="admin-subnav" aria-label="Admin sub-navigation">
  <ul class="admin-subnav-list">
    ${
    ADMIN_NAV_ITEMS.map((item) => `
    <li>
      <a href="${item.href}" class="admin-subnav-link${
      item.id === activeTab ? " is-active" : ""
    }" ${item.id === activeTab ? 'aria-current="page"' : ""}>
        ${esc(item.label)}
      </a>
    </li>`).join("")
  }
  </ul>
</nav>`;
}
