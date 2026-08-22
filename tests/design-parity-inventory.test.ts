import { describe, expect, test } from "bun:test";
import { readInventory, runNegativeRegression, validateInventory } from "../scripts/design-parity-inventory";

const inventory = readInventory();

describe("design parity inventory contract", () => {
  test("accepts the complete 19-row inventory and current evidence hashes", () => {
    expect(() => validateInventory(inventory)).not.toThrow();
    expect(inventory.rows).toHaveLength(19);
  });

  test("rejects an empty discovery result instead of treating missing inventory as success", () => {
    const empty = structuredClone(inventory);
    empty.screenIds = [];
    empty.rows = [];
    empty.rowCount = 0;
    expect(() => validateInventory(empty, { checkFiles: false })).toThrow(/exact hand-written 19-screen list/);
  });

  test("observes red then green for every exact required boundary", () => {
    const receipts = runNegativeRegression(inventory);
    expect(receipts).toHaveLength(20);
    expect(receipts.filter(line => line.startsWith("RED "))).toHaveLength(10);
    expect(receipts.filter(line => line.startsWith("GREEN "))).toHaveLength(10);
  });
});
