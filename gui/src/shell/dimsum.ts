/**
 * Dim sum surprise — the draw logic, separated from the card so it is testable.
 *
 * The contract, from the design spec:
 * - exactly ONE 10% draw per launch;
 * - never on first run (a new user's first impression is not a lottery);
 * - never on an update launch (the user is assessing whether the update broke
 *   anything — a surprise reads as "something is wrong");
 * - there is no off switch. The surprise cannot be opted out of, which is what
 *   makes the rules above load-bearing rather than decorative: an un-optable
 *   card has to be polite, so it stays non-blocking, auto-dismissing, never
 *   focus-stealing and never in the way of a task;
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

/**
 * FNV-1a over a string.
 *
 * Any stable hash would do; this one is four lines and has no dependency. It is
 * not used for anything security-sensitive — it picks a dumpling.
 */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // `Math.imul` keeps the multiply in 32 bits; a plain `*` loses precision
    // past 2^53 and would make the result depend on how far the loop had run.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The dish naming a given commit. Deterministic: same SHA, same dish, always.
 *
 * Lives here rather than in the release script because both need it and they
 * must never disagree. The release titles a build "叉燒包 Classic Char Siu Bao";
 * the app, built from that same commit, works out the same name from the same
 * table — so "which build am I running" is answerable by reading the About line
 * and matching it against the release list. A second copy of this function
 * would eventually name the same commit two different things, and the mismatch
 * would look like the user had installed something other than what they did.
 *
 * Derived from the commit rather than a run number on purpose: a re-run
 * publishes the same commit under a new number, and a build that renames itself
 * on a re-run is one nobody can cite.
 */
export function codenameFor(sha: string, dishes: DimSumDish[] = DISHES): DimSumDish {
  if (dishes.length === 0) throw new Error("no dishes are available to name a build");
  return dishes[hash(sha) % dishes.length];
}

const LAUNCHED_KEY = "ocx-m3:launched";
const LAST_VERSION_KEY = "ocx-m3:last-version";
export const DRAW_CHANCE = 0.1;

export interface DrawContext {
  /** The running app version, used to detect an update launch. */
  version: string;
  random?: () => number;
  storage?: Pick<Storage, "getItem" | "setItem">;
}

/**
 * Run the once-per-launch draw. Returns the dish to show, or null.
 *
 * Always records launch state (so the *next* launch is no longer "first run" /
 * "update launch") even when the draw loses — a launch that rolled and missed
 * is still a launch, and leaving the marker unwritten would freeze the
 * first-run suppression forever.
 *
 * There is deliberately no `enabled` parameter. The draw cannot be switched
 * off, so a caller has nothing to pass and no way to pass something wrong.
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

  if (firstRun || updated) return null;
  if (random() >= DRAW_CHANCE) return null;
  return DISHES[Math.floor(random() * DISHES.length) % DISHES.length];
}
