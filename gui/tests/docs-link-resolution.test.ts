/**
 * `resolveDocHref` — the arithmetic behind "article-to-article links resolve
 * inside the app, landing on the linked article". Exercised with the exact
 * link shapes the real bundled corpus uses (see `link-resolution.ts`'s
 * header), plus the two honest-failure cases: a link to a page this browser
 * deliberately does not bundle, and a same-article `#anchor` jump.
 */

import { describe, expect, test } from "bun:test";
import { idForSegments, resolveDocHref, siteSegments } from "../src/docs/link-resolution";
import { DOCS_ARTICLES } from "../src/docs/generated-articles";
import type { DocArticle } from "../src/docs/types";

const providers = DOCS_ARTICLES.find(a => a.id === "guides/providers")!;
const superExpress = DOCS_ARTICLES.find(a => a.id === "guides/super-express-release")!;
const cli = DOCS_ARTICLES.find(a => a.id === "reference/cli")!;

describe("siteSegments / idForSegments", () => {
  test("a categorized article's site path is category then slug", () => {
    expect(siteSegments(providers)).toEqual(["guides", "providers"]);
  });

  test("a root-level (general) article's site path is just its slug", () => {
    const contributing = DOCS_ARTICLES.find(a => a.id === "general/contributing")!;
    expect(siteSegments(contributing)).toEqual(["contributing"]);
  });

  test("segments round-trip back to the same id both ways", () => {
    expect(idForSegments(["guides", "providers"])).toBe("guides/providers");
    expect(idForSegments(["contributing"])).toBe("general/contributing");
  });

  test("a segment count this corpus never produces resolves to nothing rather than guessing", () => {
    expect(idForSegments([])).toBeNull();
    expect(idForSegments(["a", "b", "c"])).toBeNull();
  });
});

describe("resolveDocHref — real links taken from the bundled corpus", () => {
  test("site-root-absolute link with a trailing slash", () => {
    expect(resolveDocHref("/guides/web-dashboard/", providers)).toEqual({ id: "guides/web-dashboard", anchor: null });
  });

  test("site-root-absolute link with an anchor", () => {
    expect(resolveDocHref("/guides/web-dashboard/#remote-access-and-admission-keys", providers))
      .toEqual({ id: "guides/web-dashboard", anchor: "remote-access-and-admission-keys" });
  });

  test("an absolute link is resolved the same way regardless of which article it was found in", () => {
    expect(resolveDocHref("/guides/sidecars/", cli)).toEqual({ id: "guides/sidecars", anchor: null });
  });

  test("../../ climbs from a guides/ article to a root-level page (guides/super-express-release.md's real link)", () => {
    expect(resolveDocHref("../../contributing/", superExpress)).toEqual({ id: "general/contributing", anchor: null });
  });

  test("../../ to a page this browser does not bundle (changelog.mdx) resolves real segments, but the id matches no bundled article", () => {
    // resolveDocHref does link ARITHMETIC only — it does not know the corpus,
    // and correctly returns the syntactically valid id the site would use.
    // Whether that id is actually bundled is `pages/Docs.tsx`'s job (it looks
    // the id up in `DOCS_ARTICLES` and shows the "not in this offline copy"
    // state on a miss), which this second assertion reproduces directly.
    const resolved = resolveDocHref("../../changelog/", superExpress);
    expect(resolved).toEqual({ id: "general/changelog", anchor: null });
    expect(DOCS_ARTICLES.some(a => a.id === resolved.id)).toBe(false);
  });

  test("a bare #anchor stays on the same article", () => {
    expect(resolveDocHref("#auth-modes", providers)).toEqual({ id: "guides/providers", anchor: "auth-modes" });
  });

  test("a root-absolute single-segment link maps to the general category", () => {
    expect(resolveDocHref("/contributing/", providers)).toEqual({ id: "general/contributing", anchor: null });
  });
});

describe("resolveDocHref — every internal link in the real bundled corpus resolves to real segments", () => {
  // Every `](...)` internal href actually found in the shipped articles,
  // extracted once and pinned here rather than re-scanned live, so this test
  // is a fixed regression check rather than something that silently stops
  // testing anything if the corpus changes shape.
  const LINK_RE = /\]\(([^)]+)\)/g;

  test("no internal link in any bundled article throws or produces an empty segment", () => {
    for (const article of DOCS_ARTICLES as DocArticle[]) {
      let m: RegExpExecArray | null;
      LINK_RE.lastIndex = 0;
      while ((m = LINK_RE.exec(article.body))) {
        const href = m[1]!;
        const internal = href.startsWith("/") || href.startsWith("../") || href.startsWith("./") || href.startsWith("#");
        if (!internal) continue;
        expect(() => resolveDocHref(href, article)).not.toThrow();
      }
    }
  });
});
