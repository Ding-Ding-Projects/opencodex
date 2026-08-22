import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("startup prompts", () => {
  test("does not ship a package-manager postinstall lifecycle prompt", async () => {
    const pkg = JSON.parse(await readText("package.json")) as {
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(pkg.files ?? []).not.toContain("scripts/postinstall.mjs");
  });

  test("ocx start does not invoke a GitHub-star prompt", async () => {
    const cli = await readText("src/cli/index.ts");
    expect(cli).not.toContain("maybeShowStarPrompt");
    expect(cli).not.toContain("GitHub-star prompt");
    expect(cli).toContain("await syncModelsToCodex(port)");
  });

  test("the removed GitHub-star prompt has no source or ownership marker", async () => {
    const cli = await readText("src/cli/index.ts");
    const notify = await readText("src/update/notify.ts");
    const ownership = await readText("src/lib/config-ownership.ts");
    const promptPath = fileURLToPath(new URL("src/cli/star-prompt.ts", root));

    expect(existsSync(promptPath)).toBe(false);
    expect(cli).not.toContain("star-prompt");
    expect(notify).not.toContain("hasStarPromptRun");
    expect(ownership).not.toContain(".star-prompted");
  });

  test("ocx init offers the Codex autostart shim by default", async () => {
    const init = await readText("src/cli/init.ts");

    expect(init).toContain("Install Codex autostart shim? [Y/n]");
    expect(init).toContain("installCodexShim");
  });
});
