import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_OLLAMA_BASE_URL,
  checkOllamaHealth,
  deleteOllamaModel,
  fetchOllamaRunning,
  fetchOllamaShow,
  fetchOllamaTags,
  resolveOllamaBaseUrl,
} from "../src/lib/model-runtime/client";
import { setExistsCheckerForTests, setProbeRunnerForTests } from "../src/lib/model-runtime/executable-detect";

let originalFetch: typeof fetch;
let responder: (url: string, init: RequestInit | undefined) => Promise<Response> | Response;
let originalOllamaHost: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return responder(url, init);
  }) as typeof fetch;
  originalOllamaHost = process.env.OLLAMA_HOST;
  delete process.env.OLLAMA_HOST;
  setExistsCheckerForTests(() => false);
  setProbeRunnerForTests(async () => false);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOllamaHost === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = originalOllamaHost;
  setExistsCheckerForTests(null);
  setProbeRunnerForTests(null);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function refused(): never {
  throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" });
}

function timedOut(): never {
  throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
}

describe("resolveOllamaBaseUrl", () => {
  test("no OLLAMA_HOST → the documented default", () => {
    expect(resolveOllamaBaseUrl()).toEqual({ baseUrl: DEFAULT_OLLAMA_BASE_URL, hostWarning: null });
  });

  test("OLLAMA_HOST=127.0.0.1:9999 → honoured, no warning", () => {
    process.env.OLLAMA_HOST = "127.0.0.1:9999";
    expect(resolveOllamaBaseUrl()).toEqual({ baseUrl: "http://127.0.0.1:9999", hostWarning: null });
  });

  test("OLLAMA_HOST=localhost:11500 → honoured (localhost counts as local)", () => {
    process.env.OLLAMA_HOST = "localhost:11500";
    const result = resolveOllamaBaseUrl();
    expect(result.baseUrl).toBe("http://localhost:11500");
    expect(result.hostWarning).toBeNull();
  });

  test("OLLAMA_HOST pointing off-machine is rejected and the default is used, with a warning", () => {
    process.env.OLLAMA_HOST = "example.com:11434";
    const result = resolveOllamaBaseUrl();
    expect(result.baseUrl).toBe(DEFAULT_OLLAMA_BASE_URL);
    expect(result.hostWarning).toContain("does not point at a local address");
  });

  test("a private-network (non-loopback) OLLAMA_HOST is also rejected, not silently trusted", () => {
    process.env.OLLAMA_HOST = "192.168.1.50:11434";
    const result = resolveOllamaBaseUrl();
    expect(result.baseUrl).toBe(DEFAULT_OLLAMA_BASE_URL);
    expect(result.hostWarning).not.toBeNull();
  });
});

describe("checkOllamaHealth — state selection", () => {
  test("healthy: root 200 and /api/version answers with a version string", async () => {
    responder = async url => {
      if (url.endsWith("/")) return new Response("Ollama is running", { status: 200 });
      if (url.endsWith("/api/version")) return jsonResponse({ version: "0.6.2" });
      throw new Error(`unexpected url ${url}`);
    };
    const result = await checkOllamaHealth();
    expect(result.state).toBe("healthy");
    expect(result.version).toBe("0.6.2");
  });

  test("unhealthy: root 200 but /api/version is malformed", async () => {
    responder = async url => {
      if (url.endsWith("/")) return new Response("Ollama is running", { status: 200 });
      return new Response("not json", { status: 200 });
    };
    const result = await checkOllamaHealth();
    expect(result.state).toBe("unhealthy");
    expect(result.version).toBeNull();
  });

  test("unhealthy: root times out", async () => {
    responder = async () => timedOut();
    const result = await checkOllamaHealth();
    expect(result.state).toBe("unhealthy");
  });

  test("missing: connection refused AND no executable found anywhere", async () => {
    responder = async () => refused();
    setExistsCheckerForTests(() => false);
    setProbeRunnerForTests(async () => false);
    const result = await checkOllamaHealth();
    expect(result.state).toBe("missing");
  });

  test("stopped: connection refused but an executable IS found", async () => {
    responder = async () => refused();
    setExistsCheckerForTests(() => true);
    const result = await checkOllamaHealth();
    expect(result.state).toBe("stopped");
  });

  test("stopped: connection refused and executable presence is inconclusive — never escalated to 'missing'", async () => {
    responder = async () => refused();
    setExistsCheckerForTests(() => false);
    setProbeRunnerForTests(async () => null);
    const result = await checkOllamaHealth();
    expect(result.state).toBe("stopped");
  });

  test("offline: a non-refusal, non-timeout network error", async () => {
    responder = async () => { throw new Error("getaddrinfo ENOTFOUND somehost"); };
    const result = await checkOllamaHealth();
    expect(result.state).toBe("offline");
  });

  test("a 3xx from the runtime is never followed and reported as unhealthy", async () => {
    responder = async () => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } });
    const result = await checkOllamaHealth();
    expect(result.state).toBe("unhealthy");
  });
});

describe("fetchOllamaTags", () => {
  test("parses a real /api/tags payload, exhaustively — no client-side filtering", async () => {
    responder = async () => jsonResponse({
      models: [
        { name: "llama3.1:8b", model: "llama3.1:8b", modified_at: "2026-01-01T00:00:00Z", size: 4_920_000_000, digest: "sha256:abc", details: { format: "gguf", family: "llama", families: ["llama"], parameter_size: "8.0B", quantization_level: "Q4_0" } },
        { name: "phi3:mini", model: "phi3:mini", modified_at: "2026-01-02T00:00:00Z", size: 2_200_000_000, digest: "sha256:def", details: { format: "gguf", family: "phi3", parameter_size: "3.8B", quantization_level: "Q4_0" } },
      ],
    });
    const result = await fetchOllamaTags("http://127.0.0.1:11434");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    expect(result.data[0].name).toBe("llama3.1:8b");
    expect(result.data[0].details.parameterSize).toBe("8.0B");
    expect(result.data[1].details.families).toBeNull();
  });

  test("an entry with no name is dropped rather than crashing the whole list", async () => {
    responder = async () => jsonResponse({ models: [{ model: "unnamed" }, { name: "real:tag" }] });
    const result = await fetchOllamaTags("http://127.0.0.1:11434");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map(e => e.name)).toEqual(["real:tag"]);
  });

  test("an oversized response is refused rather than buffered whole", async () => {
    responder = async () => jsonResponse({ models: [], padding: "x".repeat(5 * 1024 * 1024) });
    const result = await fetchOllamaTags("http://127.0.0.1:11434");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("too-large");
  });
});

describe("fetchOllamaRunning", () => {
  test("parses /api/ps", async () => {
    responder = async () => jsonResponse({ models: [{ name: "llama3.1:8b", model: "llama3.1:8b", size: 1, size_vram: 5_000_000_000, expires_at: "2026-01-01T01:00:00Z" }] });
    const result = await fetchOllamaRunning("http://127.0.0.1:11434");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].sizeVramBytes).toBe(5_000_000_000);
  });
});

describe("fetchOllamaShow", () => {
  test("finds context_length regardless of family prefix, and parameter_count from general.*", async () => {
    responder = async () => jsonResponse({
      capabilities: ["completion", "tools"],
      model_info: { "general.parameter_count": 8_030_000_000, "llama.context_length": 131072, "general.architecture": "llama" },
      details: { family: "llama", families: ["llama"], quantization_level: "Q4_0", format: "gguf" },
      license: "some license text",
    });
    const info = await fetchOllamaShow("http://127.0.0.1:11434", "llama3.1:8b");
    expect(info.ok).toBe(true);
    expect(info.contextLength).toBe(131072);
    expect(info.parameterCount).toBe(8_030_000_000);
    expect(info.capabilities).toEqual(["completion", "tools"]);
    expect(info.quantizationLevel).toBe("Q4_0");
  });

  test("a missing model_info degrades to nulls, never throws", async () => {
    responder = async () => jsonResponse({});
    const info = await fetchOllamaShow("http://127.0.0.1:11434", "ghost:1b");
    expect(info.ok).toBe(true);
    expect(info.contextLength).toBeNull();
    expect(info.parameterCount).toBeNull();
  });

  test("a failed show reports ok:false with a plain-language error, not a thrown exception", async () => {
    responder = async () => new Response("nope", { status: 404 });
    const info = await fetchOllamaShow("http://127.0.0.1:11434", "missing:1b");
    expect(info.ok).toBe(false);
    expect(info.error).toContain("404");
  });
});

describe("deleteOllamaModel", () => {
  test("success", async () => {
    responder = async () => new Response(null, { status: 200 });
    const result = await deleteOllamaModel("http://127.0.0.1:11434", "llama3.1:8b");
    expect(result.ok).toBe(true);
  });

  test("failure surfaces the HTTP status rather than pretending success", async () => {
    responder = async () => new Response("not found", { status: 404 });
    const result = await deleteOllamaModel("http://127.0.0.1:11434", "ghost:1b");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("http");
  });
});
