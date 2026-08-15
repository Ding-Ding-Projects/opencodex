import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildOllamaCatalog } from "../src/lib/model-runtime/catalog";
import type { HardwareFacts } from "../src/lib/model-runtime/types";

const BASE_URL = "http://127.0.0.1:11434";

let originalFetch: typeof fetch;
let responder: (url: string, init: RequestInit | undefined) => Promise<Response> | Response;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return responder(url, init);
  }) as typeof fetch;
});

afterEach(() => { globalThis.fetch = originalFetch; });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const NO_HARDWARE: HardwareFacts = {
  detectedAt: 0, platform: "win32", totalRamBytes: null, freeRamBytes: null, gpus: [], freeDiskBytes: null, diskPath: null, warnings: [],
};
const GENEROUS_HARDWARE: HardwareFacts = {
  detectedAt: 0, platform: "win32", totalRamBytes: 64 * 1024 ** 3, freeRamBytes: 40 * 1024 ** 3,
  gpus: [{ name: "RTX 4090", vramBytes: 24 * 1024 ** 3, source: "nvidia-smi", caveats: [] }],
  freeDiskBytes: 500 * 1024 ** 3, diskPath: "C:\\", warnings: [],
};

describe("buildOllamaCatalog", () => {
  test("exhaustive: every installed tag appears, none silently dropped", async () => {
    responder = async url => {
      if (url.includes("/api/tags")) {
        return jsonResponse({
          models: [
            { name: "llama3.1:8b", size: 4_920_000_000, details: { parameter_size: "8.0B" } },
            { name: "phi3:mini", size: 2_200_000_000, details: { parameter_size: "3.8B" } },
            { name: "qwen2.5:72b", size: 40_000_000_000, details: { parameter_size: "72B" } },
          ],
        });
      }
      if (url.includes("/api/ps")) return jsonResponse({ models: [{ name: "phi3:mini", size_vram: 2_500_000_000 }] });
      if (url.includes("/api/show")) return jsonResponse({ capabilities: ["completion"], model_info: {}, details: {} });
      throw new Error(`unexpected ${url}`);
    };
    const result = await buildOllamaCatalog(BASE_URL, "0.6.2", GENEROUS_HARDWARE);
    expect(result.entries.map(e => e.name)).toEqual(["llama3.1:8b", "phi3:mini", "qwen2.5:72b"]);
    expect(result.pageCount).toBe(1);
    expect(result.sourceRevision).toBe("0.6.2");
    expect(result.completeness.verdict).toBe("complete");
  });

  test("running state is combined from /api/ps without hiding either set", async () => {
    responder = async url => {
      if (url.includes("/api/tags")) return jsonResponse({ models: [{ name: "phi3:mini", size: 1 }] });
      if (url.includes("/api/ps")) return jsonResponse({ models: [{ name: "phi3:mini", size_vram: 999 }] });
      if (url.includes("/api/show")) return jsonResponse({});
      throw new Error("unexpected");
    };
    const result = await buildOllamaCatalog(BASE_URL, null, NO_HARDWARE);
    expect(result.entries[0].running).toBe(true);
    expect(result.entries[0].runningVramBytes).toBe(999);
  });

  test("a show failure for one tag marks completeness partial but keeps the entry (never dropped)", async () => {
    // /api/show is a POST with the model name in the JSON body, not the URL, and
    // catalog.ts fans the two tags out with SHOW_CONCURRENCY=4 (i.e. concurrently),
    // so which tag's show call lands first is not guaranteed — key the failure off
    // the request body instead of call order.
    responder = async (url, init) => {
      if (url.includes("/api/tags")) return jsonResponse({ models: [{ name: "ok:1b", size: 1 }, { name: "broken:1b", size: 1 }] });
      if (url.includes("/api/ps")) return jsonResponse({ models: [] });
      if (url.includes("/api/show")) {
        const requested = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        return requested.model === "broken:1b" ? new Response("boom", { status: 500 }) : jsonResponse({});
      }
      throw new Error("unexpected");
    };
    const result = await buildOllamaCatalog(BASE_URL, null, NO_HARDWARE);
    expect(result.entries).toHaveLength(2);
    expect(result.completeness.verdict).toBe("partial");
    expect(result.entries.some(e => !e.showOk)).toBe(true);
  });

  test("tags unreachable → completeness unavailable, empty entries, never guessed", async () => {
    responder = async url => {
      if (url.includes("/api/tags")) return new Response("boom", { status: 500 });
      throw new Error("unexpected");
    };
    const result = await buildOllamaCatalog(BASE_URL, null, NO_HARDWARE);
    expect(result.entries).toEqual([]);
    expect(result.completeness.verdict).toBe("unavailable");
    expect(result.pageCount).toBe(0);
  });

  test("every entry carries a fit verdict computed against the passed-in hardware", async () => {
    responder = async url => {
      if (url.includes("/api/tags")) return jsonResponse({ models: [{ name: "tiny:1b", size: 700_000_000, details: { parameter_size: "1B" } }] });
      if (url.includes("/api/ps")) return jsonResponse({ models: [] });
      if (url.includes("/api/show")) return jsonResponse({});
      throw new Error("unexpected");
    };
    const result = await buildOllamaCatalog(BASE_URL, null, GENEROUS_HARDWARE);
    expect(result.entries[0].fit.verdict).toBe("runs-well");
    expect(result.entries[0].fit.evidence.length).toBeGreaterThan(0);
  });
});
