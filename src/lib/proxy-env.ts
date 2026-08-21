export const OUTBOUND_PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] as const;
export const PROXY_ENV_KEYS = [...OUTBOUND_PROXY_ENV_KEYS, "NO_PROXY"] as const;

export type ProxyEnvKey = typeof PROXY_ENV_KEYS[number];
export type ProxyEnvMap = Record<string, string | undefined>;

const MAX_NO_PROXY_ENTRIES = 256;
const MAX_NO_PROXY_ENTRY_LENGTH = 255;
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;

export function proxyEnvPresent(key: ProxyEnvKey, env: ProxyEnvMap = process.env): boolean {
  return Boolean(env[key]?.trim() || env[key.toLowerCase()]?.trim());
}

export function outboundProxyConfigured(env: ProxyEnvMap = process.env): boolean {
  return OUTBOUND_PROXY_ENV_KEYS.some(key => proxyEnvPresent(key, env));
}

export function validateNoProxyEntry(value: unknown): string | null {
  if (typeof value !== "string") return "NO_PROXY entries must be strings";
  const entry = value.trim();
  if (!entry) return "NO_PROXY entries must not be empty";
  if (entry.length > MAX_NO_PROXY_ENTRY_LENGTH) return "NO_PROXY entries are too long";
  if (CONTROL_OR_SPACE.test(entry)) return "NO_PROXY entries must not contain spaces or control characters";
  if (entry === "*" || entry.includes("*")) return "NO_PROXY wildcards are not supported";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) || entry.includes("@") || entry.includes("?") || entry.includes("#")) {
    return "NO_PROXY entries must be host, address, or host:port values without URLs or credentials";
  }
  if (entry.startsWith(".") || entry.endsWith(".")) return "NO_PROXY entries must not use ambiguous leading or trailing dots";
  const bracketed = /^\[[0-9a-f:.]+\](?::\d+)?$/i.test(entry);
  const hostPort = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?$/i.test(entry);
  const ipv6 = /^[0-9a-f:.]+$/i.test(entry) && entry.includes(":") && !entry.includes("/");
  if (!bracketed && !hostPort && !ipv6) return "NO_PROXY entry is not a host, IP address, or bracketed IPv6 address";
  const port = entry.match(/:(\d{1,5})\]?$/)?.[1];
  if (port && (Number(port) < 1 || Number(port) > 65535)) return "NO_PROXY port must be between 1 and 65535";
  return null;
}

export function normalizeNoProxyEntries(value: unknown): string[] {
  const raw = value === undefined || value === null
    ? []
    : Array.isArray(value) ? value.flatMap(item => typeof item === "string" ? item.split(",") : [item])
      : typeof value === "string" ? value.split(",") : [value];
  const filtered = raw.filter(item => typeof item === "string" && item.trim().length > 0);
  if (filtered.length > MAX_NO_PROXY_ENTRIES) throw new Error("NO_PROXY has too many entries");
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of filtered) {
    const error = validateNoProxyEntry(item);
    if (error) throw new Error(error);
    const normalized = (item as string).trim();
    const key = normalized.toLowerCase();
    if (!seen.has(key)) { seen.add(key); result.push(normalized); }
  }
  return result;
}

export function mergeNoProxyEntries(
  configured: unknown,
  inherited: ProxyEnvMap = process.env,
): string[] {
  const inheritedValue = inherited.NO_PROXY ?? inherited.no_proxy ?? "";
  const entries = normalizeNoProxyEntries(inheritedValue);
  for (const entry of normalizeNoProxyEntries(configured)) {
    if (!entries.some(existing => existing.toLowerCase() === entry.toLowerCase())) entries.push(entry);
  }
  for (const loopback of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
    if (!entries.some(existing => existing.toLowerCase() === loopback.toLowerCase())) entries.push(loopback);
  }
  if (entries.length > MAX_NO_PROXY_ENTRIES) throw new Error("NO_PROXY has too many entries");
  return entries;
}

export function proxyEnvironment(
  config: { proxy?: string; noProxy?: unknown; systemProxy?: "off" | "static" },
  inherited: ProxyEnvMap = process.env,
  detectedProxy?: string,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  const proxy = config.proxy?.trim() || detectedProxy?.trim();
  if (proxy) {
    if (!proxyEnvPresent("HTTP_PROXY", inherited)) env.HTTP_PROXY = proxy;
    if (!proxyEnvPresent("HTTPS_PROXY", inherited)) env.HTTPS_PROXY = proxy;
  }
  const hasProxyInputs = Boolean(proxy || config.noProxy !== undefined || inherited.NO_PROXY?.trim() || inherited.no_proxy?.trim());
  if (hasProxyInputs) env.NO_PROXY = mergeNoProxyEntries(config.noProxy, inherited).join(",");
  return env;
}
