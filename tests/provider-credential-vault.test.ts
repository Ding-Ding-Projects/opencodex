import { expect, test } from "bun:test";
import { isProviderVaultReference, providerVaultReferenceId, resolveProviderCredential } from "../src/lib/provider-credentials";
import { migrateProviderApiKeysToVault } from "../src/providers/api-keys";
import type { OcxConfig } from "../src/types";

test("provider vault references are opaque and never resolved from their text", () => {
  expect(isProviderVaultReference("vault:provider-abc123")).toBe(true);
  expect(providerVaultReferenceId("vault:provider-abc123")).toBe("provider-abc123");
  expect(isProviderVaultReference("vault:secret with spaces")).toBe(false);
  expect(resolveProviderCredential("vault:provider-missing")).toBeUndefined();
});

test("vault migration is fail-safe when the platform vault is unavailable", () => {
  const config = {
    providerApiKeyVault: "windows",
    providers: { demo: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "plaintext-sentinel" } },
  } as unknown as OcxConfig;
  const result = migrateProviderApiKeysToVault(config);
  if (process.platform !== "win32") {
    expect(result.unavailable).toBe(true);
    expect(config.providers.demo!.apiKey).toBe("plaintext-sentinel");
  }
});
