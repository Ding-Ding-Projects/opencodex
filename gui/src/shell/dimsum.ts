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
  /** Jyutping romanisation, so the name is pronounceable by a non-reader. */
  jyutping: string;
  /**
   * Fallback art, for the moment between a dish being listed and its photo
   * being bundled. Every dish here currently ships a real photo; the fallback
   * stays because adding a dish should never be able to render a broken image.
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
  { id: "classic-har-gow", name: "Classic Har Gow", zh: "蝦餃", jyutping: "haa1 gaau2", emoji: "🥟" },
  { id: "classic-siu-mai", name: "Classic Siu Mai", zh: "燒賣", jyutping: "siu1 maai6", emoji: "🥟" },
  { id: "classic-char-siu-bao", name: "Classic Char Siu Bao", zh: "叉燒包", jyutping: "caa1 siu1 baau1", emoji: "🥟" },
  { id: "steamed-chicken-with-black-fungus", name: "Steamed Chicken with Black Fungus", zh: "雲耳蒸雞", jyutping: "wan4 ji5 zing1 gai1", emoji: "🥟" },
  { id: "puff-pastry-egg-tarts", name: "Puff Pastry Egg Tarts", zh: "酥皮蛋撻", jyutping: "sou1 pei4 daan6 taat1", emoji: "🥟" },
  { id: "steamed-radish-cake", name: "Steamed Radish Cake", zh: "蒸蘿蔔糕", jyutping: "zing1 lo4 baak6 gou1", emoji: "🥟" },
  { id: "black-bean-chicken-feet", name: "Steamed Chicken Feet in Black Bean Sauce", zh: "豉汁蒸鳳爪", jyutping: "si6 zap1 zing1 fung6 zaau2", emoji: "🥟" },
  { id: "steamed-bean-curd-roll", name: "Steamed Bean Curd Skin Roll", zh: "鮮竹卷", jyutping: "sin1 zuk1 gyun2", emoji: "🥟" },
  { id: "traditional-big-bun", name: "Traditional Big Bun", zh: "大包", jyutping: "daai6 baau1", emoji: "🥟" },
  { id: "steamed-beef-balls", name: "Steamed Beef Balls", zh: "山竹牛肉", jyutping: "saan1 zuk1 ngau4 juk6", emoji: "🥟" },
  { id: "sausage-turnip-pudding", name: "Turnip Pudding with Chinese Sausage", zh: "臘味蘿蔔糕", jyutping: "laap6 mei6 lo4 baak6 gou1", emoji: "🥟" },
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
