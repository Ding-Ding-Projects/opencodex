/**
 * Destructive-action super confirmation — the gate for the handful of actions
 * in this app that genuinely have no way back.
 *
 * `useConfirm()` (`confirm.tsx`) is the right tool for almost every decision:
 * stop the proxy, remove a provider, restore a snapshot. Every one of those
 * either does not destroy anything (a stop can be started again) or is
 * recorded first by `shell/revisions.ts` or the proxy's own local git history,
 * so Version History has something to show even when the one-click "restore"
 * on a local entry is, by its own admission, a note rather than a replay (see
 * `pages/VersionHistory.tsx`'s `restoreLocal`). An ordinary confirm dialog is
 * the right amount of ceremony for those, and turning every one of them into
 * this gate would train the user to stop reading it.
 *
 * What lands here is narrower: an action that skips every safety net on
 * purpose. Permanently deleting archived sessions (`storage.cleanup`, mode
 * `permanent`) explicitly bypasses quarantine — the code and copy both say so
 * — and there is no server-side record to restore from afterwards. Redeeming a
 * Codex reset credit spends a scarce, non-renewable resource the moment the
 * request lands; `codexAuth.irreversible` already told the user that before
 * this gate existed. Both are two-click confirmations today; this replaces the
 * second click with something that cannot be produced by accident.
 *
 * The mechanism, in order:
 *
 *   1. Two independently operated keys (`Toggle`s, not one control clicked
 *      twice) must both be on before the slider does anything at all.
 *   2. The slider spans its full range. Dragging it paints a filling, reddening
 *      track — the "dramatic but non-blocking" progress the contract asks for;
 *      non-blocking because this whole surface is non-modal or, on the modal
 *      fallback, never traps the page behind a spinner.
 *   3. Reaching the end calls `onAuthorize()` exactly once. Nothing before that
 *      moment can perform the action — the input stays disabled until both
 *      keys are on, and the slider stops accepting input the instant it fires.
 *   4. A distinct completion state (a check, not the same fill animation) plays
 *      after `onAuthorize()` resolves, then the gate closes itself.
 *   5. A rejection resets the slider to zero, keeps the keys on, and shows what
 *      went wrong inline — so a transient failure is one drag away from a retry
 *      rather than a trip back through both keys.
 *
 * Emergency exit is always clickable, Escape always dismisses, and both do
 * exactly what Cancel does anywhere else in this app: settle nothing, perform
 * nothing, and hand focus back to the control that opened this. An in-flight
 * `onAuthorize()` is not cancelled by closing early — there is no way to abort
 * a request already sent — but a `mountedRef` guard stops its eventual
 * settlement from touching state that no longer has anywhere to render.
 *
 * Two presentations, per the contract's own preference order. `"anchored"`
 * floats beside `anchorRef` exactly the way `RegexBuilderButton` and
 * `TabAppearanceEditor` already do — measured placement, `onOutsidePress`,
 * document-level Escape, no focus trap, nothing behind it inert. `"modal"` is
 * the documented fallback for a layout that cannot host that: `CodexAccountResetModal`
 * swaps its entire body between an info step and a confirm step, so the button
 * that opens the confirm step is unmounted by the time this would need to
 * measure it. Reusing the shared `Dialog` there keeps the account-credit flow
 * doing what it already did — a centred modal — while gaining the same gate.
 */

import {
  useEffect, useId, useLayoutEffect, useRef, useState,
  useCallback, type ReactNode, type RefObject,
} from "react";
import { onOutsidePress } from "./outside-press";
import { computeViewportPlacement } from "./use-anchored-placement";
import { fixedPanelStyle, INITIAL_PLACEMENT, type Placement } from "../../../shared/m3/anchor";
import { Banner, Button, Dialog, Toggle } from "./m3-ui";
import { IconAlert, IconCheck } from "../icons";
import { useT } from "../i18n/shared";

type Phase = "idle" | "authorizing" | "done" | "error";

/** How long the completion state stays on screen before the gate closes itself. */
const DONE_DWELL_MS = 900;

export interface SuperConfirmGateProps {
  /**
   * The destructive control this gate belongs to. Anchors the floating panel
   * in `"anchored"` presentation and receives focus back on every exit route
   * in both presentations.
   */
  anchorRef: RefObject<HTMLElement | null>;
  presentation: "anchored" | "modal";
  /** Names the exact destructive action — never "Are you sure?". */
  title: string;
  /** What will be deleted, changed or spent, and what it costs. Rendered `pre-line`. */
  body: ReactNode;
  /** Exactly two independently operated acknowledgements. Order is cosmetic. */
  keyLabels: readonly [string, string];
  /** The slider's own accessible name, naming the action it authorizes. */
  sliderLabel: string;
  /** Shown while `onAuthorize()` is in flight. */
  workingLabel: string;
  /** Shown during the completion dwell, after `onAuthorize()` resolves. */
  doneLabel: string;
  /**
   * Runs exactly once, only once both keys are on and the slider has reached
   * its end. A thrown error (or a rejected promise) is caught and shown
   * inline; it never propagates to the caller.
   */
  onAuthorize: () => Promise<void>;
  /** Every exit route: Emergency exit, Escape, the scrim (modal only), and a completed authorize. */
  onClose: () => void;
}

/** Mounted only while the caller wants it open — presence in the tree IS "open". */
export function SuperConfirmGate(props: SuperConfirmGateProps) {
  const {
    anchorRef, presentation, title, body, keyLabels, sliderLabel, workingLabel, doneLabel, onAuthorize, onClose,
  } = props;
  const t = useT();
  const [key1, setKey1] = useState(false);
  const [key2, setKey2] = useState(false);
  const [value, setValue] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [placement, setPlacement] = useState<Placement>(INITIAL_PLACEMENT);
  const panelRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const baseId = useId();
  const titleId = `${baseId}-title`;

  const bothKeys = key1 && key2;
  const idle = phase === "idle";

  useEffect(() => () => { mountedRef.current = false; }, []);

  /**
   * Every dismissal route lands here. Resetting local state before `onClose`
   * matters only for the (impossible in practice, cheap to guard) case where a
   * caller keeps the same component instance mounted across a reopen; handing
   * focus back is what every exit route in this app already promises.
   */
  const cancel = useCallback(() => {
    setKey1(false);
    setKey2(false);
    setValue(0);
    setPhase("idle");
    setErrorMessage(null);
    onClose();
    anchorRef.current?.focus();
  }, [anchorRef, onClose]);

  // `cancel` is rebuilt every render (it closes over `onClose`, which a caller
  // may hand down as a fresh inline function each time). The document listeners
  // below are registered once per `presentation` rather than once per render —
  // re-subscribing on every keystroke of the slider would be wasted work for a
  // listener that only ever needs the latest closure at the moment it actually
  // fires — so they read through this ref instead of naming `cancel` as a
  // dependency, which would otherwise mean acting on a stale `onClose`.
  const cancelRef = useRef(cancel);
  useEffect(() => {
    cancelRef.current = cancel;
  }, [cancel]);

  // Anchored-only chrome: outside press and Escape. The modal presentation
  // gets both from `Dialog` itself (its own scrim and its own `onCancel`).
  useEffect(() => {
    if (presentation !== "anchored") return;
    const onDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) cancelRef.current();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") cancelRef.current(); };
    const stopOutsidePress = onOutsidePress(onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutsidePress();
      document.removeEventListener("keydown", onKey);
    };
  }, [presentation]);

  useLayoutEffect(() => {
    if (presentation !== "anchored") return;
    const reposition = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      setPlacement(computeViewportPlacement(
        { top: anchor.top, bottom: anchor.bottom, left: anchor.left, right: anchor.right },
        { width: panel.width, height: panel.height },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [presentation, anchorRef]);

  // Focus the first key on open. The modal presentation gets this for free
  // from `showModal()` (first focusable descendant), but the anchored one has
  // no such native behaviour to lean on.
  useEffect(() => {
    if (presentation !== "anchored") return;
    const first = panelRef.current?.querySelector<HTMLButtonElement>('[role="switch"]');
    first?.focus();
  }, [presentation]);

  const runAuthorize = () => {
    setPhase("authorizing");
    setErrorMessage(null);
    onAuthorize()
      .then(() => {
        if (!mountedRef.current) return;
        setPhase("done");
        window.setTimeout(() => {
          if (!mountedRef.current) return;
          onClose();
          anchorRef.current?.focus();
        }, DONE_DWELL_MS);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setPhase("error");
        // The keys stay on — only the slide itself is undone — so a retry
        // after a transient failure is one drag away, not a walk back through
        // both acknowledgements.
        setValue(0);
      });
  };

  // Guards apply even though the control is `disabled` outside these
  // conditions: a disabled `<input>` does not reliably suppress `change` in
  // every environment this renders in (jsdom/happy-dom included), and "never
  // perform the action unless both keys and the slider have completed" is the
  // one promise this file exists to keep, not one to trust to a DOM attribute.
  const onSlide = (next: number) => {
    if (!bothKeys || (phase !== "idle" && phase !== "error")) return;
    setValue(next);
    if (next >= 100) runAuthorize();
  };

  const statusText = phase === "authorizing" ? workingLabel
    : phase === "done" ? doneLabel
    : bothKeys ? t("superConfirm.slideHint")
    : t("superConfirm.keysHint");

  const content = (
    <>
      <h2 id={titleId} className="m3-superconfirm-title">{title}</h2>
      <div className="m3-superconfirm-body">{body}</div>

      <div className="m3-superconfirm-keys" role="group" aria-label={t("superConfirm.keysHint")}>
        {keyLabels.map((label, index) => {
          const on = index === 0 ? key1 : key2;
          const setOn = index === 0 ? setKey1 : setKey2;
          return (
            <div className="m3-superconfirm-key" key={index}>
              <IconAlert width={18} aria-hidden="true" className="m3-superconfirm-key-icon" />
              <span className="m3-superconfirm-key-label">{label}</span>
              <Toggle on={on} disabled={!idle} onChange={setOn} label={label} />
            </div>
          );
        })}
      </div>

      <p className="m3-superconfirm-status" role="status">{statusText}</p>

      <div
        className={`m3-superconfirm-track m3-superconfirm-track--${phase}${bothKeys ? " m3-superconfirm-track--armed" : ""}`}
        style={{ ["--sc-progress" as string]: `${value}%` }}
      >
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={idle || phase === "error" ? value : 100}
          disabled={!bothKeys || (phase !== "idle" && phase !== "error")}
          aria-label={sliderLabel}
          aria-valuetext={t("superConfirm.progressAnnounce", { percent: String(value) })}
          className="m3-superconfirm-slider"
          onChange={event => onSlide(Number(event.target.value))}
        />
      </div>

      {phase === "done" && (
        <div className="m3-superconfirm-done" role="presentation">
          <IconCheck width={28} aria-hidden="true" />
        </div>
      )}

      {phase === "error" && errorMessage && (
        <Banner tone="error" title={t("superConfirm.authFailed")}>{errorMessage}</Banner>
      )}

      <div className="m3-dialog__actions">
        <Button variant="outlined" onClick={cancel}>{t("superConfirm.emergencyExit")}</Button>
      </div>
    </>
  );

  if (presentation === "modal") {
    return (
      <Dialog labelledBy={titleId} onClose={cancel}>
        {content}
      </Dialog>
    );
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      // No `aria-modal`: nothing behind an anchored gate is inert, and saying
      // otherwise tells a screen reader the rest of the page is unavailable —
      // the same reasoning `RegexBuilderButton` and `TabAppearanceEditor` use.
      aria-labelledby={titleId}
      className="m3-superconfirm-panel"
      style={fixedPanelStyle(placement)}
    >
      {content}
    </div>
  );
}
