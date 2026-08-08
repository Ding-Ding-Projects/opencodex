import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GUI_BUILD_MANIFEST_FILE,
  GUI_UI_GENERATION,
  type GuiBuildManifest,
} from "../src/lib/gui-build";
import { computeGuiSourceHash, guiRoot, packageVersion } from "./gui-source-hash";

const distIndex = join(guiRoot, "dist", "index.html");
if (!existsSync(distIndex)) {
  throw new Error("gui/dist/index.html is missing after the dashboard build");
}

const manifest: GuiBuildManifest = {
  schema: 1,
  uiGeneration: GUI_UI_GENERATION,
  packageVersion: packageVersion(),
  sourceHash: computeGuiSourceHash(),
};
const destination = join(guiRoot, "dist", GUI_BUILD_MANIFEST_FILE);
const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
try {
  renameSync(temporary, destination);
} catch (error) {
  try { unlinkSync(temporary); } catch { /* best effort */ }
  throw error;
}

console.log(`Stamped ${GUI_BUILD_MANIFEST_FILE} for ${manifest.uiGeneration} (${manifest.sourceHash.slice(0, 19)}...).`);
