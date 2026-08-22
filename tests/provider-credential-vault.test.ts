import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteProviderVaultReference, isProviderVaultReference, providerVaultExportRefusal, providerVaultReferenceId, resolveProviderCredential, setProviderVaultDeleteForTests } from "../src/lib/provider-credentials";
import { setCredentialVaultSyncSeamForTests } from "../src/lib/os-credential-vault";
import { addProviderApiKey, listProviderApiKeys, migrateProviderApiKeysToVault, ProviderKeyRemovalUnresolvedError, removeProviderApiKey, setActiveProviderApiKey, setProviderApiKeySaveForTests } from "../src/providers/api-keys";
import type { OcxConfig } from "../src/types";
import { removeTempDir } from "./helpers/temp-dir";

const originalHome = process.env.OPENCODEX_HOME;
let testHome: string | undefined;
afterEach(() => {
  setCredentialVaultSyncSeamForTests(null);
  setProviderVaultDeleteForTests(null);
  setProviderApiKeySaveForTests(null);
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
  if (testHome) removeTempDir(testHome);
  testHome = undefined;
});

test("provider vault references are opaque and never resolved from their text", () => {
  expect(isProviderVaultReference("vault:provider-abc123")).toBe(true);
  expect(providerVaultReferenceId("vault:provider-abc123")).toBe("provider-abc123");
  expect(isProviderVaultReference("vault:secret with spaces")).toBe(false);
  expect(resolveProviderCredential("vault:provider-missing")).toBeUndefined();
  expect(providerVaultExportRefusal({ providerApiKeyVault: "windows" })).toContain("omitted");
  expect(providerVaultExportRefusal({ providerApiKeyVault: "off" })).toBeNull();
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

test("fake DPAPI seam supports store, restart-read, switch/remove, and ciphertext-only config", { timeout: 20_000 }, () => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-vault-seam-"));
  process.env.OPENCODEX_HOME = testHome;
  const fake = (script: string, payload: string): string => {
    const parsed = JSON.parse(payload) as { plaintextB64?: string; ciphertextB64?: string };
    if (script.includes("ProtectedData]::Protect")) return Buffer.from(`cipher:${parsed.plaintextB64 ?? ""}`).toString("base64");
    const encoded = Buffer.from(parsed.ciphertextB64 ?? "", "base64").toString("utf8");
    return encoded.startsWith("cipher:") ? encoded.slice("cipher:".length) : "";
  };
  setCredentialVaultSyncSeamForTests({ platform: "win32", runner: fake });
  const config = {
    providerApiKeyVault: "windows",
    providers: { demo: { adapter: "openai-chat", baseUrl: "https://example.test/v1", authMode: "key" } },
  } as unknown as OcxConfig;
  const first = addProviderApiKey(config, "demo", "secret-one");
  expect("id" in first).toBe(true);
  const firstRef = config.providers.demo!.apiKey!;
  expect(isProviderVaultReference(firstRef)).toBe(true);
  expect(readFileSync(join(testHome, "schedule-secrets.json"), "utf8")).not.toContain("secret-one");
  expect(resolveProviderCredential(firstRef)).toBe("secret-one");
  config.providers.other = { adapter: "openai-chat", baseUrl: "https://other.example/v1", authMode: "key" };
  addProviderApiKey(config, "other", "secret-one");
  const sharedRef = config.providers.other!.apiKey!;
  expect(sharedRef).toBe(firstRef);
  const duplicate = addProviderApiKey(config, "demo", "secret-one");
  expect("id" in duplicate && duplicate.id).toBe("id" in first ? first.id : "");
  expect(listProviderApiKeys(config, "demo").keys).toHaveLength(1);
  addProviderApiKey(config, "demo", "secret-two");
  const keys = listProviderApiKeys(config, "demo").keys;
  expect(keys).toHaveLength(2);
  const firstId = keys.find(key => key.masked.includes("vault reference"))!.id;
  expect(setActiveProviderApiKey(config, "demo", firstId)).toBe(true);
  expect(resolveProviderCredential(config.providers.demo!.apiKey)).toBe("secret-one");
  expect(removeProviderApiKey(config, "demo", firstId)).toBe(true);
  expect(resolveProviderCredential(config.providers.demo!.apiKey)).toBe("secret-two");
  expect(resolveProviderCredential(sharedRef)).toBe("secret-one");
  deleteProviderVaultReference(config.providers.demo!.apiKey!);
  deleteProviderVaultReference(sharedRef);
});

test("migration restores live config and removes newly-created vault refs when persistence fails", () => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-vault-rollback-"));
  process.env.OPENCODEX_HOME = testHome;
  setCredentialVaultSyncSeamForTests({
    platform: "win32",
    runner: (script, payload) => script.includes("ProtectedData]::Protect")
      ? Buffer.from(`cipher:${(JSON.parse(payload) as { plaintextB64: string }).plaintextB64}`).toString("base64")
      : (() => {
        const encoded = Buffer.from((JSON.parse(payload) as { ciphertextB64: string }).ciphertextB64, "base64").toString("utf8");
        return encoded.startsWith("cipher:") ? encoded.slice("cipher:".length) : "";
      })(),
  });
  setProviderApiKeySaveForTests(() => { throw new Error("save failed"); });
  const config = {
    providerApiKeyVault: "windows",
    providers: { demo: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "rollback-secret" } },
  } as unknown as OcxConfig;
  const result = migrateProviderApiKeysToVault(config);
  expect(result.unavailable).toBe(true);
  expect(config.providers.demo!.apiKey).toBe("rollback-secret");
  expect(JSON.parse(readFileSync(join(testHome, "schedule-secrets.json"), "utf8"))).toEqual({});
});

test("key add/remove persistence failures never lose the vault entry or mutate live config", () => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-vault-save-failure-"));
  process.env.OPENCODEX_HOME = testHome;
  setCredentialVaultSyncSeamForTests({
    platform: "win32",
    runner: (script, payload) => script.includes("ProtectedData]::Protect")
      ? Buffer.from(`cipher:${(JSON.parse(payload) as { plaintextB64: string }).plaintextB64}`).toString("base64")
      : (() => {
        const encoded = Buffer.from((JSON.parse(payload) as { ciphertextB64: string }).ciphertextB64, "base64").toString("utf8");
        return encoded.startsWith("cipher:") ? encoded.slice("cipher:".length) : "";
      })(),
  });
  const config = { providerApiKeyVault: "windows", providers: { demo: { adapter: "openai-chat", baseUrl: "https://example.test/v1", authMode: "key" } } } as unknown as OcxConfig;
  setProviderApiKeySaveForTests(() => { throw new Error("save failed"); });
  const rejected = addProviderApiKey(config, "demo", "preserve-secret");
  expect("error" in rejected).toBe(true);
  expect(config.providers.demo!.apiKey).toBeUndefined();
  expect(JSON.parse(readFileSync(join(testHome, "schedule-secrets.json"), "utf8"))).toEqual({});
  setProviderApiKeySaveForTests(() => undefined);
  const stored = addProviderApiKey(config, "demo", "preserve-secret");
  expect("id" in stored).toBe(true);
  const ref = config.providers.demo!.apiKey!;
  setProviderApiKeySaveForTests(() => { throw new Error("save failed"); });
  expect("id" in stored && removeProviderApiKey(config, "demo", stored.id)).toBe(false);
  expect(config.providers.demo!.apiKey).toBe(ref);
  expect(resolveProviderCredential(ref)).toBe("preserve-secret");
});

test("new-vault cleanup failure is explicit and leaves the unresolved reference recoverable", () => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-vault-cleanup-failure-"));
  process.env.OPENCODEX_HOME = testHome;
  setCredentialVaultSyncSeamForTests({
    platform: "win32",
    runner: (script, payload) => script.includes("ProtectedData]::Protect")
      ? Buffer.from(`cipher:${(JSON.parse(payload) as { plaintextB64: string }).plaintextB64}`).toString("base64")
      : (() => {
        const encoded = Buffer.from((JSON.parse(payload) as { ciphertextB64: string }).ciphertextB64, "base64").toString("utf8");
        return encoded.startsWith("cipher:") ? encoded.slice("cipher:".length) : "";
      })(),
  });
  setProviderApiKeySaveForTests(() => { throw new Error("save failed"); });
  setProviderVaultDeleteForTests(() => { throw new Error("delete failed"); });
  const config = { providerApiKeyVault: "windows", providers: { demo: { adapter: "openai-chat", baseUrl: "https://example.test/v1", authMode: "key" } } } as unknown as OcxConfig;
  const result = addProviderApiKey(config, "demo", "unresolved-secret");
  expect("error" in result && result.unresolved).toBe(true);
  expect(config.providers.demo!.apiKey).toBeUndefined();
  expect(Object.keys(JSON.parse(readFileSync(join(testHome, "schedule-secrets.json"), "utf8")))).toHaveLength(1);
});

test("remove does not complete when vault deletion fails and restores the config reference", () => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-vault-remove-failure-"));
  process.env.OPENCODEX_HOME = testHome;
  setCredentialVaultSyncSeamForTests({
    platform: "win32",
    runner: (script, payload) => script.includes("ProtectedData]::Protect")
      ? Buffer.from(`cipher:${(JSON.parse(payload) as { plaintextB64: string }).plaintextB64}`).toString("base64")
      : (() => {
        const encoded = Buffer.from((JSON.parse(payload) as { ciphertextB64: string }).ciphertextB64, "base64").toString("utf8");
        return encoded.startsWith("cipher:") ? encoded.slice("cipher:".length) : "";
      })(),
  });
  setProviderApiKeySaveForTests(() => undefined);
  const config = { providerApiKeyVault: "windows", providers: { demo: { adapter: "openai-chat", baseUrl: "https://example.test/v1", authMode: "key" } } } as unknown as OcxConfig;
  const stored = addProviderApiKey(config, "demo", "remove-secret");
  expect("id" in stored).toBe(true);
  const ref = config.providers.demo!.apiKey!;
  setProviderVaultDeleteForTests(() => { throw new Error("delete failed"); });
  expect("id" in stored && removeProviderApiKey(config, "demo", stored.id)).toBe(false);
  expect(config.providers.demo!.apiKey).toBe(ref);
  expect(resolveProviderCredential(ref)).toBe("remove-secret");
});

test("remove reports an unresolved transaction when the compensating config save also fails", () => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-vault-remove-unresolved-"));
  process.env.OPENCODEX_HOME = testHome;
  setCredentialVaultSyncSeamForTests({ platform: "win32", runner: (script, payload) => script.includes("ProtectedData]::Protect")
    ? Buffer.from(`cipher:${(JSON.parse(payload) as { plaintextB64: string }).plaintextB64}`).toString("base64")
    : "" });
  let saves = 0;
  setProviderApiKeySaveForTests(() => { saves += 1; if (saves > 2) throw new Error("restore save failed"); });
  const config = { providerApiKeyVault: "windows", providers: { demo: { adapter: "openai-chat", baseUrl: "https://example.test/v1", authMode: "key" } } } as unknown as OcxConfig;
  const stored = addProviderApiKey(config, "demo", "unresolved-remove-secret");
  expect("id" in stored).toBe(true);
  setProviderVaultDeleteForTests(() => { throw new Error("delete failed"); });
  expect(() => "id" in stored && removeProviderApiKey(config, "demo", stored.id)).toThrow(ProviderKeyRemovalUnresolvedError);
});
