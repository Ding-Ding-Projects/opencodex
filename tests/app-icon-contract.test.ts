import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const EXPECTED_SIZES = [16, 24, 32, 48, 64, 128, 256];

function pngDimensions(bytes: Buffer) {
  expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("packaged application icon contract", () => {
  test("the committed derivatives reproduce byte-for-byte from the master mark", () => {
    const pngBefore = readFileSync("gui/public/opencodex.png");
    const icoBefore = readFileSync("gui/public/opencodex.ico");
    const servedIcoBefore = readFileSync("docs-site/public/opencodex.ico");
    const generated = spawnSync("bun", ["scripts/generate-app-icon.mjs"], { encoding: "utf8" });
    expect(generated.status).toBe(0);
    expect(readFileSync("gui/public/opencodex.png")).toEqual(pngBefore);
    expect(readFileSync("gui/public/opencodex.ico")).toEqual(icoBefore);
    expect(readFileSync("docs-site/public/opencodex.ico")).toEqual(servedIcoBefore);
    expect(servedIcoBefore).toEqual(icoBefore);
    expect(pngDimensions(pngBefore)).toEqual([512, 512]);
  });

  test("the ICO directory and every embedded PNG declare the required real size", () => {
    const ico = readFileSync("gui/public/opencodex.ico");
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(EXPECTED_SIZES.length);
    const observed = [];
    let previousEnd = 6 + EXPECTED_SIZES.length * 16;
    for (let index = 0; index < EXPECTED_SIZES.length; index += 1) {
      const entry = 6 + index * 16;
      const size = ico[entry] || 256;
      const height = ico[entry + 1] || 256;
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      expect(height).toBe(size);
      expect(ico.readUInt16LE(entry + 4)).toBe(1);
      expect(ico.readUInt16LE(entry + 6)).toBe(32);
      expect(offset).toBe(previousEnd);
      expect(offset + length).toBeLessThanOrEqual(ico.length);
      expect(pngDimensions(ico.subarray(offset, offset + length))).toEqual([size, size]);
      previousEnd = offset + length;
      observed.push(size);
    }
    expect(observed).toEqual(EXPECTED_SIZES);
    expect(previousEnd).toBe(ico.length);
  });

  test("desktop packaging and Squirrel metadata use the canonical generated icon", () => {
    const manifest = readFileSync("electron-builder.yml", "utf8");
    expect(manifest).toMatch(/^\s*icon:\s*gui\/public\/opencodex[.]ico\s*$/m);
    expect(manifest).toMatch(/^\s*iconUrl:\s*https:\/\/opencodex[.]me\/opencodex[.]ico\s*$/m);
  });
});
