/**
 * Small, opt-in data-plane tenant boundary.
 *
 * Admission uses a dedicated per-tenant key and never reuses the forwarded
 * provider Authorization credential. The registry is process-local and may be
 * populated only by an operator-owned bootstrap path; it is not exposed through
 * management routes. An empty registry preserves the existing single-user mode.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

export type TenantPolicy = Readonly<{
  tenantId: string;
  admissionKey: string;
  allowedProviders: readonly string[];
  allowedModels: readonly string[];
}>;

export type TenantStoredPolicy = Readonly<{
  tenantId: string;
  admissionKeyDigest: string;
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

export function canonicalRouteIdentity(value: string): string {
  return value.trim().replace(/^~+/, "").toLowerCase();
}

export class TenantBoundary {
  private policies = new Map<string, TenantAdmission>();
  private keyDigests = new Map<string, Buffer>();

  configure(policies: readonly TenantPolicy[]): void {
    const next = new Map<string, TenantAdmission>();
    const nextDigests = new Map<string, Buffer>();
    const seenDigests = new Set<string>();
    if (policies.length > 64) throw new Error("tenant policy count exceeds 64");
    for (const policy of policies) {
      if (!validId(policy.tenantId) || next.has(policy.tenantId) || !policy.admissionKey || !policy.allowedModels.length) {
        throw new Error("tenant policy must contain a bounded id, admission key, and model allowlist");
      }
      const keyDigest = digest(policy.admissionKey);
      const keyHex = keyDigest.toString("hex");
      if (seenDigests.has(keyHex)) throw new Error("tenant admission keys must be unique");
      seenDigests.add(keyHex);
      const admission: TenantAdmission = {
        tenantId: policy.tenantId,
        allowedProviders: new Set(policy.allowedProviders.filter(validId).map(canonicalRouteIdentity)),
        allowedModels: new Set(policy.allowedModels.filter(model => model.length > 0 && model.length <= 200).map(canonicalRouteIdentity)),
      };
      next.set(policy.tenantId, admission);
      // Store only a digest. The supplied admission key is never retained, logged, or returned.
      nextDigests.set(policy.tenantId, digest(policy.admissionKey));
    }
    this.policies = next;
    this.keyDigests = nextDigests;
  }

  configureStored(policies: readonly TenantStoredPolicy[]): void {
    if (policies.length > 64) throw new Error("tenant policy count exceeds 64");
    const next = new Map<string, TenantAdmission>();
    const nextDigests = new Map<string, Buffer>();
    for (const policy of policies) {
      if (!validId(policy.tenantId) || next.has(policy.tenantId) || !/^[0-9a-f]{64}$/i.test(policy.admissionKeyDigest) || policy.allowedModels.length === 0) throw new Error("tenant stored policy is invalid");
      const digestValue = Buffer.from(policy.admissionKeyDigest, "hex");
      if ([...nextDigests.values()].some(existing => equalDigest(existing, digestValue))) throw new Error("tenant admission keys must be unique");
      next.set(policy.tenantId, { tenantId: policy.tenantId, allowedProviders: new Set(policy.allowedProviders.filter(validId).map(canonicalRouteIdentity)), allowedModels: new Set(policy.allowedModels.filter(model => model.length > 0 && model.length <= 200).map(canonicalRouteIdentity)) });
      nextDigests.set(policy.tenantId, digestValue);
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
    let matched: TenantAdmission | undefined;
    for (const admission of this.policies.values()) {
      const candidate = this.keyDigests.get(admission.tenantId);
      if (!candidate) continue;
      if (equalDigest(candidate, keyDigest)) matched = admission;
    }
    if (matched) return { kind: "admitted", admission: matched };
    return { kind: "forbidden", status: 403, message: "tenant admission key is invalid" };
  }

  authorize(request: Request, model: string | undefined, provider: string | undefined): TenantAuthorizationResult {
    const result = this.admit(request);
    if (result.kind !== "admitted") return result.kind === "disabled" ? result : result;
    if (model && !result.admission.allowedModels.has(canonicalRouteIdentity(model))) return { kind: "forbidden", status: 403, message: "model is not authorized for this tenant" };
    if (provider && result.admission.allowedProviders.size > 0 && !result.admission.allowedProviders.has(canonicalRouteIdentity(provider))) return { kind: "forbidden", status: 403, message: "provider is not authorized for this tenant" };
    return { kind: "allowed", admission: result.admission };
  }

  async modelFromRequest(request: Request): Promise<string | undefined> {
    if (request.method === "GET" || request.method === "HEAD") return undefined;
    const length = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > 1_048_576) throw new Error("tenant admission body exceeds 1 MiB");
    const clone = request.clone();
    const reader = clone.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > 1_048_576) throw new Error("tenant admission body exceeds 1 MiB");
        chunks.push(part.value);
      }
    } finally { try { reader.releaseLock(); } catch { /* clone teardown */ } }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try {
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).model === "string" ? (body as Record<string, unknown>).model as string : undefined;
    } catch { return undefined; }
  }

  filterModels<T extends { id: string }>(admission: TenantAdmission | undefined, models: readonly T[]): T[] {
    if (!admission) return [...models];
    return models.filter(model => admission.allowedModels.has(canonicalRouteIdentity(model.id)));
  }

  filterCatalogEntries<T extends Record<string, unknown>>(admission: TenantAdmission | undefined, entries: readonly T[]): T[] {
    if (!admission) return [...entries];
    return entries.filter(entry => {
      const id = typeof entry.id === "string" ? entry.id : typeof entry.slug === "string" ? entry.slug : "";
      return admission.allowedModels.has(canonicalRouteIdentity(id));
    });
  }

  requestHistoryKey(admission: TenantAdmission, requestId: string): string {
    if (!requestId || requestId.length > 200) throw new Error("request id is invalid");
    return `${admission.tenantId}:${requestId}`;
  }
}

export const tenantBoundary = new TenantBoundary();

export class TenantBoundaryStore {
  readonly path: string;
  constructor(path = join(getConfigDir(), "tenant-boundary.json")) { this.path = path; }

  load(): TenantStoredPolicy[] {
    if (!existsSync(this.path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    const container = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    if (container?.version !== 1) throw new Error("tenant boundary store version is unsupported");
    const rows = container.policies;
    if (!Array.isArray(rows) || rows.length > 64) throw new Error("tenant boundary store is invalid");
    return rows.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tenant policy record is invalid");
      const row = value as Record<string, unknown>;
      if (typeof row.tenantId !== "string" || typeof row.admissionKeyDigest !== "string" || !Array.isArray(row.allowedProviders) || !Array.isArray(row.allowedModels)) throw new Error("tenant policy record is incomplete");
      return { tenantId: row.tenantId, admissionKeyDigest: row.admissionKeyDigest, allowedProviders: row.allowedProviders.filter((x): x is string => typeof x === "string"), allowedModels: row.allowedModels.filter((x): x is string => typeof x === "string") };
    });
  }

  save(policies: readonly TenantPolicy[]): void {
    const probe = new TenantBoundary();
    probe.configure(policies);
    const stored: TenantStoredPolicy[] = policies.map(policy => ({ tenantId: policy.tenantId, admissionKeyDigest: digest(policy.admissionKey).toString("hex"), allowedProviders: [...policy.allowedProviders], allowedModels: [...policy.allowedModels] }));
    mkdirSync(dirname(this.path), { recursive: true });
    atomicWriteFile(this.path, JSON.stringify({ version: 1, policies: stored }, null, 2) + "\n");
  }

  rotate(tenantId: string, newAdmissionKey: string): void {
    const rows = this.load();
    const index = rows.findIndex(row => row.tenantId === tenantId);
    if (index < 0) throw new Error("tenant does not exist");
    if (!newAdmissionKey) throw new Error("new tenant admission key is required");
    const updated = rows.map((row, rowIndex) => rowIndex === index ? { ...row, admissionKeyDigest: digest(newAdmissionKey).toString("hex") } : row);
    if (new Set(updated.map(row => row.admissionKeyDigest)).size !== updated.length) throw new Error("tenant admission keys must be unique");
    atomicWriteFile(this.path, JSON.stringify({ version: 1, policies: updated }, null, 2) + "\n");
  }
}

export type TenantRequestRecord = Readonly<{
  tenantId: string;
  requestId: string;
  path: string;
  model?: string;
  provider?: string;
  status: "admitted";
  recordedAt: string;
}>;

export class TenantRequestLedger {
  readonly path: string;
  constructor(path = join(getConfigDir(), "tenant-request-history.json")) { this.path = path; }

  record(record: TenantRequestRecord): void {
    if (!validId(record.tenantId) || !record.requestId || record.requestId.length > 200 || !record.path.startsWith("/v1/")) throw new Error("tenant request record is invalid");
    const existing = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : [];
    if (!Array.isArray(existing)) throw new Error("tenant request history is invalid");
    const next = [...existing, record].slice(-10_000);
    mkdirSync(dirname(this.path), { recursive: true });
    atomicWriteFile(this.path, JSON.stringify(next) + "\n");
  }

  listForTenant(tenantId: string): TenantRequestRecord[] {
    if (!validId(tenantId) || !existsSync(this.path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((value): value is TenantRequestRecord => !!value && typeof value === "object" && (value as Record<string, unknown>).tenantId === tenantId) : [];
  }
}

export const tenantRequestLedger = new TenantRequestLedger();
