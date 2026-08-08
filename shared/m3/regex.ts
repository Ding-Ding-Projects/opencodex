/**
 * The regex engine, as one import path for every surface.
 *
 * There is exactly one implementation of `evaluate` / `namedGroups` /
 * `describeGroups` / the safety caps / the guided palette in this repository and
 * it lives in `gui/src/regex/engine.ts`. This module does not copy it, wrap it,
 * or add a second opinion about what a pattern matches — it re-exports it, so a
 * consumer that is not the dashboard has a stable path to import from without
 * reaching across the tree by hand. Same arrangement, and same reasoning, as
 * `shared/m3/tokens.ts`.
 *
 * Why re-export and not move: the dashboard is under active edit by another
 * agent, and relocating that file would rewrite imports in the builder page and
 * the anchored popover that already depend on it. When the move happens it is a
 * one-line change here — `export * from "./regex-impl"` — and no consumer
 * notices.
 *
 * Why sharing this matters more than sharing a colour: the caps are a safety
 * property. A 400-character pattern ceiling, a 20,000-character sample ceiling, a
 * 200-match ceiling and the forced advance on a zero-width match are what stop a
 * pattern the user is *still typing* from locking the main thread. A second copy
 * of the evaluator is a second place those four numbers can be edited apart, and
 * the surface that lost one hangs the page rather than reporting a slow pattern.
 *
 * Deliberately NOT here:
 *  - Translations. `TOKEN_GROUPS` and `FLAGS` carry `tkey` strings, which the
 *    dashboard resolves through its own dictionary. A consumer that is not the
 *    dashboard maps those same keys through its own — see
 *    `docs-site/src/lib/strings.ts`, which falls back to the construct itself so
 *    a token added upstream renders as `\p{...}` rather than as a raw key.
 *  - Any rendering. The popover markup differs per surface (the dashboard's uses
 *    its own primitives and icon set); what must not differ is which strings
 *    match and which index a named group has, and that is all this module owns.
 */

export * from "../../gui/src/regex/engine";
