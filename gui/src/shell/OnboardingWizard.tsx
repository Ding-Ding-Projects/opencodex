/**
 * First-run onboarding wizard.
 *
 * Three steps — language, connect a provider, done — shown once on a brand new
 * install and never again. It is mounted unconditionally in `App.tsx` beside the
 * snackbar host and decides for itself whether to appear; `onboarding-state.ts`
 * owns that decision and biases every ambiguous signal towards staying hidden.
 *
 * This is one of the few legitimately blocking surfaces in the dashboard, so it
 * is a real modal: `role="dialog"` + `aria-modal`, a labelled title, focus moved
 * in on open and trapped while open, Escape closing it as a skip, and focus
 * returned to whatever had it before. Everything else the app says stays
 * non-blocking — the exit itself reports through the snackbar host.
 *
 * It never gates the app. The wizard only opens after the provider probe has
 * answered; a proxy that is down, a refused request or an unexpected payload all
 * mean it stays shut rather than trapping the user behind a half-loaded wizard.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { IconCheck, IconDevices, IconServer, IconTranslate, IconX } from "../icons";
import { LOCALES, useI18n, useT, type Locale } from "../i18n/shared";
import { Button, Chip, TextInput, Toggle } from "./m3-ui";
import { useNotifications } from "./notifications-context";
import { recordRevision } from "./revisions";
import {
  closeForLaunch,
  completeOnboarding,
  decideFirstRun,
  deferOnboarding,
  isClosedForLaunch,
} from "./onboarding-state";

const TOTAL_STEPS = 4;

/** Shortest key `/api/host` will store. Stated up front rather than after a rejection. */
const MIN_KEY_LENGTH = 12;

const TITLE_ID = "ocx-onboard-title";
const SUB_ID = "ocx-onboard-sub";
const LANG_LABEL_ID = "ocx-onboard-lang-label";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

type ExitReason = "finish" | "skip" | "provider";

function focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  // No visibility filtering: the dialog renders one step at a time, so
  // everything matched here is on screen. `offsetParent` probing would only add
  // a layout-dependent way for the trap to end up with an empty list.
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

export default function OnboardingWizard({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const { notify } = useNotifications();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<{ url: string; self: boolean; version?: string }[] | null>(null);
  const [expose, setExpose] = useState(false);
  const [key, setKey] = useState("");
  const [exposeBusy, setExposeBusy] = useState(false);
  // Pre-armed on purpose: the wizard is a once-only surface, so the default
  // behaviour of every exit path is "never again". Turning it off is how a user
  // asks to be shown it on the next launch, which is the only way this control
  // can mean anything without risking the every-launch failure mode.
  const [dontShow, setDontShow] = useState(true);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const restorePendingRef = useRef(false);

  // The latch in `onboarding-state` is what makes this robust against
  // StrictMode's double mount and any later remount of the shell: once the
  // wizard has been closed or decided against, this page load is done with it.
  useEffect(() => {
    if (isClosedForLaunch()) return;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      const show = await decideFirstRun(apiBase, controller.signal);
      if (cancelled) return;
      if (!show) { closeForLaunch(); return; }
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [apiBase]);

  // Move focus into the dialog on open and on every step change, so a screen
  // reader announces the new step's heading rather than staying on a button
  // that just disappeared.
  useEffect(() => {
    if (!open) return;
    cardRef.current?.focus();
  }, [open, step]);

  // Belt to the Tab handler's braces: anything that lands focus outside the
  // dialog while it is open (a click on the page behind, a browser-supplied
  // focus move) is pulled straight back in.
  useEffect(() => {
    if (!open) return;
    const onFocusIn = (event: FocusEvent) => {
      const card = cardRef.current;
      if (!card) return;
      const target = event.target as Node | null;
      if (target && !card.contains(target)) card.focus();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [open]);

  // Focus goes back where it came from — after the close has committed, so the
  // trap above has already been torn down and cannot snatch it back to a card
  // that is on its way out.
  useEffect(() => {
    if (open || !restorePendingRef.current) return;
    restorePendingRef.current = false;
    const target = returnFocusRef.current;
    if (target && document.contains(target) && typeof target.focus === "function") target.focus();
  }, [open]);

  const close = useCallback((reason: ExitReason) => {
    closeForLaunch();
    // "Don't show this again" governs EVERY exit that is not finishing the wizard,
    // not just the ones labelled skip. Gating it on reason === "skip" meant the
    // step-2 "Open Providers" link — the primary call to action — always wrote
    // completed, so a user who unticked the box and then followed the wizard's own
    // main path never saw it again. A checkbox that is honoured on the way out but
    // ignored on the way forward is worse than not offering one.
    //
    // Finishing is different and always completes: someone who reached the end has
    // been onboarded, whatever the box says.
    if (reason === "finish" || dontShow) completeOnboarding();
    else deferOnboarding();
    restorePendingRef.current = true;
    setOpen(false);

    if (reason === "finish") {
      notify({ tone: "success", title: t("onboard.doneTitle"), body: t("onboard.doneSub") });
    } else if (reason === "provider") {
      notify({ tone: "info", title: t("onboard.providerTitle"), body: t("onboard.providerSub") });
    } else {
      notify({ tone: "info", title: t("onboard.skip"), body: t("onboard.sub") });
    }
  }, [dontShow, notify, t]);

  const pickLocale = useCallback((next: Locale, name: string) => {
    // An unchanged value is not a mutation, so it records nothing.
    if (next === locale) return;
    setLocale(next);
    recordRevision({
      scope: "settings",
      label: t("nav.language"),
      summary: t("lang.revisionSummary", { name }),
    });
  }, [locale, setLocale, t]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close("skip");
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusablesIn(cardRef.current);
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === cardRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  const heading = step === 0 ? t("onboard.langTitle")
    : step === 1 ? t("onboard.providerTitle")
    : step === 2 ? t("onboard.networkTitle")
    : t("onboard.doneTitle");
  const body = step === 0 ? t("onboard.langSub")
    : step === 1 ? t("onboard.providerSub")
    : step === 2 ? t("onboard.networkSub")
    : t("onboard.doneSub");

  return (
    <div className="modal-overlay">
      <div
        ref={cardRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={SUB_ID}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <h3 id={TITLE_ID}>{t("onboard.title")}</h3>
          <button
            type="button"
            className="m3-icon-btn"
            aria-label={t("onboard.skip")}
            title={t("onboard.skip")}
            onClick={() => close("skip")}
          >
            <IconX aria-hidden="true" width={18} height={18} />
          </button>
        </div>
        <p id={SUB_ID} className="modal-desc">{t("onboard.sub")}</p>

        <section aria-labelledby="ocx-onboard-step-title">
          <h4
            id="ocx-onboard-step-title"
            style={{ margin: "0 0 4px", fontSize: "var(--t-title-m)", display: "flex", alignItems: "center", gap: 8 }}
          >
            {step === 0 && <IconTranslate aria-hidden="true" width={20} height={20} />}
            {step === 1 && <IconServer aria-hidden="true" width={20} height={20} />}
            {step === 2 && <IconDevices aria-hidden="true" width={20} height={20} />}
            {step === 3 && <IconCheck aria-hidden="true" width={20} height={20} />}
            {heading}
          </h4>
          <p style={{ margin: "0 0 var(--sp-3)", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
            {body}
          </p>

          {step === 0 && (
            <div className="m3-field">
              <div className="m3-field-label" id={LANG_LABEL_ID}>{t("lang.mode")}</div>
              <div className="m3-row" role="group" aria-labelledby={LANG_LABEL_ID} style={{ gap: 8, flexWrap: "wrap" }}>
                {LOCALES.map(l => (
                  <Chip
                    key={l.code}
                    lang={l.htmlLang}
                    selected={locale === l.code}
                    onClick={() => pickLocale(l.code, l.name)}
                  >
                    {l.name}
                  </Chip>
                ))}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="m3-row" style={{ gap: 8, flexWrap: "wrap" }}>
              {/* A hash link, not a router call: the wizard sits outside the tab
                  strip, and `#providers` is the same deep link the nav writes. */}
              <a
                className="m3-btn m3-btn--filled"
                href="#providers"
                onClick={() => close("provider")}
              >
                <IconServer aria-hidden="true" width={18} height={18} />
                {t("settings.jumpTo", { page: t("nav.providers") })}
              </a>
              {/* Never a dead end: "later" moves on to the network step rather
                  than closing, so skipping a provider still reaches the rest. */}
              <Button variant="text" onClick={() => setStep(2)}>{t("onboard.providerSkip")}</Button>
            </div>
          )}

          {step === 2 && (
            <div className="m3-stack" style={{ gap: "var(--sp-3)" }}>
              {/* Discovery is a button, never automatic. A first-run wizard that
                  silently sweeps the subnet is indistinguishable from the thing
                  security tooling exists to catch. */}
              <div className="m3-row" style={{ gap: 8, flexWrap: "wrap" }}>
                <Button
                  variant="outlined"
                  disabled={scanning}
                  onClick={async () => {
                    setScanning(true);
                    try {
                      const res = await fetch(`${apiBase}/api/host/discover`, { method: "POST" });
                      const data = await res.json().catch(() => null) as { found?: typeof found } | null;
                      setFound(data?.found ?? []);
                    } catch {
                      setFound([]);
                    } finally {
                      setScanning(false);
                    }
                  }}
                >
                  <IconDevices aria-hidden="true" width={18} height={18} />
                  {scanning ? t("onboard.netScanning") : t("onboard.netScan")}
                </Button>
              </div>

              {found !== null && (
                found.length === 0 ? (
                  <p className="m3-dialog__desc">{t("onboard.netNone")}</p>
                ) : (
                  <ul className="m3-stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: 6 }}>
                    {found.map(hit => (
                      <li key={hit.url} className="m3-row m3-row--split">
                        <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t-body-s)" }}>
                          {hit.url}
                          {hit.self && ` · ${t("onboard.netThisMachine")}`}
                        </span>
                        {!hit.self && (
                          <a className="m3-btn m3-btn--text" href={hit.url} target="_blank" rel="noreferrer noopener">
                            {t("onboard.netConnect")}
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                )
              )}

              <div className="m3-row m3-row--split">
                <div>
                  <div style={{ fontWeight: 500 }}>{t("onboard.netExpose")}</div>
                  <div style={{ fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>
                    {t("onboard.netExposeHint")}
                  </div>
                </div>
                <Toggle on={expose} onChange={setExpose} label={t("onboard.netExpose")} />
              </div>

              {expose && (
                <div className="m3-stack" style={{ gap: 8 }}>
                  {/* Said before they type, not after the server refuses: exposing
                      the proxy publishes the dashboard too, and the password is
                      the only thing between the two. */}
                  <p className="m3-banner m3-banner--warn" role="note">{t("onboard.netExposeWarn")}</p>
                  <TextInput
                    type="password"
                    value={key}
                    onChange={e => setKey(e.target.value)}
                    placeholder={t("onboard.netKeyPlaceholder")}
                    aria-label={t("onboard.netKey")}
                    autoComplete="new-password"
                  />
                  <Button
                    variant="filled"
                    disabled={exposeBusy || key.trim().length < MIN_KEY_LENGTH}
                    onClick={async () => {
                      setExposeBusy(true);
                      try {
                        const res = await fetch(`${apiBase}/api/host`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ exposed: true, customKeyValue: key, newKeyName: "onboarding" }),
                        });
                        const body = await res.json().catch(() => null) as { error?: string } | null;
                        if (!res.ok) {
                          notify({ tone: "error", title: t("onboard.netExposeFailed"), body: body?.error });
                          return;
                        }
                        notify({ tone: "success", title: t("onboard.netExposed"), body: t("network.restartHint") });
                        setStep(3);
                      } catch {
                        notify({ tone: "error", title: t("onboard.netExposeFailed") });
                      } finally {
                        setExposeBusy(false);
                      }
                    }}
                  >
                    {t("onboard.netExposeAction")}
                  </Button>
                  <p style={{ fontSize: "var(--t-label-s)", color: "var(--m3-on-surface-variant)", margin: 0 }}>
                    {t("onboard.netKeyRule", { n: MIN_KEY_LENGTH })}
                  </p>
                </div>
              )}
            </div>
          )}
        </section>

        <div
          className="m3-row"
          style={{ gap: 8, marginTop: "var(--sp-3)", flexWrap: "wrap", alignItems: "center" }}
        >
          <Toggle on={dontShow} label={t("onboard.dontShow")} onChange={setDontShow} />
          {/* The switch already carries this exact text as its accessible name,
              so the visible copy beside it is decoration to assistive tech. */}
          <span aria-hidden="true" style={{ fontSize: "var(--t-label-m)", color: "var(--m3-on-surface-variant)" }}>
            {t("onboard.dontShow")}
          </span>
        </div>

        <div className="modal-actions" style={{ alignItems: "center" }}>
          <span
            aria-live="polite"
            style={{ marginRight: "auto", fontSize: "var(--t-label-m)", color: "var(--m3-on-surface-variant)" }}
          >
            {t("onboard.stepOf", { n: step + 1, total: TOTAL_STEPS })}
          </span>
          <Button variant="text" onClick={() => close("skip")}>{t("onboard.skip")}</Button>
          {step > 0 && (
            <Button variant="outlined" onClick={() => setStep(s => Math.max(0, s - 1))}>{t("onboard.back")}</Button>
          )}
          {step < TOTAL_STEPS - 1 ? (
            <Button variant="filled" onClick={() => setStep(s => Math.min(TOTAL_STEPS - 1, s + 1))}>
              {t("onboard.next")}
            </Button>
          ) : (
            <Button variant="filled" onClick={() => close("finish")}>{t("onboard.finish")}</Button>
          )}
        </div>
      </div>
    </div>
  );
}
