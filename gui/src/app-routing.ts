/** Pure hash → page resolution used by App route state. */

import { normalizeHashPath } from "./hash-routing";

export type Page =
  | "dashboard"
  | "startup"
  | "providers"
  | "models"
  | "combos"
  | "subagents"
  | "logs"
  | "usage"
  | "storage"
  | "codex-auth"
  | "api"
  | "claude"
  | "grok"
  // System pages introduced by the Material 3 shell.
  | "appearance"
  | "language"
  | "regex"
  | "changelog"
  | "history"
  | "notifications"
  | "network"
  | "settings"
  | "terminal"
  | "mobile"
  | "docs";

export const VALID_PAGES = new Set<Page>([
  "dashboard",
  "startup",
  "providers",
  "models",
  "combos",
  "subagents",
  "logs",
  "usage",
  "storage",
  "codex-auth",
  "api",
  "claude",
  "grok",
  "appearance",
  "language",
  "regex",
  "changelog",
  "history",
  "notifications",
  "network",
  "settings",
  "terminal",
  "mobile",
  "docs",
]);

/** Product pages sit above the system pages in the nav, separated by a divider. */
export const PAGE_GROUP: Record<Page, "product" | "system"> = {
  dashboard: "product",
  "codex-auth": "product",
  providers: "product",
  models: "product",
  combos: "product",
  subagents: "product",
  logs: "product",
  usage: "product",
  storage: "product",
  api: "product",
  claude: "product",
  grok: "product",
  startup: "product",
  appearance: "system",
  language: "system",
  regex: "system",
  changelog: "system",
  history: "system",
  notifications: "system",
  network: "system",
  settings: "system",
  terminal: "system",
  mobile: "system",
  docs: "system",
};

/**
 * The route part of a hash, with any `?query` suffix removed.
 *
 * A hash can legitimately carry parameters — `#/mobile?pair=<token>` is how a
 * paired phone receives its credential from a QR code — and those belong to the
 * page, not to the router. Without this the whole string was matched against
 * the page table, so scanning a pairing QR resolved to `dashboard`: the one
 * screen the code existed to open was the one screen it could not reach.
 */
export function hashRoutePath(rawHash: string): string {
  return rawHash.split("?")[0];
}

/** The `?`-delimited parameters carried on a hash route, if any. */
export function hashRouteParams(rawHash: string): URLSearchParams {
  const query = rawHash.split("?").slice(1).join("?");
  return new URLSearchParams(query);
}

export function readPageFromHash(hash?: string): Page {
  const raw = hashRoutePath(normalizeHashPath(
    hash ?? (typeof window !== "undefined" ? window.location.hash : ""),
  ));
  // Sub-views use a "/" suffix (e.g. #logs/debug); the first segment is the page id.
  const pageId = raw.split("/")[0] as Page;
  // Legacy: Debug used to be a standalone page; it now lives as a tab on Logs.
  if (pageId === ("debug" as Page)) return "logs";
  return VALID_PAGES.has(pageId) ? pageId : "dashboard";
}

/**
 * Dashboard section tabs live in the hash so refresh/bookmark/back-forward keep the
 * choice, mirroring Logs (`#logs` / `#logs/debug`). Overview is the bare `#dashboard`,
 * so it has no suffix entry here.
 */
export const DASHBOARD_TAB_HASHES = ["dashboard/providers", "dashboard/models"] as const;

/**
 * Whether a hash already addresses `page`, so the router leaves it alone.
 *
 * Compared on the route part only. A hash that belongs to its page but carries
 * parameters — `mobile?pair=<token>` — must NOT be normalized away: the
 * rewrite would strip the pairing token out of the URL before the page it was
 * addressed to ever mounted and read it. Removing that parameter is the Mobile
 * screen's job, done once the token has actually been spent.
 */
export function hashBelongsToPage(rawHash: string, page: Page): boolean {
  const path = hashRoutePath(rawHash);
  return path === page
    || (page === "logs" && path === "logs/debug")
    || (page === "dashboard" && (DASHBOARD_TAB_HASHES as readonly string[]).includes(path));
}


/** Result of resolving an incoming hash. */
export type AppHashChangeAction = {
  page: Page;
  /** When non-null, passively replace the hash (no new history entry). */
  replaceTo: string | null;
};

/**
 * Resolve what App should do for the current location hash.
 * Any rewrite this returns is passive: callers apply it with replaceState, never a
 * push, so Back is never trapped on a hash the router immediately corrects.
 */
export function resolveAppHashChange(rawHash: string): AppHashChangeAction {
  const nextPage = readPageFromHash(rawHash);

  // Legacy: Debug used to be a standalone page.
  if (rawHash === "debug" || rawHash.startsWith("debug/")) {
    return { page: "logs", replaceTo: "logs/debug" };
  }

  // Legacy deep link from the removed dual-layout era.
  if (rawHash === "providers/workspace") {
    return { page: "providers", replaceTo: "providers" };
  }

  // An unrecognised sub-hash is normalised away rather than left in the URL.
  if (!hashBelongsToPage(rawHash, nextPage)) {
    return { page: nextPage, replaceTo: nextPage };
  }

  return { page: nextPage, replaceTo: null };
}

/**
 * The hash route for a page, as another device would type it.
 *
 * Lives here beside the route table rather than in the component that renders
 * it: a route is navigation data, not user-facing copy, and the surrounding
 * pages should not be spelling their own URLs.
 */
export function hashRouteFor(page: Page): string {
  return `#/${page}`;
}

/** Join an already validated remote origin to one application page route. */
export function pageUrlForOrigin(origin: string, page: Page): string {
  return `${origin.replace(/\/$/, "")}/${hashRouteFor(page)}`;
}
