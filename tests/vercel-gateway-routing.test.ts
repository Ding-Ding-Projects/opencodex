import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { vercelGatewayRoutingConfigError, vercelGatewayProviderPayload } from "../src/providers/vercel-gateway-routing";
import { providerManagementConfigError, safeConfigDTO } from "../src/server/auth-cors";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

function provider(baseUrl = "https://ai-gateway.vercel.sh/v1", overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl, apiKey: "test-key", ...overrides };
}

function parsed(modelId: string): OcxParsedRequest {
  return { modelId, stream: false, context: { messages: [{ role: "user", content: "hello" }], tools: [] }, options: {} };
}

function requestBody(config: OcxProviderConfig, modelId: string): Record<string, unknown> {
  const request = createOpenAIChatAdapter(config).buildRequest(parsed(modelId));
  return JSON.parse(String(request.body)) as Record<string, unknown>;
}

describe("Vercel AI Gateway provider routing", () => {
  test("forwards only/order/sort on the documented provider shorthand", () => {
    expect(requestBody(provider(undefined, {
      vercelGatewayRouting: { only: ["novita"], order: ["novita", "deepinfra"], sort: "ttft" },
    }), "zai/glm-5.2").provider).toEqual({
      only: ["novita"], order: ["novita", "deepinfra"], sort: "ttft",
    });
  });

  test("an exact model override replaces the provider-wide preference", () => {
    expect(requestBody(provider(undefined, {
      vercelGatewayRouting: { sort: "cost" },
      modelVercelGatewayRouting: { "zai/glm-5.2": { only: ["deepinfra"] } },
    }), "zai/glm-5.2").provider).toEqual({ only: ["deepinfra"] });
  });

  test("leaves an unconfigured request byte-equivalent", () => {
    const base = provider();
    const configured = provider(undefined, { modelVercelGatewayRouting: {} });
    const a = createOpenAIChatAdapter(base).buildRequest(parsed("zai/glm-5.2"));
    const b = createOpenAIChatAdapter(configured).buildRequest(parsed("zai/glm-5.2"));
    expect(String(b.body)).toBe(String(a.body));
  });
});

describe("Vercel AI Gateway routing validation", () => {
  test("accepts a valid provider and exact model override", () => {
    expect(vercelGatewayRoutingConfigError(provider(undefined, {
      vercelGatewayRouting: { sort: "tps" },
      modelVercelGatewayRouting: { "zai/glm-5.2": { order: ["novita"] } },
    }))).toBeNull();
  });

  test.each([
    ["wrong adapter", provider(undefined, { adapter: "anthropic", vercelGatewayRouting: { sort: "cost" } }), "openai-chat"],
    ["wrong host", provider("https://ai-gateway.vercel.sh/v1/proxy", { vercelGatewayRouting: { sort: "cost" } }), "canonical"],
    ["bad sort", provider(undefined, { vercelGatewayRouting: { sort: "latency" as never } }), "sort"],
    ["empty list", provider(undefined, { vercelGatewayRouting: { only: [] } }), "1-64"],
  ] as const)("rejects %s", (_label, value, expected) => {
    expect(vercelGatewayRoutingConfigError(value)).toContain(expected);
  });

  test("management validation and safe DTO preserve validated fields", () => {
    const value = provider(undefined, { vercelGatewayRouting: { sort: "cost" } });
    expect(providerManagementConfigError("vercel-ai-gateway", value)).toBeNull();
    const dto = safeConfigDTO({ port: 10100, defaultProvider: "vercel-ai-gateway", providers: { "vercel-ai-gateway": value } } as OcxConfig) as {
      providers: Record<string, { vercelGatewayRouting?: unknown }>;
    };
    expect(dto.providers["vercel-ai-gateway"].vercelGatewayRouting).toEqual({ sort: "cost" });
  });
});

test("Vercel provider is present in the canonical registry", async () => {
  const { getProviderRegistryEntry } = await import("../src/providers/registry");
  expect(getProviderRegistryEntry("vercel-ai-gateway")?.baseUrl).toBe("https://ai-gateway.vercel.sh/v1");
});
