/**
 * Pure validation for a manually entered OpenCodex dashboard endpoint.
 *
 * The result is deliberately an HTTP origin only. Authentication stays with the
 * destination dashboard and must never be placed in this URL or browser storage.
 */

export const DEFAULT_REMOTE_PORT = 10100;

export type RemoteEndpointError = "host" | "ipv4-leading-zero" | "port";

export type RemoteEndpointResult =
  | { ok: true; url: string; host: string; port: number }
  | { ok: false; error: RemoteEndpointError };

function ipv4Candidate(value: string): string[] | null {
  const parts = value.split(".");
  return parts.length === 4 && parts.every(part => /^\d+$/.test(part)) ? parts : null;
}

function normalizedIpv6(value: string): string | null {
  // URL IPv6 literals cannot carry a zone id. Restricting the alphabet before
  // parsing also keeps percent-encoded or delimiter-bearing input out.
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return null;
  try {
    const parsed = new URL(`http://[${value}]:${DEFAULT_REMOTE_PORT}`);
    return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function normalizedDnsHost(value: string): string | null {
  // RFC host names are at most 253 characters in presentation form, with
  // labels of at most 63 characters. Keep this ASCII-only so the displayed
  // destination cannot differ from browser IDNA conversion.
  if (value.length > 253) return null;
  const labels = value.split(".");
  if (labels.some(label => (
    label.length === 0
    || label.length > 63
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ))) return null;
  const host = value.toLowerCase();

  // WHATWG URL parsing treats some DNS-looking strings as legacy IPv4 forms
  // (`0x7f000001`, `0x7f.1`, and similar). Only accept a DNS spelling when the
  // browser will preserve it exactly, so the displayed destination cannot be
  // silently rewritten to another address when the tab opens.
  try {
    const parsed = new URL(`http://${host}:${DEFAULT_REMOTE_PORT}`);
    return parsed.hostname === host ? host : null;
  } catch {
    return null;
  }
}

function normalizedHost(value: string): { host: string } | { error: RemoteEndpointError } {
  // Reject rather than trim. Hidden leading/trailing whitespace must not make
  // the preview differ from the address the user entered.
  if (!value || /[\s/?#@\\]/.test(value)) return { error: "host" };

  const startsBracket = value.startsWith("[");
  const endsBracket = value.endsWith("]");
  if (startsBracket !== endsBracket) return { error: "host" };

  const unbracketed = startsBracket ? value.slice(1, -1) : value;
  if (!unbracketed) return { error: "host" };

  if (unbracketed.includes(":")) {
    const host = normalizedIpv6(unbracketed);
    return host ? { host } : { error: "host" };
  }
  if (startsBracket) return { error: "host" };

  const ipv4 = ipv4Candidate(unbracketed);
  if (ipv4) {
    if (ipv4.some(part => part.length > 1 && part.startsWith("0"))) {
      return { error: "ipv4-leading-zero" };
    }
    if (ipv4.some(part => part.length > 3 || Number(part) > 255)) {
      return { error: "host" };
    }
    return { host: ipv4.join(".") };
  }

  // Block legacy browser forms such as 127.1 or a single decimal integer,
  // which URL parsing can reinterpret as a different IPv4 destination.
  if (/^\d[\d.]*$/.test(unbracketed)) return { error: "host" };

  const host = normalizedDnsHost(unbracketed);
  return host ? { host } : { error: "host" };
}

export function buildRemoteEndpoint(hostInput: string, portInput: string): RemoteEndpointResult {
  const hostResult = normalizedHost(hostInput);
  if ("error" in hostResult) return { ok: false, error: hostResult.error };

  if (!/^\d+$/.test(portInput)) return { ok: false, error: "port" };
  const port = Number(portInput);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: "port" };
  }

  return {
    ok: true,
    host: hostResult.host,
    port,
    url: `http://${hostResult.host}:${port}`,
  };
}
