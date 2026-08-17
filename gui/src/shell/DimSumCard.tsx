/**
 * The dim sum surprise card. Non-blocking by contract: it floats bottom-right,
 * auto-dismisses, never traps focus, and never sits over a dialog (z below the
 * modal layer). It renders at most once per launch — the draw happens in the
 * mount effect and is never re-rolled.
 */

import { useEffect, useState } from "react";
import { IconX } from "../icons";
import { useT } from "../i18n/shared";
import { drawDimSum, photoSrc, type DimSumDish } from "./dimsum";
import { useSchoolModeActive } from "../school-mode/hooks";

const AUTO_DISMISS_MS = 12_000;

/**
 * One draw per launch, cached at module level. The cache is what makes this
 * robust against StrictMode's double-mount and any later remount of the shell:
 * the roll happens once per page load, full stop. A remount never buys a second
 * chance, which is the whole of "never twice in one launch".
 */
let launchDraw: DimSumDish | null | undefined;

function drawOncePerLaunch(version: string): DimSumDish | null {
  if (launchDraw === undefined) launchDraw = drawDimSum({ version });
  return launchDraw;
}

/**
 * The dish photo, with the emoji as the fallback.
 *
 * A browser cannot be asked synchronously whether a bundled file exists, so the
 * image is rendered optimistically and `onError` swaps in the stand-in. That
 * makes the art drop-in: put `har-gow.webp` in `gui/public/dimsum/` and this
 * starts showing it, with no change here.
 *
 * The photo is decorative because the dish is already named in text beside it;
 * announcing the name twice is noise for a screen reader. The emoji fallback is
 * hidden for the same reason.
 */
export function DishArt({ dish }: { dish: DimSumDish }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <span aria-hidden="true" style={{ fontSize: 32, lineHeight: 1 }}>{dish.emoji}</span>;
  }
  return (
    <img
      src={photoSrc(dish)}
      alt=""
      aria-hidden="true"
      width={48}
      height={48}
      // Eager, not lazy. The card lives for twelve seconds and the file is a few
      // kilobytes; deferring the load can push it past the card's own lifetime,
      // so the surprise renders as an empty square and then disappears.
      loading="eager"
      decoding="async"
      onError={() => setFailed(true)}
      style={{ width: 48, height: 48, borderRadius: "var(--r-m)", objectFit: "cover", flex: "0 0 auto" }}
    />
  );
}

export default function DimSumCard({ version }: { version: string }) {
  const t = useT();
  // Lazy initializer, not an effect: the draw is a synchronous read+write of
  // localStorage and produces the initial state, so an effect would only add a
  // second render (and trip the set-state-in-effect rule).
  const [dish, setDish] = useState<DimSumDish | null>(() => drawOncePerLaunch(version));
  // School Mode makes the surprise "behave as if it is not installed" — not
  // merely quieter. Checked here, at render, rather than only inside the
  // draw itself: if the roll already happened earlier in this launch (before
  // School Mode turned on, or before its own status fetch resolved), the
  // "once per launch" slot is already spent and cannot be re-rolled — but
  // this still keeps it from ever becoming *visible* while the mode is on,
  // and it reacts live if the mode flips while the card is already showing.
  const schoolModeActive = useSchoolModeActive();

  useEffect(() => {
    if (!dish) return;
    const timer = setTimeout(() => setDish(null), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [dish]);

  if (!dish || schoolModeActive) return null;

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 45, // above content, below dialogs and snackbars
        display: "flex",
        alignItems: "center",
        gap: 12,
        maxWidth: 320,
        padding: "12px 12px 12px 16px",
        borderRadius: "var(--r-l)",
        background: "var(--m3-tertiary-container)",
        color: "var(--m3-on-tertiary-container)",
        boxShadow: "var(--e2)",
        animation: "m3-rise 240ms cubic-bezier(0.2, 0, 0, 1)",
      }}
    >
      <DishArt dish={dish} />
      <div style={{ minWidth: 0, flex: "1 1 auto" }}>
        <div style={{ fontWeight: 600, fontSize: "var(--t-title-s)" }}>{t("dimsum.title")}</div>
        <div style={{ fontSize: "var(--t-body-s)" }}>
          <span lang="zh-HK">{dish.zh}</span> · <span>{dish.name}</span>
        </div>
        <div style={{ fontSize: "var(--t-label-s)", opacity: 0.85, fontStyle: "italic" }}>{dish.jyutping}</div>
        <div style={{ fontSize: "var(--t-label-s)", opacity: 0.8, marginTop: 2 }}>{t("dimsum.hint")}</div>
      </div>
      <button
        type="button"
        onClick={() => setDish(null)}
        aria-label={t("notif.dismiss")}
        title={t("notif.dismiss")}
        style={{
          flex: "0 0 auto",
          display: "grid",
          placeItems: "center",
          width: 36,
          height: 36,
          border: "none",
          borderRadius: "var(--r-pill)",
          background: "transparent",
          color: "inherit",
          cursor: "pointer",
        }}
      >
        <IconX aria-hidden style={{ width: 16, height: 16 }} />
      </button>
    </div>
  );
}
