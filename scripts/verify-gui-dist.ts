import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GUI_BUILD_MANIFEST_FILE,
  GUI_UI_GENERATION,
  guiGenerationMetaTag,
  parseGuiBuildManifest,
} from "../src/lib/gui-build";
import { computeGuiSourceHash, guiRoot, packageVersion } from "./gui-source-hash";

function fail(message: string): never {
  console.error(`GUI package gate failed: ${message}`);
  console.error("Run `bun run build:gui` before packing or publishing.");
  process.exit(1);
}

const indexPath = join(guiRoot, "dist", "index.html");
const manifestPath = join(guiRoot, "dist", GUI_BUILD_MANIFEST_FILE);
if (!existsSync(indexPath)) fail("gui/dist/index.html is missing");
if (!existsSync(manifestPath)) fail(`${GUI_BUILD_MANIFEST_FILE} is missing`);

const indexHtml = readFileSync(indexPath, "utf8");
if (!indexHtml.includes(guiGenerationMetaTag())) {
  fail(`gui/dist/index.html is not the ${GUI_UI_GENERATION} dashboard`);
}

let rawManifest: unknown;
try {
  rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  fail(`${GUI_BUILD_MANIFEST_FILE} is not valid JSON`);
}
const manifest = parseGuiBuildManifest(rawManifest);
if (!manifest) fail(`${GUI_BUILD_MANIFEST_FILE} has an unsupported schema or generation`);
if (manifest.packageVersion !== packageVersion()) {
  fail(`dashboard version ${manifest.packageVersion} does not match package ${packageVersion()}`);
}
const currentHash = computeGuiSourceHash();
if (manifest.sourceHash !== currentHash) {
  fail("dashboard sources changed after gui/dist was built");
}

// `npm pack --json` reserves stdout for its machine-readable JSON document.
// This script runs from `prepack`, so even a success diagnostic on stdout
// corrupts the redirected pack manifest on every platform.
console.error(`GUI package gate passed: ${manifest.uiGeneration}, package ${manifest.packageVersion}.`);
