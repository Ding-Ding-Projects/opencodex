/**
 * The Material 3 token engine, as one import path for every surface.
 *
 * There is exactly one implementation of `buildScheme` / `densityTokens` /
 * `typeTokens` / `applyTokens` in this repository and it lives in
 * `gui/src/theme/m3.ts`, ported from the design prototype. This module does not
 * copy it, wrap it, or add a second opinion about what a role token is — it
 * re-exports it, so a consumer that is not the dashboard has a stable path to
 * import from without reaching across the tree by hand.
 *
 * Why a re-export and not a move: the dashboard is under active edit by another
 * agent, and physically relocating the file would rewrite an import that four
 * dozen of its modules depend on. When that move does happen it is a one-line
 * change here — `export * from "./tokens-impl"` — and no consumer of this module
 * notices. Until then, "one source" is literally true: there is one file, and
 * both trees resolve to it.
 *
 * Deliberately NOT here:
 *  - Font stacks. `FONT_CHOICES` below names Roboto Flex and Noto Sans HK, which
 *    the dashboard bundles and the docs site does not. A shared list would
 *    silently offer a face one surface cannot render, and a picker whose options
 *    do nothing is worse than a shorter picker. Each surface declares the faces
 *    it actually ships and resolves ids against its own list.
 *  - Anything that reads `localStorage`. Preference *storage* is per-surface (a
 *    docs visitor is not the operator of a local dashboard); only the maths is
 *    shared.
 */

export * from "../../gui/src/theme/m3";
