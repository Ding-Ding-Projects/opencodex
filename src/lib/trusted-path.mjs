import { existsSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Whether a PATH entry *is* the current directory. The hijack this guards against is
 * Windows resolving a bare command name out of the directory opencodex was launched
 * from, so only that exact directory has to be skipped — every candidate we hand to
 * spawn is an absolute path, which is what actually defeats the implicit cwd-first
 * search.
 *
 * Deliberately not a subtree test: npm's default Windows global prefix is
 * `%AppData%\npm` (`C:\Users\x\AppData\Roaming\npm`) and Bun's is `%UserProfile%\.bun\bin`,
 * so excluding everything under the cwd would fail closed for anyone whose shell sits
 * in their home directory — a normal setup, not the untrusted-project case this
 * hardening is for.
 */
function isCurrentDirectory(cwd, entry) {
  const left = win32.resolve(entry);
  const right = win32.resolve(cwd);
  return left.toLowerCase() === right.toLowerCase();
}

function cleanPathEntry(entry) {
  const trimmed = entry.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * First absolute, non-cwd PATH entry holding `command` + a PATHEXT extension, or null.
 *
 * Windows-only by construction (win32 path semantics, PATHEXT); callers decide what a
 * null means for them. Shared by the npm and Bun update resolutions so the cwd-hijack
 * defense has exactly one implementation — two copies of this rule would be two rules
 * the moment either is edited.
 */
export function resolveOnTrustedPath(command, env = process.env, deps = {}) {
  const exists = deps.exists ?? existsSync;
  const cwd = deps.cwd ?? process.cwd();
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const pathEntries = (env.PATH ?? env.Path ?? "")
    .split(win32.delimiter)
    .map(cleanPathEntry)
    .filter(Boolean);

  for (const entry of pathEntries) {
    if (!win32.isAbsolute(entry)) continue;
    if (isCurrentDirectory(cwd, entry)) continue;
    for (const extension of extensions) {
      const candidate = win32.join(entry, `${command}${extension.toLowerCase()}`);
      if (exists(candidate)) return win32.resolve(candidate);
    }
  }
  return null;
}
