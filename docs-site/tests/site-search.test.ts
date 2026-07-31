/**
 * The content search: what it matches, what it ranks first, and what it escapes.
 *
 * The escaping tests are the ones with teeth. Both excerpt sources end up in
 * `dangerouslySetInnerHTML` — Pagefind returns markup, and a local highlight has
 * to produce markup — so `markSafe` is the single thing standing between page
 * content and script execution. It is tested against the shapes that would slip
 * through a naive "strip the tags" pass.
 *
 * The bounds are the other half: the caps that make a pattern safe are only real
 * if the corpus honours them, so the regex path is checked against a page longer
 * than the sample ceiling.
 */

import { describe, expect, test } from "bun:test";
import { MATCH_CAP, SAMPLE_CAP } from "../../shared/m3/regex";
import type { PageDoc } from "../src/lib/search-index";
import { escapeHtml, markSafe, searchDocs, withBase } from "../src/lib/site-search";

const doc = (over: Partial<PageDoc> & { path: string; title: string }): PageDoc => ({
  description: "",
  headings: [],
  text: "",
  truncated: false,
  ...over,
});

const CORPUS: PageDoc[] = [
  doc({ path: "/guides/docker/", title: "Docker", description: "Run in a container", headings: ["Compose"], text: "Docker compose runs the proxy. docker again." }),
  doc({ path: "/reference/cli/", title: "CLI", description: "Command line", headings: ["Flags"], text: "The --port flag sets the port." }),
  doc({ path: "/guides/providers/", title: "Providers", description: "Bring your own key", headings: [], text: "A provider needs a base URL." }),
];

describe("markSafe", () => {
  test("keeps the highlight Pagefind produced", () => {
    expect(markSafe("a <mark>hit</mark> here")).toBe("a <mark>hit</mark> here");
  });

  test("neutralises a script tag rather than removing it", () => {
    expect(markSafe("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("an attribute cannot ride in on a mark", () => {
    const safe = markSafe('<mark onmouseover="x">hi</mark>');
    // Only the bare `</mark>` is restored — the opening tag carried an attribute,
    // so it stays escaped and no handler survives. The lone closing tag left
    // behind is inert: the HTML parser drops an unmatched end tag.
    expect(safe).not.toContain("onmouseover=\"");
    expect(safe).toContain("&lt;mark onmouseover=&quot;x&quot;&gt;");
  });

  test("an already-escaped entity is not double-decoded into a tag", () => {
    expect(markSafe("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;");
  });

  test("escapeHtml covers the five characters that matter", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});

describe("withBase", () => {
  test("a root deploy needs no prefix", () => {
    expect(withBase("/guides/docker/", "/")).toBe("/guides/docker/");
  });

  test("a project-site deploy gets one", () => {
    expect(withBase("/guides/docker/", "/opencodex/")).toBe("/opencodex/guides/docker/");
  });

  test("prefixing is idempotent, so a Pagefind that already did it is not doubled", () => {
    expect(withBase("/opencodex/guides/docker/", "/opencodex/")).toBe("/opencodex/guides/docker/");
  });
});

describe("searchDocs, plain text", () => {
  test("matches case-insensitively across title, description and body", () => {
    const out = searchDocs(CORPUS, { query: "container", regex: false, flags: "i" });
    expect(out.hits.map(h => h.path)).toEqual(["/guides/docker/"]);
  });

  test("a title hit outranks a body hit", () => {
    const corpus = [
      doc({ path: "/b/", title: "Nothing", text: "docker docker docker docker" }),
      doc({ path: "/a/", title: "Docker", text: "one mention" }),
    ];
    const out = searchDocs(corpus, { query: "docker", regex: false, flags: "i" });
    expect(out.hits[0]!.path).toBe("/a/");
  });

  test("no match is an empty list rather than everything", () => {
    expect(searchDocs(CORPUS, { query: "kubernetes", regex: false, flags: "i" }).hits).toHaveLength(0);
  });

  test("the excerpt highlights the hit and escapes the rest", () => {
    const corpus = [doc({ path: "/x/", title: "X", text: "before <b> port after" })];
    const out = searchDocs(corpus, { query: "port", regex: false, flags: "i" });
    expect(out.hits[0]!.excerptHtml).toContain("<mark>port</mark>");
    expect(out.hits[0]!.excerptHtml).toContain("&lt;b&gt;");
  });
});

describe("searchDocs, regex", () => {
  test("runs a real pattern, not a substring search", () => {
    const out = searchDocs(CORPUS, { query: "^The --\\w+ flag", regex: true, flags: "im" });
    expect(out.hits.map(h => h.path)).toEqual(["/reference/cli/"]);
  });

  test("counts every match on the page", () => {
    const out = searchDocs(CORPUS, { query: "docker", regex: true, flags: "gi" });
    // "Docker" in the title, then twice in the body.
    expect(out.hits[0]!.count).toBeGreaterThanOrEqual(3);
  });

  test("an uncompilable pattern matches nothing rather than throwing", () => {
    expect(() => searchDocs(CORPUS, { query: "(unclosed", regex: true, flags: "i" })).not.toThrow();
    expect(searchDocs(CORPUS, { query: "(unclosed", regex: true, flags: "i" }).hits).toHaveLength(0);
  });

  test("a zero-width pattern terminates and is capped", () => {
    const corpus = [doc({ path: "/z/", title: "Z", text: "x".repeat(5000) })];
    const out = searchDocs(corpus, { query: "(?:)", regex: true, flags: "g" });
    expect(out.hits[0]!.count).toBeLessThanOrEqual(MATCH_CAP * 2);
  });

  test("a page longer than the sample cap is searched up to the cap and marked", () => {
    const corpus = [doc({
      path: "/long/",
      title: "Long",
      text: `${"a".repeat(SAMPLE_CAP)}NEEDLE`,
      truncated: true,
    })];
    // The needle sits past the ceiling, so it is honestly not found...
    expect(searchDocs(corpus, { query: "NEEDLE", regex: true, flags: "i" }).hits).toHaveLength(0);
    // ...while text inside the ceiling still is, and the hit carries the flag.
    const found = searchDocs(corpus, { query: "a+", regex: true, flags: "i" });
    expect(found.hits[0]!.truncated).toBe(true);
  });
});
