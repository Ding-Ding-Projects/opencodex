import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TenantBoundary, TenantBoundaryStore, TenantRequestLedger } from "../src/server/tenant-boundary";

function request(key?: string): Request {
  return new Request("http://127.0.0.1/v1/models", key ? { headers: { "x-opencodex-tenant-key": key } } : undefined);
}

describe("data-plane tenant boundary", () => {
  test("keeps legacy single-user mode disabled until an operator configures tenants", () => {
    const boundary = new TenantBoundary();
    expect(boundary.admit(request())).toEqual({ kind: "disabled" });
  });

  test("separates tenant admission from forwarded provider Authorization", () => {
    const boundary = new TenantBoundary();
    boundary.configure([{ tenantId: "tenant-a", admissionKey: "admission-a", allowedProviders: ["litellm"], allowedModels: ["litellm/model-a"] }]);
    const req = new Request("http://127.0.0.1/v1/responses", { headers: { Authorization: "Bearer provider-token" } });
    expect(boundary.admit(req)).toEqual({ kind: "unauthorized", status: 401, message: "tenant admission key required" });
  });

  test("rejects forged or cross-tenant admission and authorizes only the matching model", () => {
    const boundary = new TenantBoundary();
    boundary.configure([
      { tenantId: "tenant-a", admissionKey: "admission-a", allowedProviders: ["litellm"], allowedModels: ["litellm/model-a"] },
      { tenantId: "tenant-b", admissionKey: "admission-b", allowedProviders: ["litellm"], allowedModels: ["litellm/model-b"] },
    ]);
    expect(boundary.admit(request("forged"))).toEqual({ kind: "forbidden", status: 403, message: "tenant admission key is invalid" });
    expect(boundary.authorize(new Request("http://127.0.0.1/v1/responses", { headers: { "x-opencodex-tenant-key": "admission-a" } }), "litellm/model-b", "litellm")).toEqual({ kind: "forbidden", status: 403, message: "model is not authorized for this tenant" });
    const allowed = boundary.authorize(new Request("http://127.0.0.1/v1/responses", { headers: { "x-opencodex-tenant-key": "admission-a" } }), "litellm/model-a", "litellm");
    expect(allowed.kind).toBe("allowed");
    if (allowed.kind === "allowed") expect(allowed.admission.tenantId).toBe("tenant-a");
  });

  test("projects the catalog and history key per tenant without exposing credentials", () => {
    const boundary = new TenantBoundary();
    boundary.configure([{ tenantId: "tenant-a", admissionKey: "admission-a", allowedProviders: [], allowedModels: ["model-a"] }]);
    const admitted = boundary.admit(request("admission-a"));
    expect(admitted.kind).toBe("admitted");
    if (admitted.kind !== "admitted") return;
    expect(boundary.filterModels(admitted.admission, [{ id: "model-a" }, { id: "model-b" }])).toEqual([{ id: "model-a" }]);
    expect(boundary.requestHistoryKey(admitted.admission, "req-1")).toBe("tenant-a:req-1");
    expect(JSON.stringify(admitted)).not.toContain("admission-a");
  });

  test("canonicalizes routed aliases and rejects duplicate atomic configuration", () => {
    const boundary = new TenantBoundary();
    boundary.configure([{ tenantId: "tenant-a", admissionKey: "admission-a", allowedProviders: ["litellm"], allowedModels: ["litellm/model-a"] }]);
    expect(boundary.authorize(request("admission-a"), "~LiteLLM/Model-A", "LiteLLM").kind).toBe("allowed");
    expect(() => boundary.configure([
      { tenantId: "tenant-a", admissionKey: "one", allowedProviders: [], allowedModels: ["one"] },
      { tenantId: "tenant-a", admissionKey: "two", allowedProviders: [], allowedModels: ["two"] },
    ])).toThrow(/tenant policy/);
    expect(boundary.admit(request("admission-a")).kind).toBe("admitted");
  });

  test("persists bounded digests atomically and rotates one tenant without exposing the key", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? ".", "ocx-tenant-store-"));
    try {
      const store = new TenantBoundaryStore(join(root, "tenant-boundary.json"));
      store.save([{ tenantId: "tenant-a", admissionKey: "admission-a", allowedProviders: ["litellm"], allowedModels: ["model-a"] }]);
      store.rotate("tenant-a", "admission-a-rotated");
      const rows = store.load();
      expect(rows).toHaveLength(1);
      expect(readFileSync(store.path, "utf8")).not.toContain("admission-a-rotated");
      expect(rows[0]?.admissionKeyDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("extracts a bounded model before dispatch for every JSON inference shape", async () => {
    const boundary = new TenantBoundary();
    const responses = await boundary.modelFromRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST", body: JSON.stringify({ model: "combo/internal" }) }));
    const messages = await boundary.modelFromRequest(new Request("http://127.0.0.1/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-alias" }) }));
    expect(responses).toBe("combo/internal");
    expect(messages).toBe("claude-alias");
  });

  test("persists and filters tenant request history without payloads", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? ".", "ocx-tenant-history-"));
    try {
      const ledger = new TenantRequestLedger(join(root, "history.json"));
      ledger.record({ tenantId: "tenant-a", requestId: "req-a", path: "/v1/responses", model: "model-a", status: "admitted", recordedAt: new Date().toISOString() });
      ledger.record({ tenantId: "tenant-b", requestId: "req-b", path: "/v1/chat/completions", model: "model-b", status: "admitted", recordedAt: new Date().toISOString() });
      expect(ledger.listForTenant("tenant-a")).toHaveLength(1);
      expect(ledger.listForTenant("tenant-a")[0]?.requestId).toBe("req-a");
      expect(readFileSync(ledger.path, "utf8")).not.toContain("admission");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
