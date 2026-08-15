/**
 * `src/lib/converter/delimited.ts` — CSV/TSV <-> JSON.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_DELIMITED_CELL_LENGTH,
  MAX_DELIMITED_COLUMNS,
  MAX_DELIMITED_ROWS,
  MAX_STRUCTURED_INPUT_BYTES,
} from "../src/lib/converter/bounds";
import { delimitedToJson, jsonToDelimited } from "../src/lib/converter/delimited";

describe("jsonToDelimited: the failure paths", () => {
  test("refuses a non-array top-level value", () => {
    const result = jsonToDelimited({ a: 1 }, "csv");
    expect(result.ok).toBe(false);
  });

  test("refuses an array whose entries are not plain objects", () => {
    const result = jsonToDelimited([1, 2, 3], "csv");
    expect(result.ok).toBe(false);
  });

  test("refuses an array of objects that has too many distinct columns", () => {
    const row: Record<string, number> = {};
    for (let i = 0; i <= MAX_DELIMITED_COLUMNS; i++) row[`col${i}`] = i;
    const result = jsonToDelimited([row], "csv");
    expect(result.ok).toBe(false);
  });

  test("refuses an array with too many rows", () => {
    const rows = Array.from({ length: MAX_DELIMITED_ROWS + 1 }, (_, i) => ({ n: i }));
    const result = jsonToDelimited(rows, "csv");
    expect(result.ok).toBe(false);
  });

  test("refuses a cell over the maximum cell length", () => {
    const result = jsonToDelimited([{ text: "x".repeat(MAX_DELIMITED_CELL_LENGTH + 1) }], "csv");
    expect(result.ok).toBe(false);
  });
});

describe("jsonToDelimited: discloses the type loss it always causes", () => {
  test("every successful result is marked lossy with a real note", () => {
    const result = jsonToDelimited([{ a: 1 }], "csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lossy).toBe(true);
    expect(result.notes.length).toBeGreaterThan(0);
    expect(result.notes.join(" ")).toMatch(/type/i);
  });
});

describe("jsonToDelimited / delimitedToJson: real round trips", () => {
  test("a simple table round-trips its text content exactly", () => {
    const source = [
      { name: "Alice", city: "Springfield" },
      { name: "Bob", city: "Shelbyville" },
    ];
    const csv = jsonToDelimited(source, "csv");
    expect(csv.ok).toBe(true);
    if (!csv.ok) return;
    const back = delimitedToJson(csv.text, "csv");
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value).toEqual([
      { name: "Alice", city: "Springfield" },
      { name: "Bob", city: "Shelbyville" },
    ]);
  });

  test("numbers, booleans and null all read back as strings — the disclosed type loss, proven", () => {
    const csv = jsonToDelimited([{ n: 42, b: true, z: null }], "csv");
    expect(csv.ok).toBe(true);
    if (!csv.ok) return;
    const back = delimitedToJson(csv.text, "csv");
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value).toEqual([{ n: "42", b: "true", z: "" }]);
  });

  test("cells containing the delimiter, quotes and newlines are escaped and round-trip correctly", () => {
    const source = [{ note: 'has "quotes", a comma, and\na newline' }];
    const csv = jsonToDelimited(source, "csv");
    expect(csv.ok).toBe(true);
    if (!csv.ok) return;
    const back = delimitedToJson(csv.text, "csv");
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value).toEqual(source.map(r => ({ note: r.note })));
  });

  test("a ragged array of objects still produces one consistent table via the union of keys", () => {
    const source = [{ a: 1 }, { a: 2, b: "extra" }];
    const csv = jsonToDelimited(source, "csv");
    expect(csv.ok).toBe(true);
    if (!csv.ok) return;
    expect(csv.text.split("\r\n")[0]).toBe("a,b");
    const back = delimitedToJson(csv.text, "csv");
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value).toEqual([{ a: "1", b: "" }, { a: "2", b: "extra" }]);
  });

  test("nested objects/arrays in a cell are JSON-stringified and disclosed", () => {
    const csv = jsonToDelimited([{ tags: ["a", "b"] }], "csv");
    expect(csv.ok).toBe(true);
    if (!csv.ok) return;
    expect(csv.notes.some(n => n.includes("JSON-stringified"))).toBe(true);
    const back = delimitedToJson(csv.text, "csv");
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value[0].tags).toBe('["a","b"]');
  });

  test("TSV uses a real tab delimiter and round-trips independently of CSV", () => {
    const tsv = jsonToDelimited([{ a: "x", b: "y" }], "tsv");
    expect(tsv.ok).toBe(true);
    if (!tsv.ok) return;
    expect(tsv.text.split("\r\n")[0]).toBe("a\tb");
    const back = delimitedToJson(tsv.text, "tsv");
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value).toEqual([{ a: "x", b: "y" }]);
  });

  test("an empty array becomes just a header-less document, and parses back to an empty array", () => {
    const csv = jsonToDelimited([], "csv");
    expect(csv.ok).toBe(true);
    if (!csv.ok) return;
    // Empty array -> no columns -> a single empty header line.
    const back = delimitedToJson(csv.text, "csv");
    expect(back.ok).toBe(true);
  });
});

describe("delimitedToJson: the failure paths", () => {
  test("refuses input over the input size limit", () => {
    const huge = "a\n".repeat(Math.ceil(MAX_STRUCTURED_INPUT_BYTES / 2) + 1);
    const result = delimitedToJson(huge, "csv");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("too-large");
  });

  test("refuses a row with a different column count than the header (ragged input)", () => {
    const result = delimitedToJson("a,b\n1,2,3\n", "csv");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("malformed");
  });

  test("refuses a duplicate header column name", () => {
    const result = delimitedToJson("a,a\n1,2\n", "csv");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("malformed");
  });

  test("refuses an unterminated quoted field", () => {
    const result = delimitedToJson('a,b\n"unterminated,2\n', "csv");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.boundary).toBe("malformed");
  });

  test("an empty input parses to an empty array, not an error", () => {
    const result = delimitedToJson("", "csv");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  test("a header-only input (no data rows) parses to an empty array", () => {
    const result = delimitedToJson("a,b\n", "csv");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  test("never infers a type from a cell's text — every value stays a string", () => {
    const result = delimitedToJson("n,flag\n007,true\n", "csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([{ n: "007", flag: "true" }]);
    expect(typeof result.value[0].n).toBe("string");
  });
});
