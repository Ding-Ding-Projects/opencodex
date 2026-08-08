/**
 * Material 3 presentation constants for the Codex Auth account surfaces.
 *
 * Kept in a component-free module so the account cards, the main card and the
 * settings cards share one visual vocabulary without tripping the
 * `react-refresh/only-export-components` rule, and so no literal colour ever
 * appears in the JSX: every value below resolves to an `--m3-*` role token.
 */

import type { CSSProperties } from "react";

/** Pool / main account card. The active card takes the tonal secondary container. */
export function accountCardStyle(active: boolean): CSSProperties {
  return {
    marginBottom: 0,
    ...(active
      ? {
        background: "var(--m3-secondary-container)",
        color: "var(--m3-on-secondary-container)",
      }
      : {
        border: "1px solid var(--m3-outline-variant)",
      }),
  };
}

export type AccountChipTone = "neutral" | "primary" | "ok" | "warn" | "error";

const CHIP_TONES: Record<AccountChipTone, CSSProperties> = {
  neutral: {
    background: "var(--m3-surface-container-highest)",
    color: "var(--m3-on-surface-variant)",
    borderColor: "transparent",
  },
  primary: {
    background: "var(--m3-primary-container)",
    color: "var(--m3-on-primary-container)",
    borderColor: "transparent",
  },
  ok: {
    background: "var(--m3-ok-container)",
    color: "var(--m3-on-ok-container)",
    borderColor: "transparent",
  },
  warn: {
    background: "var(--m3-warn-container)",
    color: "var(--m3-on-warn-container)",
    borderColor: "transparent",
  },
  error: {
    background: "var(--m3-error-container)",
    color: "var(--m3-on-error-container)",
    borderColor: "transparent",
  },
};

/** Static (non-interactive) chip: same pill as `.m3-chip`, without the pointer. */
export function chipStyle(tone: AccountChipTone = "neutral"): CSSProperties {
  return { ...CHIP_TONES[tone], minHeight: 28, padding: "0 10px", fontSize: "var(--t-label-m)", cursor: "default" };
}

/** Clickable chip (the reset-credit ticket): keeps the 28px pill but stays a button. */
export function chipButtonStyle(tone: AccountChipTone = "neutral"): CSSProperties {
  return { ...chipStyle(tone), cursor: "pointer" };
}

/** Round leading avatar for an account row. Decorative — always `aria-hidden`. */
export const ACCOUNT_AVATAR: CSSProperties = {
  display: "grid",
  placeItems: "center",
  flex: "0 0 auto",
  width: 40,
  height: 40,
  borderRadius: "var(--r-pill)",
  background: "var(--m3-primary-container)",
  color: "var(--m3-on-primary-container)",
};

export const ACCOUNT_TITLE: CSSProperties = {
  fontSize: "var(--t-title-s)",
  fontWeight: 600,
  overflowWrap: "anywhere",
};

export const ACCOUNT_META: CSSProperties = {
  color: "var(--m3-on-surface-variant)",
  fontSize: "var(--t-label-m)",
  overflowWrap: "anywhere",
};

export const ACCOUNT_META_MONO: CSSProperties = {
  ...ACCOUNT_META,
  fontFamily: "var(--mono)",
};

/** Auto-fitting grid the pool cards live in (matches the prototype's 320px floor). */
export const POOL_GRID: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
  marginBottom: "var(--sp-4)",
};

/** Section heading above the main / pool / settings blocks. */
export const SECTION_TITLE: CSSProperties = {
  margin: "var(--sp-4) 0 var(--sp-2)",
  fontSize: "var(--t-title-m)",
  fontWeight: 600,
};
