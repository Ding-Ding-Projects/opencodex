/**
 * "Edit appearance…" for one piece of chrome, reachable from that piece itself.
 *
 * The per-element style system has existed since the M3 shell landed — six
 * targets, each writing `--el-<id>-*` custom properties — but the only way to
 * reach it was the Appearance *page*, where the element is chosen from a
 * dropdown. That is a fine place to browse them and a poor place to edit one:
 * the thing being restyled is on another screen, so every change is made
 * blind.
 *
 * This is the in-place route. A context rather than props threaded through the
 * shell, because the elements that want it — the nav rail, the app bar, the tab
 * strip, a card, a table — have no common ancestor short of `App`, and passing
 * an opener down five levels to reach a `<Card>` would put appearance plumbing
 * in the signature of every layout component it passes through.
 *
 * Split from the component file so that one exports only components: Fast
 * Refresh discards a module's state when it exports non-components alongside
 * them, which here would close the editor on every edit to it.
 */

import { createContext, useContext } from "react";

export interface ElementAppearanceApi {
  /**
   * Open the editor for `id`, anchored beside `anchor`.
   *
   * `id` is an `ELEMENT_TARGETS` id. An unknown one is ignored rather than
   * throwing: a caller that mistypes a target should lose a menu entry, not
   * take the shell down.
   */
  open: (id: string, anchor: HTMLElement | null) => void;
  /** Which target is open, so a surface can mark itself as being edited. */
  openId: string | null;
}

export const ElementAppearanceContext = createContext<ElementAppearanceApi | null>(null);

/**
 * Never throws when there is no provider.
 *
 * Unlike `usePrefs`, this is consumed by leaf chrome that is also rendered in
 * tests and in the onboarding wizard, neither of which mounts the host. A
 * missing provider should make "Edit appearance…" unavailable, not make a card
 * fail to render.
 */
export function useElementAppearance(): ElementAppearanceApi {
  return useContext(ElementAppearanceContext) ?? NO_HOST;
}

const NO_HOST: ElementAppearanceApi = { open: () => {}, openId: null };
