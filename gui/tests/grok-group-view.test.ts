import { expect, test } from "bun:test";
import { grokGroupView, grokRowHaystack, type GrokCandidate } from "../src/pages/grok-groups";

const CANDIDATES: GrokCandidate[] = [
  { id: "gpt-5.6-sol", contextWindow: 372_000, native: true },
  { id: "gpt-5.5", contextWindow: 272_000, native: true },
  { id: "cursor/grok-4.5", contextWindow: 500_000, native: false },
  { id: "kimi/k3[1m]", contextWindow: 1_048_576, native: false },
];

const ALIASES = new Map([
  ["gpt-5.6-sol", "ocx-gpt-5-6-sol"],
  ["cursor/grok-4.5", "ocx-cursor-grok-4-5"],
]);

test("groups partition native from routed", () => {
  const native = grokGroupView(CANDIDATES, ALIASES, new Set(), "native");
  expect(native.total).toBe(2);
  expect(native.rows.map(r => r.id)).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
  const routed = grokGroupView(CANDIDATES, ALIASES, new Set(), "routed");
  expect(routed.total).toBe(2);
});

test("enabled count reflects the exclusion set", () => {
  const view = grokGroupView(CANDIDATES, ALIASES, new Set(["gpt-5.5"]), "native");
  expect(view.enabled).toBe(1);
  expect(view.total).toBe(2);
});

test("registered models sort first, stably", () => {
  const view = grokGroupView(CANDIDATES, ALIASES, new Set(["gpt-5.6-sol"]), "native");
  expect(view.rows.map(r => r.id)).toEqual(["gpt-5.5", "gpt-5.6-sol"]);
  expect(view.rows[0]!.enabled).toBe(true);
  expect(view.rows[1]!.enabled).toBe(false);
});

// A switched-off or not-yet-applied model has no alias: the page must show "—" from a
// null, never a computed guess. Aliases are the writer's output only.
test("a model not in the fence has a null alias", () => {
  const view = grokGroupView(CANDIDATES, ALIASES, new Set(), "routed");
  const kimi = view.rows.find(r => r.id === "kimi/k3[1m]");
  const cursor = view.rows.find(r => r.id === "cursor/grok-4.5");
  expect(kimi!.alias).toBeNull();
  expect(cursor!.alias).toBe("ocx-cursor-grok-4-5");
});

// The settings search runs after the alias is attached, so a user can find a model by the
// name opencodex actually registered it under — not only by the raw provider id.
test("the settings search filters on the id and on the written alias", () => {
  const byId = grokGroupView(CANDIDATES, ALIASES, new Set(), "native",
    row => grokRowHaystack(row).includes("5.5"));
  expect(byId.rows.map(r => r.id)).toEqual(["gpt-5.5"]);
  expect(byId.total).toBe(1);

  const byAlias = grokGroupView(CANDIDATES, ALIASES, new Set(), "routed",
    row => grokRowHaystack(row).includes("ocx-cursor"));
  expect(byAlias.rows.map(r => r.id)).toEqual(["cursor/grok-4.5"]);

  // A model with no alias must not be matched by an empty alias slot swallowing the query.
  const noMatch = grokGroupView(CANDIDATES, ALIASES, new Set(), "routed",
    row => grokRowHaystack(row).includes("ocx-kimi"));
  expect(noMatch.total).toBe(0);
});

// An unfiltered call must behave exactly as before the search existed.
test("the group view keeps every row when no search predicate is passed", () => {
  expect(grokGroupView(CANDIDATES, ALIASES, new Set(), "native").total).toBe(2);
  expect(grokGroupView(CANDIDATES, ALIASES, new Set(), "routed").total).toBe(2);
});
