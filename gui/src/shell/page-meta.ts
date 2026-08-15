/** Nav order, icon and label key for every page. Mirrors `PAGES` in the design prototype. */

import {
  IconActivity, IconApi, IconBell, IconBolt, IconBot, IconBoxes, IconChangelog, IconClock,
  IconDevices, IconGrid, IconHardDrive, IconHistory, IconKey, IconLock, IconMenuBook, IconPalette,
  IconPictureAsPdf, IconReceiptLong, IconRegex, IconRestartAlt, IconServer, IconShuffle, IconSliders,
  IconSparkle, IconSyncAlt, IconTerminal, IconTranslate,
} from "../icons";
import { PAGE_GROUP, type Page } from "../app-routing";
import type { TKey } from "../i18n/shared";

export interface PageMeta {
  id: Page;
  tkey: TKey;
  Icon: typeof IconGrid;
  group: "product" | "system";
}

const ICONS: Record<Page, typeof IconGrid> = {
  dashboard: IconGrid,
  "codex-auth": IconKey,
  providers: IconServer,
  models: IconBoxes,
  combos: IconShuffle,
  subagents: IconBot,
  logs: IconReceiptLong,
  usage: IconActivity,
  storage: IconHardDrive,
  api: IconApi,
  claude: IconSparkle,
  grok: IconBolt,
  startup: IconRestartAlt,
  appearance: IconPalette,
  language: IconTranslate,
  schedule: IconClock,
  regex: IconRegex,
  changelog: IconChangelog,
  history: IconHistory,
  notifications: IconBell,
  network: IconDevices,
  terminal: IconTerminal,
  mobile: IconDevices,
  settings: IconSliders,
  docs: IconMenuBook,
  locks: IconLock,
  authenticator: IconLock,
  pdf: IconPictureAsPdf,
  converter: IconSyncAlt,
};

const TKEYS: Record<Page, TKey> = {
  dashboard: "nav.dashboard",
  "codex-auth": "nav.codexAuth",
  providers: "nav.providers",
  models: "nav.models",
  combos: "nav.combos",
  subagents: "nav.subagents",
  logs: "nav.logs",
  usage: "nav.usage",
  storage: "nav.storage",
  api: "nav.api",
  claude: "nav.claude",
  grok: "nav.grok",
  startup: "nav.startup",
  appearance: "nav.appearance",
  language: "nav.language",
  schedule: "nav.schedule",
  regex: "nav.regex",
  changelog: "nav.changelog",
  history: "nav.history",
  notifications: "nav.notifications",
  network: "nav.network",
  terminal: "nav.terminal",
  mobile: "nav.mobile",
  settings: "nav.settings",
  docs: "nav.docs",
  locks: "nav.locks",
  authenticator: "nav.authenticator",
  pdf: "nav.pdf",
  converter: "nav.converter",
};

/** Nav order is deliberate: dashboard first, then auth, then the rest of the product. */
const ORDER: Page[] = [
  "dashboard", "codex-auth", "providers", "models", "combos", "subagents",
  "logs", "usage", "storage", "api", "claude", "grok", "startup",
  "appearance", "language", "schedule", "regex", "changelog", "docs", "history", "notifications",
  "network", "locks", "authenticator", "pdf", "converter", "settings", "terminal", "mobile",
];

export const PAGE_META: PageMeta[] = ORDER.map(id => ({
  id,
  tkey: TKEYS[id],
  Icon: ICONS[id],
  group: PAGE_GROUP[id],
}));

export const PAGE_META_BY_ID: Record<Page, PageMeta> = Object.fromEntries(
  PAGE_META.map(m => [m.id, m]),
) as Record<Page, PageMeta>;

/** The four pages the compact bottom bar shows; everything else lives in the drawer.
 *  Mirrors the prototype's `navItems.slice(0, 4)` — the first four entries of `ORDER`. */
export const BOTTOM_NAV_PAGES: Page[] = ["dashboard", "codex-auth", "providers", "models"];
