/**
 * Grok page group view: partition the candidate catalog into native/routed groups and
 * order each with registered models first. Pure so the counting and ordering are
 * testable without a DOM.
 *
 * Aliases are NEVER computed here: they come from readGrokStatus() (what the writer
 * actually wrote). A switched-off or not-yet-applied model has no alias, and the page
 * shows "—" for it.
 */

export interface GrokCandidate {
  id: string;
  contextWindow?: number;
  native: boolean;
}

export interface GrokGroupRow extends GrokCandidate {
  /** The alias from the written fence, or null when the model is not registered. */
  alias: string | null;
  enabled: boolean;
}

export interface GrokGroupView {
  rows: GrokGroupRow[];
  total: number;
  enabled: number;
}

/** Everything the settings search can match on: the model id and the written alias. */
export function grokRowHaystack(row: GrokGroupRow): string {
  return `${row.id} ${row.alias ?? ""}`;
}

export function grokGroupView(
  candidates: readonly GrokCandidate[],
  aliasById: ReadonlyMap<string, string>,
  excluded: ReadonlySet<string>,
  group: "native" | "routed",
  // The settings search filters rows AFTER the alias is attached, so a user can find a
  // model by the name opencodex actually registered it under, not only by its raw id.
  matches: (row: GrokGroupRow) => boolean = () => true,
): GrokGroupView {
  const rows = candidates
    .filter(c => (group === "native") === c.native)
    .map(c => ({
      ...c,
      alias: aliasById.get(c.id) ?? null,
      enabled: !excluded.has(c.id),
    }))
    .filter(matches)
    // Registered models first; stable inside each partition so server order survives.
    .toSorted((a, b) => Number(!a.enabled) - Number(!b.enabled));
  return {
    rows,
    total: rows.length,
    enabled: rows.filter(r => r.enabled).length,
  };
}
