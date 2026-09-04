import { describe, expect, test } from "bun:test";

const scripts = [
  "download-popup-layout-check.ts",
  "recapture-download-popups.ts",
] as const;

describe("capture script path portability", () => {
  for (const script of scripts) {
    test(`${script} converts its module URL to a native path`, async () => {
      const source = await Bun.file(new URL(`../scripts/${script}`, import.meta.url)).text();

      expect(source).toMatch(/^import \{ fileURLToPath \} from "node:url";$/m);
      expect(source).toMatch(
        /^const ROOT = fileURLToPath\(new URL\("\.\.", import\.meta\.url\)\);$/m,
      );
      expect(source).not.toMatch(
        /^const ROOT = new URL\("\.\.", import\.meta\.url\)\.pathname/m,
      );
    });
  }
});
