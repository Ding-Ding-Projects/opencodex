/**
 * The bulk-action bar every list in this app gets.
 *
 * `src/lib/bulk-actions.ts` (server-side twin) decides *what* a bulk action would
 * do; this is the surface that says it out loud before it happens. The three
 * things it exists to prevent are the three ways a bulk action lies:
 *
 *  1. **A "select all" that means something other than what it says.** On a
 *     filtered list it can mean the page, the filter, or the collection. The bar
 *     names the scope in the sentence, so the count on the button and the rows
 *     that change are visibly the same set.
 *  2. **Silently skipped items.** "42 selected" reads as 42 changes when six are
 *     protected. Skips are counted separately and their reason is shown.
 *  3. **Claiming a whole batch succeeded.** A run that fails at item thirty did
 *     twenty-nine things, and "Done" is false in the direction that costs the
 *     most to discover later.
 *
 * It renders nothing at all when nothing is selected. A bar that is always there
 * is chrome; a bar that appears when it has something to say is an answer.
 */

import { useMemo, type ReactNode } from "react";
import { Button } from "./m3-ui";
import { useT } from "../i18n/shared";

/** What "select all" was asked to mean. Named, because the three differ. */
export type SelectAllScope = "page" | "matching" | "all";

export interface BulkItemView {
  id: string;
  label: string;
  /** Why this row cannot take part, or null. A reason, never a bare boolean. */
  skipReason?: string | null;
}

export interface BulkActionView {
  id: string;
  label: string;
  destructive?: boolean;
  run: (ids: string[]) => void | Promise<void>;
}

export interface BulkBarProps {
  items: BulkItemView[];
  selected: Set<string>;
  scope: SelectAllScope;
  actions: BulkActionView[];
  onSelectAll: () => void;
  onSelectNone: () => void;
  onInvert: () => void;
  /** Rendered while a run is in flight; the caller owns cancellation. */
  progress?: { done: number; total: number; onCancel: () => void } | null;
  children?: ReactNode;
}

export default function BulkBar({
  items, selected, scope, actions, onSelectAll, onSelectNone, onInvert, progress, children,
}: BulkBarProps) {
  const t = useT();

  const chosen = useMemo(() => items.filter(item => selected.has(item.id)), [items, selected]);
  const skipped = useMemo(() => chosen.filter(item => !!item.skipReason), [chosen]);
  const affected = chosen.length - skipped.length;
  const reasons = useMemo(
    () => [...new Set(skipped.map(item => item.skipReason!))].join("; "),
    [skipped],
  );

  // Nothing selected: nothing to say. Rendering an empty bar would be chrome.
  if (!chosen.length && !progress) return null;

  const scopeWord = scope === "page" ? t("bulk.scope.page")
    : scope === "matching" ? t("bulk.scope.matching")
      : t("bulk.scope.all");

  return (
    <div className="m3-bulkbar" role="region" aria-label={t("bulk.region")}>
      <p className="m3-bulkbar__count" role="status" aria-live="polite">
        {progress
          ? t("bulk.progress", { done: progress.done, total: progress.total })
          : skipped.length
            // The count and the exclusions in one sentence: each is misleading
            // without the other.
            ? t("bulk.selectedWithSkips", { count: affected, scope: scopeWord, skipped: skipped.length, reasons })
            : t("bulk.selected", { count: affected, scope: scopeWord })}
      </p>

      <div className="m3-row m3-bulkbar__actions">
        {progress ? (
          <Button variant="outlined" onClick={progress.onCancel}>{t("bulk.cancel")}</Button>
        ) : (
          <>
            <Button variant="text" onClick={onSelectAll}>{t("bulk.selectAll")}</Button>
            <Button variant="text" onClick={onInvert}>{t("bulk.invert")}</Button>
            <Button variant="text" onClick={onSelectNone}>{t("bulk.clear")}</Button>
            {children}
            {actions.map(action => (
              <Button
                key={action.id}
                variant={action.destructive ? "danger" : "filled"}
                // Everything selected being excluded is not an action to offer.
                disabled={affected === 0}
                onClick={() => void action.run(chosen.filter(item => !item.skipReason).map(item => item.id))}
              >
                {action.label}
              </Button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
