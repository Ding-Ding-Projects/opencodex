import { randomBytes } from "node:crypto";
import { deleteVaultSecret, readVaultSecretSync, storeVaultSecretSync } from "./os-credential-vault";

export const PROVIDER_VAULT_REF_PREFIX = "vault:";
const REF_RE = /^vault:([A-Za-z0-9_-]{1,80})$/;

export function isProviderVaultReference(value: unknown): boolean {
  return typeof value === "string" && REF_RE.test(value);
}

export function providerVaultReferenceId(value: string): string | null {
  const match = REF_RE.exec(value);
  return match?.[1] ?? null;
}

export function resolveProviderCredential(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ref = providerVaultReferenceId(value);
  if (ref) return readVaultSecretSync(ref) ?? undefined;
  return value;
}

export function createProviderVaultReference(secret: string): string {
  const ref = `${PROVIDER_VAULT_REF_PREFIX}provider-${randomBytes(12).toString("hex")}`;
  storeVaultSecretSync(ref.slice(PROVIDER_VAULT_REF_PREFIX.length), secret);
  return ref;
}

export function deleteProviderVaultReference(value: string): void {
  const ref = providerVaultReferenceId(value);
  if (ref) deleteVaultSecret(ref);
}
