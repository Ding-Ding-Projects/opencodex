# 100 — Shared live-config persistence

Base: `0bb8f49a4823bd905e4117c2f25657411499c5d2` (post-upstream rebase parent on
current `dev2-go`, already containing the response-state, usage-snapshot, and
Claude auth-core work phases).

## Boundary

This phase adds one eagerly armed `config.LivePersistence` owner for the
long-lived Go runtime. It serializes each complete live mutation and durable
write, retains the existing atomic `config.Save`, and applies the TypeScript
`claudeCode` conflict policy:

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
it before returning the retry key. `LivePersistence.Update` snapshots the full
config before mutation and restores it on save failure, so a failed durable
write both refuses the retry and leaves no in-memory-only key rotation behind.
Management mutations run inside `LivePersistence.Serialize` and runtime Codex
account mutations use `Update`, preventing a failed request-path rotation from
restoring a stale snapshot over another writer. Direct `Save` also snapshots
before applying a preserved hand edit and restores that live value on failure.
The owner uses an RW lock: request routing, live registry/auth/adapter/relay
resolution, provider quotas, and `/v1/models` projections read through
`Read`/`Snapshot`. The management API's pre-existing config mutex is bound to
the owner, so 429 updates also exclude legacy management readers without
holding a read lock across unrelated network work.

Standalone management/server constructors create a local owner only when a
caller supplied a config path but not the production owner. This preserves test
and embedding compatibility without changing the `runServe` one-owner rule.

## Tests

The literal patch adds:

- direct baseline tests for eager arming, external-edit preservation,
  runtime-wins conflict handling, rebasing, key-order equality, malformed-file
  fallback, migration-sentinel retention, concurrent serialized updates, and
  complete rollback after both update and direct-save failures;
- direct management and Claude Desktop save-boundary coverage;
- a management/runtime concurrency test proving both writers share one
  transaction lock and remain disk/live consistent under the race detector;
- direct runtime Codex-account persistence coverage;
- a source inventory preventing bare `config.Save` calls in the five
  long-lived writer owners and locking the `runServe` composition points;
- real `/v1/responses` production tests proving 429 retry, durable selected-key
  persistence, simultaneous `claudeCode` hand-edit preservation, and no live
  key mutation or retry when persistence fails, plus concurrent routing reads
  against runtime config writes under the race detector.

## Scope exclusions

This packet does not add Claude auth detection, launch-environment behavior,
management API fields, GUI changes, or Orca diagnostics. Those remain separate
work phases. It also does not broaden hand-edit protection beyond `claudeCode`.

## Apply and verify

Extract the fenced diff from `101_config_persistence_literal_patch.md` and apply
it in a clean `0bb8f49a4823bd905e4117c2f25657411499c5d2` checkout. Then run:

```bash
gofmt -d go/internal/config/live_persistence.go \
  go/internal/config/live_persistence_test.go \
  go/internal/config/live_writer_inventory_test.go \
  go/internal/cli/live_config.go \
  go/internal/cli/runtime_management.go \
  go/internal/cli/runtime_seams.go \
  go/internal/management/api.go \
  go/internal/management/claude_desktop.go \
  go/internal/management/config_persistence_test.go \
  go/internal/management/models.go \
  go/internal/server/server.go \
  go/internal/server/data_plane.go \
  go/internal/server/subagent_fallback.go \
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
(cd go && go test ./... -count=1 -timeout 400s)
(cd go && go test -race ./internal/config ./internal/management ./internal/server -count=1)
(cd go && go test -race ./internal/cli \
  -run 'TestRuntimeCodexAccountSaveUsesSharedPersistence|TestCodexAuthManagement|TestServe' \
  -count=1)
(cd go && GOOS=windows GOARCH=amd64 go build -buildvcs=false ./...)
(cd go && GOOS=linux GOARCH=amd64 go build -buildvcs=false ./...)
(cd go && go vet ./...)
```

The audited literal patch is 1,277 insertions and 218 deletions across 17
files.
