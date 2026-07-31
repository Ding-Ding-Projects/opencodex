/**
 * The build-time page index, whose one interesting decision is the URL.
 *
 * A wrong `path` here is a search result that 404s — visible to a reader,
 * invisible to a build, and exactly the class of failure this site keeps
 * shipping. The base-prefix cases are the ones that matter: the site publishes
 * to a domain root AND to a project-site path prefix, and an index built without
 * the prefix works perfectly on one host while every result is a dead link on
 * the other.
 *
 * The text extraction is tested for what it must NOT lose (code, which is what
 * this documentation is mostly searched for) and what it must not invent (words
 * created by collapsing two tags together).
 */

import { describe, expect, test } from "bun:test";
import { SAMPLE_CAP } from "../../shared/m3/regex";
import {
  buildLocaleIndex,
  headingsOf,
  indexUrl,
  localeOfId,
  pathForId,
  plainText,
  toPageDoc,
} from "../src/lib/search-index";

describe("pathForId", () => {
  test("a page at a domain root", () => {
    expect(pathForId("guides/docker", "/")).toBe("/guides/docker/");
  });

  test("the same page under a project-site prefix", () => {
    expect(pathForId("guides/docker", "/opencodex/")).toBe("/opencodex/guides/docker/");
  });

  test("a base without its trailing slash is still handled", () => {
    expect(pathForId("guides/docker", "/opencodex")).toBe("/opencodex/guides/docker/");
  });

  test("an index page collapses to its directory", () => {
    expect(pathForId("index", "/")).toBe("/");
    expect(pathForId("ja/index", "/")).toBe("/ja/");
    expect(pathForId("benchmarks/index", "/opencodex/")).toBe("/opencodex/benchmarks/");
  });

  test("a file extension is not part of the URL", () => {
    expect(pathForId("guides/docker.mdx", "/")).toBe("/guides/docker/");
  });
});

describe("localeOfId", () => {
  test("a locale segment is recognised", () => {
    expect(localeOfId("ja/guides/docker")).toBe("ja");
    expect(localeOfId("zh-cn/index")).toBe("zh-cn");
  });

  test("no segment means the root locale, not an unknown one", () => {
    expect(localeOfId("guides/docker")).toBe("root");
    expect(localeOfId("index")).toBe("root");
  });

  test("a directory that merely looks like a locale is not one", () => {
    expect(localeOfId("jargon/terms")).toBe("root");
  });
});

describe("plainText", () => {
  test("keeps the contents of a fenced code block", () => {
    const body = "Run it:\n\n```bash\nopencodex --port 8080\n```\n";
    expect(plainText(body)).toContain("opencodex --port 8080");
  });

  test("drops MDX machinery a reader never sees", () => {
    const body = 'import Card from "../Card.astro";\n\nReal prose.';
    const text = plainText(body);
    expect(text).not.toContain("Card.astro");
    expect(text).toContain("Real prose.");
  });

  test("a link collapses to its label, not its URL", () => {
    expect(plainText("See [the CLI](/reference/cli/) for more.")).toBe("See the CLI for more.");
  });

  test("removing tags does not weld two words together", () => {
    expect(plainText("<b>alpha</b><b>beta</b>")).toBe("alpha beta");
  });

  test("heading markers go, heading text stays", () => {
    expect(plainText("## Install\n\nbody")).toBe("Install\n\nbody");
  });
});

describe("headingsOf", () => {
  test("reports sections in document order", () => {
    expect(headingsOf("# One\n\ntext\n\n## Two\n")).toEqual(["One", "Two"]);
  });

  test("a comment inside a code fence is not a section", () => {
    expect(headingsOf("# Real\n\n```sh\n# not a heading\n```\n")).toEqual(["Real"]);
  });
});

describe("toPageDoc", () => {
  test("caps the text at the regex engine's own sample ceiling and says so", () => {
    const doc = toPageDoc({ id: "long", title: "Long", body: "x".repeat(SAMPLE_CAP + 500) }, "/");
    expect(doc.text.length).toBe(SAMPLE_CAP);
    expect(doc.truncated).toBe(true);
  });

  test("a short page is not marked truncated", () => {
    const doc = toPageDoc({ id: "short", title: "Short", body: "hello" }, "/");
    expect(doc.truncated).toBe(false);
  });
});

describe("buildLocaleIndex", () => {
  const entries = [
    { id: "index", title: "Home", body: "root" },
    { id: "guides/docker", title: "Docker", body: "containers" },
    { id: "ja/index", title: "ホーム", body: "日本語" },
    { id: "ja/guides/docker", title: "Docker", body: "コンテナ" },
  ];

  test("keeps only the requested locale", () => {
    expect(buildLocaleIndex(entries, "ja", "/").map(d => d.path)).toEqual(["/ja/", "/ja/guides/docker/"]);
  });

  test("the root locale is the pages with no locale segment", () => {
    expect(buildLocaleIndex(entries, "root", "/").map(d => d.path)).toEqual(["/", "/guides/docker/"]);
  });

  test("every path carries the deployment base", () => {
    for (const doc of buildLocaleIndex(entries, "root", "/opencodex/")) {
      expect(doc.path.startsWith("/opencodex/")).toBe(true);
    }
  });
});

describe("indexUrl", () => {
  test("the writer and the reader agree on where the file lives", () => {
    expect(indexUrl("/", "root")).toBe("/ocx-search/root.json");
    expect(indexUrl("/opencodex/", "ja")).toBe("/opencodex/ocx-search/ja.json");
  });
});
