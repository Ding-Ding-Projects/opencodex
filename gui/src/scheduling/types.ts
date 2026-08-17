/**
 * Scheduled-settings data model.
 *
 * A rule says *when* (days + an optional date range + an optional time window)
 * and *where the values come from* (typed directly here, fetched from an HTTPS
 * API, or gated on a Home Assistant boolean entity). Nothing in this file talks
 * to the network or to `localStorage` — see `schema.ts` for persistence and
 * `match.ts` for the pure "is this rule active right now" logic. Keeping the
 * shape on its own means the matching semantics can be unit-tested without a
 * DOM, a fetch mock or a browser at all.
 */

import type { DensityLevel, ThemeMode } from "../theme/m3";
import type { FunnyLevel } from "../i18n/voice";
import type { Locale } from "../i18n/shared";

/** 0 = Sunday .. 6 = Saturday, matching `Date#getDay()`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const ALL_WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/**
 * "Every day" is its own value rather than `[0,1,2,3,4,5,6]` written out, so a
 * rule that means "every day" and a rule that means "these seven days I
 * individually ticked" cannot silently drift apart, and so an *empty* array is
 * unambiguously "no day selected" (a rule that can never match) rather than a
 * second spelling of "every day".
 */
export type ScheduleDays = "everyday" | Weekday[];

/**
 * The subset of the app's appearance/customization surface a scheduled rule
 * may set. Every field is optional: a rule only overrides what it names, and
 * everything else keeps whatever the user's own (base) settings say.
 *
 * `motion` is deliberately absent. This app has no persisted "reduced motion"
 * preference to schedule — `appearance.reducedMotionOsOnly` already says why:
 * transitions follow the operating system's reduced-motion setting and cannot
 * be overridden from inside the app, scheduled or otherwise. There is nothing
 * here for a rule to hold.
 */
export interface ScheduleValues {
  theme?: ThemeMode;
  seed?: string;
  density?: DensityLevel;
  fontId?: string;
  fontStack?: string;
  fontScale?: number;
  fontWeight?: number;
  locale?: Locale;
  funnyEn?: FunnyLevel;
  funnyYue?: FunnyLevel;
}

export const SCHEDULE_VALUE_KEYS: readonly (keyof ScheduleValues)[] = [
  "theme", "seed", "density", "fontId", "fontStack", "fontScale", "fontWeight",
  "locale", "funnyEn", "funnyYue",
];

export type ScheduleSourceKind = "local" | "api" | "homeAssistant";

export interface LocalScheduleSource {
  kind: "local";
  values: ScheduleValues;
}

/**
 * Values fetched from a validated, versioned HTTPS API (a bounded loopback
 * `http://127.0.0.1` URL is also accepted, for local development — see
 * `src/server/management/schedule-routes.ts` for the exact allowlist). The
 * privileged process performs the request; the renderer never calls out
 * directly.
 */
export interface ApiScheduleSource {
  kind: "api";
  url: string;
  /** How often to re-fetch while this rule is the active one. */
  refreshMinutes: number;
}

/**
 * Values gated on a Home Assistant boolean entity (`binary_sensor` or
 * `input_boolean`). `on` applies `values`; `off`, unknown, or a failed check
 * means this rule contributes nothing and the next-best rule (or the base
 * settings) applies instead.
 *
 * `tokenRef` names an entry in the OS credential vault — never the token
 * itself. The renderer never receives the plaintext token back.
 */
export interface HomeAssistantScheduleSource {
  kind: "homeAssistant";
  baseUrl: string;
  entityId: string;
  tokenRef: string;
  values: ScheduleValues;
  refreshMinutes: number;
}

export type ScheduleSource = LocalScheduleSource | ApiScheduleSource | HomeAssistantScheduleSource;

export interface ScheduleRule {
  id: string;
  /** Creation order, used as the precedence tie-breaker. See `match.ts`. */
  createdAt: number;
  label: string;
  enabled: boolean;
  /** Higher wins when more than one enabled rule matches the same instant. */
  priority: number;
  days: ScheduleDays;
  /** Inclusive, `YYYY-MM-DD`, in the device's local calendar. */
  startDate?: string;
  endDate?: string;
  /** `HH:MM`, 24-hour, in the device's local time. */
  startTime?: string;
  endTime?: string;
  source: ScheduleSource;
}

export const SCHEDULE_SCHEMA_VERSION = 1 as const;

export interface ScheduleState {
  version: typeof SCHEDULE_SCHEMA_VERSION;
  rules: ScheduleRule[];
}

export function emptyScheduleState(): ScheduleState {
  return { version: SCHEDULE_SCHEMA_VERSION, rules: [] };
}
