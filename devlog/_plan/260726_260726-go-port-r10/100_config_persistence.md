# 100 — Shared live-config persistence

Base: `ddd968a0` with `061_response_state_literal_patch.md`,
`071_usage_snapshot_literal_patch.md`, and
`091_claude_auth_core_literal_patch.md` applied in that order.

## Boundary

This phase adds one eagerly armed `config.LivePersistence` owner for the
long-lived Go runtime. It serializes durable writes, retains the existing
atomic `config.Save`, and applies the TypeScript `claudeCode` conflict policy:

- disk changed, runtime unchanged: preserve the hand edit;
- disk and runtime both changed: runtime wins;
- after a successful save: rebase the structural baseline;
- missing, unreadable, or malformed config file: keep the previous save
  behavior;
- compare parsed JSON structurally, so object key order is irrelevant.

The owner is created after `LoadMigrated` returns, so the `091` migration has
already populated `ClaudeCodeConfig.AuthModeMigratedAt`. Tests preserve and
assert that sentinel while exercising hand edits. Short-lived CLI commands stay
unarmed and continue to call `config.Save` directly.

## Production composition

`runServe` creates exactly one owner and passes it to every long-lived writer:

- management API saves;
- Claude Desktop direct and best-effort background saves;
- runtime Codex-account imports, removals, aliases, and login completion;
- selected-port persistence before serving;
- request-path provider-key rotation after a 429.

The 429 path now writes the selected key back to the live provider and commits
it before returning the retry key. A failed durable write refuses the rotation
instead of reporting an in-memory-only success.

Standalone management/server constructors create a local owner only when a
caller supplied a config path but not the production owner. This preserves test
and embedding compatibility without changing the `runServe` one-owner rule.

## Tests

The literal patch adds:

- direct baseline tests for eager arming, external-edit preservation,
  runtime-wins conflict handling, rebasing, key-order equality, malformed-file
  fallback, migration-sentinel retention, and concurrent serialized updates;
- direct management and Claude Desktop save-boundary coverage;
- direct runtime Codex-account persistence coverage;
- a source inventory preventing bare `config.Save` calls in the five
  long-lived writer owners and locking the `runServe` composition points;
- a real `/v1/responses` production test proving 429 retry, durable selected-key
  persistence, and simultaneous `claudeCode` hand-edit preservation.

## Scope exclusions

This packet does not add Claude auth detection, launch-environment behavior,
management API fields, GUI changes, or Orca diagnostics. Those remain separate
work phases. It also does not broaden hand-edit protection beyond `claudeCode`.

## Apply and verify

Extract the fenced diff from `101_config_persistence_literal_patch.md` and apply
it after `061 → 071 → 091` in a clean `ddd968a0` checkout. Then run:

```bash
gofmt -d go/internal/config/live_persistence.go \
  go/internal/config/live_persistence_test.go \
  go/internal/config/live_writer_inventory_test.go \
  go/internal/management/api.go \
  go/internal/management/claude_desktop.go \
  go/internal/management/config_persistence_test.go \
  go/internal/server/server.go \
  go/internal/server/config_persistence_production_test.go \
  go/internal/cli/codex_auth_management.go \
  go/internal/cli/serve.go \
  go/internal/cli/config_persistence_test.go
git diff --check
(cd go && go test ./internal/claude ./internal/config ./internal/management \
  ./internal/server ./internal/usage ./internal/platform -count=1)
(cd go && go test ./internal/cli \
  -run 'TestRuntimeCodexAccountSaveUsesSharedPersistence|TestCodexAuthManagement|TestServe' \
  -count=1)
(cd go && go test ./... -count=1 -timeout 120s)
(cd go && go test -race ./internal/config ./internal/management ./internal/server -count=1)
(cd go && go test -race ./internal/cli \
  -run 'TestRuntimeCodexAccountSaveUsesSharedPersistence|TestCodexAuthManagement|TestServe' \
  -count=1)
(cd go && GOOS=windows GOARCH=amd64 go build -buildvcs=false ./...)
(cd go && GOOS=linux GOARCH=amd64 go build -buildvcs=false ./...)
(cd go && go vet ./...)
```

The literal patch is 592 insertions and 31 deletions across 11 files.
