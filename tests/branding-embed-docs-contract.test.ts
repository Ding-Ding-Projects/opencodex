import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const GUIDE_PATH = "docs-site/src/content/docs/guides/branding-and-link-embeds.md";
const SIDEBAR_PATH = "docs-site/astro.config.mjs";
const SIDEBAR_SLUG = 'slug: "guides/branding-and-link-embeds"';

describe("branding and link-embed documentation contract", () => {
  test("ships the canonical guide with the complete evidence boundary", () => {
    expect(existsSync(GUIDE_PATH)).toBe(true);
    const guide = readFileSync(GUIDE_PATH, "utf8");

    expect(guide).toContain("title: Branding and link embeds");
    for (const heading of [
      "## Desktop package and update wiring",
      "## Social preview derivatives",
      "## Static link metadata",
      "## GitHub repository social preview",
      "## Failure modes",
      "## Security and privacy",
      "## Verification",
      "## Suggested articles",
    ]) {
      expect(guide).toContain(heading);
    }

    for (const requiredEvidence of [
      "gui/public/logo.png",
      "scripts/generate-app-icon.mjs",
      "gui/public/opencodex.ico",
      "scripts/generate-social-preview.mjs",
      "social-preview.png",
      "docs-site/public/social-preview.png",
      "byte-identical",
      "server-rendered HTML",
      "summary_large_image",
      "Settings → General → Social preview",
      "built-artifact inspection",
    ]) {
      expect(guide).toContain(requiredEvidence);
    }
  });

  test("registers the guide in the hand-written documentation sidebar", () => {
    const sidebar = readFileSync(SIDEBAR_PATH, "utf8");
    const matches = sidebar.match(new RegExp(SIDEBAR_SLUG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? [];
    expect(matches).toHaveLength(1);
  });
});
