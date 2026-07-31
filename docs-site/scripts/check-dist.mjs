/**
 * Post-build assertions over `dist/`, for the two failures this site keeps
 * shipping because neither one is a build error.
 *
 * Both classes below have already reached production at least once, and in both
 * cases every build reported success while the site was broken:
 *
 *  1. **A root-absolute path with no base prefix.** The site publishes to a
 *     domain root AND to a project-site path prefix. A link written `/guides/x/`
 *     is correct on the first host and a 404 on the second. At the time this
 *     check was written there were 205 of them across 94 of the 156 pages, plus
 *     four redirect stubs whose refresh target pointed outside the base.
 *
 *  2. **A page with no tab strip.** The strip is a `transition:persist` island,
 *     and Astro's swap only preserves it if the *incoming* document contains it
 *     too. Land on a page that lacks it and the reader's tabs are destroyed —
 *     silently, with no error anywhere. It survives today only because the one
 *     component that renders it is on every route; one layout change breaks that
 *     and nothing would catch it.
 *
 * Run for both deployments. Under a root deploy check 1 is vacuous (every path
 * is already "under" the base) and check 2 is the whole value.
 *
 * The base is INFERRED from `dist/` rather than passed in, because a checker
 * that has to be told what it is checking can be told wrong. Run by hand against
 * a project-site dist without setting `DOCS_BASE` and the earlier version of
 * this script skipped check 1 entirely, then printed "160 page(s) OK" — a false
 * pass, which is worse than no check at all. Astro stamps the base into every
 * `_astro/` asset URL it emits, so the built output already knows the answer.
 *
 * `DOCS_BASE`/argv still override, for checking a dist that emitted no assets.
 * When an override disagrees with what the output actually contains, that is
 * itself reported — the two disagreeing means one of them is describing a
 * deployment that was not built.
 *
 * Usage: node scripts/check-dist.mjs [base]
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Normalised exactly as `astro.config.mjs` normalises it: "" or "/prefix". */
const normalizeBase = (value) =>
  value && value.trim() ? `/${value.trim().replace(/^\/|\/$/g, "")}` : "";

/**
 * The base Astro actually emitted, read back out of an asset URL.
 *
 * Every built page references hashed assets under `<base>/_astro/`, so the
 * prefix in front of `/_astro/` IS the base — "" on a root deploy. Reading it
 * from the output is what makes this check impossible to run in the wrong mode.
 */
function inferBase(html) {
  const match = html.match(/(?:href|src)="([^"]*?)\/_astro\//);
  return match ? match[1] : null;
}

/**
 * Pages exempt from the island check, and why.
 *
 * These four are the `redirects` stubs from `astro.config.mjs`: bare
 * meta-refresh documents with no layout, so there is no component that could
 * carry the island. They are listed by name rather than pattern-matched so that
 * a *new* island-less page fails the build instead of quietly joining an
 * allowlist that was only ever meant to hold four known files.
 */
const ISLAND_EXEMPT = new Set([
  "getting-started/index.html",
  "guides/index.html",
  "reference/index.html",
  "troubleshooting/index.html",
]);

const ISLAND_MARKER = "ocx-tabstrip";

/** Every .html file under dist, as paths relative to dist with forward slashes. */
async function htmlFiles(dir = DIST, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await htmlFiles(full, acc);
    else if (entry.name.endsWith(".html")) acc.push(full);
  }
  return acc;
}

/**
 * Root-absolute URL attribute values that do not start with the base.
 *
 * `//` is excluded because a protocol-relative URL points at another origin
 * despite its leading slash — prefixing it would be the bug, not the fix.
 */
const ABSOLUTE_URL = /(?:href|src|content)="(\/(?!\/)[^"]*)"/g;

/** Meta-refresh targets, whose URL sits inside a `content` attribute. */
const REFRESH_TARGET = /content="\d+\s*;\s*url=(\/(?!\/)[^"]*)"/gi;

function offendingPaths(html, base) {
  const bad = new Set();
  const outside = (url) => !(url === base || url.startsWith(`${base}/`));
  for (const [, url] of html.matchAll(ABSOLUTE_URL)) if (outside(url)) bad.add(url);
  for (const [, url] of html.matchAll(REFRESH_TARGET)) if (outside(url)) bad.add(url);
  return [...bad];
}

const files = await htmlFiles();
if (files.length === 0) {
  console.error("check-dist: no HTML found in dist/ — did the build run?");
  process.exit(1);
}

/* Resolve the base from the output, with the override reconciled against it. */
const override = process.argv[2] ?? process.env.DOCS_BASE ?? null;
let BASE = null;
for (const file of files) {
  const found = inferBase(await readFile(file, "utf8"));
  if (found !== null) { BASE = found; break; }
}

if (BASE === null) {
  if (override === null) {
    console.error("check-dist: could not find an /_astro/ asset URL to read the base from,");
    console.error("and no DOCS_BASE was given. Refusing to report a pass it cannot justify.");
    process.exit(1);
  }
  BASE = normalizeBase(override);
  console.warn(`check-dist: no asset URL found; trusting DOCS_BASE="${BASE || "(root)"}".`);
} else if (override !== null && normalizeBase(override) !== BASE) {
  console.error(
    `check-dist: DOCS_BASE says "${normalizeBase(override) || "(root)"}" but dist/ was built ` +
      `with "${BASE || "(root)"}". One of them describes a deployment that was not built.`,
  );
  process.exit(1);
}

const baseFailures = [];
const islandFailures = [];

for (const file of files) {
  const rel = relative(DIST, file).split(sep).join("/");
  const html = await readFile(file, "utf8");

  // Run unconditionally rather than under `if (BASE)`. With an empty base every
  // root-absolute path is trivially "under" it, so this is a no-op on the
  // canonical build by construction — which is a better guarantee than a
  // conditional a later edit could widen by accident.
  const bad = offendingPaths(html, BASE);
  if (bad.length) baseFailures.push({ rel, bad });

  if (!ISLAND_EXEMPT.has(rel) && !html.includes(ISLAND_MARKER)) islandFailures.push(rel);
}

let failed = false;

if (baseFailures.length) {
  failed = true;
  const total = baseFailures.reduce((n, f) => n + f.bad.length, 0);
  console.error(
    `\ncheck-dist: ${total} absolute path(s) missing the "${BASE}" prefix, in ${baseFailures.length} file(s).`,
  );
  console.error("These resolve on the canonical domain and 404 on the project site.\n");
  for (const { rel, bad } of baseFailures.slice(0, 15)) {
    console.error(`  ${rel}`);
    for (const url of bad.slice(0, 6)) console.error(`      ${url}`);
    if (bad.length > 6) console.error(`      … and ${bad.length - 6} more`);
  }
  if (baseFailures.length > 15) console.error(`  … and ${baseFailures.length - 15} more file(s)`);
}

if (islandFailures.length) {
  failed = true;
  console.error(
    `\ncheck-dist: ${islandFailures.length} page(s) do not contain the "${ISLAND_MARKER}" island.`,
  );
  console.error("Navigating to one of these destroys the reader's persisted tabs.\n");
  for (const rel of islandFailures.slice(0, 15)) console.error(`  ${rel}`);
  if (islandFailures.length > 15) console.error(`  … and ${islandFailures.length - 15} more`);
}

if (failed) process.exit(1);

console.log(
  `check-dist: ${files.length} page(s) OK` +
    (BASE ? ` — every absolute path under "${BASE}"` : "") +
    `, ${files.length - ISLAND_EXEMPT.size} carrying the tab strip.`,
);
