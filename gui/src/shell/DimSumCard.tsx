/**
 * The dim sum surprise card. Non-blocking by contract: it floats bottom-right,
 * auto-dismisses, never traps focus, and never sits over a dialog (z below the
 * modal layer). It renders at most once per launch — the draw happens in the
 * mount effect and is never re-rolled.
 */

import { useEffect, useState } from "react";
import { IconX } from "../icons";
import { useT } from "../i18n/shared";
import { usePrefs } from "../theme/prefs-context";
import { drawDimSum, photoSrc, type DimSumDish } from "./dimsum";

const AUTO_DISMISS_MS = 12_000;

/**
 * One draw per launch, cached at module level. The cache is what makes this
 * robust against StrictMode's double-mount and any later remount of the shell:
 * the roll happens once per page load, full stop. Toggling the pref mid-session
 * does not grant a fresh roll either — the next launch honours the new value.
 */
let launchDraw: DimSumDish | null | undefined;

function drawOncePerLaunch(enabled: boolean, version: string): DimSumDish | null {
  if (launchDraw === undefined) launchDraw = drawDimSum({ enabled, version });
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
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      style={{ width: 48, height: 48, borderRadius: "var(--r-m)", objectFit: "cover", flex: "0 0 auto" }}
    />
  );
}

export default function DimSumCard({ version }: { version: string }) {
  const t = useT();
  const { prefs } = usePrefs();
  // Lazy initializer, not an effect: the draw is a synchronous read+write of
  // localStorage and produces the initial state, so an effect would only add a
  // second render (and trip the set-state-in-effect rule).
  const [dish, setDish] = useState<DimSumDish | null>(() => drawOncePerLaunch(prefs.dimsum, version));

  useEffect(() => {
    if (!dish) return;
    const timer = setTimeout(() => setDish(null), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [dish]);

  if (!dish) return null;

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
          <span lang="yue">{dish.zh}</span> · <span role="img" aria-label={dish.name}>{dish.name}</span>
        </div>
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
