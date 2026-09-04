# 094 — Go CLI/config/OAuth/update final assessment

Date: 2026-07-26

Branch: `dev2-go`

Review base: `53756bcc` plus this final hardening patch

## Verdict

The Go CLI track is implementation-complete for the public TypeScript command
surface, persistent configuration schema, OAuth/account lifecycle, native
update planning, and production server composition owned by the CLI package.
It is suitable for a native preview after the release workflow proposal in
`091_native_release_plan.md` is reviewed and applied.

This verdict does not mean the release is already native. Public stable/preview
releases still need the six binaries and checksum manifest attached, npm still
needs the matching `bin/native/` files, and production signing plus native OS
execution remain release gates.

## Scope reviewed

- `go/internal/cli/**` and `go/cmd/**`: command dispatch, help/completion,
  provider/model/account/config commands, lifecycle/service/tray, OAuth login,
  server factories, management backends, and built-binary scenarios.
- `go/internal/config/**`: schema/defaults, validation, migration, repair,
  environment references, atomic persistence, backward/forward compatibility,
  custom models, account/key pools, and redaction.
- `go/internal/oauth/**`: provider flows, device/browser callbacks, account
  store, cross-process refresh, refresh-intent replay protection, Kiro import,
  aliases, and token guardian.
- `go/internal/update/**` plus CLI update composition: channel resolution,
  trusted artifact selection, manifest parsing, download/replace planning,
  job persistence, restart/reclaim integration, and dry-run behavior.
- Native packaging support in `bin/**` and `scripts/build-go-release.go`.

## Verification matrix

| Surface | Evidence | Assessment |
|---|---|---|
| Command registration | `TestCommandRegistrationTableIsUniqueAndComplete`, `TestHelpAndRegistrationCoverTypeScriptPublicCommands`, and the flag manifest cover every TS public command plus compatibility aliases | Complete |
| Help/completion/exit streams | Help derives from the registration table; bash/zsh/fish/PowerShell completion and unknown-command stdout/stderr/exit parity are tested | Complete |
| Built binary | Isolated-home tests execute status, doctor, provider/models/config, serve/stop, provider mutation, multi-provider routing, Codex shim sync/restore/back, account/combo failover, corrupt config recovery, disk/port failures, and standalone no-Bun operation | Complete for deterministic local scenarios |
| Config schema | Reflection manifest covers TS top-level/provider fields; full extended round trip includes model adapters, reasoning policies, custom models, key pools, OAuth accounts, sidecars, Cursor execution, and MiniMax reasoning split | Complete for current schema |
| Config compatibility | Legacy minimal files, missing defaults, invalid stream mode repair, wrong-type passthrough, UTF-8 BOM, explicit zero, environment references, OpenAI tier migration/backup, orphaned custom models, and unknown future top/provider fields survive load/save | Complete |
| Config persistence safety | Same-directory atomic temp+rename, `0600` files and `0700` directories on Unix, concurrent writer tests, protected migration backup, resolved secrets never persisted | Complete |
| OAuth/account state | Device/browser flows, callback validation, account pools, aliases, active selection, refresh generation races, persistent refresh intent, Kiro SQLite import, logout and restart restoration are tested | Complete without live third-party credentials |
| Management injection | OAuth, Codex auth, provider quota, Claude runtime, runtime control, shared model cache, live resolver, liveness and runtime-port readers are injected by `serve` and mutation-tested | Complete |
| Reset credits | Expanded consume contract returns `remaining` only from a fresh WHAM payload containing `available_count`; omission/failure cannot invent zero | Complete |
| Adapter factories | Provider-aware OpenAI/Anthropic/MiMo/Google/Cursor constructors and retry/native policies, pool auth, headers, per-model wire override, MiniMax reasoning split, and default provider are factory/request tested | Complete in CLI composition |
| Native updater | Latest/preview resolver, exact target names, trusted GitHub host/path, duplicate/missing asset rejection, checksum parsing, dry-run nonreplacement, atomic replacement and restart planning are tested | Complete; publication pending |
| Distribution matrix | darwin/linux/windows on amd64/arm64 cross-build successfully; all six locally rehearsed checksums verify | Build-complete, not equivalent to native OS execution |

## Configuration compatibility conclusion

Existing user configuration is safe to load under the reviewed Go schema:

1. Newly added fields are optional and absent fields retain TS-compatible
   defaults or zero/nil semantics.
2. Invalid syntax still follows protected backup-and-default recovery; repairable
   missing defaults retain user providers and pool accounts.
3. UTF-8 BOM files are accepted like TypeScript and become canonical JSON only
   after an explicit save.
4. Unknown top-level and provider fields are retained as raw JSON across
   `config set`/save, preventing downgrade or mixed-version data loss.
5. Unknown fields shown by `ocx config show` pass through recursive secret-key
   and token-value redaction.
6. Environment references remain unresolved in persistent state; only a
   runtime copy receives secret values.
7. The OpenAI tier migration remains snapshot-backed and refuses to overwrite
   a differing rollback backup.

## Security and privacy review

- OAuth management DTOs cannot represent access tokens, refresh tokens, API
  keys, or physical upstream account IDs.
- Credential and refresh-intent files use protected atomic writes; refresh
  intent prevents replay of a possibly consumed rotating grant.
- Diagnostic/config output redacts known and forward-compatible secret fields.
- Provider headers are validated against sensitive names and CR/LF injection.
- Native updates require HTTPS, an allowlisted GitHub release path, exact asset
  naming, and a SHA-256 digest from the versioned manifest before replacement.
- No test uses or mutates the user's real home; command and serve scenarios use
  `t.TempDir()` and controlled local upstreams.

## Remaining work outside the CLI track

These are explicit release/integration gates, not hidden CLI implementation
gaps:

1. Apply the reviewed `.github/workflows/release.yml` proposal from 091. The
   workflow is a maintainer security boundary and was intentionally not edited.
2. Sign/notarize final macOS artifacts and apply the Windows signing policy;
   regenerate checksums after those byte mutations.
3. Execute service, tray, ACL, launcher, and update replacement on real Windows
   amd64/arm64 runners. Cross-compilation alone does not prove those behaviors.
4. Attach six native binaries and one checksum manifest to preview, package the
   corresponding `bin/native/` files, and run the operator cutover/rollback
   checklist before stable promotion.
5. Decide when preview soak is sufficient to remove the Node/Bun compatibility
   fallback from npm. The standalone Go binary itself does not require either.
6. GUI static assets remain a distribution input. The native proxy can operate
   without the GUI, but dashboard delivery requires packaged `gui/dist` unless
   a future build embeds it.
7. Live third-party provider/OAuth contract tests require maintainer-controlled
   credentials and were deliberately replaced here with deterministic local
   protocol fixtures. No credential should be added to CI to close this item.
8. The differential harness still declares two API-access host/origin response
   differences. They are server/API-access ownership, not CLI/config/OAuth/update
   differences.

The native Unix Codex shim remains an intentional distribution difference: it
executes native `ocx ensure`; reproducing the TS bytes would restore a Bun
dependency and is therefore not a parity objective.

## Final gate

Required before the final commit:

```bash
cd go
go build ./...
go vet ./...
go test ./... -count=1 -timeout 300s
```

Additional final-track checks:

```bash
go test -race ./internal/cli ./internal/config ./internal/oauth ./internal/update -count=1 -timeout 300s
node --test scripts/ocx-native-launcher.test.mjs
```

The exact command outputs and final commit are recorded in the round handoff.
