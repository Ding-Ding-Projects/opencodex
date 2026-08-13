import type { TFn } from "../i18n/shared";
import type { ProviderDiscoverySummary } from "../models-groups";
import { modelVisible, type ProviderModelMap } from "../model-visibility";
import { DEFAULT_SEARCH_FLAGS, stripStatefulFlags } from "../shell/settings-search";

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function discoveryFailureLabel(
  t: TFn,
  discovery: Extract<ProviderDiscoverySummary, { status: "failed" }>,
): string {
  switch (discovery.reason) {
    case "http":
      return t("models.discoveryFailedHttp", { status: discovery.httpStatus });
    case "blocked":
      return t("models.discoveryFailedBlocked");
    case "invalid_response":
      return t("models.discoveryFailedInvalidResponse");
    case "network":
      return t("models.discoveryFailedNetwork");
    case "provider":
      return t("models.discoveryFailedProvider");
    default:
      return t("models.discoveryFailedGeneric");
  }
}

export interface ModelRow {
  provider: string;
  id: string;
  namespaced: string;
  disabled: boolean;
  native?: boolean;
  custom?: boolean;
  customId?: string;
  displayName?: string;
  inputModalities?: string[];
  contextWindow?: number;
  contextCap?: number;
  contextCapped?: boolean;
  reasoningEfforts?: string[];
}

/**
 * Reasoning ladder as the design shows it: `low→xhigh`, or the single rung when
 * a model only has one. The rungs are API identifiers, so they are not translated.
 */
export function effortRange(efforts: string[] | undefined): string {
  if (!efforts || efforts.length === 0) return "";
  const first = efforts[0];
  const last = efforts[efforts.length - 1];
  return first === last ? first : `${first}→${last}`;
}

export interface Matcher {
  test: (text: string) => boolean;
  /** Regex compile failure, verbatim from the engine. `null` while the pattern is usable. */
  error: string | null;
}

/**
 * Plain text by default, `.*` only when the caller opted in — the rule every search
 * bar on this screen follows. The pattern is capped at 400 characters and evaluated
 * locally (ECMAScript `RegExp`), so a pasted novel can never become a
 * catastrophic-backtracking payload. An invalid pattern matches nothing rather than
 * silently falling back to plain text, so the reported error and the result agree.
 *
 * `flags` is what the anchored regex builder beside the field actually composed.
 * It used to be a pinned `"i"`, which meant the chips inside the popover changed
 * its preview and then changed nothing about the list behind it: a pattern
 * deliberately built as case-sensitive arrived here case-insensitive. It defaults
 * to `DEFAULT_SEARCH_FLAGS` — the same `"i"` — precisely because this function
 * feeds six surfaces, so a caller that has not yet been given a flags control
 * keeps the behaviour it has today rather than silently changing what it finds.
 *
 * `g` and `y` are stripped before compiling. Both keep `lastIndex` between calls,
 * so one matcher reused down a list of models returns true, false, true, false —
 * half the matching rows vanish, and which half depends only on the order they
 * were tested in. The builder offers both because they are meaningful when
 * scanning a sample, so they arrive here legitimately and are dropped rather than
 * refused: the pattern still works, it just stops being order-dependent.
 *
 * Plain text is untouched by any of this. It is a substring search over visible
 * text and stays case-insensitive whatever the flags say, because the flags
 * describe a regex that mode never compiles.
 */
export function makeMatcher(query: string, useRegex: boolean, flags = DEFAULT_SEARCH_FLAGS): Matcher {
  const trimmed = query.trim();
  if (!trimmed) return { test: () => true, error: null };
  if (useRegex) {
    try {
      const re = new RegExp(trimmed.slice(0, 400), stripStatefulFlags(flags));
      return { test: (text: string) => re.test(text), error: null };
    } catch (e) {
      return { test: () => false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const needle = trimmed.toLowerCase();
  return { test: (text: string) => text.toLowerCase().includes(needle), error: null };
}

/**
 * The settings this screen owns, in render order. The settings search bar filters
 * against these ids, so a user who knows a setting's name can type it here instead
 * of scanning the controls block.
 */
export const MODELS_SETTING_IDS = ["shadowCall", "subAgent", "threads", "contextCap"] as const;
export type ModelsSettingId = (typeof MODELS_SETTING_IDS)[number];

export interface ProviderContextCapsResponse {
  cap?: number;
  value?: number;
  caps?: Record<string, number>;
}

export interface V2Status {
  enabled: boolean;
  agentsMaxThreadsConflict: boolean;
  maxConcurrentThreadsPerSession?: number | null;
  multiAgentMode?: "v1" | "default" | "v2";
}

export interface ShadowCallData {
  enabled: boolean;
  model: string;
}

export const CAP_OPTIONS = Array.from({ length: 18 }, (_, i) => 100_000 + i * 50_000); // 100k … 950k
export const CAP_OPTION_SET = new Set(CAP_OPTIONS);
export const CUSTOM_OPTION = "custom";
export const THREAD_OPTIONS = [4, 8, 16, 32, 64, 128, 256, 500, 1000];
export const THREAD_OPTION_SET = new Set(THREAD_OPTIONS);
export const PAGE = 60; // rows rendered per provider before a "show more"

export const COLLAPSED_KEY_V1 = "ocx-models-collapsed:v1";
export const COLLAPSED_KEY_LEGACY = "ocx-models-collapsed";
export const COMBOS_OPEN_KEY_V1 = "ocx-models-combos-open:v1";
export const COMBOS_OPEN_KEY_LEGACY = "ocx-models-combos-open";

/** Compact token display (350k) — unit is technical, not prose. */
export function fmtK(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return String(n);
  return n % 1000 === 0 ? `${n / 1000}k` : n.toLocaleString();
}

export function collectDisabledNamespaced(rows: ModelRow[]): Set<string> {
  const next = new Set<string>();
  for (const m of rows) {
    if (m.disabled) next.add(m.namespaced);
  }
  return next;
}

export function activeModelOptions(
  models: ModelRow[],
  disabled: Set<string>,
  selected: ProviderModelMap,
): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (const m of models) {
    const blocked = disabled.has(m.id) || disabled.has(m.namespaced);
    if (modelVisible(selected, m.provider, m.id, m.native === true, blocked)) {
      options.push({ value: m.namespaced, label: m.namespaced });
    }
  }
  return options;
}

export function readCollapsedProviders(storage: StorageLike = localStorage): Set<string> {
  try {
    const saved = storage.getItem(COLLAPSED_KEY_V1) ?? storage.getItem(COLLAPSED_KEY_LEGACY);
    return saved ? new Set(JSON.parse(saved) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

export function writeCollapsedProviders(collapsed: Set<string>, storage: StorageLike = localStorage): void {
  try {
    storage.setItem(COLLAPSED_KEY_V1, JSON.stringify([...collapsed]));
  } catch {
    /* quota / private-mode */
  }
}

export function readCombosOpen(storage: StorageLike = localStorage): boolean {
  try {
    const saved = storage.getItem(COMBOS_OPEN_KEY_V1) ?? storage.getItem(COMBOS_OPEN_KEY_LEGACY);
    return saved === "1";
  } catch {
    return false;
  }
}

export function writeCombosOpen(open: boolean, storage: StorageLike = localStorage): void {
  try {
    storage.setItem(COMBOS_OPEN_KEY_V1, open ? "1" : "0");
  } catch {
    /* quota / private-mode */
  }
}
