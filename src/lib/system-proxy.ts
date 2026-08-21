import { execFileSync } from "node:child_process";

export type StaticSystemProxy = {
  proxy: string;
  source: "windows-static";
};

export type SystemProxyReader = (file: string, args: string[]) => string;

const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

function parseRegValue(output: string, name: string): string | undefined {
  const line = output.split(/\r?\n/).find(row => new RegExp(`\\b${name}\\s+REG_`).test(row));
  if (!line) return undefined;
  const match = line.match(/\s+REG_[A-Z0-9_]+\s+(.*)$/);
  return match?.[1]?.trim();
}

function normalizeProxyCandidate(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    if (!parsed.hostname || parsed.port === "0") return undefined;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/**
 * Read only the user's static WinINet proxy. PAC, WPAD, auto-detect, and live
 * configuration mutation are deliberately outside this API.
 */
export function detectStaticWindowsSystemProxy(
  reader: SystemProxyReader = (file, args) => execFileSync(file, args, { encoding: "utf8", windowsHide: true }),
  platform: NodeJS.Platform = process.platform,
): StaticSystemProxy | null {
  if (platform !== "win32") return null;
  let output: string;
  try {
    output = reader("reg.exe", ["query", INTERNET_SETTINGS_KEY, "/v", "ProxyEnable", "/v", "ProxyServer", "/v", "AutoConfigURL"]);
  } catch {
    return null;
  }
  const enabled = parseRegValue(output, "ProxyEnable");
  if (enabled !== "0x1" && enabled !== "1") return null;
  // AutoConfigURL is intentionally observed but never followed. A configured PAC
  // is not a static proxy and must not silently become an unconditional direct route.
  const pac = parseRegValue(output, "AutoConfigURL");
  if (pac) return null;
  const raw = parseRegValue(output, "ProxyServer");
  if (!raw) return null;
  const candidates = raw.split(";").flatMap(part => {
    const separator = part.indexOf("=");
    return separator >= 0 ? [part.slice(separator + 1)] : [part];
  });
  const proxy = normalizeProxyCandidate(candidates.find(Boolean) ?? "");
  return proxy ? { proxy, source: "windows-static" } : null;
}

export class StaticSystemProxyUnavailableError extends Error {
  constructor() {
    super("opt-in static system proxy detection found no usable static proxy (PAC/WPAD is not supported)");
    this.name = "StaticSystemProxyUnavailableError";
  }
}
