/**
 * The flags a search bar is actually compiling, as controls rather than as a secret.
 *
 * The builder hands a pattern *and* its flags back now, which is what made this
 * necessary. Before that, every collection search in the app compiled
 * `new RegExp(query, "i")` and the flag chips inside the anchored popover were
 * decorative from the field's point of view: turning on `m` or `s` changed the
 * match list in the panel and then changed nothing about what the list behind it
 * found, and a pattern deliberately built as case-sensitive arrived
 * case-insensitive. Carrying the flags fixes half of that. This row fixes the
 * other half — a search running under flags the user can neither see nor change
 * is the same invisible state moved one screen along rather than removed.
 *
 * So the carried flags land in chips that show what arrived and let it be
 * corrected, and a line underneath names the literal the field compiles to.
 *
 * Extracted rather than copied because ten search bars now need it, and this
 * file's neighbours already record what happens when a search behaviour is
 * hand-wired ten times: `settings-search.ts` exists precisely because six
 * near-identical copies of one search row had drifted apart in ways nobody
 * decided on. `Logs.tsx` holds the original inline copy this is generalized
 * from; that page keeps its own markup only because its row is threaded through
 * a hand-off from another screen, and the two are asserted to agree by the
 * shared translation keys they both render.
 *
 * What it deliberately does NOT do: hold state, compile anything, or decide what
 * the search finds. The host owns its query, its mode and its flags; this only
 * renders them and reports what the compile step will drop.
 */

import { FLAGS } from "../regex/engine";
import { useT } from "../i18n/shared";
import { Chip } from "./m3-ui";
import { stripStatefulFlags } from "./settings-search";

const MONO = { fontFamily: "var(--mono)" } as const;

const LABEL_STYLE = {
  color: "var(--m3-on-surface-variant)",
  fontSize: "var(--t-label-l)",
} as const;

const STATE_STYLE = {
  margin: "0 0 8px",
  color: "var(--m3-on-surface-variant)",
  fontSize: "var(--t-label-m)",
} as const;

export interface SearchFlagsRowProps {
  /**
   * The host's regex mode. The row renders nothing while it is off, because
   * plain text is a case-insensitive substring search whatever the chips say —
   * and a control that looks live while changing nothing is exactly the
   * decorative affordance the interface rules forbid.
   */
  regex: boolean;
  /** The flags the host compiles, minus whatever the compile step drops. */
  flags: string;
  /** A chip was pressed. The host writes the new set into its own state. */
  onFlagsChange: (next: string) => void;
  /**
   * Id for the state line, so the host's own search field can point
   * `aria-describedby` at it.
   *
   * Required rather than generated: two search bars on one screen own two
   * independent flag sets, and a generated id could not be referenced by the
   * field it belongs to — which is the half of this that reaches a screen reader.
   */
  id: string;
}

export function SearchFlagsRow({ regex, flags, onFlagsChange, id }: SearchFlagsRowProps) {
  const t = useT();
  if (!regex) return null;

  const toggleFlag = (flag: string) => {
    onFlagsChange(flags.includes(flag) ? flags.replace(flag, "") : flags + flag);
  };

  // Derived from the same function the compile step calls rather than from a
  // hand-written `includes("g") || includes("y")`. The two must never be able to
  // disagree: a row that says a flag is honoured while the matcher drops it is
  // worse than a row that says nothing, because it is a claim the user checks
  // their own pattern against.
  const statefulIgnored = stripStatefulFlags(flags) !== flags;

  return (
    <>
      <div
        className="m3-row"
        style={{ gap: 6, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}
      >
        <span style={LABEL_STYLE}>{t("search.flags")}</span>
        <div
          className="m3-row"
          role="group"
          aria-label={t("search.flags")}
          // The state line is the description, so a screen reader reaching the
          // group hears what the current set actually compiles to rather than
          // six unexplained single letters.
          aria-describedby={id}
          style={{ gap: 6 }}
        >
          {FLAGS.map(f => (
            <Chip
              key={f.flag}
              selected={flags.includes(f.flag)}
              onClick={() => toggleFlag(f.flag)}
              title={t(f.tkey)}
            >
              <code style={MONO}>{f.flag}</code>
            </Chip>
          ))}
        </div>
      </div>
      <p id={id} style={STATE_STYLE}>
        {flags ? t("search.flagsCompiled", { flags }) : t("search.flagsNone")}
        {/* `g` and `y` are dropped before compiling, so the row has to say so
            rather than leaving the user to wonder why a global pattern behaves
            identically with the chip on and off. */}
        {statefulIgnored ? ` ${t("search.flagsStateful")}` : ""}
      </p>
    </>
  );
}
