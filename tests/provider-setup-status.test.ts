import { describe, expect, test } from "bun:test";
import { getDefaultConfig } from "../src/config";
import { providerConfigurationState, providerHasConfiguredApiKey } from "../src/providers/setup-status";
import { safeConfigDTO } from "../src/server/auth-cors";
import type { OcxProviderConfig } from "../src/types";

const provider = (overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig => ({
  adapter: "openai-chat",
  baseUrl: "https://provider.example/v1",
  ...overrides,
});

describe("provider configuration status", () => {
  test.each([
    ["key optional", provider({ keyOptional: true }), "key_optional"],
    ["forward", provider({ authMode: "forward" }), "forward"],
    ["oauth", provider({ authMode: "oauth" }), "oauth"],
    ["local", provider({ authMode: "local" }), "local"],
    ["loopback", provider({ baseUrl: "http://127.0.0.1:11434/v1" }), "loopback"],
    ["direct key", provider({ apiKey: "key-value" }), "api_key"],
    ["active pooled key", provider({ apiKey: "pool-key", apiKeyPool: [{ id: "one", key: "pool-key" }] }), "api_key"],
  ])("marks %s configuration ready", (_label, value, reason) => {
    expect(providerConfigurationState(value)).toEqual({ status: "ready", reason });
  });

  test("keeps disabled providers separate", () => {
    expect(providerConfigurationState(provider({ disabled: true, apiKey: "key-value" })))
      .toEqual({ status: "disabled", reason: "disabled" });
  });

  test("does not mistake arbitrary headers for a provider credential", () => {
    expect(providerConfigurationState(provider({ headers: { "x-client": "desktop" } })))
      .toEqual({ status: "needs_setup", reason: "missing_api_key" });
  });

  test("an explicit key contract outranks a loopback endpoint", () => {
    expect(providerConfigurationState(provider({
      baseUrl: "http://127.0.0.1:11434/v1",
      authMode: "key",
    }))).toEqual({ status: "needs_setup", reason: "missing_api_key" });
  });

  test("loopback readiness shares canonical localhost and mapped-IP normalization", () => {
    for (const baseUrl of [
      "http://localhost.:11434/v1",
      "http://model.localhost:11434/v1",
      "http://127.1.2.3:11434/v1",
      "http://[::ffff:127.0.0.1]:11434/v1",
    ]) {
      expect(providerConfigurationState(provider({ baseUrl })))
        .toEqual({ status: "ready", reason: "loopback" });
    }
  });

  test("registry-local providers stay keyless when moved to an allowed LAN endpoint", () => {
    const ollama = provider({
      baseUrl: "http://192.168.50.99:11434/v1",
      allowPrivateNetwork: true,
    });
    expect(providerConfigurationState(ollama, "ollama"))
      .toEqual({ status: "ready", reason: "local" });
    expect(providerConfigurationState({ ...ollama, authMode: "key" }, "ollama"))
      .toEqual({ status: "needs_setup", reason: "missing_api_key" });
  });

  test("Vertex external key or ADC auth is configuration-ready without probing secrets", () => {
    expect(providerConfigurationState(provider({ authMode: "key", googleMode: "vertex" }), "google-vertex"))
      .toEqual({ status: "ready", reason: "vertex_auth" });
    expect(providerConfigurationState(provider({ authMode: "key" }), "google-vertex"))
      .toEqual({ status: "ready", reason: "vertex_auth" });
    expect(providerConfigurationState(provider({ authMode: "key", googleMode: "ai-studio" }), "google-vertex"))
      .toEqual({ status: "needs_setup", reason: "missing_api_key" });
  });

  test("public status does not reveal whether a configured environment reference resolves", () => {
    const variable = "OCX_PROVIDER_SETUP_STATUS_MISSING";
    const previous = process.env[variable];
    delete process.env[variable];
    try {
      expect(providerConfigurationState(provider({ apiKey: `\${${variable}}` })))
        .toEqual({ status: "ready", reason: "api_key" });
      process.env[variable] = "resolved-key";
      expect(providerConfigurationState(provider({ apiKey: `\${${variable}}` })))
        .toEqual({ status: "ready", reason: "api_key" });
      expect(providerConfigurationState(provider({ apiKeyPool: [{ id: "one", key: "pool-only" }] })))
        .toEqual({ status: "needs_setup", reason: "missing_api_key" });
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });

  test("ignores blank direct and pooled keys", () => {
    const value = provider({ apiKey: "  ", apiKeyPool: [{ id: "blank", key: "  " }] });
    expect(providerHasConfiguredApiKey(value)).toBe(false);
    expect(providerConfigurationState(value).status).toBe("needs_setup");
  });

  test("safe management config exposes status without exposing key material", () => {
    const config = getDefaultConfig();
    config.providers = {
      forward: provider({ authMode: "forward" }),
      pooled: provider({ apiKey: "pool-secret", apiKeyPool: [{ id: "one", key: "pool-secret" }] }),
      missing: provider(),
    };

    const dto = safeConfigDTO(config) as {
      providers: Record<string, {
        hasApiKey: boolean;
        configurationStatus: string;
        configurationReason: string;
        apiKey?: string;
        apiKeyPool?: unknown;
      }>;
    };

    expect(dto.providers.forward).toMatchObject({
      hasApiKey: false,
      configurationStatus: "ready",
      configurationReason: "forward",
    });
    expect(dto.providers.pooled).toMatchObject({
      hasApiKey: true,
      configurationStatus: "ready",
      configurationReason: "api_key",
    });
    expect(dto.providers.missing).toMatchObject({
      hasApiKey: false,
      configurationStatus: "needs_setup",
      configurationReason: "missing_api_key",
    });
    expect(JSON.stringify(dto)).not.toContain("pool-secret");
    expect(dto.providers.pooled.apiKey).toBeUndefined();
    expect(dto.providers.pooled.apiKeyPool).toBeUndefined();
  });
});
