import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("hard-pinned startup keeps safe Windows dead-row reclamation enabled", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");
  const hardPinStart = source.indexOf("if (hardPin && preferred > 0)");
  const hardPinEnd = source.indexOf("try {", hardPinStart);
  const block = source.slice(hardPinStart, hardPinEnd);

  expect(block).toContain("killOcxHolders: false");
  expect(block).not.toContain("dropTcpRows: false");
});
