/**
 * The gate every locked surface shows instead of teleporting past the lock —
 * and the "already unlocked" strip with its explicit "Lock again" action.
 *
 * One component covers both states because they are the same conversation
 * with the user at two different points: "here is what is locked and how to
 * get past it" and "here is what is currently unlocked and how to put it back".
 * A caller renders this in place of the content it gates; `onUnlocked` is how
 * it tells that caller the gate just opened.
 *
 * Anchored and non-modal, like every other per-element surface in this app —
 * `TabAppearanceEditor`, the appearance editor, `SuperConfirmGate`. This one is
 * usually embedded *inside* one of those rather than opened on its own, so it
 * does not manage its own placement; it renders inline and lets its host place
 * the surrounding panel.
 */

import { useEffect, useId, useState } from "react";
import { Banner, Button, Field, TextInput } from "./m3-ui";
import { IconLock } from "../icons";
import { useT } from "../i18n/shared";
import {
  attemptUnlock, isUnlocked, rateLimitState, relock, subscribeLocks, type LockRecord,
} from "./locks";
import { recoveryLine } from "./lock-recovery-copy";

export interface UnlockPromptProps {
  lock: LockRecord;
  /** Called once an unlock actually succeeds. */
  onUnlocked?: () => void;
  /** Called once "Lock again" is pressed. */
  onRelocked?: () => void;
  /** Navigates to Support Tickets — the caller decides what that means (a route, a scroll, a tab switch). */
  onForgotten?: () => void;
  compact?: boolean;
}

function durationLabel(t: ReturnType<typeof useT>, lock: LockRecord): string {
  if (lock.duration === "here") return t("lock.duration.here");
  if (lock.duration === "close") return t("lock.duration.close");
  return t("lock.duration.minutes", { n: String(lock.duration) });
}

export function UnlockPrompt({ lock, onUnlocked, onRelocked, onForgotten, compact }: UnlockPromptProps) {
  const t = useT();
  const fieldId = useId();
  const [unlocked, setUnlocked] = useState(() => isUnlocked(lock.id));
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "checking" | "wrong" | "limited">("idle");
  const [waitMs, setWaitMs] = useState(0);
  const [recovery, setRecovery] = useState<string | null>(null);

  useEffect(() => {
    const listener = () => setUnlocked(isUnlocked(lock.id));
    listener();
    return subscribeLocks(listener);
  }, [lock.id]);

  useEffect(() => { void recoveryLine(t).then(setRecovery); }, [t]);

  // A rate-limited wait is a real countdown, not a one-shot message — a person
  // staring at "wait 12 seconds" wants to see it become "wait 4 seconds", not
  // a stale number that quietly stopped being true.
  useEffect(() => {
    if (status !== "limited") return;
    const tick = () => {
      const state = rateLimitState(lock.id);
      if (!state.limited) { setStatus("idle"); setWaitMs(0); return; }
      setWaitMs(state.waitMs);
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [status, lock.id]);

  const submit = async () => {
    setStatus("checking");
    const outcome = await attemptUnlock(
      lock.id,
      lock.method === "password" ? { password } : { code },
      lock.duration,
    );
    if (outcome === "ok") {
      setPassword("");
      setCode("");
      setStatus("idle");
      setUnlocked(true);
      onUnlocked?.();
      return;
    }
    if (outcome === "rate-limited") {
      const state = rateLimitState(lock.id);
      setWaitMs(state.waitMs);
      setStatus("limited");
      return;
    }
    setStatus("wrong");
  };

  if (unlocked) {
    return (
      <div className="m3-row" role="status" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <IconLock width={16} height={16} aria-hidden="true" style={{ opacity: 0.6 }} />
        <span style={{ fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>
          {t("lock.unlockedUntil", { duration: durationLabel(t, lock) })}
        </span>
        <Button
          variant="text"
          onClick={() => { relock(lock.id); setUnlocked(false); onRelocked?.(); }}
        >
          {t("lock.lockAgain")}
        </Button>
      </div>
    );
  }

  return (
    <div data-unlock-prompt={lock.id} style={{ display: "grid", gap: 8 }}>
      <div className="m3-row" style={{ gap: 8, alignItems: "center" }}>
        <IconLock width={18} height={18} aria-hidden="true" />
        <strong style={{ fontSize: "var(--t-body-m)" }}>{t("lock.lockedLabel", { name: lock.label })}</strong>
      </div>
      <Banner tone="info">{t("lock.disclosureToy")}</Banner>

      {lock.method === "password" ? (
        <Field label={t("lock.wizard.password")} id={fieldId}>
          <TextInput
            id={fieldId}
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={e => { setPassword(e.target.value); setStatus("idle"); }}
            onKeyDown={e => { if (e.key === "Enter") void submit(); }}
            style={{ width: "100%" }}
          />
        </Field>
      ) : (
        <Field label={t("lock.wizard.totpConfirmCode")} id={fieldId}>
          <TextInput
            id={fieldId}
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={code}
            onChange={e => { setCode(e.target.value.replace(/\D/g, "")); setStatus("idle"); }}
            onKeyDown={e => { if (e.key === "Enter") void submit(); }}
            style={{ width: 140, fontFamily: "var(--mono)" }}
          />
        </Field>
      )}

      {status === "wrong" && (
        <p role="alert" style={{ margin: 0, color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>
          {t(lock.method === "password" ? "lock.wrongPassword" : "lock.wrongCode")}
        </p>
      )}
      {status === "limited" && (
        <p role="alert" style={{ margin: 0, color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>
          {t("lock.rateLimited", { seconds: String(Math.max(1, Math.ceil(waitMs / 1000))) })}
        </p>
      )}

      <div className="m3-row" style={{ gap: 8, justifyContent: compact ? "flex-start" : "space-between", flexWrap: "wrap" }}>
        <Button
          variant="filled"
          disabled={status === "checking" || status === "limited" || (lock.method === "password" ? password.length === 0 : code.length !== 6)}
          onClick={() => void submit()}
        >
          {status === "checking" ? t("lock.unlocking") : t("lock.unlock")}
        </Button>
        <button
          type="button"
          className="m3-btn m3-btn--text"
          onClick={onForgotten}
        >
          {t("lock.forgotten")}
        </button>
      </div>

      {recovery && (
        <p style={{ margin: 0, fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>{recovery}</p>
      )}
    </div>
  );
}
