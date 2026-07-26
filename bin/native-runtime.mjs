import { statSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function nativeTarget(platform, architecture) {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[platform];
  const arch = { x64: "amd64", arm64: "arm64" }[architecture];
  return os && arch ? { os, arch } : null;
}

export function nativeArtifactName(version, target) {
  return `ocx_${version}_${target.os}_${target.arch}${target.os === "windows" ? ".exe" : ""}`;
}

function expandUserPath(raw) {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return raw;
}

function isExecutableFile(path, platform) {
  try {
    const stat = statSync(path);
    return stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

export function resolveNativeGoBinary({
  here,
  version,
  env = process.env,
  platform = process.platform,
  architecture = process.arch,
}) {
  const mode = (env.OPENCODEX_RUNTIME ?? "auto").trim().toLowerCase();
  if (!new Set(["auto", "go", "ts"]).has(mode)) {
    throw new Error(`selection must be one of auto, go, or ts (got ${JSON.stringify(mode)}).`);
  }
  if (mode === "ts") return null;

  const override = env.OPENCODEX_GO_BINARY?.trim();
  if (override) {
    const candidate = resolve(expandUserPath(override));
    if (isExecutableFile(candidate, platform)) return candidate;
    throw new Error(`override is not an executable file: ${candidate}`);
  }

  const target = nativeTarget(platform, architecture);
  if (target) {
    const candidate = join(here, "native", nativeArtifactName(version, target));
    if (isExecutableFile(candidate, platform)) return candidate;
  }
  if (mode === "go") {
    throw new Error("was requested but no packaged binary exists for this platform. Set OPENCODEX_GO_BINARY or use OPENCODEX_RUNTIME=ts.");
  }
  return null;
}

export function launchForwardingChild(executable, args, label) {
  const child = spawn(executable, args, { stdio: "inherit" });
  const forwarded = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = forwarded.map(signal => {
    const handler = () => {
      try { child.kill(signal); } catch { /* child already exited */ }
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  const clearHandlers = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
  child.on("error", error => {
    clearHandlers();
    console.error(`opencodex: failed to launch ${label}: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    clearHandlers();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
