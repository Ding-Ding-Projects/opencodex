/**
 * The settings search bar every settings surface carries, as one component.
 *
 * Pairs with `settings-search.ts`, which holds the matching, and
 * `use-settings-search.ts`, which holds the state. This file is only the row —
 * the field, the `.*` opt-in, the anchored builder and the status line.
 *
 * The builder instance is per-row: `SettingsSearchRow` renders its own
 * `RegexBuilderButton` seeded from its own query and its own flags, and writes
 * the applied pattern and flags straight back into that row's state. That is the
 * bidirectional half of the contract — the builder opens showing what the field
 * holds, and applying puts the pattern, the flags and regex mode back. A screen
 * with two search bars therefore gets two builders that cannot see each other,
 * rather than one that applies to whichever field was touched last.
 */

import { useId } from "react";
import { Chip, TextInput } from "./m3-ui";
import { RegexBuilderButton } from "./RegexBuilderButton";
import { IconSearch } from "../icons";
import { useT } from "../i18n/shared";
import { joinBilingual } from "../i18n/resolve";
import type { SettingsSearch } from "./use-settings-search";
import type { CSSProperties } from "react";

const ROW: CSSProperties = { gap: 8, marginBottom: 0 };
const MONO: CSSProperties = { fontFamily: "var(--mono)" };

/**
 * The field grows to fill the row, and its flex *basis* is what decides whether
 * the row fits on one line.
 *
 * A wrapping flex line breaks on the basis rather than shrinking to fit, so at a
 * phone's 390px the icon, a 240px field and the `.*` chip fill the line and the
 * builder button drops to a second row — turning the search block into a quarter
 * of the screen. `compact` lowers the basis so all four sit together; the field
 * still absorbs whatever is left over, because it is the only item that grows.
 *
 * This exists as a prop rather than as a stylesheet override at the call site
 * because the basis is an inline style, and the only way to beat an inline style
 * from CSS is `!important` — which is a worse thing to leave in a stylesheet than
 * a named variant is to leave in a component.
 */
const INPUT: CSSProperties = { flex: "1 1 240px", width: "auto", minWidth: 0, maxWidth: 460 };
const INPUT_COMPACT: CSSProperties = { ...INPUT, flex: "1 1 120px" };

/**
 * Reserved height. The status line appears and disappears as the user types, and
 * without a floor every keystroke that changes it reflows the settings below —
 * which moves the control the user was reaching for out from under the pointer.
 * `compact` keeps the reservation and gives back the margin, because on a phone
 * that space is charged against the content the screen exists to show.
 */
const STATUS: CSSProperties = {
  minHeight: 20,
  margin: "4px 0 var(--sp-3)",
  color: "var(--m3-on-surface-variant)",
  fontSize: "var(--t-label-m)",
};
const STATUS_COMPACT: CSSProperties = { ...STATUS, margin: "4px 0 6px" };

export interface SettingsSearchRowProps {
  search: SettingsSearch;
  /** Accessible name and placeholder. Defaults to the shared "Search settings…". */
  label?: string;
  /** Overrides the builder trigger's name where "Open regex builder" is ambiguous. */
  builderLabel?: string;
  /** Sizes the row for a narrow surface — a phone column, or a 340px popover. */
  compact?: boolean;
  style?: CSSProperties;
}

/**
 * The row: field, regex opt-in, anchored builder, status line.
 *
 * The status line is the part that satisfies "say when the match is elsewhere".
 * It reports three separate facts and it reports them together, because they are
 * separately actionable: how many settings matched here, how many matched on
 * another tab of this same surface (one click away), and how many matched on a
 * different screen entirely (navigate there). Only when all three are zero does
 * it say there is no match — a bare "no matches" while a hit sits one tab over is
 * the exact lie this component exists to stop telling.
 */
export function SettingsSearchRow({ search, label, builderLabel, compact, style }: SettingsSearchRowProps) {
  const t = useT();
  const statusId = useId();
  const name = label ?? t("settings.search");
  const {
    query, setQuery, useRegex, setUseRegex, flags, setFlags,
    error, active, hits, total, otherTabs, otherTabHits, elsewhereTabs, elsewhereHits, sample,
  } = search;

  const notes: string[] = [];
  if (active) {
    notes.push(t("settings.matchCount", { count: hits, total }));
  }
  // Both lists hold `t()` results, so in bilingual mode each name is already a
  // pair. `joinBilingual` regroups a list into one pair that the sentence it is
  // pasted into can still split; a plain comma join interleaves the languages
  // and the whole run then lands in both clauses.
  if (otherTabHits > 0) {
    notes.push(t("settings.otherTabHere", { count: otherTabHits, tabs: joinBilingual(otherTabs, ", ") }));
  }
  if (elsewhereHits > 0) {
    notes.push(t("settings.otherTab", { count: elsewhereHits, tabs: joinBilingual(elsewhereTabs, ", ") }));
  }
  if (active && hits === 0 && otherTabHits === 0 && elsewhereHits === 0) {
    notes.push(t("settings.noMatch"));
  }

  const status = error ? `${t("regex.invalid")}: ${error}` : notes.join(" · ");

  return (
    <>
      <div className="m3-row" role="search" style={style ? { ...ROW, ...style } : ROW}>
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={name}
          aria-label={name}
          aria-invalid={!!error}
          // Bound only while there is something to read: a dangling reference
          // resolves to nothing and quietly costs the field its description.
          aria-describedby={status ? statusId : undefined}
          style={compact ? INPUT_COMPACT : INPUT}
        />
        {/* Plain text stays the default; `.*` is the explicit opt-in every search bar carries. */}
        <Chip
          selected={useRegex}
          onClick={() => setUseRegex(!useRegex)}
          title={t("regex.regexMode")}
          aria-label={t("regex.regexMode")}
        >
          <code style={MONO}>.*</code>
        </Chip>
        <RegexBuilderButton
          value={query}
          flags={flags}
          regex={useRegex}
          onRegexChange={setUseRegex}
          // Both halves come back, not just the pattern: applying a builder whose
          // `m` flag was switched on and then compiling the field with `i` would
          // find different settings than the panel had just previewed.
          onApply={(pattern, appliedFlags) => {
            setQuery(pattern);
            setFlags(appliedFlags);
          }}
          sample={sample}
          label={builderLabel ?? t("settings.openBuilder")}
        />
      </div>
      <p
        id={statusId}
        // An invalid pattern is an error the user has to act on, so it interrupts;
        // a match count is not, so it is announced politely when it settles.
        role={error ? "alert" : "status"}
        style={{ ...(compact ? STATUS_COMPACT : STATUS), ...(error ? { color: "var(--m3-error)" } : null) }}
      >
        {status}
      </p>
    </>
  );
}
