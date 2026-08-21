/**
 * Small, opt-in data-plane tenant boundary.
 *
 * Admission uses a dedicated per-tenant key and never reuses the forwarded
 * provider Authorization credential. The registry is process-local and may be
 * populated only by an operator-owned bootstrap path; it is not exposed through
 * management routes. An empty registry preserves the existing single-user mode.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export type TenantPolicy = Readonly<{
  tenantId: string;
  admissionKey: string;
  allowedProviders: readonly string[];
  allowedModels: readonly string[];
}>;

export type TenantAdmission = Readonly<{
  tenantId: string;
  allowedProviders: ReadonlySet<string>;
  allowedModels: ReadonlySet<string>;
}>;

export type TenantAdmissionResult =
  | { kind: "disabled" }
  | { kind: "admitted"; admission: TenantAdmission }
  | { kind: "unauthorized"; status: 401; message: "tenant admission key required" }
  | { kind: "forbidden"; status: 403; message: "tenant admission key is invalid" };

export type TenantAuthorizationResult =
  | { kind: "allowed"; admission: TenantAdmission }
  | { kind: "disabled" }
  | { kind: "unauthorized"; status: 401; message: string }
  | { kind: "forbidden"; status: 403; message: string };

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function equalDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value);
}

export class TenantBoundary {
  private policies = new Map<string, TenantAdmission>();
  private keyDigests = new Map<string, Buffer>();

  configure(policies: readonly TenantPolicy[]): void {
    const next = new Map<string, TenantAdmission>();
    const nextDigests = new Map<string, Buffer>();
    for (const policy of policies) {
      if (!validId(policy.tenantId) || !policy.admissionKey || !policy.allowedModels.length) {
        throw new Error("tenant policy must contain a bounded id, admission key, and model allowlist");
      }
      const admission: TenantAdmission = {
        tenantId: policy.tenantId,
        allowedProviders: new Set(policy.allowedProviders.filter(validId)),
        allowedModels: new Set(policy.allowedModels.filter(model => model.length > 0 && model.length <= 200)),
      };
      next.set(policy.tenantId, admission);
      // Store only a digest. The supplied admission key is never retained, logged, or returned.
      nextDigests.set(policy.tenantId, digest(policy.admissionKey));
    }
    this.policies = next;
    this.keyDigests = nextDigests;
  }

  clear(): void { this.policies = new Map(); this.keyDigests = new Map(); }

  get enabled(): boolean { return this.policies.size > 0; }

  admit(request: Request): TenantAdmissionResult {
    if (!this.enabled) return { kind: "disabled" };
    const key = request.headers.get("x-opencodex-tenant-key")?.trim();
    if (!key) return { kind: "unauthorized", status: 401, message: "tenant admission key required" };
    const keyDigest = digest(key);
    for (const admission of this.policies.values()) {
      const candidate = this.keyDigests.get(admission.tenantId);
      if (!candidate) continue;
      if (equalDigest(candidate, keyDigest)) return { kind: "admitted", admission };
    }
    return { kind: "forbidden", status: 403, message: "tenant admission key is invalid" };
  }

  authorize(request: Request, model: string | undefined, provider: string | undefined): TenantAuthorizationResult {
    const result = this.admit(request);
    if (result.kind !== "admitted") return result.kind === "disabled" ? result : result;
    if (model && !result.admission.allowedModels.has(model)) return { kind: "forbidden", status: 403, message: "model is not authorized for this tenant" };
    if (provider && result.admission.allowedProviders.size > 0 && !result.admission.allowedProviders.has(provider)) return { kind: "forbidden", status: 403, message: "provider is not authorized for this tenant" };
    return { kind: "allowed", admission: result.admission };
  }

  filterModels<T extends { id: string }>(admission: TenantAdmission | undefined, models: readonly T[]): T[] {
    if (!admission) return [...models];
    return models.filter(model => admission.allowedModels.has(model.id));
  }

  filterCatalogEntries<T extends Record<string, unknown>>(admission: TenantAdmission | undefined, entries: readonly T[]): T[] {
    if (!admission) return [...entries];
    return entries.filter(entry => {
      const id = typeof entry.id === "string" ? entry.id : typeof entry.slug === "string" ? entry.slug : "";
      return admission.allowedModels.has(id);
    });
  }

  requestHistoryKey(admission: TenantAdmission, requestId: string): string {
    if (!requestId || requestId.length > 200) throw new Error("request id is invalid");
    return `${admission.tenantId}:${requestId}`;
  }
}

export const tenantBoundary = new TenantBoundary();
