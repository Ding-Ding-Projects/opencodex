import { rmSync } from "node:fs";

/** Best-effort Windows-safe cleanup for test-owned temporary directories. */
export function removeTempDir(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      const until = Date.now() + 20;
      while (Date.now() < until) { /* allow a closing handle to settle */ }
    }
  }
}
