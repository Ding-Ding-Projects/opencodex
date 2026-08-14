/**
 * Persistence, bounds and migration for scheduled-settings rules.
 *
 * Stored under its own `localStorage` key — never folded into `PREFS_KEY` —
 * because a rule is metadata *about* settings, not a setting itself, and the
 * two have different lifecycles: resetting appearance to defaults must not
 * delete a person's schedule, and deleting a schedule must not touch their
 * theme. Every read is bounded and validated exactly like `readPrefs` in
 * `theme/prefs-context.ts`: a corrupt or hand-edited value never reaches a
 * `<select>`, a stylesheet, or a network request built from it.
 */

import { ALL_WEEKDAYS, SCHEDULE_SCHEMA_VERSION, emptyScheduleState } from "./types";
import type {
  ApiScheduleSource, HomeAssistantScheduleSource, LocalScheduleSource,
  ScheduleDays, ScheduleRule, ScheduleSource, ScheduleState, ScheduleValues, Weekday,
} from "./types";

export const SCHEDULE_KEY = "ocx-m3:schedule";

/** Generous enough for real use, small enough that a corrupt profile cannot balloon. */
export const MAX_RULES = 50;
export const LABEL_MAX = 80;
export const URL_MAX = 2000;
export const ENTITY_ID_MAX = 200;
export const TOKEN_REF_MAX = 80;
export const FONT_ID_MAX = 200;
export const FONT_STACK_MAX = 400;
export const SEED_MAX = 32;
/** A rule that refreshes more than once a minute is not "scheduled", it is polling. */
export const REFRESH_MINUTES_MIN = 1;
export const REFRESH_MINUTES_MAX = 24 * 60;
export const REFRESH_MINUTES_DEFAULT = 15;
export const PRIORITY_MIN = -1000;
export const PRIORITY_MAX = 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Same shape TOKEN_REF and the vault key it addresses must agree on. */
const TOKEN_REF_RE = /^[A-Za-z0-9_-]{1,80}$/;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  // `new Date("2026-02-30")` rolls forward to March 2nd rather than refusing —
  // round-tripping through the ISO components is what actually rejects it.
  const [y, m, d] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

function isValidTime(value: unknown): value is string {
  return typeof value === "string" && TIME_RE.test(value);
}

function readDays(raw: unknown): ScheduleDays {
  if (raw === "everyday") return "everyday";
  if (!Array.isArray(raw)) return "everyday";
  const days = raw
    .map(v => Math.trunc(Number(v)))
    .filter((v): v is Weekday => ALL_WEEKDAYS.includes(v as Weekday));
  // De-duplicate and sort so two rules built from the same picker selection
  // always compare equal, and so a corrupt profile with `[1,1,1]` reads as one
  // day rather than as junk that merely happens to validate.
  return [...new Set(days)].sort((a, b) => a - b);
}

function readThemeMode(raw: unknown): ScheduleValues["theme"] | undefined {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : undefined;
}

function readDensity(raw: unknown): ScheduleValues["density"] | undefined {
  const n = Math.round(Number(raw));
  return n >= 1 && n <= 5 ? (n as ScheduleValues["density"]) : undefined;
}

function readFunny(raw: unknown): ScheduleValues["funnyEn"] | undefined {
  const n = Math.round(Number(raw));
  return n >= 1 && n <= 5 ? (n as ScheduleValues["funnyEn"]) : undefined;
}

/** Matches `LOCALES` in `i18n/shared.ts`, kept as a literal list to avoid a runtime import cycle. */
const LOCALE_CODES = new Set(["en", "yue", "bi", "de", "ko", "zh", "ru", "ja"]);
function readLocale(raw: unknown): ScheduleValues["locale"] | undefined {
  return typeof raw === "string" && LOCALE_CODES.has(raw) ? (raw as ScheduleValues["locale"]) : undefined;
}

/**
 * The same bounded validation a stored rule's local values go through,
 * exposed for the runtime to re-check whatever an `api`/`homeAssistant`
 * source hands back. The management-plane route already allowlists and
 * bounds its response server-side (`schedule-routes.ts`); this is
 * defense-in-depth so the renderer never trusts a network response — even one
 * from this app's own privileged process — into `applyTokens` unchecked.
 */
export function sanitizeScheduleValues(raw: unknown): ScheduleValues {
  return readValues(raw);
}

function readValues(raw: unknown): ScheduleValues {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: ScheduleValues = {};
  const theme = readThemeMode(r.theme);
  if (theme) out.theme = theme;
  const seed = boundedString(r.seed, SEED_MAX);
  // A seed is a CSS colour: only accept the shapes `applyTokens` can actually
  // consume, so a corrupt profile cannot smuggle something else into a style
  // declaration by way of "seed colour".
  if (seed && /^#[0-9a-fA-F]{3,8}$/.test(seed)) out.seed = seed;
  const density = readDensity(r.density);
  if (density) out.density = density;
  const fontId = boundedString(r.fontId, FONT_ID_MAX);
  if (fontId) out.fontId = fontId;
  const fontStack = boundedString(r.fontStack, FONT_STACK_MAX);
  if (fontStack) out.fontStack = fontStack;
  if (Number.isFinite(Number(r.fontScale))) out.fontScale = Math.min(1.6, Math.max(0.8, Number(r.fontScale)));
  if (Number.isFinite(Number(r.fontWeight))) out.fontWeight = Math.min(700, Math.max(300, Number(r.fontWeight)));
  const locale = readLocale(r.locale);
  if (locale) out.locale = locale;
  const funnyEn = readFunny(r.funnyEn);
  if (funnyEn) out.funnyEn = funnyEn;
  const funnyYue = readFunny(r.funnyYue);
  if (funnyYue) out.funnyYue = funnyYue;
  return out;
}

function isHttpsOrLoopbackUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return false; // credentials in the URL itself
    if (parsed.protocol === "https:") return true;
    // Loopback HTTP is the explicitly bounded development route the contract
    // allows; anything else over plain HTTP is refused.
    return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  } catch {
    return false;
  }
}

function readSource(raw: unknown): ScheduleSource | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "local") {
    return { kind: "local", values: readValues(r.values) } satisfies LocalScheduleSource;
  }
  if (r.kind === "api") {
    const url = boundedString(r.url, URL_MAX);
    if (!url || !isHttpsOrLoopbackUrl(url)) return null;
    return {
      kind: "api",
      url,
      refreshMinutes: clampInt(r.refreshMinutes, REFRESH_MINUTES_MIN, REFRESH_MINUTES_MAX, REFRESH_MINUTES_DEFAULT),
    } satisfies ApiScheduleSource;
  }
  if (r.kind === "homeAssistant") {
    const baseUrl = boundedString(r.baseUrl, URL_MAX);
    const entityId = boundedString(r.entityId, ENTITY_ID_MAX);
    const tokenRef = boundedString(r.tokenRef, TOKEN_REF_MAX);
    if (!baseUrl || !isHttpsOrLoopbackUrl(baseUrl)) return null;
    if (!entityId || !/^[a-z_]+\.[a-z0-9_]+$/i.test(entityId)) return null;
    if (!tokenRef || !TOKEN_REF_RE.test(tokenRef)) return null;
    return {
      kind: "homeAssistant",
      baseUrl,
      entityId,
      tokenRef,
      values: readValues(r.values),
      refreshMinutes: clampInt(r.refreshMinutes, REFRESH_MINUTES_MIN, REFRESH_MINUTES_MAX, REFRESH_MINUTES_DEFAULT),
    } satisfies HomeAssistantScheduleSource;
  }
  return null;
}

function readRule(raw: unknown): ScheduleRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = boundedString(r.id, 64);
  const label = boundedString(r.label, LABEL_MAX);
  const source = readSource(r.source);
  if (!id || !label || !source) return null;
  const startDate = isValidDate(r.startDate) ? r.startDate : undefined;
  const endDate = isValidDate(r.endDate) ? r.endDate : undefined;
  const startTime = isValidTime(r.startTime) ? r.startTime : undefined;
  const endTime = isValidTime(r.endTime) ? r.endTime : undefined;
  const createdAt = Number.isFinite(Number(r.createdAt)) ? Number(r.createdAt) : Date.now();
  return {
    id,
    createdAt,
    label,
    enabled: r.enabled === true,
    priority: clampInt(r.priority, PRIORITY_MIN, PRIORITY_MAX, 0),
    days: readDays(r.days),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
    source,
  };
}

/**
 * Read and validate the stored schedule. Anything that fails to validate is
 * dropped rather than carried through — the same "validates down to nothing
 * is dropped" contract `readPrefs` follows, so a bounds check here can never
 * silently reintroduce an out-of-range value by leaving it in the object.
 *
 * An unrecognised `version` returns an empty, valid state rather than
 * attempting to interpret a shape this build does not know. There is only one
 * schema version today (`SCHEDULE_SCHEMA_VERSION`); this is where a future
 * migration step would be added, keyed on the stored version number.
 */
export function readScheduleState(storage?: Pick<Storage, "getItem">): ScheduleState {
  try {
    // `storage ?? localStorage` is resolved *inside* the try block rather than
    // as a default parameter value. A default parameter is evaluated in the
    // function's prologue, before the try/catch below ever runs — so on a
    // surface with no `localStorage` global (an SSR-style render in a test,
    // same as several existing suites already exercise for `SettingsDraftProvider`)
    // referencing it there would throw before this function got a chance to
    // fail safe, exactly the trap `readPrefs` in `theme/prefs-context.ts`
    // avoids by doing the same lookup inside its own try block.
    const store = storage ?? localStorage;
    const raw = JSON.parse(store.getItem(SCHEDULE_KEY) || "null");
    if (!raw || typeof raw !== "object") return emptyScheduleState();
    const r = raw as Record<string, unknown>;
    if (r.version !== SCHEDULE_SCHEMA_VERSION) return emptyScheduleState();
    if (!Array.isArray(r.rules)) return emptyScheduleState();
    const rules = r.rules
      .map(readRule)
      .filter((rule): rule is ScheduleRule => rule !== null)
      .slice(0, MAX_RULES);
    return { version: SCHEDULE_SCHEMA_VERSION, rules };
  } catch {
    return emptyScheduleState();
  }
}

export function writeScheduleState(state: ScheduleState, storage?: Pick<Storage, "setItem">): void {
  const bounded: ScheduleState = { version: SCHEDULE_SCHEMA_VERSION, rules: state.rules.slice(0, MAX_RULES) };
  (storage ?? localStorage).setItem(SCHEDULE_KEY, JSON.stringify(bounded));
}

/** New random id, stable identity for a rule across edits. */
export function newRuleId(): string {
  return `sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
