/**
 * Readable rendering of a revision's captured `before` payload.
 *
 * The old pane dumped the raw serialized snapshot into a `<pre>`. That is the one
 * thing on this screen the user actually has to read — it is what a restore would
 * write back — so it gets structure: JSON becomes `path → value` rows that scan
 * like a settings list, and anything that is not JSON keeps its preformatted text
 * rather than being forced into a table it does not fit.
 */

import type { CSSProperties } from "react";
import { flattenPayload } from "./history-model";

const MONO: CSSProperties = { fontFamily: "var(--mono)" };

const RAW: CSSProperties = {
  ...MONO,
  margin: 0,
  padding: "14px 16px",
  borderRadius: "var(--r-m)",
  background: "var(--m3-surface-container-highest)",
  color: "var(--m3-on-surface)",
  fontSize: "var(--t-label-m)",
  lineHeight: 1.7,
  // Scrolls inside its own box: a long token must never give the page a
  // horizontal scrollbar.
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const TABLE: CSSProperties = {
  margin: 0,
  padding: "10px 16px",
  borderRadius: "var(--r-m)",
  background: "var(--m3-surface-container-highest)",
  color: "var(--m3-on-surface)",
  display: "grid",
  // `auto` rather than a fixed first column: a deep dotted path must not squeeze
  // the value column to nothing at narrow widths.
  gridTemplateColumns: "minmax(0, auto) minmax(0, 1fr)",
  columnGap: 16,
  rowGap: 2,
  // A 400-row snapshot would otherwise push the restore button off screen.
  maxHeight: 340,
  overflowY: "auto",
};

const PATH: CSSProperties = {
  ...MONO,
  margin: 0,
  padding: "4px 0",
  fontSize: "var(--t-label-m)",
  color: "var(--m3-on-surface-variant)",
  overflowWrap: "anywhere",
};

const VALUE: CSSProperties = {
  ...MONO,
  margin: 0,
  padding: "4px 0",
  fontSize: "var(--t-label-m)",
  overflowWrap: "anywhere",
  whiteSpace: "pre-wrap",
};

/**
 * `aria-label` is supplied by the caller (the section heading above it), so the
 * scrollable region is reachable and named for a screen reader instead of being
 * an anonymous scroll trap.
 */
export default function HistoryPayload({ raw, label }: { raw: string; label: string }) {
  const rows = flattenPayload(raw);

  if (!rows) {
    return <pre style={RAW} tabIndex={0} role="group" aria-label={label}>{raw}</pre>;
  }

  return (
    <dl style={TABLE} tabIndex={0} role="group" aria-label={label}>
      {rows.map(row => (
        <div key={row.path} style={{ display: "contents" }}>
          <dt style={PATH}>{row.path}</dt>
          <dd style={VALUE}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
