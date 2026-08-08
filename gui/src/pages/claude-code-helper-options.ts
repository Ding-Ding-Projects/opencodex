import type { ReactNode } from "react";
import { modelLabel } from "../model-display";

/** Background-helper picker options, preserving icon-bearing model labels. */
export function backgroundHelperOptions(
  available: readonly string[] | undefined,
  unsetLabel: string,
): { value: string; label: ReactNode }[] {
  const options = (available ?? []).map(m => ({ value: m, label: modelLabel(m) }));
  return [{ value: "", label: unsetLabel }, ...options];
}
