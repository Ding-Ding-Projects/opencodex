/**
 * REL-03: `scripts/prepare-release-assets.ts` spawns a bare `"tar"` with no pin to a known-good
 * implementation, so an entirely ordinary Windows PATH order can silently swap in a `tar` build
 * that cannot even read a plain drive-letter archive path.
 *
 * `runTar()` in scripts/prepare-release-assets.ts does `Bun.spawn(["tar", ...args], ...)` -- a
 * bare command name resolved through whatever PATH the hosting process happens to have. Git for
 * Windows (needed for `git` itself, and present on essentially every Windows dev machine and on
 * GitHub's own `windows-latest` runner image) ships its own GNU tar at
 * `C:\Program Files\Git\usr\bin\tar.exe`. Any shell, launcher, or CI step whose PATH lists that
 * directory ahead of `C:\Windows\System32` (Git Bash is the ordinary case; a `shell: bash` GitHub
 * Actions step on windows-latest is another) gets GNU tar instead of the Windows-native `bsdtar`
 * that ships in System32 -- and GNU tar's remote-archive heuristic misreads an ordinary absolute
 * Windows path like `C:\Users\...\file.tgz` as `host:file` syntax, failing with "Cannot connect to
 * C: resolve failed" before it ever looks at the file's actual bytes.
 *
 * This is not hypothetical: the repository's own committed tests/prepare-release-assets.test.ts
 * passes 13/13 run from a PowerShell-style PATH (System32 first) and fails 10/13 with exactly this
 * "Cannot connect to C: resolve failed" error run from a Git-Bash-style PATH (Git's usr/bin first)
 * -- same unmodified test file, same unmodified script, only PATH differs. This regression isolates
 * the exact mechanism with a minimal fixture so it does not depend on that other 400+ line
 * fixture's unrelated moving parts.
 *
 * Contrast: scripts/release.ts already has a documented, tested fix for this exact CLASS of bug for
 * `npm`/`gh` (see win-exec.ts's `commandInvocation`, and the comment on `runQuiet` in release.ts
 * about ".cmd shims"). That protection was never extended to the `tar` spawn in
 * prepare-release-assets.ts, which is used for real npm release-asset preparation
 * (prepare/verify/materialize), not only in tests.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptPath = join(repoRoot, "scripts", "prepare-release-assets.ts");

const GIT_FOR_WINDOWS_TAR_DIR = "C:\\Program Files\\Git\\usr\\bin";
const SYSTEM_ROOT = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
const SYSTEM32_DIR = join(SYSTEM_ROOT, "System32");
const hasGitForWindowsTar = process.platform === "win32" && existsSync(join(GIT_FOR_WINDOWS_TAR_DIR, "tar.exe"));

setDefaultTimeout(30_000);

/** The literal key name PATH is stored under in this process's own environment (Windows is case-insensitive about it, but child-process env objects are not). */
const PATH_KEY = Object.keys(process.env).find(key => key.toLowerCase() === "path") ?? "Path";

const TAR_MISPARSE_PATTERN = /cannot connect to|resolve failed/i;

/**
 * Run `prepare-release-assets.ts materialize` against a deliberately controlled PATH. The
 * `--archive` content is irrelevant to reaching the defect: GNU tar's remote-archive heuristic
 * rejects the Windows-absolute *filename argument itself* before it ever reads the file, so any
 * small dummy file reaches and exercises the same `runTar(["-tvzf", archive], ...)` spawn that
 * `validateArchiveInventory` makes on real release candidates.
 */
function runMaterializeAgainstPath(pathValue: string): { combined: string; status: number | null } {
  const work = mkdtempSync(join(tmpdir(), "ocx-tar-resolution-"));
  try {
    const archive = join(work, "dummy.tgz");
    writeFileSync(archive, "deliberately not a real tar archive; only its path matters here");
    const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
    const output = join(work, "out");
    const receipt = join(work, "receipt.env");

    const result = spawnSync(
      process.execPath,
      [scriptPath, "materialize", "--archive", archive, "--sha256", sha256, "--output", output, "--receipt", receipt],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, [PATH_KEY]: pathValue },
      },
    );
    return { combined: `${result.stdout ?? ""}\n${result.stderr ?? ""}`, status: result.status };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("REL-03: prepare-release-assets.ts tar resolution depends on PATH order", () => {
  test.skipIf(!hasGitForWindowsTar)(
    "a Git-for-Windows-first PATH (the ordinary Git Bash shape) must never surface tar's remote-host misparse",
    () => {
      // This is the actual contract: prepare-release-assets.ts prepares real release assets and
      // must behave the same regardless of which shell's PATH launched it. Today it does not --
      // this assertion is the RED half of the regression. The dummy archive is deliberately
      // invalid content either way, so a correct fix still fails this call; it must simply fail on
      // the archive's bytes, never on tar misreading the Windows path as a remote host.
      const path = [GIT_FOR_WINDOWS_TAR_DIR, SYSTEM32_DIR, SYSTEM_ROOT].join(";");
      const result = runMaterializeAgainstPath(path);

      expect(result.status, "materialize should fail either way (the dummy file is not a real archive)").not.toBe(0);
      expect(
        TAR_MISPARSE_PATTERN.test(result.combined),
        `prepare-release-assets.ts must never surface tar's "drive letter looks like a hostname" misparse merely `
        + `because Git for Windows' tar resolved first on PATH -- it must fail on the archive's actual bytes `
        + `instead, exactly like the System32-first case below. Got:\n${result.combined}`,
      ).toBe(false);
    },
  );

  test.skipIf(process.platform !== "win32")(
    "a System32-first PATH (the ordinary PowerShell / production shape) never surfaces tar's remote-host misparse",
    () => {
      const path = [SYSTEM32_DIR, SYSTEM_ROOT].join(";");
      const result = runMaterializeAgainstPath(path);

      expect(result.status, "materialize should still fail on the deliberately invalid dummy archive").not.toBe(0);
      expect(
        TAR_MISPARSE_PATTERN.test(result.combined),
        `System32's bsdtar must fail on the invalid archive CONTENT, never on the Windows path syntax itself; got:\n${result.combined}`,
      ).toBe(false);
    },
  );
});
