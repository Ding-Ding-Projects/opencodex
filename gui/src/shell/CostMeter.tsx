/**
 * App-bar cost meter: the proxy's estimated spend, visible on every page.
 *
 * Range defaults to lifetime ("all") and is configurable from the chip itself;
 * the choice persists in prefs. The figure comes from the server's own
 * /api/usage summary — the same source the Usage screen reads, so the header
 * can never disagree with the page.
 *
 * The meter is lane-aware. It used to read the legacy `estimatedCostUsd`
 * aggregate, which is direct-API-key-only by construction, so every
 * subscription/OAuth user — the majority — saw a confident "$0.000" for traffic
 * that had a perfectly good API-equivalent value. It now resolves the lane
 * through `resolveSummaryCost` and shows that equivalent figure, tagged in words
 * so nobody reads it as money owed, and shows nothing at all when no lane priced
 * anything: absence of a figure is not a figure, and neither is zero.
 */

import { useEffect, useRef, useState } from "react";
import { onOutsidePress } from "./outside-press";
import { useKeyedClientResource } from "../client-resource";
import { readJsonIfOk } from "../fetch-json";
import { useT, type TKey } from "../i18n/shared";
import { usePrefs } from "../theme/prefs-context";
import type { CostRange } from "../theme/prefs-context";
import { fixedPanelStyle, useAnchoredPlacement } from "./use-anchored-placement";
import { formatUsd } from "./cost-format";
import { resolveSummaryCost, type LaneBearingSummary, type ResolvedSummaryCost } from "../cost-lanes";

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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPlacement = useAnchoredPlacement(wrapRef, menuRef, menuOpen, 180);

  const range = prefs.costRange;
  const poll = useKeyedClientResource(
    `app-usage-cost:${apiBase}:${range}`,
    [range],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/usage?range=${range}`, { signal });
      const d = await readJsonIfOk<{ summary?: LaneBearingSummary }>(res);
      if (!d?.summary) return null;
      const resolved = resolveSummaryCost(d.summary);
      return resolved.primary ? resolved : null;
    },
    { pollMs: 60_000 },
  );

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    const stopOutsideonDown = onOutsidePress(onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutsideonDown();
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // No data (proxy down, no usage log yet) and no lane that priced anything both
  // hide the meter rather than showing a misleading $0 — absence of a figure is
  // not a figure, and zero is a claim about price rather than a lack of one.
  const cost: ResolvedSummaryCost | null | undefined = poll.data;
  if (!cost?.primary) return null;

  const rangeLabel = t(RANGES.find(r => r.range === range)?.tkey ?? "cost.rangeAll");
  const equivalent = cost.primary.kind === "api_equivalent";
  const amount = formatUsd(cost.primary.total);

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <button
        ref={triggerRef}
        type="button"
        // The equivalent variant carries its own tonal container AND the visible
        // "not billed" word below — the tone alone would be colour-only meaning.
        className={equivalent ? "m3-cost-chip m3-cost-chip--equivalent" : "m3-cost-chip"}
        onClick={() => setMenuOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t(equivalent ? "cost.lane.equivalentAria" : "cost.aria", { amount, range: rangeLabel })}
        title={t(equivalent ? "cost.lane.equivalentTitle" : "cost.title", { range: rangeLabel })}
      >
        <span className="m3-cost-amount">{amount}</span>
        <span className="m3-cost-range">
          {equivalent ? t("cost.lane.equivalentTag") : rangeLabel}
        </span>
      </button>
      {menuOpen && (
        {/* The panel itself carries no ARIA role: `role="menu"` requires its owned
            children to be menu items, and the lane breakdown below is descriptive
            content rather than a set of choices. The role therefore sits on the
            inner group that actually holds the range radios. */}
        <div ref={menuRef} className="m3-menu" style={{ ...fixedPanelStyle(menuPlacement), zIndex: 70, minWidth: "min(230px, calc(100vw - 16px))" }}>
          {/* The chip has room for one figure. When both lanes have traffic this is
              where the split becomes visible, so the headline number can never
              stand in for the other lane without saying so. */}
          <div className="m3-menu-heading" id="cost-lane-heading">{t("usage.cost.laneHeading")}</div>
          <dl className="m3-cost-lane-group" aria-labelledby="cost-lane-heading">
            {cost.direct && (
              <div className="m3-cost-lane">
                <dt className="m3-cost-lane-label">{t("cost.lane.direct")}</dt>
                <dd className="m3-cost-lane-value">{formatUsd(cost.direct.total)}</dd>
              </div>
            )}
            {cost.apiEquivalent && (
              <div className="m3-cost-lane">
                <dt className="m3-cost-lane-label">
                  {t("cost.lane.equivalent")} · {t("cost.lane.equivalentTag")}
                </dt>
                <dd className="m3-cost-lane-value">{formatUsd(cost.apiEquivalent.total)}</dd>
              </div>
            )}
          </dl>
          {cost.apiEquivalent && (
            <p className="m3-cost-lane-note">{t("cost.lane.equivalentMeaning")}</p>
          )}
          <div className="m3-menu-heading" id="cost-range-heading">{t("cost.menuTitle")}</div>
          <div role="menu" aria-labelledby="cost-range-heading">
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
        </div>
      )}
    </div>
  );
}
