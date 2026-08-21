import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { scanRepository } from "../scripts/privacy-scan";

const root = process.cwd();
const sourceCopy = join(root, "design-reference", "original-source");
const tempRoots: string[] = [];

setDefaultTimeout(30_000);

function overlay(): string {
  const tempRoot = mkdtempSync(join(tmpdir(), "ocx-design-privacy-"));
  const copyRoot = join(tempRoot, "original-source");
  cpSync(sourceCopy, copyRoot, { recursive: true });
  tempRoots.push(tempRoot);
  return copyRoot;
}

function designFindings(designReferenceRoot?: string) {
  return scanRepository({
    root,
    designReferenceRoot,
  }).filter(result => result.file.startsWith("design-reference/original-source/"));
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) rmSync(tempRoot, { recursive: true, force: true });
});

describe("historical design-reference privacy boundary", () => {
  test("keeps an exact historical copy excluded after every content and provenance check", () => {
    const findings = scanRepository();
    expect(findings.filter(result => result.file.startsWith("design-reference/original-source/"))).toEqual([]);
    expect(findings.some(result => result.kind === "package-allowlist")).toBe(false);
  });

  test("scans a copied file after a byte mutation instead of inheriting the exception", () => {
    const copyRoot = overlay();
    const dataPath = join(copyRoot, "ocx-data.js");
    const original = readFileSync(dataPath, "utf8");
    const sourceEmail = ["codingmachineedge", "gmail.com"].join("@");
    const replacementEmail = ["privacy-regression", "invalid"].join("@");
    writeFileSync(dataPath, original.replace(sourceEmail, replacementEmail));

    const findings = designFindings(copyRoot);
    expect(findings.some(result => result.kind === "historical-design-source")).toBe(true);
    expect(findings.some(result => result.kind === "email")).toBe(true);
  });

  test("rejects an extra path instead of allowing it to grow the copied surface", () => {
    const copyRoot = overlay();
    writeFileSync(join(copyRoot, "unlisted-fixture.txt"), "historical copy growth probe\n");

    const findings = designFindings(copyRoot);
    expect(findings).toContainEqual(expect.objectContaining({
      file: "design-reference/original-source/unlisted-fixture.txt",
      kind: "historical-design-path",
    }));
  });

  test("fails closed when the manifest is malformed and scans the copied text", () => {
    const copyRoot = overlay();
    writeFileSync(join(copyRoot, "MANIFEST.json"), "{ malformed");

    const findings = designFindings(copyRoot);
    expect(findings).toContainEqual(expect.objectContaining({
      file: "design-reference/original-source/MANIFEST.json",
      kind: "historical-design-manifest",
    }));
    expect(findings.some(result => result.kind === "email")).toBe(true);
  });

  test("fails closed when the manifest names the wrong source commit", () => {
    const copyRoot = overlay();
    const manifestPath = join(copyRoot, "MANIFEST.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { sourceCommit: string };
    manifest.sourceCommit = "0".repeat(40);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const findings = designFindings(copyRoot);
    expect(findings.some(result => result.kind === "historical-design-manifest")).toBe(true);
    expect(findings.some(result => result.kind === "email")).toBe(true);
  });
});
