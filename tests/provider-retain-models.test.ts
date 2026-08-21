import { describe, expect, test } from "bun:test";
import {
  mergeConfiguredModelsIntoLiveCatalog,
  recordRetainedOmissionCycle,
  reconcileProviderFetchWarnings,
  retainedWithoutDiscoveryRefs,
  warnRetainedModel404Once,
  warnedRetained404Refs,
} from "../src/codex/catalog/provider-fetch";
import { clearModelCache } from "../src/codex/model-cache";
import { nonBlankStringArrayConfigError } from "../src/config";
import type { CatalogModel } from "../src/codex/catalog/parsing";
import type { OcxProviderConfig } from "../src/types";

function model(id: string, provider = "test-prov"): CatalogModel {
  return { id, provider };
}

describe("#1690 retainModels provider configuration", () => {
  test("retains configured models listed in retainModels when live discovery omits them", () => {
    const prov: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      retainModels: ["gemini-3.7-flash"],
    };
    const live = [model("gemini-3.5-flash")];
    const configured = [model("gemini-3.7-flash"), model("unrelated-model")];

    const { models, droppedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({
      name: "google-antigravity",
      provider: prov,
      models: live,
      configured,
    });

    expect(models.map(m => m.id)).toEqual(["gemini-3.5-flash", "gemini-3.7-flash"]);
    expect(droppedConfiguredIds).toEqual(["unrelated-model"]);
  });

  test("drops unlisted models when retainModels is empty or undefined", () => {
    const prov: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.example.com/v1",
    };
    const live = [model("live-model-1")];
    const configured = [model("configured-model-1")];

    const { models, droppedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({
      name: "custom-prov",
      provider: prov,
      models: live,
      configured,
    });

    expect(models.map(m => m.id)).toEqual(["live-model-1"]);
    expect(droppedConfiguredIds).toEqual(["configured-model-1"]);
  });

  test("preserves discovered models that match retainModels without duplication", () => {
    const prov: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      retainModels: ["gemini-3.7-flash"],
    };
    const live = [model("gemini-3.7-flash")];
    const configured = [model("gemini-3.7-flash")];

    const { models, droppedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({
      name: "google-antigravity",
      provider: prov,
      models: live,
      configured,
    });

    expect(models.map(m => m.id)).toEqual(["gemini-3.7-flash"]);
    expect(droppedConfiguredIds).toEqual([]);
  });

  test("retains multiple specified models across an empty live discovery", () => {
    const prov: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      retainModels: ["gemini-3.7-flash", "claude-sonnet-4-6"],
    };
    const live: CatalogModel[] = [];
    const configured = [
      model("gemini-3.7-flash"),
      model("claude-sonnet-4-6"),
      model("dropped-model"),
    ];

    const { models, droppedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({
      name: "google-antigravity",
      provider: prov,
      models: live,
      configured,
    });

    expect(models.map(m => m.id)).toEqual(["gemini-3.7-flash", "claude-sonnet-4-6"]);
    expect(droppedConfiguredIds).toEqual(["dropped-model"]);
  });

  test("reports retained provenance only when live discovery omitted the retained model", () => {
    const prov: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      retainModels: ["gemini-3.7-flash"],
    };
    const omitted = mergeConfiguredModelsIntoLiveCatalog({
      name: "google-antigravity",
      provider: prov,
      models: [model("gemini-3.5-flash")],
      configured: [model("gemini-3.7-flash")],
    });
    expect(omitted.retainedConfiguredIds).toEqual(["gemini-3.7-flash"]);

    const present = mergeConfiguredModelsIntoLiveCatalog({
      name: "google-antigravity",
      provider: prov,
      models: [model("gemini-3.7-flash")],
      configured: [model("gemini-3.7-flash")],
    });
    expect(present.retainedConfiguredIds).toEqual([]);
  });

  test("rejects blank retainModels entries without rejecting a missing optional field", () => {
    expect(nonBlankStringArrayConfigError(undefined, "retainModels")).toBeNull();
    expect(nonBlankStringArrayConfigError(["  "], "retainModels")).toContain("nonblank");
  });

  test("starts a fresh warning window for a new omission cycle and clears removed models", () => {
    reconcileProviderFetchWarnings(100);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      recordRetainedOmissionCycle("provider-a", ["model-a"]);
      warnRetainedModel404Once("provider-a", "model-a");
      warnRetainedModel404Once("provider-a", "model-a");
      expect(warnings).toHaveLength(1);
      recordRetainedOmissionCycle("provider-a", ["model-a"]);
      warnRetainedModel404Once("provider-a", "model-a");
      expect(warnings).toHaveLength(2);
      recordRetainedOmissionCycle("provider-a", []);
      expect(retainedWithoutDiscoveryRefs.has("provider-a")).toBe(false);
      expect(warnedRetained404Refs.has("provider-a/model-a")).toBe(false);
      warnRetainedModel404Once("provider-a", "model-a");
      expect(warnings).toHaveLength(2);
      recordRetainedOmissionCycle("provider-b", ["model-b"]);
      warnRetainedModel404Once("provider-b", "model-b");
      expect(warnings).toHaveLength(3);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("provider-scoped invalidation leaves another provider's diagnostics intact", () => {
    recordRetainedOmissionCycle("provider-a", ["model-a"]);
    recordRetainedOmissionCycle("provider-b", ["model-b"]);
    warnedRetained404Refs.add("provider-a/model-a");
    warnedRetained404Refs.add("provider-b/model-b");
    clearModelCache("provider-a");
    expect(retainedWithoutDiscoveryRefs.has("provider-a")).toBe(false);
    expect(warnedRetained404Refs.has("provider-a/model-a")).toBe(false);
    expect(retainedWithoutDiscoveryRefs.get("provider-b")).toEqual(new Set(["model-b"]));
    expect(warnedRetained404Refs.has("provider-b/model-b")).toBe(true);
    reconcileProviderFetchWarnings(1000);
  });
});
