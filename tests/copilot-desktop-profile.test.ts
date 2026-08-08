import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatCompletionsToResponsesBody, ChatCompletionsRequestError } from "../src/chat/inbound";
import {
  buildCopilotDesktopProfile,
  clearCopilotObservedRequestForTests,
  getCopilotObservedRequest,
} from "../src/chat/copilot-profile";
import { responsesSseToChatCompletionsSse } from "../src/chat/outbound";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import {
  assertServerAuthConfig,
  classifyDataPlaneCredential,
  isDataPlaneAdmissionSecret,
} from "../src/server/auth-cors";
import { handleChatCompletions } from "../src/server/chat-completions";
import { handleManagementAPI } from "../src/server/management-api";
import { clearRequestLogsForTests, getRequestLogEntries } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const PURPOSE = "github-copilot-desktop" as const;
const PROFILE_KEY = "ocx_data_copilot_profile_secret";
const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const originalFetch = globalThis.fetch;
let previousHome: string | undefined;
let testDir = "";
let isolatedCodexHome: IsolatedCodexHome | null = null;

function profileEntry() {
  return {
    id: "copilot-key",
    name: "GitHub Copilot Desktop",
    key: PROFILE_KEY,
    createdAt: "2026-08-07T00:00:00.000Z",
    purpose: PURPOSE,
  };
}

function profileConfig(baseUrl = "http://127.0.0.1:9/v1", hostname = "127.0.0.1"): OcxConfig {
  return {
    port: 0,
    hostname,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl,
        apiKey: "access-token-value-upstream",
        allowPrivateNetwork: true,
        liveModels: false,
        models: ["test-model"],
        modelInputModalities: { "test-model": ["text"] },
        modelReasoningEfforts: { "test-model": ["low", "high"] },
      },
    },
    apiKeys: [profileEntry()],
  };
}

function profileHeaders(channel: "authorization" | "x-api-key" | "x-opencodex-api-key"): HeadersInit {
  return channel === "authorization"
    ? { authorization: `Bearer ${PROFILE_KEY}` }
    : { [channel]: PROFILE_KEY };
}

function chatBody(extra: Record<string, unknown> = {}) {
  return {
    model: "mock/test-model",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
    ...extra,
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-copilot-profile-"));
  process.env.OPENCODEX_HOME = testDir;
  isolatedCodexHome = installIsolatedCodexHome("ocx-copilot-profile-codex-");
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  globalThis.fetch = originalFetch;
  clearCopilotObservedRequestForTests();
  clearRequestLogsForTests();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  globalThis.fetch = originalFetch;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  clearCopilotObservedRequestForTests();
  clearRequestLogsForTests();
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("GitHub Copilot Desktop credential identity", () => {
  for (const channel of ["authorization", "x-api-key", "x-opencodex-api-key"] as const) {
    test(`classifies a purpose key from ${channel} without returning the secret`, () => {
      const config = profileConfig();
      const classified = classifyDataPlaneCredential(new Request("http://localhost/v1/models", {
        headers: profileHeaders(channel),
      }), config);
      expect(classified).toEqual({
        channel,
        source: "configured",
        keyId: "copilot-key",
        purpose: PURPOSE,
      });
      expect(JSON.stringify(classified)).not.toContain(PROFILE_KEY);
    });
  }

  test("purpose keys cannot secure a non-loopback bind or act as generic remote admission", () => {
    const config = profileConfig(undefined, "0.0.0.0");
    expect(() => assertServerAuthConfig(config)).toThrow("data-plane credential");
    expect(isDataPlaneAdmissionSecret(PROFILE_KEY, config)).toBe(false);
  });
});

describe("GitHub Copilot Desktop key management", () => {
  test("create reveals the key once and safe summaries retain only bounded purpose metadata", async () => {
    const config = profileConfig();
    config.apiKeys = [];
    saveConfig(config);
    const post = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost" },
      body: JSON.stringify({ name: "Copilot integration", purpose: PURPOSE }),
    });
    const createdResponse = await handleManagementAPI(post, new URL(post.url), config);
    expect(createdResponse?.status).toBe(201);
    const created = await createdResponse!.json() as Record<string, unknown>;
    expect(created.purpose).toBe(PURPOSE);
    expect(typeof created.key).toBe("string");

    const get = new Request("http://localhost/api/keys", { headers: { host: "localhost" } });
    const summaryResponse = await handleManagementAPI(get, new URL(get.url), config);
    const summaryText = await summaryResponse!.text();
    const summary = JSON.parse(summaryText) as { keys: Array<Record<string, unknown>> };
    expect(summary.keys[0]?.purpose).toBe(PURPOSE);
    expect(summary.keys[0]?.key).toBeUndefined();
    expect(summaryText).not.toContain(String(created.key));
  });

  test("create rejects unknown purpose metadata", async () => {
    const config = profileConfig();
    const request = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost" },
      body: JSON.stringify({ name: "wrong", purpose: "another-client" }),
    });
    const response = await handleManagementAPI(request, new URL(request.url), config);
    expect(response?.status).toBe(400);
  });
});

describe("GitHub Copilot Desktop strict Chat Completions", () => {
  const invalidRequests = [
    ["unknown role", { messages: [{ role: "observer", content: "x" }] }],
    ["unknown content", { messages: [{ role: "user", content: [{ type: "audio", audio: "x" }] }] }],
    ["legacy functions", { functions: [{ name: "old" }] }],
    ["multiple choices", { n: 2 }],
    ["log probabilities", { logprobs: true }],
    ["unknown field", { mystery_control: true }],
    ["malformed image", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "file:///tmp/a.png" } }] }] }],
    ["malformed tool", { tools: [{ type: "function", function: { parameters: {} } }] }],
    ["malformed tool choice", { tool_choice: { type: "function", function: {} } }],
  ] as const;

  for (const [label, override] of invalidRequests) {
    test(`rejects ${label} instead of silently dropping it`, () => {
      expect(() => chatCompletionsToResponsesBody(chatBody(override), { profile: PURPOSE }))
        .toThrow(ChatCompletionsRequestError);
    });
  }

  test("preserves generic compatibility for an unknown role", () => {
    const body = chatCompletionsToResponsesBody({
      model: "mock/test-model",
      messages: [{ role: "observer", content: "ignored" }, { role: "user", content: "kept" }],
    });
    expect((body.input as unknown[]).length).toBe(1);
  });

  test("returns OpenAI-shaped 413 before reading a declared oversized profile body", async () => {
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(17 * 1024 * 1024) },
      body: JSON.stringify(chatBody()),
    });
    const response = await handleChatCompletions(
      request,
      profileConfig(),
      { model: "unknown", provider: "unknown" },
      undefined,
      { profile: PURPOSE },
    );
    expect(response.status).toBe(413);
    const json = await response.json() as { error: { type: string; code: string } };
    expect(json.error).toMatchObject({ type: "invalid_request_error", code: "request_too_large" });
  });

  test("emits usage only as the requested empty-choices stream chunk", async () => {
    const upstreamFrames = [
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } })}\n\n`,
    ].join("");
    const makeUpstream = () => new Response(upstreamFrames).body!;
    const without = await new Response(responsesSseToChatCompletionsSse(makeUpstream(), "test", {
      includeUsage: false,
      separateUsageChunk: false,
    })).text();
    expect(without).not.toContain('"usage"');

    const withUsage = await new Response(responsesSseToChatCompletionsSse(makeUpstream(), "test", {
      includeUsage: true,
      separateUsageChunk: true,
    })).text();
    const chunks = withUsage.split("\n\n")
      .filter(block => block.startsWith("data: {") && block.includes('"usage"'))
      .map(block => JSON.parse(block.slice(6)) as { choices: unknown[]; usage: unknown });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.choices).toEqual([]);
    expect(withUsage.match(/data: \[DONE\]/g)).toHaveLength(1);
  });
});

describe("GitHub Copilot Desktop end-to-end profile", () => {
  test("profile discovery exposes only callable routed models and updates token-free readiness", async () => {
    const config = profileConfig();
    saveConfig(config);
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/models", server.url), {
        headers: profileHeaders("authorization"),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { data: Array<{ id: string }> };
      expect(body.data.map(model => model.id)).toEqual(["mock/test-model"]);
      expect(getCopilotObservedRequest()).toMatchObject({ endpoint: "models", status: 200 });

      const profile = await buildCopilotDesktopProfile(config);
      expect(profile.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(profile.wireApi).toBe("completions");
      expect(profile.models.find(model => model.id === "mock/test-model")).toMatchObject({
        ready: true,
        capabilities: {
          chat: "supported",
          tools: "supported",
          images: "unsupported",
          reasoning: "supported",
          structuredOutput: "unsupported",
        },
      });
      expect(JSON.stringify(profile)).not.toContain(PROFILE_KEY);
      expect(JSON.stringify(profile)).not.toContain("access-token-value-upstream");
    } finally {
      server.stop(true);
    }
  });

  test("all supported credential channels are consumed and never forwarded upstream", async () => {
    const seen: Array<{ authorization: string | null; xApiKey: string | null; xOcxKey: string | null }> = [];
    const upstream = Bun.serve({
      port: 0,
      async fetch(request) {
        seen.push({
          authorization: request.headers.get("authorization"),
          xApiKey: request.headers.get("x-api-key"),
          xOcxKey: request.headers.get("x-opencodex-api-key"),
        });
        return new Response([
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const config = profileConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`);
    saveConfig(config);
    const server = startServer(0);
    try {
      for (const channel of ["authorization", "x-api-key", "x-opencodex-api-key"] as const) {
        const response = await fetch(new URL("/v1/chat/completions", server.url), {
          method: "POST",
          headers: { "content-type": "application/json", ...profileHeaders(channel) },
          body: JSON.stringify(chatBody()),
        });
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(seen).toHaveLength(3);
      for (const headers of seen) {
        expect(headers.authorization).toBe("Bearer access-token-value-upstream");
        expect(headers.authorization).not.toContain(PROFILE_KEY);
        expect(headers.xApiKey).toBeNull();
        expect(headers.xOcxKey).toBeNull();
      }
      await Bun.sleep(25);
      expect(getRequestLogEntries().some(entry => entry.surface === PURPOSE && entry.status === 200)).toBe(true);
    } finally {
      server.stop(true);
      upstream.stop(true);
    }
  });

  test("rejects a profile key on a non-loopback bind even when another remote credential secures the server", async () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "ordinary-remote-admission";
    const config = profileConfig(undefined, "0.0.0.0");
    saveConfig(config);
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/models", server.url), {
        headers: profileHeaders("x-api-key"),
      });
      expect(response.status).toBe(403);
      const json = await response.json() as { error: { code: string } };
      expect(json.error.code).toBe("copilot_profile_loopback_only");
    } finally {
      server.stop(true);
    }
  });

  test("rejects OpenAI Direct mode before forwarding the profile bearer", async () => {
    const config: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
      apiKeys: [profileEntry()],
    };
    saveConfig(config);
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", ...profileHeaders("authorization") },
        body: JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(response.status).toBe(400);
      const json = await response.json() as { error: { code: string; message: string } };
      expect(json.error.code).toBe("direct_mode_unsupported");
      expect(json.error.message).toContain("managed Pool mode");
    } finally {
      server.stop(true);
    }
  });

  test("token-free management DTO reports last request, providers, models, and sidecar disclosure", async () => {
    const config = profileConfig();
    const request = new Request("http://localhost/api/copilot-desktop", { headers: { host: "localhost" } });
    const response = await handleManagementAPI(request, new URL(request.url), config);
    expect(response?.status).toBe(200);
    const text = await response!.text();
    const dto = JSON.parse(text) as Record<string, unknown>;
    expect(dto).toMatchObject({
      purpose: PURPOSE,
      loopbackOnly: true,
      wireApi: "completions",
      directModeExcluded: true,
    });
    expect(Array.isArray(dto.providers)).toBe(true);
    expect(Array.isArray(dto.models)).toBe(true);
    expect(Array.isArray(dto.sidecarDisclosure)).toBe(true);
    expect(text).not.toContain(PROFILE_KEY);
    expect(text).not.toContain("access-token-value-upstream");
  });
});
