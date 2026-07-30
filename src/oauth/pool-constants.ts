/**
 * Pool constants that live across an import cycle — deliberately a leaf module
 * with no imports of its own.
 *
 * `provider-pool.ts` needs `../providers/quota` for usage scores, and that reaches
 * back around through `codex/auth-api` → `oauth/health` → `oauth/anthropic-routing`
 * → `provider-pool`. A cycle alone is harmless while every partner only touches
 * the others inside function bodies. It stops being harmless the moment a module
 * reads a cyclic partner's `const` at evaluation time: whichever module the graph
 * enters first wins, and the other one sees the binding in its temporal dead zone.
 *
 * That is not hypothetical. The Anthropic facade aliases this cap at module scope,
 * so importing `provider-pool.ts` as the graph's first module threw
 * `ReferenceError: Cannot access 'OAUTH_POOL_MAX_FAILOVERS_PER_REQUEST' before
 * initialization` — which is exactly what happens under `bun test --isolate`, where
 * each file gets a fresh registry and nothing has primed the graph. The pool's own
 * test file contributed zero passing tests because of it.
 *
 * Keeping the shared value here means both sides import it from outside the cycle,
 * and neither can observe the other half-built. Anything else read at module scope
 * by two modules in this cycle belongs here too.
 */

/** Cap same-request 429 rotations so a short Retry-After cannot infinite-loop. */
export const OAUTH_POOL_MAX_FAILOVERS_PER_REQUEST = 3;
