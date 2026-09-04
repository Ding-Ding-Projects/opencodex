# 090 — Claude auth core parity

Current stale-check base: `94f0fa2102e08018881a37efb685fb7050e37444`,
which already contains audited `061_response_state_literal_patch.md` and
`071_usage_snapshot_literal_patch.md`. Current upstream ancestry reference:
`origin/dev@1eb7269f447c913c31e5609dda503da8b623d7ac`.

## Boundary

This phase ports only the native Claude authentication decision core and its
startup schema migration. It deliberately does not wire the result into CLI
launch environments, system environment persistence, management routes, the
GUI, or the guarded config saver. Those owners need later work phases because
they change live process and API behavior.

The diff owns eight files:

- NEW `go/internal/claude/auth.go`: source probes, three-valued aggregation,
  owned-token exclusion, stale-marker reporting, conservative resolution, and
  auto/manual intent.
- NEW `go/internal/claude/auth_keychain.go`: metadata-only Keychain command
  contract with a 1.5-second context deadline and exit-code mapping.
- NEW `go/internal/claude/auth_keychain_darwin.go` and
  `auth_keychain_other.go`: build-tagged production activation; non-Darwin is
  an explicit absent source and never spawns `security`.
- NEW `go/internal/claude/auth_test.go`: source parity, privacy, feedback-loop,
  resolver, profile binding, command shape, actual 1.5-second timeout activation,
  output suppression, and exit-44 tests.
- MODIFY `go/internal/config/schema_extended.go`: persist
  `authModeMigratedAt` across Go/TypeScript round trips.
- MODIFY `go/internal/config/migration.go`: run the Claude migration in the
  existing startup transaction, after OpenAI tier projection and before the
  returned config can be served.
- NEW `go/internal/config/claude_auth_migration_test.go`: legacy pinning,
  explicit mode preservation, later-Auto idempotence, no-block behavior, disk
  persistence, true Claude-only backup absence, combined OpenAI+Claude ordering,
  exact rollback bytes, and second-load stability.

## Behavioral contract

Each source returns `present`, `absent`, or `unknown`. Any present source wins;
otherwise unknown wins over absent. A corrupt JSON file, permission error,
failed Keychain command, timeout, or environment read failure therefore cannot
silently switch a subscriber into proxy mode.

The exported environment source ignores both `opencodex-proxy` and the caller's
configured admission-token values. This prevents the proxy's own output from
becoming user-auth evidence on the next detection pass. The stale proxy marker
is still reported separately so later launch-environment work can remove or
re-establish it deliberately.

The Darwin probe executes exactly:

`security find-generic-password -s "Claude Code-credentials"`

It never passes `-g` or `-w`, discards stdout and stderr, has a 1.5-second
context deadline, maps status 0 to present and status 44 to absent, and maps
every other status or error to unknown. Build tags keep this command unreachable
on non-Darwin systems.

An explicit stored `proxy` or `subscription` remains manual. An absent key is
Auto: present resolves to subscription, absent to proxy, and unknown
conservatively to subscription. The pure resolver does not mutate config.

For a pre-Auto config that already has a `claudeCode` block, the one-time
migration writes `subscription` only when `authMode` was absent and always
stamps `authModeMigratedAt`. A missing block stays untouched. A non-empty
sentinel prevents reruns, including after a later UI action deletes `authMode`
to select Auto.

## Security and scope notes

No token value, OAuth email, Keychain output, or filesystem error text enters an
auth result detail. Tests assert that the OAuth detail contains only the source
label. The detector accepts owned tokens as an injected list rather than
importing `config`, preserving the existing `config -> claude` package direction
and avoiding an import cycle.

The startup migration reuses the existing atomic `config.Save`. It creates the
OpenAI rollback snapshot only when the OpenAI migration changed; a Claude-only
migration does not manufacture an unrelated backup.

## Verification protocol

Extract the fenced diff from `091_claude_auth_core_literal_patch.md`, apply it
to a clean `94f0fa21` checkout, then run:

```bash
gofmt -d go/internal/claude/auth.go go/internal/claude/auth_keychain.go \
  go/internal/claude/auth_keychain_darwin.go go/internal/claude/auth_keychain_other.go \
  go/internal/claude/auth_test.go go/internal/config/schema_extended.go \
  go/internal/config/migration.go go/internal/config/claude_auth_migration_test.go
git diff --check
(cd go && go test ./internal/claude ./internal/config -count=1)
(cd go && go test ./... -count=1 -timeout 400s)
(cd go && go vet ./...)
(cd go && GOOS=windows GOARCH=amd64 go build ./...)
(cd go && GOOS=linux GOARCH=amd64 go build ./...)
```

The literal patch is 664 insertions and 5 deletions across eight files. The
independent apply check must leave only the 061, 071, and 091 scoped deltas.
