/**
 * Deterministic capture preflight. This lane intentionally does not capture
 * pixels yet; it proves the exact one-page CDP target before a future shutter.
 */

export interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("CDP_URL_CREDENTIALS");
  url.hash = "";
  return url.href;
}

export function assertSinglePageTarget(targets: unknown, expectedUrl: string): CdpTarget {
  if (!Array.isArray(targets)) throw new Error("CDP_TARGET_LIST_NOT_ARRAY");
  if (targets.length !== 1) throw new Error("CDP_TARGET_COUNT_NOT_ONE");
  const target = targets[0] as CdpTarget;
  if (!target || target.type !== "page") throw new Error("CDP_TARGET_NOT_PAGE");
  if (normalizeUrl(String(target.url || "")) !== normalizeUrl(expectedUrl)) throw new Error("CDP_TARGET_URL_MISMATCH");
  const socket = String(target.webSocketDebuggerUrl || "");
  if (!/^ws:\/\/(127\.0\.0\.1|localhost):\d+\//.test(socket)) throw new Error("CDP_TARGET_SOCKET_NOT_LOOPBACK");
  return target;
}

async function listTargets(endpoint: string, timeoutMs = 5000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL("/json/list", endpoint);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("CDP_ENDPOINT_NOT_LOOPBACK");
    return await (await fetch(url, { signal: controller.signal })).json();
  } finally { clearTimeout(timer); }
}

if (import.meta.main) {
  if (process.argv.includes("--self-test")) {
    const expected = "http://127.0.0.1:9333/OpenCodex%20M3.dc.html?screen=dashboard&state=overview";
    const target = assertSinglePageTarget([{ type: "page", url: expected, webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/one" }], expected);
    let countError = "";
    try { assertSinglePageTarget([], expected); } catch (error) { countError = String(error); }
    if (target.type !== "page" || !countError.includes("CDP_TARGET_COUNT_NOT_ONE")) process.exit(1);
    console.log("OK design-reference-capture self-test");
  } else {
    const endpointIndex = process.argv.indexOf("--endpoint");
    const expectedIndex = process.argv.indexOf("--expected-url");
    const endpoint = endpointIndex >= 0 ? process.argv[endpointIndex + 1] : undefined;
    const expected = expectedIndex >= 0 ? process.argv[expectedIndex + 1] : undefined;
    if (!endpoint || !expected) throw new Error("usage: --endpoint <loopback> --expected-url <exact-url>");
    const target = assertSinglePageTarget(await listTargets(endpoint), expected);
    console.log(JSON.stringify({ ok: true, type: target.type, url: normalizeUrl(String(target.url)), socket: "loopback" }));
  }
}
