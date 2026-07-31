/**
 * The three surfaces that live in the corners of every page: the notification
 * bell and its centre, the snackbar stack, and the dim sum card.
 *
 * ## Why one island and not three
 *
 * All three are `position: fixed` chrome that must survive a client-side
 * navigation, and Astro persists an island by name — so three islands would be
 * three `transition:persist` targets that every one of the 165 built pages has
 * to contain, and the first layout that omitted one would silently destroy that
 * surface's state. One island is one thing to keep on every page, which
 * `scripts/check-dist.mjs` can then assert.
 *
 * It also settles the dim sum contract by construction. The draw is once per
 * *launch*, and a component that remounted on every navigation would either
 * redraw or need a guard that outlives it. Persisting the island means the
 * effect runs once for the whole visit; the module-level flag in `lib/dimsum.ts`
 * is the belt to that braces.
 *
 * ## Two of the three are portalled, and one is not
 *
 * The bell renders where it is placed — inside the header's trailing group,
 * beside the appearance and language controls, because that is where a reader
 * looks for it. The snackbar stack and the dim sum card portal to `<body>`:
 * they are viewport-anchored, and `position: fixed` inside an ancestor carrying
 * a `transform`, `filter` or `contain` is positioned against *that* ancestor
 * rather than the viewport. The header is exactly the kind of element that
 * acquires a transform later, and the failure mode — toasts appearing halfway up
 * the page — would look like a CSS bug rather than a containing-block one.
 *
 * ## What is a toast and what is a dialog
 *
 * Everything here informs. Nothing here blocks: no `showModal`, no focus trap,
 * no inert background. The notification centre is a non-modal anchored panel
 * over a page the reader can still read, and the rule it follows — modals only
 * for decisions the reader must make before continuing — means this file has no
 * modal in it at all, because a documentation site asks the reader to decide
 * nothing.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { computePlacement, type Placement } from "../../../shared/m3/anchor";
import { Button, Icon } from "./ui";
import { useUi } from "../lib/i18n/use-ui";
import {
  clearHistory,
  dismiss,
  getNotifications,
  markAllRead,
  relativeTime,
  subscribeNotifications,
  notify,
  type Notice,
  type NoticeTone,
} from "../lib/notifications";
import { dishImage, drawOnce, type DimSumDish } from "../lib/dimsum";
import type { UiKey } from "../lib/i18n/keys";
import type { Vars } from "../../../shared/m3/i18n";
import { BASE } from "../lib/routes";

type Translate = (key: UiKey, vars?: Vars) => string;

/* ------------------------------------------------------------------ icons -- */

const BellIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
);

/**
 * One glyph per tone, so a notice is distinguishable without relying on its
 * colour — the contrast rule applies to meaning as much as to legibility, and a
 * reader who cannot separate the warning amber from the error red still has to
 * be able to tell a warning from an error.
 */
const TONE_ICON: Record<NoticeTone, React.ReactNode> = {
  info: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />
    </svg>
  ),
  success: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.5 2.5L16 9.5" />
    </svg>
  ),
  warn: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h.01" />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" />
    </svg>
  ),
};

/* ------------------------------------------------------------------ store -- */

/**
 * Subscribe to the notification store.
 *
 * `useSyncExternalStore` would be the idiomatic call, but it is imported here
 * through a hand-rolled subscription for one reason: the store is also written
 * from outside React (a `<script>`, another island), and the snapshot identity
 * contract is already guaranteed by `commit` replacing the object. A plain
 * subscribe-and-setState is equivalent here and keeps the dependency surface of
 * this island to what it actually needs.
 */
function useNotificationsState() {
  const [snapshot, setSnapshot] = useState(getNotifications);
  useEffect(() => subscribeNotifications(() => setSnapshot(getNotifications())), []);
  return snapshot;
}

/* ------------------------------------------------------------- notice row -- */

function NoticeAction({ notice, onDone }: { notice: Notice; onDone: () => void }) {
  const action = notice.action;
  if (!action) return null;
  if (action.href) {
    return <a className="m3-snack-action" href={action.href}>{action.label}</a>;
  }
  return (
    <button
      type="button"
      className="m3-snack-action"
      onClick={() => { action.onAction?.(); onDone(); }}
    >
      {action.label}
    </button>
  );
}

/* --------------------------------------------------------------- snackbars -- */

/**
 * The live stack, bottom-left.
 *
 * `aria-live="polite"` on the container so arrivals are announced without
 * stealing focus — none of these is a decision point. An error additionally
 * carries `role="alert"`, which is assertive: an error that waits politely
 * behind whatever the reader is currently hearing can be missed entirely, and an
 * error is the one tone that is never allowed to be missed.
 *
 * Bottom-left rather than bottom-right: the right edge is where a phone's
 * scroll-to-top affordances and a desktop's scrollbar live, and the tab strip's
 * overflow menu opens downward on that side.
 */
function SnackbarStack({ live, dismissLabel }: { live: Notice[]; dismissLabel: string }) {
  if (!live.length) return null;
  return (
    <div className="ocx-snack-host" aria-live="polite">
      {live.map(notice => (
        <div
          key={notice.id}
          className={`ocx-snack ocx-snack--${notice.tone}`}
          role={notice.tone === "error" ? "alert" : undefined}
        >
          <span className="ocx-snack-icon" aria-hidden="true">{TONE_ICON[notice.tone]}</span>
          <div className="ocx-snack-text">
            <p className="ocx-snack-title">{notice.title}</p>
            {notice.body ? <p className="ocx-snack-body">{notice.body}</p> : null}
          </div>
          <NoticeAction notice={notice} onDone={() => dismiss(notice.id)} />
          <button
            type="button"
            className="ocx-snack-close"
            aria-label={dismissLabel}
            title={dismissLabel}
            onClick={() => dismiss(notice.id)}
          >
            {Icon.close}
          </button>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ dim sum card -- */

/**
 * The 1 % card.
 *
 * Auto-dismisses, never takes focus, and is `role="status"` rather than
 * `role="alert"` — it is a small delight, and interrupting a screen-reader user
 * mid-sentence to tell them about a dumpling would be the opposite of one.
 *
 * The alt text is the dish's English name, as the spec requires, so a reader who
 * cannot see the photo gets the same thing the photo carries. The Chinese name
 * and the Jyutping are rendered as text beside it rather than folded into the
 * alt, because they are content and not a description of the image.
 *
 * `onError` falls back to the dish's emoji. Every dish in the table ships a real
 * photo today; the fallback exists so that adding a dish to `shared/m3/dimsum.ts`
 * before its art lands renders a dumpling rather than a broken-image icon.
 */
function DimSumCard({ dish, onDismiss, t }: { dish: DimSumDish; onDismiss: () => void; t: Translate }) {
  const [broken, setBroken] = useState(false);
  const translate = t;
  return (
    <div className="ocx-dimsum" role="status">
      <div className="ocx-dimsum-art">
        {broken ? (
          <span className="ocx-dimsum-emoji" role="img" aria-label={dish.name}>{dish.emoji}</span>
        ) : (
          <img src={dishImage(dish)} alt={dish.name} width={72} height={72} loading="lazy" onError={() => setBroken(true)} />
        )}
      </div>
      <div className="ocx-dimsum-text">
        <p className="ocx-dimsum-title">{translate("dimsum.title")}</p>
        <p className="ocx-dimsum-dish">
          {dish.name} · <span lang="zh-HK">{dish.zh}</span>{" "}
          <span className="ocx-dimsum-jyut">{dish.jyutping}</span>
        </p>
        <p className="ocx-dimsum-why">
          {translate("dimsum.explain")}{" "}
          <a href={`${BASE}settings/`}>{translate("dimsum.settings")}</a>
        </p>
      </div>
      <button
        type="button"
        className="ocx-snack-close"
        aria-label={translate("dimsum.dismiss")}
        title={translate("dimsum.dismiss")}
        onClick={onDismiss}
      >
        {Icon.close}
      </button>
    </div>
  );
}

/** Long enough to read the dish's name twice; short enough not to be furniture. */
const DIM_SUM_MS = 14000;

/* ----------------------------------------------------------------- island -- */

export default function ShellSurfaces() {
  const { t } = useUi();
  const state = useNotificationsState();

  /* ----------------------------------------------------------- the centre */

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  /* Measure first, position second. `useLayoutEffect` so the panel is never
     painted in the wrong place and then moved — on a phone that reads as the
     panel flying in from the wrong edge. */
  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return; }
    const anchor = triggerRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!anchor || !panel) return;
    setPlacement(computePlacement(anchor, { width: panel.width, height: panel.height }, {
      width: window.innerWidth,
      height: window.innerHeight,
    }));
  }, [open, state.history.length]);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, close]);

  /* Opening marks everything read. The alternative — a "mark read" button the
     reader has to find — leaves a badge sitting on the bell after they have
     demonstrably looked at the list, which trains them to ignore it. */
  useEffect(() => {
    if (open) markAllRead();
  }, [open]);

  /* ---------------------------------------------------------- the dim sum */

  const [dish, setDish] = useState<DimSumDish | null>(null);
  useEffect(() => {
    const drawn = drawOnce();
    if (drawn) setDish(drawn);
  }, []);
  useEffect(() => {
    if (!dish) return;
    const timer = setTimeout(() => setDish(null), DIM_SUM_MS);
    return () => clearTimeout(timer);
  }, [dish]);

  /* A preview from the settings page arrives as an event rather than a shared
     store: the settings island and this one are separate React roots, and one
     custom event is a smaller contract than a fourth module store for a button
     that fires at most a few times in a visit. */
  useEffect(() => {
    const onPreview = (event: Event) => {
      const detail = (event as CustomEvent<DimSumDish>).detail;
      if (detail) setDish(detail);
    };
    document.addEventListener("ocx:dimsum-preview", onPreview);
    return () => document.removeEventListener("ocx:dimsum-preview", onPreview);
  }, []);

  /* ----------------------------------------------------------------- copy */

  const history = state.history;
  const unread = state.unread;
  const bellLabel = unread ? `${t("notif.open")} — ${t("notif.unread", { count: unread })}` : t("notif.open");
  const now = Date.now();

  const rows = useMemo(() => history.map(notice => {
    const rel = relativeTime(notice.at, now);
    const when = rel.key === "justNow" ? t("notif.justNow") : t(`notif.${rel.key}` as "notif.minutesAgo", { n: rel.n });
    return { notice, when };
  }), [history, now, t]);

  const portalTarget = typeof document === "undefined" ? null : document.body;

  return (
    <div className="ocx-notif" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="preference-control ocx-notif-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="ocx-notif-panel"
        aria-label={bellLabel}
        title={bellLabel}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="ocx-notif-icon" aria-hidden="true">{BellIcon}</span>
        {unread > 0 && <span className="ocx-notif-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
      </button>

      {open && (
        <div
          id="ocx-notif-panel"
          ref={panelRef}
          className={`ocx-notif-panel${placement?.side === "above" ? " above" : ""}`}
          role="dialog"
          aria-label={t("notif.title")}
          style={{
            left: placement ? `${placement.left}px` : undefined,
            maxHeight: placement ? `${placement.maxHeight}px` : undefined,
            visibility: placement ? "visible" : "hidden",
          }}
        >
          <header className="ocx-notif-head">
            <h2>{t("notif.title")}</h2>
            <button type="button" className="ocx-snack-close" aria-label={t("notif.close")} onClick={() => close()}>
              {Icon.close}
            </button>
          </header>

          {rows.length === 0 ? (
            <div className="ocx-notif-empty">
              <p>{t("notif.empty")}</p>
              <p className="m3-field-hint">{t("notif.emptyHint")}</p>
            </div>
          ) : (
            <>
              <ul className="ocx-notif-list">
                {rows.map(({ notice, when }) => (
                  <li key={notice.id} className={`ocx-notif-row ocx-notif-row--${notice.tone}`}>
                    <span className="ocx-notif-row-icon" aria-hidden="true">{TONE_ICON[notice.tone]}</span>
                    <div className="ocx-notif-row-text">
                      <p className="ocx-notif-row-title">{notice.title}</p>
                      {notice.body ? <p className="ocx-notif-row-body">{notice.body}</p> : null}
                      {notice.action?.href ? (
                        <a className="ocx-notif-row-link" href={notice.action.href}>{notice.action.label}</a>
                      ) : null}
                    </div>
                    <time className="ocx-notif-row-when" dateTime={new Date(notice.at).toISOString()}>{when}</time>
                  </li>
                ))}
              </ul>
              <footer className="ocx-notif-foot">
                <Button
                  variant="text"
                  onClick={() => {
                    clearHistory();
                    notify({ tone: "success", title: t("notif.historyCleared") });
                  }}
                >
                  {t("notif.clear")}
                </Button>
              </footer>
            </>
          )}
        </div>
      )}

      {portalTarget && createPortal(
        <>
          <SnackbarStack live={state.live} dismissLabel={t("notif.dismiss")} />
          {dish && <DimSumCard dish={dish} onDismiss={() => setDish(null)} t={t} />}
        </>,
        portalTarget,
      )}
    </div>
  );
}
