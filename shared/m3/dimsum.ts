/**
 * The dim sum draw, as one import path for every surface.
 *
 * `gui/src/shell/dimsum.ts` already encodes the whole contract — one 1 % draw
 * per launch, never on a first run, never on an update launch, and the off
 * switch honoured *before* the draw — and it does it with no imports at all, so
 * re-exporting it costs a consumer nothing.
 *
 * Copying it would have been the expensive mistake here, and not for the usual
 * reason. `codenameFor` in that file is also what the release pipeline uses to
 * name a build after a dish: the release is titled "叉燒包 Classic Char Siu Bao"
 * and the app, built from the same commit, derives the same name from the same
 * table. A second copy of `DISHES` would eventually name one commit two
 * different things, and a user checking which build they are running would see
 * a mismatch that looks exactly like having installed the wrong artifact.
 *
 * What a consumer still owns:
 *  - **How the art renders.** The dashboard intentionally uses offline emoji art:
 *    a credential-bearing local control surface must not make surprise outbound
 *    image requests, and consumers must not copy catalog photos into their repos.
 *  - **Which storage keys the launch markers use.** `drawDimSum` takes a
 *    `storage` argument, so a consumer namespaces the markers by passing an
 *    adapter rather than by having a second copy of the draw.
 */

export * from "../../gui/src/shell/dimsum";
