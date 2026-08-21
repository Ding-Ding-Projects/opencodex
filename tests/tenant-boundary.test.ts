import { describe, expect, test } from "bun:test";
import { TenantBoundary } from "../src/server/tenant-boundary";

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
});
