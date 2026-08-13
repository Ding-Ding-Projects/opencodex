/**
 * The filter row every dropdown, combobox and context menu carries at its
 * head — the presentational half of `menu-filter.ts`.
 *
 * It is `SearchField` (query input + anchored `RegexBuilderButton`, already
 * shared by every collection search in the app) plus the keyboard contract a
 * menu's filter field owes on top of an ordinary search bar:
 *
 *  - **Focus lands here first.** Every converted menu moves focus onto this
 *    field when it opens, not onto its first item — typing is how the field
 *    is meant to be used, and a menu that opens focused on an item makes the
 *    field an extra Tab stop nobody reaches by habit.
 *  - **ArrowDown leaves the field for the results.** `onArrowDown` is called
 *    so the host can move focus onto its first visible row; the host owns
 *    that ref, not this component.
 *  - **Enter activates a single survivor.** When exactly one row matches,
 *    `onEnterSingle` fires — narrowing a list to one entry and then reaching
 *    for the arrow keys anyway is the extra step this removes.
 *  - **Escape clears before it closes.** A first Escape empties the query
 *    (`onQuery("")`) and stops the keystroke there; a second Escape, or one
 *    pressed with the field already empty, is not intercepted at all and
 *    reaches the host's own document-level listener, which is what actually
 *    closes the menu. That is what "clears the filter and then closes" means
 *    in practice: this component owns stage one, the host already owned stage
 *    two before this was ever added to it.
 *
 * Every one of those is gated on the keystroke's target actually being this
 * field's own `<input>` — never a descendant. The anchored regex-builder
 * popover this field can open is a nested `role="dialog"` living in the same
 * DOM subtree, and a keystroke typed into *its* pattern field must reach the
 * popover's own Escape/arrow handling untouched; treating it as if it were the
 * filter field would make the cursor keys in a half-built pattern jump focus
 * out to the results list instead of moving the caret.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useT } from "../i18n/shared";
import { SearchField } from "./RegexBuilderButton";
import { MENU_FILTER_FLAGS } from "./menu-filter";
import type { TabMatcher } from "../../../shared/m3/tabs";

export interface MenuFilterFieldProps {
  /** DOM id of the rendered `<input>`. Also how this component tells its own
   * keystrokes apart from ones bubbling up from a nested dialog. */
  id: string;
  query: string;
  onQuery: (next: string) => void;
  regex: boolean;
  onRegexChange: (next: boolean) => void;
  /** Every row's label, joined — what the anchored builder previews a pattern against. */
  sample: string;
  /** Overrides the generic accessible name, for a menu whose filter deserves a more specific one. */
  searchLabel?: string;
  placeholder?: string;
  /** Overrides the generic regex-builder trigger label / popover dialog name. */
  builderLabel?: string;
  /** Called on ArrowDown typed into the field; the host focuses its first visible row. */
  onArrowDown?: () => void;
  /** Called on Enter when exactly one row is currently visible. */
  onEnterSingle?: () => void;
  /** How many rows are currently visible, so Enter can tell "exactly one" from "several". */
  resultCount: number;
}

export function MenuFilterField({
  id, query, onQuery, regex, onRegexChange, sample,
  searchLabel, placeholder, builderLabel, onArrowDown, onEnterSingle, resultCount,
}: MenuFilterFieldProps) {
  const t = useT();

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // Not this field: most commonly the pattern input inside the nested regex
    // popover, which owns its own Escape and its own cursor-key handling.
    if (target.id !== id) return;

    if (event.key === "Escape") {
      if (!query) return; // Nothing to clear; let the host's own listener close the menu.
      event.preventDefault();
      event.stopPropagation();
      onQuery("");
      return;
    }
    if (event.key === "ArrowDown" && onArrowDown) {
      event.preventDefault();
      onArrowDown();
      return;
    }
    if (event.key === "Enter" && resultCount === 1 && onEnterSingle) {
      event.preventDefault();
      onEnterSingle();
    }
  };

  return (
    <div className="m3-menu-filter" onKeyDown={onKeyDown}>
      <SearchField
        id={id}
        value={query}
        onChange={onQuery}
        searchLabel={searchLabel ?? t("menuFilter.searchLabel")}
        placeholder={placeholder ?? t("menuFilter.placeholder")}
        regex={regex}
        onRegexChange={onRegexChange}
        flags={MENU_FILTER_FLAGS}
        sample={sample}
        label={builderLabel ?? t("menuFilter.builder")}
      />
    </div>
  );
}

/**
 * The "nothing matches" / "pattern does not compile" line under a filtered
 * menu — an empty dropdown reads as a rendering failure, and a user cannot
 * tell a bad pattern from a query with no hits unless the message says which.
 *
 * Three states, not two: an untouched field (`matcher.reason === "empty"`)
 * says nothing, because the unfiltered list is already the answer; a pattern
 * that fails to compile (`reason === "invalid"`) says so and names the error;
 * and a pattern that compiles fine but matched nothing (`matcher.ok` yet
 * `resultCount === 0`) is the case a naive `!matcher.ok` check would miss
 * entirely — `ok` only reports whether the pattern *compiled*, not whether it
 * found anything.
 */
export function MenuFilterStatus({ matcher, query, resultCount }: { matcher: TabMatcher; query: string; resultCount: number }) {
  const t = useT();
  if (!matcher.ok) {
    if (matcher.reason === "invalid") {
      return <p className="m3-field-hint" role="alert">{t("menuFilter.invalid", { error: matcher.error })}</p>;
    }
    return null;
  }
  if (resultCount > 0) return null;
  return <p className="m3-field-hint" role="status">{t("menuFilter.empty", { query })}</p>;
}
