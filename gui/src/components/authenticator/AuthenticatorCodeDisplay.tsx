/**
 * The live code for one entry: large grouped digits, a copy action, a
 * countdown to the next rollover, and a peek at the code that is coming next.
 *
 * Two accessibility rules this file exists to keep straight, both from the
 * shared contract for a built-in authenticator:
 *
 * - **The code region announces on change, not every second.** `role="status"
 *   aria-live="polite"` sits on the digits alone. React only touches that
 *   node's text when the code value actually differs between renders (see
 *   `use-authenticator-code.ts`'s rollover-timed refetch), so a screen reader
 *   announces it once per 30-second period, never once per second.
 * - **The countdown is never colour-only or motion-only.** The ring is a
 *   decorative `aria-hidden` conic-gradient; the number beside it is real text
 *   in a `role="timer" aria-live="off"` region — `aria-live="off"` on a timer
 *   is the WAI-ARIA-recommended pairing for something that changes every
 *   second, so assistive tech does not narrate a stream of numbers, while the
 *   value stays available on request.
 */

import { IconCopy } from "../../icons";
import { Button } from "../../shell/m3-ui";
import type { TFn } from "../../i18n/shared";

/** "123456" -> "123 456"; "1234567" -> "123 456 7"; always chunks of 3 from the left. */
function groupDigits(code: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < code.length; i += 3) chunks.push(code.slice(i, i + 3));
  return chunks.join(" ");
}

export interface AuthenticatorCodeDisplayProps {
  code: string | null;
  nextCode: string | null;
  period: number;
  secondsRemaining: number;
  loading: boolean;
  failed: boolean;
  copyOutcome: "copied" | "unavailable" | null;
  onCopyCode: () => void;
  t: TFn;
}

export default function AuthenticatorCodeDisplay({
  code, nextCode, period, secondsRemaining, loading, failed, copyOutcome, onCopyCode, t,
}: AuthenticatorCodeDisplayProps) {
  const percentElapsed = period > 0 ? Math.min(100, Math.max(0, ((period - secondsRemaining) / period) * 100)) : 0;

  if (failed) {
    return <p className="m3-authenticator-code m3-authenticator-code--failed" role="status">{t("auth.entry.codeLoadFailed")}</p>;
  }

  return (
    <div className="m3-authenticator-code-row">
      <div
        className="m3-authenticator-code"
        role="status"
        aria-live="polite"
        aria-busy={loading}
      >
        {code ? groupDigits(code) : "—"}
      </div>

      <Button
        variant="text"
        className="m3-authenticator-code-copy"
        onClick={onCopyCode}
        disabled={!code}
        aria-label={t("auth.entry.copyCode")}
      >
        <IconCopy width={18} height={18} aria-hidden="true" />
        <span className="m3-visually-hidden">
          {copyOutcome === "copied" ? t("auth.entry.codeCopied") : t("auth.entry.copyCode")}
        </span>
      </Button>

      <div className="m3-authenticator-countdown">
        <span
          className="m3-authenticator-countdown-ring"
          aria-hidden="true"
          style={{ ["--m3-auth-pct" as string]: `${percentElapsed}%` }}
        />
        <span className="m3-authenticator-countdown-text" role="timer" aria-live="off">
          {t("auth.add.periodSeconds", { seconds: secondsRemaining })}
        </span>
      </div>

      {nextCode && (
        <span className="m3-authenticator-next-code" title={t("auth.entry.nextCode", { code: nextCode })}>
          {t("auth.entry.nextCode", { code: nextCode })}
        </span>
      )}
    </div>
  );
}
