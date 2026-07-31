/**
 * The 1 % dim sum surprise, as this site runs it.
 *
 * The draw itself is not reimplemented here. `shared/m3/dimsum.ts` re-exports
 * the dashboard's `drawDimSum`, which already encodes the whole contract — one
 * draw per launch, never on a first run, the off switch honoured *before* the
 * draw rather than after, no network fetch ever — and that table of dishes is
 * also what names a release build, so a second copy would eventually give one
 * commit two different codenames.
 *
 * What this module owns is the three things the shared draw deliberately leaves
 * to its consumer.
 *
 * ## 1. The storage namespace
 *
 * `drawDimSum` writes its launch markers under `ocx-m3:*`, which is the
 * dashboard's namespace. The keys are not parameters, but `storage` is — so this
 * passes an adapter that prefixes every key with `ocx-docs:`. Different origins
 * would have kept them apart anyway; sharing a namespace by accident is the kind
 * of thing that is only harmless until someone runs the dashboard and the docs
 * on the same host.
 *
 * ## 2. Where the art lives
 *
 * `photoSrc` returns a bare `dimsum/<id>.webp`, which resolves correctly against
 * a page at the site root and incorrectly against a page three levels deep — and
 * this site publishes to a domain root *and* under a `/opencodex` prefix. The
 * URL is built from `BASE` for the same reason every other link on this site is.
 *
 * ## 3. What "an update launch" means for a website
 *
 * The shared draw suppresses the surprise on the launch after an update, because
 * someone checking whether an update broke their install does not want a
 * dumpling in the way. A website has no install to break, so `version` is a
 * constant here: the branch that matters on this surface is the first-visit
 * suppression, and a deploy is not a first visit. Making `version` a build id
 * instead would silently suppress the draw for every reader's first visit after
 * every deploy, which would push the real frequency well under the stated 1 %.
 */

import { DISHES, drawDimSum, photoSrc, type DimSumDish } from "../../../shared/m3/dimsum";
import { BASE } from "./routes";

export type { DimSumDish };
export { DISHES };

export const ENABLED_KEY = "ocx-docs:dimsum";
const NAMESPACE = "ocx-docs:";

/** See the module comment — deliberately not a build id. */
const SITE_VERSION = "docs";

/** The bundled photo for a dish, correct under both of this site's deployments. */
export function dishImage(dish: DimSumDish): string {
  return `${BASE}${photoSrc(dish)}`;
}

/**
 * The off switch, read before anything else happens.
 *
 * Defaults to on. A reader who has never touched the setting has not opted out
 * of it, and the surprise is the documented behaviour rather than something
 * that needs consent — but the switch is one click away and is honoured
 * absolutely, including before the coin is flipped.
 */
export function readEnabled(storage?: Pick<Storage, "getItem">): boolean {
  try {
    return (storage ?? localStorage).getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeEnabled(enabled: boolean, storage?: Pick<Storage, "setItem">): void {
  try {
    (storage ?? localStorage).setItem(ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    /* private mode */
  }
}

/**
 * A `Storage` view whose keys all sit under this site's prefix.
 *
 * Only the two methods `drawDimSum` uses are implemented, and the type says so —
 * a full `Storage` shim would be four more methods nobody calls and a `length`
 * that would have to lie.
 */
export function namespacedStorage(inner: Pick<Storage, "getItem" | "setItem">): Pick<Storage, "getItem" | "setItem"> {
  return {
    getItem: key => inner.getItem(`${NAMESPACE}${key}`),
    setItem: (key, value) => inner.setItem(`${NAMESPACE}${key}`, value),
  };
}

/**
 * True once the draw has run in this browsing context.
 *
 * Module scope, not component state. The card is rendered by a `transition:persist`
 * island so it is not normally re-mounted, but a module flag is the guarantee
 * that survives a remount too — and "one draw per launch" is a promise about the
 * session, not about a component's lifecycle. With a client-side router the JS
 * context outlives every navigation, so this flag is exactly as long-lived as
 * the reader's visit.
 */
let drawn = false;

export interface DrawOptions {
  random?: () => number;
  /**
   * The **raw** store, not a namespaced view of one.
   *
   * `drawOnce` reads the off switch and the launch markers from the same place,
   * and the off switch's key is already spelled with the site's prefix while the
   * markers' keys are not. Taking the raw store here and namespacing internally
   * is what keeps a test able to prove the switch is honoured *before* the draw
   * rather than having to trust that it is.
   */
  storage?: Pick<Storage, "getItem" | "setItem">;
  /** Bypasses both the once-per-launch guard and the 1 % odds. */
  force?: boolean;
}

/**
 * Run this launch's draw. Returns a dish, or null far more often than not.
 *
 * `force` exists for the "show me one now" button in Settings: a reader who has
 * just enabled the feature deserves to see what they enabled without waiting for
 * a hundred visits, and a preview that shared the real draw would either lie
 * about the odds or consume the launch's one chance.
 */
export function drawOnce(options: DrawOptions = {}): DimSumDish | null {
  const random = options.random ?? Math.random;
  if (options.force) return DISHES[Math.floor(random() * DISHES.length) % DISHES.length] ?? null;
  if (drawn) return null;
  drawn = true;
  if (typeof localStorage === "undefined" && !options.storage) return null;
  const store = options.storage ?? localStorage;
  return drawDimSum({
    enabled: readEnabled(store),
    version: SITE_VERSION,
    random,
    storage: namespacedStorage(store),
  });
}

/** Test seam: forget that this context has drawn. Never called by the site. */
export function resetDrawForTests(): void {
  drawn = false;
}
