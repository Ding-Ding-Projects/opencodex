/**
 * Packaging branding is part of the shipped application contract, not a
 * cosmetic afterthought.  Keep this as a deliberately narrow, fail-closed
 * source/artifact check: a successful packager invocation is not proof that
 * the installer has a real mark or that its identity stayed compatible.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, ICON_DIGEST } from "../scripts/generate-windows-icon.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const YML = readFileSync(join(ROOT, "electron-builder.yml"), "utf8");
const ICON_RELATIVE_PATH = `assets/opencodex-${ICON_DIGEST}.ico`;
const PUBLIC_ICON_RELATIVE_PATH = `docs-site/public/assets/opencodex-${ICON_DIGEST}.ico`;
const ICON_URL = `https://opencodex.me/assets/opencodex-${ICON_DIGEST}.ico`;
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  name: string;
  bin: Record<string, string>;
};

function readIcoDirectory(path: string): Array<{ width: number; height: number; bytes: Buffer }> {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
  const count = bytes.readUInt16LE(4);
  expect(count).toBeGreaterThanOrEqual(6);
  const entries: Array<{ width: number; height: number; bytes: Buffer }> = [];
  for (let i = 0; i < count; i += 1) {
    const offset = 6 + i * 16;
    const width = bytes[offset] || 256;
    const height = bytes[offset + 1] || 256;
    const size = bytes.readUInt32LE(offset + 8);
    const dataOffset = bytes.readUInt32LE(offset + 12);
    entries.push({ width, height, bytes: bytes.subarray(dataOffset, dataOffset + size) });
  }
  return entries;
}

describe("Windows installer branding contract", () => {
  test("Squirrel has a stable public HTTPS iconUrl and uses the committed ICO", () => {
    expect(YML).toMatch(/^productName:\s*OpenCodex\s*$/m);
    expect(YML).toMatch(/^executableName:\s*opencodex\s*$/m);
    expect(YML).toMatch(/^appId:\s*com\.opencodex\.desktop\s*$/m);
    expect(YML).toContain(`  icon: ${ICON_RELATIVE_PATH}`);
    expect(YML).toContain(`  iconUrl: ${ICON_URL}`);
    expect(YML).toMatch(/^\s+name:\s*opencodex-desktop\s*$/m);
    expect(YML).toMatch(/^\s+forceCodeSigning:\s*false\s*$/m);
    expect(YML).toMatch(/^\s+signExecutable:\s*false\s*$/m);
    expect(YML).toMatch(/^\s+signAndEditExecutable:\s*false\s*$/m);
  });

  test("the ICO is a real multi-resolution PNG-backed image with alpha", () => {
    const icon = readFileSync(join(ROOT, ICON_RELATIVE_PATH));
    expect(createHash("sha256").update(icon).digest("hex")).toBe(ICON_DIGEST);
    const entries = readIcoDirectory(join(ROOT, ICON_RELATIVE_PATH));
    const sizes = entries.map(entry => `${entry.width}x${entry.height}`);
    for (const size of [16, 24, 32, 48, 64, 128, 256]) {
      expect(sizes).toContain(`${size}x${size}`);
    }
    for (const entry of entries) {
      expect(entry.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const decoded = decodePng(entry.bytes);
      expect(decoded.width).toBe(entry.width);
      expect(decoded.height).toBe(entry.height);
      const alpha = [...decoded.pixels].filter((_, index) => index % 4 === 3);
      expect(alpha.some(value => value > 0)).toBe(true);
      expect(alpha.some(value => value < 255)).toBe(true);
    }
    expect(icon).toEqual(readFileSync(join(ROOT, PUBLIC_ICON_RELATIVE_PATH)));
  });

  test("npm/package and runtime-facing identities remain stable while presentation is OpenCodex", () => {
    expect(PACKAGE.name).toBe("@bitkyc08/opencodex");
    expect(PACKAGE.bin.opencodex).toBe("./bin/ocx.mjs");
    expect(PACKAGE.bin.OpenCodex).toBeUndefined();
    expect(YML).toContain("extraMetadata:");
    expect(YML).toMatch(/^\s+name:\s*opencodex-desktop\s*$/m);
    expect(YML).not.toMatch(/^productName:\s*opencodex\s*$/m);
  });
});
