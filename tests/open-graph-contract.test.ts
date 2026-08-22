import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const configPath = join(import.meta.dir, "..", "docs-site", "astro.config.mjs");
const config = readFileSync(configPath, "utf8");

describe("documentation social metadata contract", () => {
  test("server-renders the complete Open Graph contract", () => {
    for (const property of ["og:image", "og:image:width", "og:image:height", "og:image:alt"]) {
      expect(config).toContain(`property: "${property}"`);
    }

    expect(config).toContain('const SITE_URL = process.env.DOCS_SITE_URL?.trim() || "https://opencodex.me";');
    expect(config).toMatch(
      /^\s*\{ tag: "meta", attrs: \{ property: "og:image", content: `\$\{SITE_URL\}\$\{BASE_PATH\}\/social-preview[.]png` \} \},\s*$/m,
    );
    expect(config).toContain('property: "og:image:width", content: "1280"');
    expect(config).toContain('property: "og:image:height", content: "640"');
    expect(config).toContain("Starlight emits the page-specific Open Graph title, description, URL,");
    expect(config).not.toMatch(
      /^\s*\{ tag: "meta", attrs: \{ property: "og:(?:title|description|url|type|site_name)"/m,
    );
  });

  test("server-renders a large Twitter card and theme colors", () => {
    expect(config).toContain('name: "twitter:card", content: "summary_large_image"');
    expect(config).toContain('name: "twitter:image", content: `${SITE_URL}${BASE_PATH}/social-preview.png`');
    expect(config).toContain('name: "twitter:image:alt", content: SOCIAL_IMAGE_ALT');
    expect(config.match(/name: "theme-color"/g)).toHaveLength(2);
  });

  test("keeps social metadata in Astro configuration rather than client code", () => {
    const headStart = config.indexOf("head: [");
    const socialStart = config.indexOf("social: [", headStart);
    const head = config.slice(headStart, socialStart);

    expect(headStart).toBeGreaterThan(-1);
    expect(socialStart).toBeGreaterThan(headStart);
    expect(head).not.toContain("client:");
    expect(head).not.toContain("document.createElement");
  });
});
