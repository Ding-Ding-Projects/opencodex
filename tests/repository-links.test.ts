import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);
const activeFiles = [
  "src/update/links.ts",
  "src/update/notify.ts",
  "package.json",
  "tests/startup-prompt.test.ts",
  "tests/update-job.test.ts",
  "tests/release-notes.test.ts",
  "tests/helpers/enforce-pr-target-harness.ts",
  ".github/ISSUE_TEMPLATE/config.yml",
  "docs-site/astro.config.mjs",
];

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("application-owned repository links", () => {
  test("active runtime and package metadata use Ding-Ding-Projects/opencodex", async () => {
    const texts = await Promise.all(activeFiles.map(readText));
    for (const [index, text] of texts.entries()) {
      if (activeFiles[index] === "tests/update-job.test.ts") continue;
      expect(text).not.toContain("lidge-jun/opencodex");
    }
    const links = await readText("src/update/links.ts");
    expect(links).toContain('OPENCODEX_GITHUB_REPOSITORY = "Ding-Ding-Projects/opencodex"');
    expect(links).toContain('OPENCODEX_REPOSITORY_URL = "https://github.com/Ding-Ding-Projects/opencodex"');
    expect(links).toContain("`${OPENCODEX_REPOSITORY_URL}/releases/latest`");
    const pkg = JSON.parse(await readText("package.json")) as { name?: string; repository?: { url?: string }; bugs?: { url?: string }; homepage?: string };
    expect(pkg.name).toBe("@bitkyc08/opencodex");
    expect(pkg.repository?.url).toBe("git+https://github.com/Ding-Ding-Projects/opencodex.git");
    expect(pkg.bugs?.url).toBe("https://github.com/Ding-Ding-Projects/opencodex/issues");
    expect(pkg.homepage).toBe("https://opencodex.me/");
  });

  test("legacy updater URL is present only as an explicit read-time migration fixture", async () => {
    const job = await readText("src/update/job.ts");
    expect(job).toContain("LEGACY_RELEASE_NOTES_URL");
    expect(job).toContain("https://github.com/lidge-jun/opencodex/releases/latest");
    const links = await readText("src/update/links.ts");
    expect(links).not.toContain("lidge-jun/opencodex");
  });

  test("historical devlog content is not part of the active-link assertion", () => {
    expect(activeFiles.some(file => file.startsWith("devlog/"))).toBe(false);
  });
});
