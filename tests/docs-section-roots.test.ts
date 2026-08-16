/**
 * Every documentation section root has to resolve.
 *
 * Starlight emits one page per content file and none for the folder, so a
 * section that is a directory of pages has no page of its own. Four of the five
 * sections were in that state: `/guides/`, `/reference/`, `/getting-started/`
 * and `/troubleshooting/` all 404ed while every child page under them worked.
 *
 * That is the worst shape for this failure. The sidebar was correct, every deep
 * link was correct, and the build reported success on every deploy — but the
 * URL a reader guesses, the one a section heading points at, and the one the
 * README's *first* documentation link used were all dead. Nothing in the
 * pipeline noticed, because a missing page is not a build error.
 *
 * These assertions are static rather than HTTP: a live check only fails after a
 * bad deploy has already shipped, and it cannot run in an offline test suite.
 * Checking the config against the content tree catches it before the push.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DOCS = join("docs-site", "src", "content", "docs");
const CONFIG = join("docs-site", "astro.config.mjs");

/** Locale subtrees mirror the English one and are routed by Starlight's i18n. */
const LOCALES = new Set(["ja", "ko", "ru", "zh-cn"]);

function sectionDirectories(): string[] {
  return readdirSync(DOCS, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !LOCALES.has(entry.name))
    .map(entry => entry.name);
}

function hasIndexPage(section: string): boolean {
  return ["index.md", "index.mdx"].some(name => existsSync(join(DOCS, section, name)));
}

const config = await Bun.file(CONFIG).text();

describe("section roots", () => {
  test("every section either has an index page or a redirect", async () => {
    // One or the other, never neither. Which of the two is a content decision;
    // having some answer is not.
    const unreachable = sectionDirectories().filter(section => {
      if (hasIndexPage(section)) return false;
      return !config.includes(`"/${section}"`);
    });
    expect(unreachable).toEqual([]);
  });

  test("every redirect target is a page that actually exists", async () => {
    // A redirect to a missing file turns one 404 into a slower 404.
    //
    // Targets are template literals carrying the deployment base, not plain
    // strings. They started as plain strings and that was wrong: a bare
    // `/getting-started/installation` is correct on the canonical domain and a
    // 404 on the project site, so the redirect that existed to fix a dead
    // section root was itself dead on one of the two hosts.
    const targets = [...config.matchAll(/"\/([a-z-]+)":\s*[`"]\$?\{?BASE_PATH\}?\/([a-z0-9/-]+)[`"]/g)]
      .map(m => m[2]);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const exists = [".md", ".mdx"].some(ext => existsSync(join(DOCS, `${target}${ext}`)));
      expect(`${target} exists: ${exists}`).toBe(`${target} exists: true`);
    }
  });

  test("a redirect target is that section's first sidebar entry", async () => {
    // Landing in the middle of a section is disorienting in a way that landing
    // at its start is not, and the sidebar already encodes where a section
    // starts. This pins the two together so they cannot drift apart.
    for (const [, section, target] of config.matchAll(/"\/([a-z-]+)":\s*[`"]\$?\{?BASE_PATH\}?\/([a-z0-9/-]+)[`"]/g)) {
      const group = config.split(new RegExp(`label: "[^"]*",\\s*(?:translations:[^}]*},\\s*)?\\n\\s*(?:collapsed[^\\n]*\\n\\s*)?items: \\[`))
        .find(chunk => chunk.includes(`slug: "${section}/`));
      if (!group) continue;
      const firstSlug = group.match(/slug: "([a-z0-9/-]+)"/)?.[1];
      expect(`${section} -> ${target}`).toBe(`${section} -> ${firstSlug}`);
    }
  });
});

describe("the README's documentation links", () => {
  test("every docs link points at a section root with an answer, or a real page", async () => {
    // The README's first documentation link was `/getting-started/`, which
    // 404ed. A broken link at the top of the readme is the first thing a new
    // reader meets.
    const readme = await Bun.file("README.md").text();
    // Both hosts. This matched ONLY `<sub>.github.io/opencodex/...` until now --
    // a host the README has never used, since every docs link goes to the
    // canonical custom domain. `paths` was therefore always `[]`, the loop below
    // never ran, and the single `expect()` inside it never executed: a guard
    // written for a real 404 that could not have caught that 404 again.
    const paths = [
      ...readme.matchAll(/https:\/\/opencodex\.me\/([a-z0-9/-]*)/g),
      ...readme.matchAll(/https:\/\/[a-z.-]*github\.io\/opencodex\/([a-z0-9/-]*)/g),
    ]
      .map(m => m[1].replace(/\/$/, ""))
      .filter(Boolean);

    // Without this the assertion above can go quiet again the moment the host
    // changes or the regex drifts, and a vacuous pass is indistinguishable from
    // a real one.
    expect(`README docs links found: ${paths.length > 0}`).toBe("README docs links found: true");

    for (const path of paths) {
      const isPage = [".md", ".mdx"].some(ext => existsSync(join(DOCS, `${path}${ext}`)));
      const isCoveredSection = hasIndexPage(path) || config.includes(`"/${path}"`);
      expect(`${path} resolves: ${isPage || isCoveredSection}`).toBe(`${path} resolves: true`);
    }
  });

  test("every GitHub link points at the repository this actually ships from", async () => {
    // The README carried six `github.com/<upstream-owner>/opencodex` links while
    // `origin` is a different repository: a clone command for the wrong codebase,
    // a security-advisory link routing vulnerability reports to strangers, a
    // LICENSE badge, and two commit links whose SHAs were created HERE and
    // return HTTP 422 there (verified against both repos with `gh api`).
    //
    // One reference is legitimately upstream and must survive this: issue #92,
    // whose title resolves in the upstream repo and 404s in this one. So the
    // rule is not "no upstream links" -- it is that only ISSUE links may be.
    const readme = await Bun.file("README.md").text();
    const origin = Bun.spawnSync(["git", "remote", "get-url", "origin"]).stdout.toString().trim();
    const owner = /github\.com[/:]([^/]+)\//.exec(origin)?.[1];
    expect(`origin owner parsed: ${Boolean(owner)}`).toBe("origin owner parsed: true");

    const foreign = [...readme.matchAll(/https:\/\/github\.com\/([^/\s)]+)\/opencodex\/([a-z-]+)\//g)]
      .filter(m => m[1] !== owner && m[2] !== "issues")
      .map(m => `${m[1]}/${m[2]}`);
    expect(foreign).toEqual([]);

    // The clone command is checked separately: it has no path segment, so the
    // pattern above cannot see it, and it is the single most damaging one.
    const clones = [...readme.matchAll(/git clone https:\/\/github\.com\/([^/\s]+)\/opencodex\.git/g)]
      .map(m => m[1])
      .filter(o => o !== owner);
    expect(clones).toEqual([]);
  });
});
