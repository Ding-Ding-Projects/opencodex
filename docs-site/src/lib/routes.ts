/**
 * What counts as a page this site may open in a tab.
 *
 * A dashboard tab holds one of 23 route ids and can be validated against a set.
 * A docs tab holds a URL out of 156 prerendered routes across five locales, and
 * shipping that table to the browser to validate a string read back out of
 * localStorage would cost more than the check is worth. So the check is
 * structural instead: same origin, under this deployment's base, no scheme, no
 * protocol-relative escape.
 *
 * That is deliberately weaker than "is a real page". A stored path pointing at
 * a page that has since been renamed survives validation and 404s when opened —
 * the same thing a browser bookmark does, and the same thing the reader can see
 * and fix. What validation exists to prevent is the dangerous case: a value
 * that is not a path at all reaching `href` or `navigate()`, where
 * `javascript:` or `//evil.example` would be a navigation nobody asked for.
 *
 * The base is read from `import.meta.env.BASE_URL` on both sides. This site
 * publishes to a domain root AND to a project-site path prefix, and a route
 * model that hardcoded "/" would mint links missing the prefix on one host —
 * built, shipped, and 404ing while the build reported success.
 */

/** A pathname this site is allowed to navigate to. */
export type DocsRoute = string & { readonly __docsRoute?: unique symbol };

/**
 * `""` at a domain root, `"/opencodex"` under a project-site prefix.
 *
 * The `?? "/"` is for consumers outside Astro's pipeline — the test runner,
 * which has no `import.meta.env.BASE_URL` to inject. Inside a build Astro always
 * defines it, so the fallback can never quietly hide a misconfigured deploy.
 */
export const BASE_PATH: string = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");

/** The base as a prefix that always ends in a slash: `"/"` or `"/opencodex/"`. */
export const BASE: string = `${BASE_PATH}/`;

export const LOCALES = ["root", "ko", "zh-cn", "ru", "ja"] as const;
export type DocsLocale = (typeof LOCALES)[number];

/**
 * True for a same-origin path under this deployment's base.
 *
 * `startsWith(BASE)` is not enough on its own: `//evil.example` also starts with
 * `/` when the base is the root, and the browser reads that as a protocol-
 * relative URL to another host. Both guards are needed, and the order matters
 * only for readability.
 */
export function isDocsRoute(value: unknown): value is DocsRoute {
  if (typeof value !== "string" || !value) return false;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes(":")) return false;
  return value.startsWith(BASE);
}

/**
 * A pathname reduced to the form the tab strip stores.
 *
 * Query strings and fragments are dropped, and a trailing slash is enforced,
 * because otherwise `/guides/docker`, `/guides/docker/` and `/guides/docker/#x`
 * would be three different tabs for one page — and "focus the tab already
 * showing this page" would stop finding it. The site is built with
 * `trailingSlash: "ignore"`, so both spellings resolve; the strip picks one.
 */
export function normalizeRoute(pathname: string): DocsRoute {
  const path = pathname.split(/[?#]/)[0] || BASE;
  if (!isDocsRoute(path)) return BASE as DocsRoute;
  return (path.endsWith("/") ? path : `${path}/`) as DocsRoute;
}

/** The home page of a locale, e.g. `/ja/` or `/opencodex/ja/`. */
export function homeFor(locale?: string | null): DocsRoute {
  return (locale && locale !== "root" ? `${BASE}${locale}/` : BASE) as DocsRoute;
}

/**
 * Which locale a path belongs to.
 *
 * Used to open a new tab in the language the reader is already in rather than
 * dropping them into English — the root locale has no URL segment, so "no
 * segment matched" and "English" are the same answer here.
 */
export function localeOf(pathname: string): DocsLocale {
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.replace(/^\/+/, "");
  const first = rest.split("/")[0];
  return (LOCALES as readonly string[]).includes(first) && first !== "root" ? (first as DocsLocale) : "root";
}

/**
 * A readable fallback name for a route whose document title is not known yet.
 *
 * Only reached for a tab restored from a previous session that was stored
 * before its title arrived; every tab the reader actually visits gets the real
 * `<title>`. Showing the last path segment beats showing the whole URL, and
 * beats "Untitled" by a mile — the reader recognises `model-routing`.
 */
export function routeFallbackLabel(route: string): string {
  const rest = route.startsWith(BASE) ? route.slice(BASE.length) : route;
  const segments = rest.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return "opencodex";
  return last.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
