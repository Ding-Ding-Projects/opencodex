import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

const ROOT = "social-preview.png";
const SERVED = "docs-site/public/social-preview.png";

function dimensions(bytes: Uint8Array): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

describe("social preview", () => {
  test("the root master is a 1280x640 PNG", async () => {
    const bytes = new Uint8Array(await Bun.file(ROOT).arrayBuffer());
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(dimensions(bytes)).toEqual([1280, 640]);
  });

  test("the published copy is byte-identical to the root master", async () => {
    const [root, served] = await Promise.all([
      Bun.file(ROOT).arrayBuffer(),
      Bun.file(SERVED).arrayBuffer(),
    ]);
    const digest = (bytes: ArrayBuffer) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
    expect(digest(served)).toBe(digest(root));
  });

  test("the generator derives the card from the committed product logo", async () => {
    const source = await Bun.file("scripts/generate-social-preview.mjs").text();
    expect(source).toContain('new URL("../gui/public/logo.png", import.meta.url)');
    expect(source).toContain("writeFile(ROOT_OUTPUT, output)");
    expect(source).toContain("writeFile(SERVED_OUTPUT, output)");
  });
});
