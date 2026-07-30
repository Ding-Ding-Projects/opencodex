/**
 * Dim sum surprise — the draw logic, separated from the card so it is testable.
 *
 * The contract, from the design spec:
 * - exactly ONE 1% draw per launch;
 * - never on first run (a new user's first impression is not a lottery);
 * - never on an update launch (the user is assessing whether the update broke
 *   anything — a surprise reads as "something is wrong");
 * - the off switch is honoured before the draw, not after;
 * - no network fetch, ever. Art ships bundled; alt text names the dish.
 */

export interface DimSumDish {
  id: string;
  /** English dish name — used as the alt text, per the spec. */
  name: string;
  /** Chinese name shown alongside. */
  zh: string;
  /**
   * Fallback art, shown when no bundled photo is present for this dish.
   *
   * Deliberately a labelled stand-in rather than a pretend photo: the card
   * renders {@link photoSrc} first and only falls back here if that asset is
   * absent, so dropping the real images into `gui/public/dimsum/` completes the
   * feature with no code change.
   */
  emoji: string;
}

/**
 * Where a dish's bundled photo lives.
 *
 * Served from `gui/public/`, so it is a local file in the build output — never
 * a network fetch, per the no-third-party rule. Absent files are handled by the
 * card's error fallback rather than by probing, because a synchronous
 * "does this asset exist" check does not exist in a browser.
 */
export function photoSrc(dish: DimSumDish): string {
  return `dimsum/${dish.id}.webp`;
}

export const DISHES: DimSumDish[] = [
  { id: "har-gow", name: "Har gow (shrimp dumpling)", zh: "蝦餃", emoji: "🥟" },
  { id: "siu-mai", name: "Siu mai (pork and shrimp dumpling)", zh: "燒賣", emoji: "🥟" },
  { id: "char-siu-bao", name: "Char siu bao (barbecue pork bun)", zh: "叉燒包", emoji: "🥠" },
  { id: "cheung-fun", name: "Cheung fun (rice noodle roll)", zh: "腸粉", emoji: "🍜" },
  { id: "dan-tat", name: "Dan tat (egg tart)", zh: "蛋撻", emoji: "🥧" },
  { id: "lo-bak-go", name: "Lo bak go (turnip cake)", zh: "蘿蔔糕", emoji: "🍘" },
  { id: "fung-zao", name: "Fung zao (chicken feet)", zh: "鳳爪", emoji: "🍗" },
  { id: "nor-mai-gai", name: "Nor mai gai (sticky rice in lotus leaf)", zh: "糯米雞", emoji: "🍙" },
];

const LAUNCHED_KEY = "ocx-m3:launched";
const LAST_VERSION_KEY = "ocx-m3:last-version";
export const DRAW_CHANCE = 0.01;

export interface DrawContext {
  /** The dim sum off switch from prefs. */
  enabled: boolean;
  /** The running app version, used to detect an update launch. */
  version: string;
  random?: () => number;
  storage?: Pick<Storage, "getItem" | "setItem">;
}

/**
 * Run the once-per-launch draw. Returns the dish to show, or null.
 *
 * Always records launch state (so the *next* launch is no longer "first run" /
 * "update launch") even when the draw is skipped — otherwise a disabled toggle
 * would freeze the first-run marker forever.
 */
export function drawDimSum(ctx: DrawContext): DimSumDish | null {
  const storage = ctx.storage ?? localStorage;
  const random = ctx.random ?? Math.random;

  let firstRun: boolean;
  let updated: boolean;
  try {
    firstRun = storage.getItem(LAUNCHED_KEY) === null;
    const lastVersion = storage.getItem(LAST_VERSION_KEY);
    updated = lastVersion !== null && lastVersion !== ctx.version;
    storage.setItem(LAUNCHED_KEY, "1");
    storage.setItem(LAST_VERSION_KEY, ctx.version);
  } catch {
    // Unreadable storage means we cannot prove this is not a first run — skip.
    return null;
  }

  if (!ctx.enabled || firstRun || updated) return null;
  if (random() >= DRAW_CHANCE) return null;
  return DISHES[Math.floor(random() * DISHES.length) % DISHES.length];
}
