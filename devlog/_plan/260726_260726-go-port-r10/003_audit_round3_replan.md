# 003 — A-gate round 3 failure and changed-plan decision

Third verdict: `FAIL`. AUDIT-LOOP-01 requires return to P with a changed plan.

## Residuals

- R1: MODIFY entries still lacked literal complete hunks.
- R2: pre-bridge process cached the old shim owner; dynamic import did not guarantee
  new shim code in the first update.
- R3: transaction marker was also used as lock, so recovery wedged on its own marker.

## Changed strategy

1. **Disposable package staging.** `bin/native` is generated only before pack and is
   gitignored. It is not a runtime live-set during build. The new plan deletes that
   owned directory before build, builds/validates all seven files, and deletes it on
   failure. There is no backup/rollback transaction to design.
2. **Shim convergence on first fresh launcher invocation.** The bridge retains Bun,
   so the cached old shim remains valid after the first update. Service/tray owners
   loaded after replacement persist Node launcher → Go immediately. The new launcher
   sees existing shim state and invokes the Go child once with
   `codex-shim install` under a recursion guard before the requested command. Thus
   shim-only users converge on the first fresh `ocx` call without a broken interval.
3. **Literal patch appendices.** Each implementation decade doc will carry complete
   unified hunks for every production owner and exact named test changes. If a file's
   hunk cannot be written without inventing behavior, that slice is split before A.

## Scope consequence

The bridge claim is now:

- package update itself remains safe because dormant Bun is retained;
- service/tray paths converge during post-replacement repair;
- a cached shim converges on first fresh launcher invocation;
- no claim says every pre-bridge process rewrites every owner before returning.
