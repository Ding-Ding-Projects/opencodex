import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Stats } from "node:fs";

export interface DurableRuntimeEntry { runtime: string; cli: string }

export interface DurableRuntimeOptions {
  platform?: NodeJS.Platform;
  architecture?: NodeJS.Architecture;
  findNode?: () => string;
  beforePackageIdentityRecheck?: () => void;
}

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-preview\.[0-9]+)?$/;

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.mode === right.mode;
}

function regularNonSymlink(path: string, executable = false): boolean {
  try {
    const first = lstatSync(path);
    if (first.isSymbolicLink() || !first.isFile()) return false;
    if (executable && process.platform !== "win32" && (first.mode & 0o111) === 0) return false;
    return sameIdentity(first, lstatSync(path));
  } catch {
    return false;
  }
}

function defaultNodeLookup(): string {
  const names = process.platform === "win32" ? ["node.exe", "node"] : ["node"];
  for (const rawDirectory of (process.env.PATH ?? "").split(delimiter)) {
    const directory = rawDirectory.trim().replace(/^"(.*)"$/, "$1");
    if (!directory || !isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        const canonical = realpathSync(candidate);
        if (regularNonSymlink(canonical, true)) return canonical;
      } catch {
        // Continue to the next PATH entry without executing a helper.
      }
    }
  }
  return "";
}

export function durableNodeExecutable(findNode: () => string = defaultNodeLookup): string | null {
  try {
    const found = findNode().trim();
    if (!found || !isAbsolute(found)) return null;
    const canonical = realpathSync(found);
    return isAbsolute(canonical) && regularNonSymlink(canonical, true) ? canonical : null;
  } catch {
    return null;
  }
}

export function packagedNativeBinary(
  root: string,
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
  beforePackageIdentityRecheck?: () => void,
): string | null {
  const os = ({ darwin: "darwin", linux: "linux", win32: "windows" } as Partial<Record<NodeJS.Platform, string>>)[platform];
  const goarch = ({ x64: "amd64", arm64: "arm64" } as Partial<Record<string, string>>)[architecture];
  if (!os || !goarch) return null;
  const packagePath = join(root, "package.json");
  try {
    if (!regularNonSymlink(packagePath)) return null;
    const first = lstatSync(packagePath);
    const { version } = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
    if (typeof version !== "string" || !VERSION_PATTERN.test(version)) return null;
    beforePackageIdentityRecheck?.();
    if (!sameIdentity(first, lstatSync(packagePath))) return null;
    const path = join(root, "bin", "native", `ocx_${version}_${os}_${goarch}${os === "windows" ? ".exe" : ""}`);
    return regularNonSymlink(path, platform !== "win32") ? path : null;
  } catch {
    return null;
  }
}

export function preferredDurableRuntime(
  root: string,
  fallback: DurableRuntimeEntry,
  options: DurableRuntimeOptions = {},
): DurableRuntimeEntry {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const native = packagedNativeBinary(root, platform, architecture, options.beforePackageIdentityRecheck);
  if (!native) return fallback;
  const packagePath = join(root, "package.json");
  const launcher = join(root, "bin", "ocx.mjs");
  if (!regularNonSymlink(launcher)) return fallback;
  const packageSnapshot = lstatSync(packagePath);
  const nativeSnapshot = lstatSync(native);
  const launcherSnapshot = lstatSync(launcher);
  const node = durableNodeExecutable(options.findNode);
  if (!node) return fallback;
  try {
    if (!sameIdentity(packageSnapshot, lstatSync(packagePath))
      || !sameIdentity(nativeSnapshot, lstatSync(native))
      || !sameIdentity(launcherSnapshot, lstatSync(launcher))) return fallback;
  } catch {
    return fallback;
  }
  return { runtime: node, cli: launcher };
}
