# WP11 — Claude auth auto production activation

Date: 2026-07-26  
Base: `ddd968a0169e4c190bf1037e78a824c6780568e9`  
Class: C4 (authentication, persisted migration, public management API)  
Predecessors: apply `061`, then `071`, then `091`, then `101` before this packet.

## Outcome

Activate the shared Go Claude-auth detector/resolver from packet `091` on every user-facing native path that decides whether opencodex owns Claude authentication:

- `ocx claude` child environment;
- plain `claude` auto-connect through the generated shell environment and macOS system environment;
- `GET/PUT /api/claude-code` three-state intent and effective resolution fields;
- post-upgrade restart behavior after selecting Auto or creating a fresh Claude block.

The implementation must preserve a user's real Claude credentials, remove only
the opencodex-owned stale marker, keep the proxy admission key independent from
marker resolution, and default
`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` whenever the final `ocx claude` child
environment contains a non-empty `ANTHROPIC_AUTH_TOKEN`. An explicit inherited
host-managed value still wins. This matches Claude Code's settings-source strip:
the flag and token must always travel together so a cc-switch/CCR
`settings.json` block cannot replace the selected provider without asserting
host authentication when no host token exists.

## Scope boundary

### IN

| Path | Action | Contract |
|---|---|---|
| `go/internal/cli/claude.go` | MODIFY | Extract deterministic child-env assembly, bind detection to the same inherited environment, preserve user variables, replace stale owned loopback URL, and tie the host-managed default to the final token. |
| `go/internal/cli/claude_test.go` | NEW | Lock user-wins, own-marker stripping, Auto present/absent/unknown, admission-key separation, the token/flag invariant, and settings-source hijack defense. |
| `go/internal/cli/runtime_management.go` | MODIFY | Resolve marker mode for generated shell env, emit the owned marker only for proxy resolution, and emit the host-managed flag only when opencodex owns the token. |
| `go/internal/cli/runtime_claude_auth_test.go` | NEW | Exercise generated shell env for Auto present/absent/unknown and admission-key paths. |
| `go/internal/cli/system_env_darwin.go` | MODIFY | Use the same resolver for launchctl injection and conditionally add the host-managed flag. |
| `go/internal/cli/system_env_darwin_test.go` | MODIFY | Lock plain-Claude Auto behavior and user credential preservation on Darwin. |
| `go/internal/platform/systemenv.go` | MODIFY | Reconcile previously tracked owned launchctl keys that are no longer desired, with rollback restoration; never remove changed user values. |
| `go/internal/management/runtime_settings.go` | MODIFY | Return three-state intent plus effective resolution metadata; accept `auto`, store literal `subscription`, delete the key for Auto, stamp the migration sentinel, and reconcile system env after auth-only writes. |
| `go/internal/management/runtime_claude_auth_test.go` | NEW | Drive real management GET/PUT and restart migration behavior at the production API root. |

### OUT

- Generated GUI assets and GUI source.
- Usage snapshot/cache work (`070`/`080`).
- Guarded saver implementation internals from `101`; this packet only uses the already-wired production save boundary.
- Orca diagnostics.
- Changes to detector policy, Keychain probing, migration semantics, or persistence conflict policy established by `091`/`101`.

## Required predecessor API

Packet `091` is the source of truth for names. This packet assumes the following shared surface; if the literal identifiers differ after composing `091`, rebase this packet mechanically without changing behavior:

```go
claude.ProxyMarker
claude.AuthDetectDeps
claude.DefaultAuthDetectDeps(env map[string]string, ownTokens []string)
claude.DetectClaudeAuth(deps claude.AuthDetectDeps) claude.AuthDetectResult
claude.ResolveAuthMode(intent string, detection claude.AuthDetectResult) claude.ResolvedAuthMode
claude.StoredAuthModeIntent(stored string) claude.AuthModeIntent
```

`ResolvedAuthMode` exposes `MarkerMode`, `Origin`, `FoundBy`; `AuthDetectResult` exposes `Presence`. Callers derive the own-token slice from `config.APIKeys` so the `claude` package never imports `config`. Unknown detection must resolve to subscription. `config.ClaudeCodeConfig.AuthModeMigratedAt` and startup migration are supplied by `091`. Packet `101` supplies the shared guarded production persistence path; no direct bare save is introduced here.

## Diff design

### 1. `ocx claude` launch environment

Add a pure `buildClaudeLaunchEnv` helper. It starts from a copied inherited environment and applies these steps in order:

1. Remove `ANTHROPIC_AUTH_TOKEN` only when its value is exactly `claude.ProxyMarker`.
2. Preserve every other inherited credential and variable.
3. Default `ANTHROPIC_BASE_URL` to the active loopback proxy. Replace it only when it is an opencodex-shaped loopback URL with an explicit stale port; preserve custom and malformed user values.
4. If an admission key exists, set it only when the user token slot is empty.
5. Run the shared detector against the original inherited environment with configured admission keys excluded as own tokens.
6. If no token is present after step 4 and marker mode resolves to proxy, inject `claude.ProxyMarker`.
7. Set gateway discovery by default.
8. If the final `ANTHROPIC_AUTH_TOKEN` is non-empty, default
   `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`. Preserve an explicit inherited
   value such as `0`; never emit the flag without a token.

Conditional activation evidence:

- inherited own marker -> marker is stripped before detection and then re-added only if resolution requires proxy;
- unreadable auth sources -> subscription resolution and no marker;
- configured admission key -> key wins independently of marker mode and host flag is set;
- inherited user token -> unchanged; an explicit host flag remains untouched,
  otherwise the flag defaults to `1` so settings-sourced provider variables are
  stripped.

### 2. Plain-Claude system environment

Both shell-file and Darwin launchctl paths call one resolver helper. The generated shell file uses conditional exports for the owned marker and host flag. Admission keys remain unconditional opencodex-owned exports, matching the existing auto-connect contract. Subscription/unknown never adds the marker. The Darwin injection path must never overwrite a pre-existing user token and must remove only a previously tracked `claude.ProxyMarker` when resolution switches away from proxy.

Conditional activation evidence:

- Auto absent -> marker + host flag;
- Auto present/unknown -> neither owned marker nor host flag;
- admission key -> admission key + host flag regardless of marker resolution;
- user launchctl token -> preserved and not relabelled as host-owned.

### 3. Management API

`GET /api/claude-code` returns:

```json
{
  "authMode": "auto|proxy|subscription",
  "markerMode": "proxy|subscription",
  "authModeOrigin": "manual|auto-present|auto-absent|auto-unknown",
  "authFoundBy": "optional source id",
  "authDetectionUnknown": false,
  "admissionKeyActive": false,
  "detectionScope": "daemon"
}
```

`PUT /api/claude-code` accepts exactly `auto`, `proxy`, or `subscription`:

- `auto`: delete `AuthMode`;
- `proxy`: store literal `proxy`;
- `subscription`: store literal `subscription`;
- every successful persistence of a Claude block stamps `AuthModeMigratedAt` if absent;
- an auth-mode-only PUT invokes system-env reconciliation;
- invalid strings and non-strings return 400 without mutation.

The GET detector uses daemon process environment and excludes all configured admission keys. It must not claim terminal-only visibility; `detectionScope` is always `daemon`.

### 4. Restart and production-root proof

The management activation test starts the real Go server/API owner with an isolated config root, performs PUT Auto, stops it, reloads through the normal migrated config path, starts a second server, and proves Auto remains Auto. A separate fresh-block test PUTs only `enabled` and proves restart does not pin subscription. These tests fail if the sentinel is omitted.

CLI activation drives the actual command-env builder used by `runClaude`; system-env activation drives `ApplyClaudeCodeSystemEnv` and the Darwin install owner rather than testing only the resolver.

## Acceptance criteria

- No user-provided `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, custom base URL, or explicit host-managed flag is overwritten.
- The stale owned marker is never accepted as user-auth evidence.
- Unknown detector state is conservative: subscription marker mode, no dummy token.
- Admission keys and marker mode remain separate axes.
- In the `ocx claude` launch environment, the host-managed assertion is `1`
  exactly when a final token exists unless the user explicitly overrides it;
  the flag is never emitted without a token.
- A simulated settings-source cc-switch/CCR block cannot replace the base URL,
  token, or model of an auto-resolved proxy or admission-key launch.
- Auto-resolved subscription without a host token deliberately carries no host
  assertion; the settings-source hijack residual remains visible and choosing
  proxy mode is the documented escape hatch.
- GET exposes intent and effective fields with the exact JSON names above.
- PUT Auto deletes `authMode`; literal subscription survives; invalid values are rejected atomically.
- Auto and a fresh Claude block survive a stop/reload/start cycle.
- Auth-only PUT reconciles plain-Claude system environment.
- No GUI, usage, guarded-saver internals, Orca, or `gpt-artifacts/` changes.

## Composition and gates

Apply literal packets in dependency order to a clean clone at `ddd968a0`:

```bash
for packet in 061 071 091 101 111; do
  sed -n '/^```diff$/,/^```$/p' "devlog/_plan/260726_260726-go-port-r10/${packet}"*_literal_patch.md \
    | sed '1d;$d' | git apply --check -
  sed -n '/^```diff$/,/^```$/p' "devlog/_plan/260726_260726-go-port-r10/${packet}"*_literal_patch.md \
    | sed '1d;$d' | git apply -
done
```

Then run:

```bash
cd go
gofmt -d internal/claude internal/config internal/cli internal/management
go test ./internal/claude ./internal/config ./internal/cli ./internal/management ./internal/server -count=1
go test -race ./internal/claude ./internal/config ./internal/cli ./internal/management -count=1
go test ./... -count=1 -timeout 120s
go vet ./...
GOOS=windows GOARCH=amd64 go build ./...
GOOS=linux GOARCH=amd64 go build ./...
```

Stop condition: all commands pass from the composed clean clone, every conditional path above has a direct assertion, and `git diff --check` reports no errors.
