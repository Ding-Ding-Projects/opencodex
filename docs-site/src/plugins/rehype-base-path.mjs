/**
 * Prefix the deployment base onto root-absolute links written in content.
 *
 * This site publishes to two hosts: the canonical domain `opencodex.me` at the
 * root, and the project-site fallback `ding-ding-projects.github.io/opencodex/`
 * under a path prefix. Astro rewrites `base` into the links and assets *it*
 * generates — sidebar entries, the header nav, image imports — but a link
 * written by hand inside a Markdown body is opaque to it. `[Adapters](/reference/adapters/)`
 * ships as `href="/reference/adapters/"` on both hosts, which is correct on one
 * and a 404 on the other.
 *
 * That was 205 dead links across 94 of the 156 pages, in every locale, while
 * both builds reported success — a missing page is not a build error, so
 * nothing anywhere caught it.
 *
 * Doing it here rather than editing the 189 Markdown links is the whole point:
 * the next contributor writes `](/guides/thing/)` because that is what every
 * existing link looks like, and the pipeline makes it correct instead of making
 * them remember. It also keeps the content host-agnostic, which is what lets one
 * source tree publish to both.
 *
 * Deliberately NOT rewritten:
 *  - `//host/path` — protocol-relative, so it points at another origin despite
 *    starting with a slash. Prefixing it would mangle an external link.
 *  - Anything with a scheme (`https:`, `mailto:`, `tel:`) or a bare fragment.
 *  - Relative paths, which already resolve against the current document.
 *  - A path already under the base, so the transform is idempotent — it runs
 *    once per build, but an already-correct link must survive it unchanged.
 *
 * `srcset` is not handled. Nothing in this content uses it, and parsing its
 * comma-and-descriptor grammar correctly is more risk than an unused code path
 * is worth; the build assertion in `scripts/check-base-path.mjs` fails the build
 * if one ever appears unprefixed rather than letting it ship silently.
 */

/** Attributes whose value is a single URL. */
const URL_ATTRS = ["href", "src"];

/**
 * @param {{ base?: string }} options `base` normalised to "" or "/prefix".
 */
export function rehypeBasePath(options = {}) {
  const base = (options.base || "").replace(/\/+$/, "");

  // A root deployment needs no rewriting at all; returning a no-op keeps the
  // canonical build from walking every tree for nothing.
  if (!base) return () => {};

  /** @param {string} value */
  const needsPrefix = (value) =>
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !(value === base || value.startsWith(`${base}/`));

  /** @param {any} node */
  const walk = (node) => {
    if (node.type === "element" && node.properties) {
      for (const attr of URL_ATTRS) {
        const value = node.properties[attr];
        if (needsPrefix(value)) node.properties[attr] = `${base}${value}`;
      }
    }
    if (Array.isArray(node.children)) for (const child of node.children) walk(child);
  };

  return (tree) => walk(tree);
}

export default rehypeBasePath;
