/**
 * The base-path rewrite, which decides whether 205 links work on one host.
 *
 * This site publishes to a domain root and to a project-site path prefix. Astro
 * rewrites `base` into what it generates itself, but a link written by hand in a
 * Markdown body is opaque to it, so `[Adapters](/reference/adapters/)` shipped
 * unprefixed and 404ed on the project site while both builds reported success.
 *
 * The cases that matter here are the ones where "prefix every absolute path" is
 * the WRONG answer — a protocol-relative URL points at another origin despite
 * its leading slash, and an already-prefixed path must survive untouched or the
 * transform stops being idempotent. Those are the edits that would break the
 * canonical host to fix the fallback one.
 */

import { describe, expect, test } from "bun:test";
import { rehypeBasePath } from "../src/plugins/rehype-base-path.mjs";

/** A minimal hast tree with one element carrying the given properties. */
const tree = (properties: Record<string, unknown>, tagName = "a") => ({
  type: "root",
  children: [{ type: "element", tagName, properties, children: [] }],
});

const run = (base: string, properties: Record<string, unknown>, tagName = "a") => {
  const t = tree(properties, tagName);
  rehypeBasePath({ base })(t);
  return (t.children[0] as { properties: Record<string, unknown> }).properties;
};

describe("under a project-site base", () => {
  const BASE = "/opencodex";

  test("prefixes a root-absolute href", () => {
    expect(run(BASE, { href: "/reference/adapters/" }).href).toBe("/opencodex/reference/adapters/");
  });

  test("prefixes a root-absolute src", () => {
    expect(run(BASE, { src: "/img/diagram.png" }, "img").src).toBe("/opencodex/img/diagram.png");
  });

  test("keeps a fragment on the rewritten path", () => {
    expect(run(BASE, { href: "/reference/configuration/#remote-access" }).href).toBe(
      "/opencodex/reference/configuration/#remote-access",
    );
  });

  test("leaves a protocol-relative URL alone — it is another origin", () => {
    // The one case where a leading slash does not mean "this site". Prefixing
    // `//cdn.example/x` would turn an external asset into a broken local path.
    expect(run(BASE, { href: "//cdn.example.com/lib.js" }).href).toBe("//cdn.example.com/lib.js");
  });

  test("leaves absolute and non-http schemes alone", () => {
    expect(run(BASE, { href: "https://github.com/x" }).href).toBe("https://github.com/x");
    expect(run(BASE, { href: "mailto:a@b.c" }).href).toBe("mailto:a@b.c");
  });

  test("leaves relative paths and bare fragments alone", () => {
    expect(run(BASE, { href: "../sibling/" }).href).toBe("../sibling/");
    expect(run(BASE, { href: "#section" }).href).toBe("#section");
  });

  test("is idempotent — an already-prefixed path is untouched", () => {
    // Guards the case where the plugin runs twice, or content is authored with
    // the prefix already written in.
    expect(run(BASE, { href: "/opencodex/guides/docker/" }).href).toBe("/opencodex/guides/docker/");
  });

  test("does not treat a lookalike prefix as already-based", () => {
    // `/opencodex-extras/` merely starts with the same characters; it is a
    // different path and still needs the base.
    expect(run(BASE, { href: "/opencodex-extras/" }).href).toBe("/opencodex/opencodex-extras/");
  });

  test("rewrites deeply nested elements, not just the top level", () => {
    const t = {
      type: "root",
      children: [
        {
          type: "element", tagName: "p", properties: {},
          children: [{ type: "element", tagName: "a", properties: { href: "/guides/docker/" }, children: [] }],
        },
      ],
    };
    rehypeBasePath({ base: BASE })(t);
    const inner = (t.children[0].children[0] as { properties: { href: string } }).properties;
    expect(inner.href).toBe("/opencodex/guides/docker/");
  });
});

describe("at the domain root", () => {
  test("changes nothing at all", () => {
    // The canonical deployment must be byte-identical to the untransformed
    // build; a no-op here is what lets one content tree serve both hosts.
    for (const base of ["", "/"]) {
      expect(run(base, { href: "/reference/adapters/" }).href).toBe("/reference/adapters/");
      expect(run(base, { href: "//cdn.example.com/x" }).href).toBe("//cdn.example.com/x");
    }
  });
});
