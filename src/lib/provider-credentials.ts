import { createHash } from "node:crypto";
import { deleteVaultSecret, hasVaultSecret, readVaultSecretSync, storeVaultSecretSync } from "./os-credential-vault";

export const PROVIDER_VAULT_REF_PREFIX = "vault:";
const REF_RE = /^vault:([A-Za-z0-9_-]{1,80})$/;
let deleteVaultSecretImpl: typeof deleteVaultSecret = deleteVaultSecret;

export function setProviderVaultDeleteForTests(next: typeof deleteVaultSecret | null): void {
  deleteVaultSecretImpl = next ?? deleteVaultSecret;
}

export function isProviderVaultReference(value: unknown): boolean {
  return typeof value === "string" && REF_RE.test(value);
}

export function providerVaultReferenceId(value: string): string | null {
  const match = REF_RE.exec(value);
  return match?.[1] ?? null;
}

export function providerVaultReferenceForSecret(secret: string): string {
  return `${PROVIDER_VAULT_REF_PREFIX}provider-${createHash("sha256").update(secret).digest("hex").slice(0, 32)}`;
}

export function resolveProviderCredential(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ref = providerVaultReferenceId(value);
  if (ref) return readVaultSecretSync(ref) ?? undefined;
  return value;
}

export function createProviderVaultReference(secret: string): string {
  // The digest is an opaque equality handle, not a credential. It keeps repeated
  // adds of the same secret on one stable pool identity without storing plaintext
  // or making the reference reversible.
  const ref = providerVaultReferenceForSecret(secret);
  const id = ref.slice(PROVIDER_VAULT_REF_PREFIX.length);
  if (!hasVaultSecret(id)) storeVaultSecretSync(id, secret);
  return ref;
}

export function deleteProviderVaultReference(value: string): void {
  const ref = providerVaultReferenceId(value);
  if (ref) deleteVaultSecretImpl(ref);
}

export function providerVaultReferenceExists(value: string): boolean {
  const ref = providerVaultReferenceId(value);
  return ref ? hasVaultSecret(ref) : false;
}

export function providerVaultExportRefusal(config: { providerApiKeyVault?: string }): string | null {
  return config.providerApiKeyVault === "windows"
    ? "provider API-key vault ciphertext is intentionally omitted from exports; refusing an incomplete full-state backup"
    : null;
}
