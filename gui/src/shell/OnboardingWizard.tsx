/**
 * First-run onboarding wizard.
 *
 * Four steps — language, connect a provider, remote access, done — shown once on
 * a brand new install and never again. It is mounted unconditionally in
 * `App.tsx` beside the snackbar host and decides for itself whether to appear;
 * `onboarding-state.ts` owns that decision and biases every ambiguous signal
 * towards staying hidden.
 *
 * This is one of the few legitimately blocking surfaces in the dashboard, so it
 * is a real modal — and it gets there through the shared `Dialog`, not through
 * chrome of its own. It used to paint `.modal-overlay` / `.modal-card`, whose
 * surface colour was `color-mix(in oklab, canvas 92%, transparent)`: `canvas` is
 * a *UA system colour*, so the one screen a new user meets first was the one
 * screen that ignored their seed colour entirely, behind 40px of backdrop blur
 * nothing else in the app uses.
 *
 * What went with those classes is a hand-rolled focus trap — a Tab/Shift+Tab
 * key handler, a `focusin` listener dragging focus back, and a pair of refs
 * restoring it on close. `Dialog` opens with `showModal()`, and the native
 * modal gives all three: focus confined to the dialog, the page behind inert,
 * and focus restored to the opener. Reimplementing that on top of it is how a
 * trap ends up fighting the browser's own.
 *
 * What this still owns is the *step* announcement: focus moves to the step
 * heading whenever the step changes, so a screen reader reads the new step
 * rather than staying on a button that has just been replaced.
 *
 * It never gates the app. The wizard only opens after the provider probe has
 * answered; a proxy that is down, a refused request or an unexpected payload all
 * mean it stays shut rather than trapping the user behind a half-loaded wizard.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { IconCheck, IconDevices, IconServer, IconTranslate, IconX } from "../icons";
import { LOCALES, useI18n, useT, type Locale } from "../i18n/shared";
import { Button, Chip, Dialog, TextInput, Toggle } from "./m3-ui";
import { useNotifications } from "./notifications-context";
import {
  closeForLaunch,
  completeOnboarding,
  decideFirstRun,
  deferOnboarding,
  isClosedForLaunch,
} from "./onboarding-state";
import { useAppDisplayName } from "../theme/use-app-name";

const TOTAL_STEPS = 4;

/** Shortest key `/api/host` will store. Stated up front rather than after a rejection. */
const MIN_KEY_LENGTH = 12;

const LANG_LABEL_ID = "ocx-onboard-lang-label";
const STEP_TITLE_ID = "ocx-onboard-step-title";

type ExitReason = "finish" | "skip" | "provider";

export default function OnboardingWizard({ apiBase }: { apiBase: string }) {
  const t = useT();
  // The wizard is the app literally introducing itself, so it introduces
  // itself by the name the user has chosen. On a genuine first run that is the
  // shipped name, since nothing has been renamed yet — but this surface also
  // reopens from Help, and greeting a renamed app by its old name would be the
  // one screen that had not been told.
  const appName = useAppDisplayName();
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

  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null);

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
      setOpen(true);
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [apiBase]);

  // Focus lands on the step heading on open and on every step change, so a
  // screen reader announces the step the user has just arrived at rather than
  // staying on a button that has been replaced underneath it.
  //
  // Effects run children-first, so `Dialog` has already recorded the opener and
  // called `showModal()` by the time this runs — this only moves focus *within*
  // the dialog, never out of it, and never overwrites what the restore target is.
  useEffect(() => {
    if (!open) return;
    stepHeadingRef.current?.focus();
  }, [open, step]);

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
    // Unmounting the Dialog is what hands focus back to the opener; there is no
    // restore of our own left to arm.
    setOpen(false);

    if (reason === "finish") {
      notify({ tone: "success", title: t("onboard.doneTitle"), body: t("onboard.doneSub") });
    } else if (reason === "provider") {
      notify({ tone: "info", title: t("onboard.providerTitle"), body: t("onboard.providerSub") });
    } else {
      notify({ tone: "info", title: t("onboard.skip"), body: t("onboard.sub") });
    }
  }, [dontShow, notify, t]);

  const pickLocale = useCallback((next: Locale) => {
    if (next !== locale) setLocale(next);
  }, [locale, setLocale]);

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
    <Dialog
      title={t("onboard.title", { name: appName })}
      description={t("onboard.sub")}
      // Escape is the only key handled, and the native `<dialog>` raises it as
      // `cancel` — so it arrives here without a key listener of our own.
      onClose={() => close("skip")}
      // A first-run wizard is shown exactly once. A stray click on the scrim
      // would dismiss it for good, and step 3 holds an unsaved network key while
      // it is open, so dismissal stays deliberate: the X, Skip, or Escape.
      dismissOnScrim={false}
      headAction={
        <button
          type="button"
          className="m3-icon-btn"
          aria-label={t("onboard.skip")}
          title={t("onboard.skip")}
          onClick={() => close("skip")}
        >
          <IconX aria-hidden="true" width={18} height={18} />
        </button>
      }
      actions={
        <>
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
        </>
      }
    >
      <section aria-labelledby={STEP_TITLE_ID}>
        {/* tabIndex -1 so the step-change effect can move focus here. It is a
            programmatic target only — never in the Tab order. */}
        <h4
          id={STEP_TITLE_ID}
          ref={stepHeadingRef}
          tabIndex={-1}
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
                  onClick={() => pickLocale(l.code)}
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
                {/* Said before they act, not after the server refuses: exposing
                    the proxy publishes the dashboard too, and the credential is
                    the only thing between the two. */}
                <p className="m3-banner m3-banner--warn" role="note">{t("onboard.netExposeWarn")}</p>

                {/* One click, and the key is generated here rather than invented
                    by the user. This step used to demand a 12-character password
                    typed on a laptop and then retyped on a phone, at the exact
                    moment a first-run user has the least patience for either —
                    so most people turned the whole feature down. The credential
                    requirement is unchanged; who authors it is what changed. A
                    phone gets it by scanning the QR on Remote access, never by
                    transcription. */}
                <p style={{ fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)", margin: 0 }}>
                  {t("onboard.netAutoKeyHint")}
                </p>
                <Button
                  variant="filled"
                  disabled={exposeBusy}
                  onClick={async () => {
                    setExposeBusy(true);
                    try {
                      const res = await fetch(`${apiBase}/api/host`, {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ exposed: true, mintKeyIfMissing: true, newKeyName: "onboarding" }),
                      });
                      const body = await res.json().catch(() => null) as { error?: string } | null;
                      if (!res.ok) {
                        notify({ tone: "error", title: t("onboard.netExposeFailed"), body: body?.error });
                        return;
                      }
                      // "Published" is not yet true of the socket, only of the
                      // config. Saying so here rather than letting the user find
                      // out from a phone that will not connect.
                      notify({ tone: "success", title: t("onboard.netExposed"), body: t("onboard.netExposedPending") });
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

                {/* Still available, and still the only way to get a key you can
                    remember — but no longer the price of admission. */}
                <details>
                  <summary style={{ fontSize: "var(--t-label-m)", cursor: "pointer" }}>{t("onboard.netOwnKey")}</summary>
                  <div className="m3-stack" style={{ gap: 8, marginTop: 8 }}>
                    <TextInput
                      type="password"
                      value={key}
                      onChange={e => setKey(e.target.value)}
                      placeholder={t("onboard.netKeyPlaceholder")}
                      aria-label={t("onboard.netKey")}
                      autoComplete="new-password"
                    />
                    <Button
                      variant="outlined"
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
                          notify({ tone: "success", title: t("onboard.netExposed"), body: t("onboard.netExposedPending") });
                          setStep(3);
                        } catch {
                          notify({ tone: "error", title: t("onboard.netExposeFailed") });
                        } finally {
                          setExposeBusy(false);
                        }
                      }}
                    >
                      {t("onboard.netOwnKeyAction")}
                    </Button>
                    <p style={{ fontSize: "var(--t-label-s)", color: "var(--m3-on-surface-variant)", margin: 0 }}>
                      {t("onboard.netKeyRule", { n: MIN_KEY_LENGTH })}
                    </p>
                  </div>
                </details>
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
    </Dialog>
  );
}
