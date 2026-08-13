/**
 * The app bar's quick restore: one press per tool that hands Codex or Claude its
 * own configuration back and then stops the proxy.
 *
 * The ordering is the feature. A normal stop — the Stop button, `ocx stop`,
 * `POST /api/host/exit` — does the restore on the way out, which means a stop
 * that drains forever, refuses because an installed service belongs to another
 * OPENCODEX_HOME, or simply hangs takes the restore down with it. That is
 * precisely the situation somebody goes looking for a button in, so gating the
 * restore on a clean shutdown makes it fail exactly when it is needed.
 *
 * So this runs them as two separate requests, restore first:
 *
 *   1. POST /api/host/quick-restore — local file I/O only. No drain, no service
 *      control, no exit. It answers in milliseconds and cannot be held up by the
 *      proxy's lifecycle, because it never touches it.
 *   2. Only then, the ordinary stop. Its failure has nowhere to reach back to.
 *
 * The two outcomes are therefore always known independently and are always
 * reported independently — including the awkward middle case, where the config
 * is native again and the proxy is still up. Saying "restored" there and nothing
 * else would leave the user believing a stop happened that did not, and starting
 * or syncing OpenCodex would quietly re-apply the routing they just removed.
 *
 * One thing this deliberately does NOT do is stop the proxy when the restore
 * failed. Stopping would take the dashboard offline and remove the surface they
 * would retry from, to no purpose — the restore is the thing they asked for, and
 * the proxy is worth more running than not while it is unfinished.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconUndo } from "../icons";
import { useT } from "../i18n/shared";
import { useConfirm } from "./confirm-context";
import { useNotifications } from "./notifications-context";
import { useSettingsDrafts } from "../settings-drafts-context";
import { usePrefs } from "../theme/prefs-context";
import { onOutsidePress } from "./outside-press";
import { requestProxyStop } from "../stop-proxy";
import { Button } from "./m3-ui";
import { fixedPanelStyle, useAnchoredPlacement } from "./use-anchored-placement";

type QuickRestoreTool = "codex" | "claude";

interface Readiness {
  tool: QuickRestoreTool;
  available: boolean;
  reason: string | null;
  paths: string[];
  injected: boolean;
}

/**
 * The restore itself: local file rewrites, a bounded history snapshot, and — for
 * Codex — a SQLite resume-history pass that can stall briefly behind the Codex
 * app's own writer lock. Generous, because the cost of cutting it short is a
 * caller that cannot say whether the files were rewritten.
 */
const RESTORE_TIMEOUT_MS = 20_000;
/** The stop REQUEST. `/api/stop` answers first and exits afterwards, so this is short. */
const STOP_TIMEOUT_MS = 5_000;
/**
 * How long the listener is given to actually disappear before we report that it
 * did not. Matches the server's own shutdown budget (`shutdownTimeoutMs`,
 * default 5 s) plus the 200 ms it waits for the response to flush.
 */
const STOP_VERIFY_MS = 6_000;
const PROBE_TIMEOUT_MS = 1_500;
const PROBE_INTERVAL_MS = 300;

/** One health probe. Any answer at all means the process is still up. */
async function proxyAnswering(apiBase: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/healthz`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for the proxy to stop answering, or give up and say so.
 *
 * This is why the stop half can be reported honestly at all. `requestProxyStop`
 * reads a dropped connection as success, which is right for the Stop button and
 * wrong here: "the socket closed because it exited" and "nothing ever came back"
 * are indistinguishable from the request alone and mean opposite things. Asking
 * the listener directly settles it.
 *
 * The first probe is expected to succeed — the server schedules its exit 200 ms
 * after flushing the response — so this polls rather than reading once.
 */
async function waitForProxyGone(apiBase: string): Promise<boolean> {
  const deadline = Date.now() + STOP_VERIFY_MS;
  for (;;) {
    if (!(await proxyAnswering(apiBase))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
}

export default function QuickRestore({ apiBase }: { apiBase: string }) {
  const t = useT();
  const confirm = useConfirm();
  const { notify } = useNotifications();
  const { windowClass } = usePrefs();
  const { dirty } = useSettingsDrafts();

  const [readiness, setReadiness] = useState<Readiness[] | null>(null);
  /** null = still loading, [] = the proxy answered but told us nothing usable. */
  const [readFailed, setReadFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busyTool, setBusyTool] = useState<QuickRestoreTool | null>(null);
  const [phase, setPhase] = useState<"restoring" | "stopping" | null>(null);

  /**
   * The real re-entry guard.
   *
   * `disabled` on the button is the visible one and stops a second click; it
   * does not stop a keyboard activation that lands in the same tick, a second
   * entry point (the inline button and the panel button share this handler), or
   * a stale render. A ref is read synchronously at the top of the handler, so
   * the second call returns before it can issue a second restore.
   */
  const running = useRef(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const placement = useAnchoredPlacement(rootRef, panelRef, open, 340);

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/host/quick-restore`, { signal: ac.signal });
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json() as { tools?: Readiness[] };
        if (!Array.isArray(body.tools)) throw new Error("shape");
        setReadiness(body.tools);
        setReadFailed(false);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        // A failed read is reported as a failed read, never rendered as "there is
        // nothing to restore" — that would disable both buttons for a reason the
        // reader would take as fact about their machine.
        setReadiness([]);
        setReadFailed(true);
      }
    })();
    return () => ac.abort();
  }, [apiBase]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const stopOutside = onOutsidePress(onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutside();
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toolName = useCallback(
    (tool: QuickRestoreTool) => t(tool === "codex" ? "quickRestore.toolCodex" : "quickRestore.toolClaude"),
    [t],
  );

  const entryFor = useCallback(
    (tool: QuickRestoreTool) => readiness?.find(entry => entry.tool === tool) ?? null,
    [readiness],
  );

  /**
   * Why this control cannot be used right now, or null when it can.
   *
   * Never an empty disabled button: a control that is greyed out with no reason
   * reads as broken, and the two reasons here mean very different things — one
   * is about the machine, the other about the proxy.
   */
  const blockedReason = useCallback((tool: QuickRestoreTool): string | null => {
    if (readiness === null) return t("quickRestore.loading");
    if (readFailed) return t("quickRestore.statusUnknown");
    const entry = entryFor(tool);
    if (!entry) return t("quickRestore.statusUnknown");
    if (!entry.available) return t("quickRestore.unavailable", { tool: toolName(tool) });
    return null;
  }, [readiness, readFailed, entryFor, t, toolName]);

  const run = useCallback(async (tool: QuickRestoreTool) => {
    if (running.current) return;
    const entry = entryFor(tool);
    // The disabled attribute is the visible guard; this is the real one, and it
    // also covers a programmatic call that never went near the button.
    if (!entry?.available) return;

    // Claimed BEFORE the confirmation, not after. Claiming after would let two
    // activations arriving in the same tick each open their own dialog, and the
    // second would then find the guard released by the time its dialog was
    // answered — two restores from one intent. The `finally` below releases it on
    // every route out, cancellation included.
    running.current = true;
    const name = toolName(tool);

    try {
      const confirmed = await confirm({
        title: t("quickRestore.confirmTitle", { tool: name }),
        body: t("quickRestore.confirmBody", { tool: name, paths: entry.paths.join("\n") }),
        confirmLabel: t("quickRestore.confirmAction"),
        tone: "danger",
      });
      if (!confirmed) return;

      setBusyTool(tool);
      setPhase("restoring");
      // The panel deliberately stays open: progress belongs in the surface the
      // action was started from, and closing it would leave a long operation with
      // nowhere to report from except a snackbar that has not happened yet.

      let payload: {
        success?: boolean; message?: string; error?: string;
        snapshotRecorded?: boolean; changed?: string[];
      } | null = null;
      try {
        const res = await fetch(`${apiBase}/api/host/quick-restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool }),
          signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS),
        });
        payload = await res.json().catch(() => null);
        if (payload && typeof payload.success !== "boolean") payload.success = res.ok;
      } catch {
        payload = null;
      }

      if (!payload) {
        // No answer at all. We do not know whether the files were rewritten, so
        // that is exactly what gets said — never a guess in either direction.
        notify({
          tone: "error",
          title: t("quickRestore.noAnswer", { tool: name }),
          body: t("quickRestore.noAnswerBody"),
        });
        return;
      }

      if (!payload.success) {
        notify({
          tone: "error",
          title: t("quickRestore.restoreFailedTitle", { tool: name }),
          body: `${payload.message ?? payload.error ?? ""}\n\n${t("quickRestore.restoreFailedBody", { tool: name })}`.trim(),
        });
        return;
      }

      // The restore has landed and is no longer at risk from anything below.
      setPhase("stopping");
      const stop = await requestProxyStop(apiBase, {
        timeoutMs: STOP_TIMEOUT_MS,
        formatFailure: status => t("quickRestore.stopHttp", { status: String(status) }),
      });
      const gone = stop.accepted ? await waitForProxyGone(apiBase) : false;

      const snapshotNote = payload.snapshotRecorded === false
        ? t("quickRestore.snapshotSkipped")
        : undefined;

      if (gone) {
        notify({
          tone: "success",
          title: t("quickRestore.doneBoth", { tool: name }),
          body: [payload.message, snapshotNote].filter(Boolean).join("\n\n") || undefined,
        });
        return;
      }

      // The middle case, reported as two notices because it is two outcomes. The
      // success auto-dismisses; the failure persists until it is read, which is
      // the right way round — the part that still needs doing is the part that
      // must not scroll away.
      notify({
        tone: "success",
        title: t("quickRestore.doneRestoreOnly", { tool: name }),
        body: [payload.message, snapshotNote].filter(Boolean).join("\n\n") || undefined,
      });
      notify({
        tone: "error",
        title: t("quickRestore.stopFailedTitle"),
        body: [stop.message, t("quickRestore.stopFailedBody", { tool: name })].filter(Boolean).join("\n\n"),
      });
    } finally {
      running.current = false;
      setBusyTool(null);
      setPhase(null);
    }
  }, [apiBase, confirm, entryFor, notify, t, toolName]);

  const actions = useMemo(() => ([
    { tool: "codex" as const, label: t("quickRestore.codex"), aria: t("quickRestore.codexAria") },
    { tool: "claude" as const, label: t("quickRestore.claude"), aria: t("quickRestore.claudeAria") },
  ]), [t]);

  const statusText = phase === "restoring"
    ? t("quickRestore.restoring", { tool: busyTool ? toolName(busyTool) : "" })
    : phase === "stopping"
      ? t("quickRestore.stopping")
      : null;

  /*
    Inline only when the row genuinely has space for two labelled buttons.

    The bar already carries a title, the build line, the code name, the cost
    meter, three icon buttons, the account chip and four window controls — and
    the draft bar on top of that whenever there are unapplied settings. Below the
    expanded breakpoint, or while that draft bar is up, these collapse into the
    single trigger and its panel rather than pushing the window controls off the
    end. Same two actions, same handler, same disabled reasons either way.
  */
  const inline = windowClass === "expanded" && !dirty;

  return (
    <div ref={rootRef} className="m3-quick-restore" style={{ position: "relative", display: "flex", alignItems: "center", gap: 4 }}>
      {inline
        ? actions.map(action => {
          const reason = blockedReason(action.tool);
          const busy = busyTool === action.tool;
          const inert = !!reason || busyTool !== null;
          return (
            <Button
              key={action.tool}
              variant="text"
              className={`m3-quick-restore__inline${inert ? " m3-quick-restore__inline--inert" : ""}`}
              /*
                `aria-disabled`, not the native `disabled` attribute.

                A natively disabled button is unfocusable, so the reason it
                carries — the whole point of not greying a control out silently —
                becomes unreachable to anyone who is not holding a mouse over it.
                It also drops focus on the floor the instant an operation starts,
                which is exactly when a keyboard user is watching the control.
                The refusal is real either way: the handler checks first, and the
                ref inside `run` refuses re-entry regardless of what the DOM says.
              */
              aria-disabled={inert || undefined}
              aria-describedby={reason ? `quick-restore-reason-${action.tool}` : undefined}
              onClick={() => { if (inert) return; void run(action.tool); }}
              aria-label={action.aria}
              title={reason ?? action.aria}
            >
              <IconUndo aria-hidden />
              <span>{busy && statusText ? statusText : action.label}</span>
              {reason && (
                <span id={`quick-restore-reason-${action.tool}`} className="m3-visually-hidden">{reason}</span>
              )}
            </Button>
          );
        })
        : (
          <button
            ref={triggerRef}
            type="button"
            className="m3-icon-btn"
            onClick={() => setOpen(o => !o)}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={t("quickRestore.title")}
            title={t("quickRestore.title")}
          >
            <IconUndo aria-hidden />
          </button>
        )}

      {open && !inline && (
        <div
          ref={panelRef}
          className="m3-menu m3-quick-restore__panel"
          role="dialog"
          aria-label={t("quickRestore.title")}
          style={{ ...fixedPanelStyle(placement), zIndex: 70, minWidth: "min(340px, calc(100vw - 16px))" }}
        >
          <div className="m3-menu-heading">{t("quickRestore.title")}</div>
          <p className="m3-quick-restore__hint">{t("quickRestore.hint")}</p>
          {actions.map(action => {
            const reason = blockedReason(action.tool);
            const entry = entryFor(action.tool);
            const busy = busyTool === action.tool;
            const inert = !!reason || busyTool !== null;
            return (
              <div key={action.tool} className="m3-quick-restore__row">
                <Button
                  variant="tonal"
                  className={inert ? "m3-quick-restore__inline--inert" : undefined}
                  // Same reasoning as the inline form above: refused in the
                  // handler, announced rather than silently unfocusable.
                  aria-disabled={inert || undefined}
                  aria-describedby={`quick-restore-reason-${action.tool}`}
                  onClick={() => { if (inert) return; void run(action.tool); }}
                  aria-label={action.aria}
                  title={reason ?? action.aria}
                >
                  {busy && statusText ? statusText : action.label}
                </Button>
                {/* Adjacent text, not only a tooltip: a control that will not act
                    must say what is unmet somewhere a keyboard or screen-reader
                    user reaches without hovering. When it will act, the same slot
                    names the files it is about to rewrite. */}
                <span id={`quick-restore-reason-${action.tool}`} className="m3-quick-restore__reason">
                  {reason
                    ?? (entry && !entry.injected
                      ? t("quickRestore.notInjected", { tool: toolName(action.tool) })
                      : entry?.paths.join(" · "))}
                </span>
              </div>
            );
          })}
          {statusText && (
            <p className="m3-quick-restore__status" role="status" aria-live="polite">{statusText}</p>
          )}
        </div>
      )}

      {/* The inline form has no room for a status line and a changed button
          label is not announced on its own, so the phase gets a live region of
          its own there. Only in that form: the panel already carries a visible
          one, and two would announce the same sentence twice. */}
      {inline && (
        <span className="m3-visually-hidden" role="status" aria-live="polite">{statusText ?? ""}</span>
      )}
    </div>
  );
}
