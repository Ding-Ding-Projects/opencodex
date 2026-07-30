import { rmSync } from "node:fs";

/**
 * Remove a test's temporary directory without ever throwing out of a hook.
 *
 * This exists because of a failure mode that is genuinely expensive to diagnose:
 * when a teardown hook throws, the runner charges the exception to whichever test
 * runs NEXT. The reported failure is then never the one that broke — it moves
 * between runs, it is always fast, and it never reproduces in isolation, so it
 * reads exactly like flakiness and gets re-run until green. Two separate CI
 * failures in this repo were that, wearing two different test names.
 *
 * Two errnos cause it, and `force: true` only covers the first:
 * - **ENOENT** — the directory is already gone. `existsSync` first is a TOCTOU
 *   race, not a guard.
 * - **EBUSY / EPERM** — Windows still has a handle open inside the directory,
 *   usually a spawned process or a file a detached task has not closed yet. No
 *   flag suppresses this; the handle simply has to go away first.
 *
 * So: retry briefly for the lock to clear, then give up quietly. A temp directory
 * the OS has not released is housekeeping, not a test result, and the OS reclaims
 * it anyway. What must never happen is that housekeeping failing a stranger's test.
 */
export function removeTempDir(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // Busy-wait rather than await: teardown hooks are frequently synchronous, and
      // a helper that only worked in an async hook would be the wrong shape here.
      const until = Date.now() + 20;
      while (Date.now() < until) { /* let the handle close */ }
    }
  }
}
