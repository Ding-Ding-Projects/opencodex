import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  scanRepository,
  validateHistoricalDesignReference,
  type PrivacyScanOptions,
} from "../scripts/privacy-scan";

const root = process.cwd();
const sourceCopy = join(root, "design-reference", "original-source");
const tempRoots: string[] = [];

setDefaultTimeout(60_000);

function overlay(): string {
  const tempRoot = mkdtempSync(join(tmpdir(), "ocx-design-privacy-"));
  const copyRoot = join(tempRoot, "original-source");
  cpSync(sourceCopy, copyRoot, { recursive: true });
  tempRoots.push(tempRoot);
  return copyRoot;
}

function designFindings(designReferenceRoot?: string, options: Omit<PrivacyScanOptions, "root" | "designReferenceRoot"> = {}) {
  return scanRepository({
    root,
    designReferenceRoot,
    reparsePointCheck: () => "clear",
    ...options,
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

  test("rejects package files patterns that could select the historical copy", () => {
    const patterns = [
      "*",
      "**",
      "design-reference*",
      "./design-reference",
      "design-reference/**",
      "./design-reference/**",
      "**/design-reference/**",
    ];
    for (const pattern of patterns) {
      const packageRoot = mkdtempSync(join(tmpdir(), "ocx-package-privacy-"));
      tempRoots.push(packageRoot);
      const packagePath = join(packageRoot, "package.json");
      const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files: string[] };
      packageJson.files = [pattern];
      writeFileSync(packagePath, JSON.stringify(packageJson));
      const findings = scanRepository({ packageJsonPath: packagePath, reparsePointCheck: () => "clear" });
      expect(findings).toContainEqual(expect.objectContaining({ kind: "package-allowlist" }));
    }
  }, { timeout: 120_000 });

  test("rejects an oversized current copied file before reading its bytes", () => {
    const copyRoot = overlay();
    const dataPath = join(copyRoot, "ocx-data.js");
    writeFileSync(dataPath, Buffer.alloc(16 * 1024 * 1024 + 1, 0x41));
    const reads: string[] = [];
    const findings = scanRepository({
      trackedFiles: [],
      designReferenceRoot: copyRoot,
      reparsePointCheck: () => "clear",
      readHistoricalFile: path => {
        reads.push(path);
        return readFileSync(path);
      },
    });

    expect(findings).toContainEqual(expect.objectContaining({
      file: "design-reference/original-source/ocx-data.js",
      kind: "historical-design-source",
    }));
    expect(reads.some(path => path.endsWith("ocx-data.js"))).toBe(false);
  });

  test("fails closed when the reparse-point probe is unavailable", () => {
    const findings = designFindings(undefined, { reparsePointCheck: () => "unavailable" });
    expect(findings.some(result => result.kind === "historical-design-path")).toBe(true);
    expect(findings.some(result => result.value === "copy root is unavailable")).toBe(true);
  });

  test("detects a Windows junction when the host can create one", () => {
    if (process.platform !== "win32") return;
    const copyRoot = overlay();
    const target = join(copyRoot, "junction-target");
    const junction = join(copyRoot, "junction");
    mkdirSync(target);
    const created = spawnSync("cmd.exe", ["/d", "/c", "mklink", "/J", junction, target], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (created.status !== 0) {
      const findings = designFindings(copyRoot, { reparsePointCheck: () => "unavailable" });
      expect(findings.some(result => result.kind === "historical-design-path")).toBe(true);
      return;
    }
    try {
      const findings = scanRepository({ designReferenceRoot: copyRoot }).filter(
        result => result.file.startsWith("design-reference/original-source/"),
      );
      expect(findings).toContainEqual(expect.objectContaining({
        file: "design-reference/original-source/junction",
        kind: "historical-design-path",
        value: "path is reparse",
      }));
    } finally {
      rmSync(junction, { recursive: true, force: true });
    }
  });

  test("rejects a manifest-listed regular-file reparse point before exclusion or reading", () => {
    const copyRoot = overlay();
    const reads: string[] = [];
    const validation = validateHistoricalDesignReference(
      root,
      copyRoot,
      path => path.endsWith("ocx-data.js") ? "reparse" : "clear",
      path => {
        reads.push(path);
        return readFileSync(path);
      },
    );

    expect(validation.findings).toContainEqual(expect.objectContaining({
      file: "design-reference/original-source/ocx-data.js",
      kind: "historical-design-source",
    }));
    expect(validation.excludedFiles.has("design-reference/original-source/ocx-data.js")).toBe(false);
    expect(reads.some(path => path.endsWith("ocx-data.js"))).toBe(false);
  });
});
