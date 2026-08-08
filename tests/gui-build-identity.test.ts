import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GUI_BUILD_MANIFEST_FILE,
  GUI_UI_GENERATION,
  guiGenerationMetaTag,
  parseGuiBuildManifest,
} from "../src/lib/gui-build";
import { computeGuiSourceHash } from "../scripts/gui-source-hash";
import { findPackagedGuiDist, isCompatibleGuiDist, serveGuiFile } from "../src/server/gui-static";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(version = "9.8.7"): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-gui-build-"));
  roots.push(root);
  writeFileSync(join(root, "index.html"), `<!doctype html><head>${guiGenerationMetaTag()} /></head>`);
  writeFileSync(join(root, GUI_BUILD_MANIFEST_FILE), JSON.stringify({
    schema: 1,
    uiGeneration: GUI_UI_GENERATION,
    packageVersion: version,
    sourceHash: `sha256:${"a".repeat(64)}`,
  }));
  return root;
}

describe("GUI build identity", () => {
  test("accepts only a matching Material 3 manifest and index marker", () => {
    const root = fixture();
    expect(isCompatibleGuiDist(root, "9.8.7")).toBe(true);
    expect(isCompatibleGuiDist(root, "9.8.8")).toBe(false);

    writeFileSync(join(root, "index.html"), "<!doctype html><div>retired dashboard</div>");
    expect(isCompatibleGuiDist(root, "9.8.7")).toBe(false);
  });

  test("fails closed on missing, malformed, or unsupported manifests", () => {
    const root = fixture();
    writeFileSync(join(root, GUI_BUILD_MANIFEST_FILE), "not json");
    expect(isCompatibleGuiDist(root, "9.8.7")).toBe(false);
    expect(isCompatibleGuiDist(join(root, "missing"), "9.8.7")).toBe(false);
    expect(parseGuiBuildManifest({
      schema: 1,
      uiGeneration: "legacy",
      packageVersion: "9.8.7",
      sourceHash: `sha256:${"a".repeat(64)}`,
    })).toBeNull();
  });

  test("serves Material 3 font assets with browser-safe MIME types", async () => {
    const root = fixture();
    writeFileSync(join(root, "dashboard.woff2"), "font");
    const response = serveGuiFile("/dashboard.woff2", root);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Content-Type")).toBe("font/woff2");
    expect(await response?.text()).toBe("font");
  });

  test("includes shared Material 3 sources in the package identity", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-gui-source-hash-"));
    roots.push(root);
    mkdirSync(join(root, "gui", "src"), { recursive: true });
    mkdirSync(join(root, "shared", "m3"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(root, "gui", "src", "main.ts"), "export const app = true;\n");
    const shared = join(root, "shared", "m3", "tabs.ts");
    writeFileSync(shared, "export const generation = 1;\n");
    const before = computeGuiSourceHash(root);
    writeFileSync(shared, "export const generation = 2;\n");
    expect(computeGuiSourceHash(root)).not.toBe(before);
  });

  test("never falls back to a sibling dashboard outside the package", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-gui-package-parent-"));
    roots.push(parent);
    const packageRoot = join(parent, "package");
    const serverDir = join(packageRoot, "src", "server");
    mkdirSync(serverDir, { recursive: true });

    const sibling = join(parent, "gui", "dist");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "index.html"), `<!doctype html>${guiGenerationMetaTag()}>`);
    writeFileSync(join(sibling, GUI_BUILD_MANIFEST_FILE), JSON.stringify({
      schema: 1,
      uiGeneration: GUI_UI_GENERATION,
      packageVersion: "9.8.7",
      sourceHash: `sha256:${"a".repeat(64)}`,
    }));

    expect(findPackagedGuiDist(serverDir, "9.8.7")).toBeNull();

    const owned = join(packageRoot, "gui", "dist");
    mkdirSync(owned, { recursive: true });
    writeFileSync(join(owned, "index.html"), `<!doctype html>${guiGenerationMetaTag()}>`);
    writeFileSync(join(owned, GUI_BUILD_MANIFEST_FILE), JSON.stringify({
      schema: 1,
      uiGeneration: GUI_UI_GENERATION,
      packageVersion: "9.8.7",
      sourceHash: `sha256:${"a".repeat(64)}`,
    }));
    expect(findPackagedGuiDist(serverDir, "9.8.7")).toBe(owned);
  });

  test("does not follow a dashboard asset symlink outside gui/dist", () => {
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), "ocx-gui-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.txt"), "must not be served");
    symlinkSync(outside, join(root, "escape"), "junction");

    expect(serveGuiFile("/escape/secret.txt", root)).toBeNull();
  });
});
