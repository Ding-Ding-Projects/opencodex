// Regression test for the privacy scanner's file-extension blind spot.
//
// scripts/privacy-scan.ts's `TEXT_FILE_RE` is the allowlist of file extensions the scanner
// reads at all (see shouldScan()). Any tracked file whose extension is not on that list is
// never opened, so none of its home-path / email / bearer-token / token-looking patterns can
// ever fire for it -- regardless of content. `bun run privacy:scan` is the credential/privacy
// CI gate documented in AGENTS.md.
//
// This repository tracks (per `git ls-files` extension counts) hundreds of `.go` files (the
// `go/` native port, which receives every change that lands on the primary branch), dozens of
// published `.mdx` files (docs-site's guide pages -- `.md` is allowlisted but `.mdx` was not, so
// MDX docs specifically went unscanned), plus `.astro`, `.mts`, `.py`, and `.bat` files -- none
// of which the old TEXT_FILE_RE matched. A real credential, email, or operator home path
// accidentally committed in any of those files (a hand-ported Go test fixture, a copy-pasted
// curl example in an .mdx guide, a debug .bat script) would never have been flagged by this
// scan, however real it was.
//
// This test proves the fix directly against the shipped scanRepository()/shouldScan()
// implementation, using an isolated temp root and an explicit `trackedFiles` list so it needs
// neither a real git checkout nor any change to the real repository tree. It asserts the safe
// target shape (an obviously-fake-but-credential-shaped Bearer token inside a tracked file of
// each newly-covered extension must be caught, the same way the identical content in a .ts file
// already is).
//
// Do not weaken these assertions to make the file report green.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { scanRepository } from "../scripts/privacy-scan";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Obviously-fake bearer token, 24+ chars, matching privacy-scan.ts's own
// `/Bearer\s+([A-Za-z0-9._-]{24,})/g` "bearer-token" pattern exactly -- the same pattern that
// DOES catch this content in a .ts/.js/.md file today.
const FAKE_SECRET_LINE = "const debugHeader = \"Bearer SECURITY-HUNT-FAKE-NOT-REAL-VALUE-0001234567890\";\n";

function scanIsolated(fileName: string): ReturnType<typeof scanRepository> {
  const root = mkdtempSync(join(tmpdir(), "ocx-privacy-scan-extension-"));
  tempRoots.push(root);
  writeFileSync(join(root, fileName), FAKE_SECRET_LINE, "utf8");
  return scanRepository({
    root,
    trackedFiles: [fileName],
    // Point the historical-design-reference check at a directory that does not exist so it
    // produces its own (unrelated, expected) "copy root is unavailable" finding instead of
    // trying to run `git` against this synthetic root -- irrelevant to what this test checks.
    designReferenceRoot: join(root, "design-reference", "original-source"),
    packageJsonPath: join(root, "package.json"), // also absent: no-ops the allowlist check
  });
}

describe("privacy-scan.ts file-extension coverage", () => {
  test("control: the same fake secret in a .ts file IS caught (proves the pattern/harness work)", () => {
    const findings = scanIsolated("fake.ts");
    expect(findings.some(f => f.file === "fake.ts" && f.kind === "bearer-token")).toBe(true);
  });

  test("a tracked .go file with the identical secret must also be caught", () => {
    const findings = scanIsolated("fake.go");
    expect(findings.some(f => f.file === "fake.go" && f.kind === "bearer-token")).toBe(true);
  });

  test("a tracked .mdx file (published docs-site content) with the identical secret must also be caught", () => {
    const findings = scanIsolated("fake.mdx");
    expect(findings.some(f => f.file === "fake.mdx" && f.kind === "bearer-token")).toBe(true);
  });

  test("a tracked .bat file with the identical secret must also be caught", () => {
    const findings = scanIsolated("fake.bat");
    expect(findings.some(f => f.file === "fake.bat" && f.kind === "bearer-token")).toBe(true);
  });

  test("a tracked .astro file with the identical secret must also be caught", () => {
    const findings = scanIsolated("fake.astro");
    expect(findings.some(f => f.file === "fake.astro" && f.kind === "bearer-token")).toBe(true);
  });

  test("a tracked .mts file with the identical secret must also be caught", () => {
    const findings = scanIsolated("fake.mts");
    expect(findings.some(f => f.file === "fake.mts" && f.kind === "bearer-token")).toBe(true);
  });

  test("a tracked .py file with the identical secret must also be caught", () => {
    const findings = scanIsolated("fake.py");
    expect(findings.some(f => f.file === "fake.py" && f.kind === "bearer-token")).toBe(true);
  });

  test("a hand-written fixture value in a Go test path is exempt the way tests/ is for TypeScript", () => {
    // isGoTestPath()'s allowance is for placeholder home-path/token content inside Go's own
    // test-only files, mirroring this project's tests/ carve-outs -- it must not blanket-exempt
    // a non-test .go file from the same directory. The value here is the hand-written shape every
    // real Go fixture uses; an entropy-shaped one stays reportable, which the suite below proves.
    const root = mkdtempSync(join(tmpdir(), "ocx-privacy-scan-extension-"));
    tempRoots.push(root);
    const handWritten = ["access", "secret", "value"].join("-");
    writeFileSync(join(root, "fake_test.go"), `const fixture = "${handWritten}"\n`, "utf8");
    const findings = scanRepository({
      root,
      trackedFiles: ["fake_test.go"],
      designReferenceRoot: join(root, "design-reference", "original-source"),
      packageJsonPath: join(root, "package.json"),
    });
    expect(findings.some(f => f.file === "fake_test.go")).toBe(false);
  });
});

describe("the Go test-path carve-out trusts a shape, not a directory", () => {
  // Trusting every path that looks like a Go test was the first shape of this carve-out, and it
  // would have let a real key pasted into a `_test.go` through the gate that exists to catch
  // exactly that. What is trusted is the hand-written fixture shape instead.
  function scanGoFixture(fileName: string, line: string): ReturnType<typeof scanRepository> {
    const root = mkdtempSync(join(tmpdir(), "ocx-privacy-go-shape-"));
    tempRoots.push(root);
    writeFileSync(join(root, fileName), line, "utf8");
    return scanRepository({
      root,
      trackedFiles: [fileName],
      designReferenceRoot: join(root, "design-reference", "original-source"),
      packageJsonPath: join(root, "package.json"),
    });
  }

  test("a hand-written fixture value in a Go test file stays quiet", () => {
    // Assembled from parts so this file does not itself contain a key-shaped literal.
    const handWritten = ["sk", "concurrency", "secret", "value"].join("-");
    const findings = scanGoFixture("quiet_test.go", `const fixture = "${handWritten}"\n`);
    expect(findings.filter(finding => finding.file === "quiet_test.go")).toEqual([]);
  });

  test("an entropy-shaped key in the same Go test file is still reported", () => {
    // Same assembly, and deliberately mixed case with a long entropy run: the shape a pasted
    // provider key has, and the shape the carve-out must keep reporting.
    const entropyShaped = ["sk", "Xk92FhQpZr71TvBnLd04WsEyRc38JmAu5Gt6"].join("-");
    const findings = scanGoFixture("leak_test.go", `const pasted = "${entropyShaped}"\n`);
    expect(findings.some(finding => finding.file === "leak_test.go")).toBe(true);
  });
});
