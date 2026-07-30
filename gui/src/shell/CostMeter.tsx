/**
 * App-bar cost meter: the proxy's estimated spend, visible on every page.
 *
 * Range defaults to lifetime ("all") and is configurable from the chip itself;
 * the choice persists in prefs. The number is the server's own
 * `estimatedCostUsd` from /api/usage — the same figure the Usage screen shows,
 * so the header can never disagree with the page.
 */

import { useEffect, useRef, useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { readJsonIfOk } from "../fetch-json";
import { useT, type TKey } from "../i18n/shared";
import { usePrefs } from "../theme/prefs-context";
import type { CostRange } from "../theme/prefs-context";
import { formatUsd } from "./cost-format";

const RANGES: { range: CostRange; tkey: TKey }[] = [
  { range: "all", tkey: "cost.rangeAll" },
  { range: "30d", tkey: "cost.range30d" },
  { range: "7d", tkey: "cost.range7d" },
];

export default function CostMeter({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { prefs, setPrefs } = usePrefs();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const range = prefs.costRange;
  const poll = useKeyedClientResource(
    `app-usage-cost:${apiBase}:${range}`,
    [range],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/usage?range=${range}`, { signal });
      const d = await readJsonIfOk<{ summary?: { estimatedCostUsd?: unknown } }>(res);
      const cost = d?.summary?.estimatedCostUsd;
      return typeof cost === "number" ? cost : null;
    },
    { pollMs: 60_000 },
  );

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // No data (proxy down, no usage log yet) hides the meter rather than showing
  // a misleading $0 — absence of a figure is not a figure.
  if (poll.data === null || poll.data === undefined) return null;

  const rangeLabel = t(RANGES.find(r => r.range === range)?.tkey ?? "cost.rangeAll");

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <button
        type="button"
        className="m3-cost-chip"
        onClick={() => setMenuOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t("cost.aria", { amount: formatUsd(poll.data), range: rangeLabel })}
        title={t("cost.title", { range: rangeLabel })}
      >
        <span className="m3-cost-amount">{formatUsd(poll.data)}</span>
        <span className="m3-cost-range">{rangeLabel}</span>
      </button>
      {menuOpen && (
        <div className="m3-menu" role="menu" style={{ top: "100%", right: 0, minWidth: 180 }}>
          <div className="m3-menu-heading">{t("cost.menuTitle")}</div>
          {RANGES.map(item => (
            <button
              key={item.range}
              type="button"
              role="menuitemradio"
              aria-checked={item.range === range}
              className="m3-menu-item"
              onClick={() => { setPrefs({ costRange: item.range }); setMenuOpen(false); }}
            >
              <span style={{ fontWeight: item.range === range ? 600 : 400 }}>{t(item.tkey)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
