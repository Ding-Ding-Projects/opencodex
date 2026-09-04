# R10 full roadmap validation receipt

Status: superseded by `009_3_audit_fail_replan.md` and the post-audit canonical
receipt. This file preserves the first full-gate evidence; its temporary-path
split Go command is not the final locked verifier.

Date: 2026-07-27  
Authoritative branch: `dev2-go`  
Authoritative HEAD: `244ca5ed95f9cb0d2f7f7b3b511b98d425fb4668`  
Current oracle: `origin/dev@2d5d491647a228c3900bac3a9aabe56c09bee344`

## Composition

A fresh disposable checkout applied the dependency-complete literal sequence:

```text
061 → 071 → 091 → 101 → 111 → 121 → 123 → 127 → 081 → 011 → 021 → 031 → 041
```

Every boundary passed `git apply --check`. The independently prepared final
tree contained 123 changed paths after generated assets were included. Excluding
the mechanically regenerated `go/internal/server/static/**` tree and manifest,
the fresh extraction matched the independently built composition byte-for-byte.

The GUI production build produced 46 files. Full-tree inventory and SHA-256
comparisons against the embedded Go tree passed. The generated manifest digest
was:

```text
5757e06c8cce47da37b53add1b596dbb642d036a65d8fa63c879d2fc88e85c6b  go/internal/server/static-manifest.json
```

## Failures found by the full gate

The first full Go run found two 401 regressions in built-server OpenAI pool
tests. Older Go previews can contain OpenAI credentials in the unified OAuth
store without `config.codexAccounts` metadata; the newly activated canonical
router therefore had no eligible account. Packet `123` now reconciles only
missing account identities through `LivePersistence` before listener startup,
preserves existing metadata/order, performs no rewrite when complete, stores no
credential bytes or opaque-ID display labels, and does not fabricate an active
selection. Both failed public-path tests and the full Go suite then passed.

The first full Bun run found four stale test assumptions: one source-checkout
`bin/ocx.mjs --version` assertion and three Bun-proxy launcher shutdown cases.
Packet `031` now leaves source version behavior with the source CLI and tests
SIGINT/SIGTERM/SIGHUP forwarding from the Node launcher to an explicit fake Go
child. Focused reruns passed 15/15; the second complete Bun run passed.

## Final gates

```text
bun run typecheck                                      PASS
bun test --isolate tests                              4736 pass, 0 fail
bun run lint:gui                                       PASS
cd gui && bun test tests                              294 pass, 0 fail, 1328 assertions
cd gui && bun run build                                PASS
node --test scripts/ocx-native-launcher.test.mjs       8 pass, 0 fail
bun run privacy:scan                                   PASS

go test all non-CLI packages -count=1 -timeout 400s    PASS
go test -trimpath ./internal/cli -count=1              PASS
go test -race targeted core/config/runtime packages    PASS
go test -race -trimpath ./internal/cli -count=1        PASS
go vet ./...                                           PASS
go build ./...                                         PASS
GOOS=windows GOARCH=amd64 go build ./cmd/ocx           PASS
GOOS=linux GOARCH=amd64 go build ./cmd/ocx             PASS
git diff --check                                       PASS
```

An untrimmed CLI test in a disposable `/private/tmp` checkout still reaches the
known crash-log absolute-path assertion; the repository's path-independent
`-trimpath` gate passes. No production or test source was changed in the
authoritative worktree during WP0 planning. User-owned `gpt-artifacts/` remained
untouched.

## Final stale-source check

The final `git fetch origin dev dev2-go` still resolved `origin/dev` to
`2d5d491647a228c3900bac3a9aabe56c09bee344`.

```text
git merge-base --is-ancestor origin/dev HEAD
exit 0
```

WP0 may advance to independent audit. Implementation remains split into the 14
successor work phases; this receipt does not authorize combining their B phases
or publishing a package.
