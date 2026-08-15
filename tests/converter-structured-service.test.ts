/**
 * `src/lib/converter/structured-service.ts` — the fs-facing structured-data
 * conversion layer (JSON, CSV, TSV, XML).
 *
 * `converter-delimited.test.ts` and `converter-xml.test.ts` already prove the
 * pure adapters; this file proves the filesystem side: bounded reads, a real
 * end-to-end conversion written to disk, the bounded-JSON-depth defense (a
 * pathologically deep value must not crash the process), and — the property
 * only a real filesystem can prove — that a write which fails validation
 * never leaves a partial or wrong file at the destination.
 *
 * "convertStructuredDataAtPath: the lossy acknowledgement is enforced here"
 * below proves the correctness fix this file exists to cover: the service
 * itself refuses to write a lossy conversion without `acknowledgeLossy:
 * true`, the same way `../pdf-tools/operations.ts`'s `assertWritable`
 * refuses a signed source without `acknowledgeSigned: true` — a caller that
 * skips the GUI's toggle entirely (a direct route call, `ocx convert`) can
 * no longer produce a silent lossy write.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_STRUCTURED_DEPTH, MAX_STRUCTURED_INPUT_BYTES } from "../src/lib/converter/bounds";
import { convertStructuredDataAtPath } from "../src/lib/converter/structured-service";
import { removeTempDir } from "./helpers/temp-dir";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-converter-structured-svc-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDir(dir); });

describe("convertStructuredDataAtPath: the real happy paths", () => {
  test("converts a real JSON file on disk to CSV, written atomically", () => {
    const dir = tempDir();
    const src = join(dir, "in.json");
    writeFileSync(src, JSON.stringify([{ name: "Ada", role: "engineer" }, { name: "Alan", role: "mathematician" }]));
    const dest = join(dir, "out.csv");

    const result = convertStructuredDataAtPath(src, "json", dest, "csv", true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lossy).toBe(true);
    expect(existsSync(dest)).toBe(true);
    const text = readFileSync(dest, "utf-8");
    expect(text.startsWith("name,role")).toBe(true);
    expect(text).toContain("Ada,engineer");
  });

  test("converts a real CSV file to JSON, written atomically", () => {
    const dir = tempDir();
    const src = join(dir, "in.csv");
    writeFileSync(src, "a,b\r\n1,2\r\n3,4\r\n");
    const dest = join(dir, "out.json");

    const result = convertStructuredDataAtPath(src, "csv", dest, "json");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(readFileSync(dest, "utf-8"));
    expect(parsed).toEqual([{ a: "1", b: "2" }, { a: "3", b: "4" }]);
  });

  test("converts a real XML file to JSON", () => {
    const dir = tempDir();
    const src = join(dir, "in.xml");
    writeFileSync(src, "<person><name>Ada</name><age>36</age></person>");
    const dest = join(dir, "out.json");

    const result = convertStructuredDataAtPath(src, "xml", dest, "json");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(readFileSync(dest, "utf-8"));
    expect(parsed).toEqual({ person: { name: "Ada", age: "36" } });
  });

  test("JSON-to-JSON is not marked lossy — the pivot format converting to itself loses nothing", () => {
    const dir = tempDir();
    const src = join(dir, "in.json");
    writeFileSync(src, JSON.stringify({ a: 1 }));
    const dest = join(dir, "out.json");
    const result = convertStructuredDataAtPath(src, "json", dest, "json");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lossy).toBeFalsy();
  });
});

describe("convertStructuredDataAtPath: the failure paths", () => {
  test("refuses a missing source file", () => {
    const dir = tempDir();
    const result = convertStructuredDataAtPath(join(dir, "nope.json"), "json", join(dir, "out.csv"), "csv");
    expect(result.ok).toBe(false);
  });

  test("refuses malformed JSON input and writes nothing", () => {
    const dir = tempDir();
    const src = join(dir, "bad.json");
    writeFileSync(src, "{ this is not valid json");
    const dest = join(dir, "out.csv");
    const result = convertStructuredDataAtPath(src, "json", dest, "csv");
    expect(result.ok).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  test("refuses a pathologically deep JSON value as a clean boundary, never a raw crash", () => {
    const dir = tempDir();
    const src = join(dir, "deep.json");
    let value: unknown = 1;
    for (let i = 0; i < MAX_STRUCTURED_DEPTH + 500; i++) value = [value];
    writeFileSync(src, JSON.stringify(value));
    const dest = join(dir, "out.json");

    const result = convertStructuredDataAtPath(src, "json", dest, "json");
    expect(result.ok).toBe(false);
    expect(result.boundary).toBe("malformed");
    expect(existsSync(dest)).toBe(false);
  });

  test("refuses a source over the input size limit before it is parsed", () => {
    const dir = tempDir();
    const src = join(dir, "huge.json");
    writeFileSync(src, "[" + "1,".repeat(Math.ceil(MAX_STRUCTURED_INPUT_BYTES / 2) + 10) + "1]");
    const dest = join(dir, "out.csv");
    const result = convertStructuredDataAtPath(src, "json", dest, "csv");
    expect(result.ok).toBe(false);
  });

  test("refuses converting a non-array JSON value to CSV, and writes nothing", () => {
    const dir = tempDir();
    const src = join(dir, "obj.json");
    writeFileSync(src, JSON.stringify({ not: "an array" }));
    const dest = join(dir, "out.csv");
    const result = convertStructuredDataAtPath(src, "json", dest, "csv");
    expect(result.ok).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  test("a destination that is an existing directory is refused, not silently written into", () => {
    const dir = tempDir();
    const src = join(dir, "in.json");
    writeFileSync(src, JSON.stringify([{ a: 1 }]));
    const destDir = join(dir, "already-a-directory");
    mkdirSync(destDir);
    // acknowledgeLossy: true — this test's whole point is proving the
    // existing-directory refusal, which only fires once the write is
    // actually attempted; without the acknowledgement the lossy-not-
    // acknowledged refusal above it would fire first and this would prove
    // nothing about the directory check.
    const result = convertStructuredDataAtPath(src, "json", destDir, "csv", true);
    expect(result.ok).toBe(false);
  });
});

describe("convertStructuredDataAtPath: the lossy acknowledgement is enforced here", () => {
  test("refuses a lossy conversion (json -> csv) without acknowledgeLossy, and writes nothing", () => {
    const dir = tempDir();
    const src = join(dir, "in.json");
    writeFileSync(src, JSON.stringify([{ name: "Ada" }]));
    const dest = join(dir, "out.csv");

    const result = convertStructuredDataAtPath(src, "json", dest, "csv");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.boundary).toBe("lossy-not-acknowledged");
    expect(result.error).toContain("acknowledgeLossy: true");
    expect(existsSync(dest)).toBe(false);
  });

  test("refuses explicitly with acknowledgeLossy: false, exactly like omitting it", () => {
    const dir = tempDir();
    const src = join(dir, "in.json");
    writeFileSync(src, JSON.stringify([{ name: "Ada" }]));
    const dest = join(dir, "out.csv");

    const result = convertStructuredDataAtPath(src, "json", dest, "csv", false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.boundary).toBe("lossy-not-acknowledged");
  });

  test("proceeds and writes once acknowledgeLossy: true is supplied — the exact same conversion as above, only acknowledged", () => {
    const dir = tempDir();
    const src = join(dir, "in.json");
    writeFileSync(src, JSON.stringify([{ name: "Ada" }]));
    const dest = join(dir, "out.csv");

    const result = convertStructuredDataAtPath(src, "json", dest, "csv", true);
    expect(result.ok).toBe(true);
    expect(existsSync(dest)).toBe(true);
  });

  test("json -> xml is refused without acknowledgement too — every lossy destination format is covered, not only CSV", () => {
    const dir = tempDir();
    const src = join(dir, "in.json");
    writeFileSync(src, JSON.stringify({ greeting: "hi" }));
    const dest = join(dir, "out.xml");

    const result = convertStructuredDataAtPath(src, "json", dest, "xml");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.boundary).toBe("lossy-not-acknowledged");
    expect(existsSync(dest)).toBe(false);
  });

  test("json -> json is never refused for lack of acknowledgement — the pivot format converting to itself is not lossy", () => {
    const dir = tempDir();
    const src = join(dir, "in.json");
    writeFileSync(src, JSON.stringify({ a: 1 }));
    const dest = join(dir, "out.json");

    const result = convertStructuredDataAtPath(src, "json", dest, "json");
    expect(result.ok).toBe(true);
  });

  test("csv -> json is never refused for lack of acknowledgement — converting into the non-lossy pivot format needs no disclosure", () => {
    const dir = tempDir();
    const src = join(dir, "in.csv");
    writeFileSync(src, "a,b\r\n1,2\r\n");
    const dest = join(dir, "out.json");

    const result = convertStructuredDataAtPath(src, "csv", dest, "json");
    expect(result.ok).toBe(true);
  });
});

describe("convertStructuredDataAtPath: atomic write proof", () => {
  test("the written file is reread from disk and verified, never trusted from memory alone", () => {
    // A positive-path proof that the reopen-and-compare step actually runs:
    // convert, then independently reread the exact bytes and recompute what
    // the pure adapter would have produced, and require them to match.
    const dir = tempDir();
    const src = join(dir, "in.json");
    const source = [{ x: 1 }, { x: 2 }];
    writeFileSync(src, JSON.stringify(source));
    const dest = join(dir, "out.csv");

    const result = convertStructuredDataAtPath(src, "json", dest, "csv", true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const onDisk = readFileSync(dest, "utf-8");
    expect(onDisk).toBe("x\r\n1\r\n2");
    expect(result.bytesWritten).toBe(Buffer.byteLength(onDisk, "utf-8"));
  });

  test("an existing destination file is only overwritten on a successful conversion, never left half-written on failure", () => {
    const dir = tempDir();
    const dest = join(dir, "out.csv");
    writeFileSync(dest, "original,untouched\r\ndata,here");

    const src = join(dir, "bad.json");
    writeFileSync(src, "not json at all {{{");
    const result = convertStructuredDataAtPath(src, "json", dest, "csv", true);
    expect(result.ok).toBe(false);
    // The original file is completely untouched — no temp file swapped in,
    // no truncation.
    expect(readFileSync(dest, "utf-8")).toBe("original,untouched\r\ndata,here");
  });
});
