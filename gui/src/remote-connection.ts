/**
 * Build the HTTP endpoint used when a person connects to another OpenCodex
 * dashboard on the local network. Discovery is helpful, not authoritative: a
 * device may be hidden by Wi-Fi isolation or a firewall, so the manual route
 * must use the same validation and URL shape as discovered results.
 */

export const DEFAULT_REMOTE_PORT = 10100;

export type RemoteEndpointError = "host" | "port";

export type RemoteEndpointResult =
  | { ok: true; url: string; host: string; port: number }
  | { ok: false; error: RemoteEndpointError };

function validIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every(part => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const number = Number(part);
    return number >= 0 && number <= 255;
  });
}

function normalizedHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\x00- /?#@\\]/.test(trimmed)) return null;

  // An IPv6 literal may arrive already bracketed from a copied URL. The output
  // always brackets it exactly once because the port follows it.
  const unbracketed = trimmed.startsWith("[") || trimmed.endsWith("]")
    ? (trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : null)
    : trimmed;
  if (!unbracketed) return null;

  if (unbracketed.includes(":")) {
    if (!/^[0-9a-fA-F:.]+$/.test(unbracketed)) return null;
    try {
      const parsed = new URL(`http://[${unbracketed}]:${DEFAULT_REMOTE_PORT}`);
      if (parsed.hostname !== `[${unbracketed.toLowerCase()}]`) return null;
    } catch {
      return null;
    }
    return `[${unbracketed}]`;
  }

  if (validIpv4(unbracketed)) return unbracketed;
  if (/^\d[\d.]*$/.test(unbracketed)) return null;

  const labels = unbracketed.split(".");
  if (labels.some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) return null;
  return unbracketed;
}

export function buildRemoteEndpoint(hostInput: string, portInput: string): RemoteEndpointResult {
  const host = normalizedHost(hostInput);
  if (!host) return { ok: false, error: "host" };

  const portText = portInput.trim();
  if (!/^\d+$/.test(portText)) return { ok: false, error: "port" };
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return { ok: false, error: "port" };

  return { ok: true, host, port, url: `http://${host}:${port}` };
}
