import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const WIDTH = 1280;
const HEIGHT = 640;
const ROOT = new URL("../social-preview.png", import.meta.url);
const SERVED = new URL("../docs-site/public/social-preview.png", import.meta.url);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function inspectPng(bytes, label) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${label} is not a PNG file`);
  }
  if (bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${label} has no leading PNG IHDR chunk`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== WIDTH || height !== HEIGHT) {
    throw new Error(`${label} is ${width}x${height}; expected ${WIDTH}x${HEIGHT}`);
  }
}

const [root, served] = await Promise.all([readFile(ROOT), readFile(SERVED)]);
inspectPng(root, "social-preview.png");
inspectPng(served, "docs-site/public/social-preview.png");

if (!root.equals(served)) {
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  throw new Error(
    `Social-preview copies differ: root=${digest(root)} served=${digest(served)}. Run scripts/generate-social-preview.mjs.`,
  );
}

console.log(`Social-preview contract verified: ${WIDTH}x${HEIGHT}, byte-identical, sha256=${createHash("sha256").update(root).digest("hex")}.`);
