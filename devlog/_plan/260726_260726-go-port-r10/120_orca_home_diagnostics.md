# WP0 — Windows Orca CODEX_HOME diagnostics

Base: `ddd968a0`

## Boundary

This packet ports only the Windows Orca `CODEX_HOME` diagnosis already owned by the TypeScript runtime. It is independent of Claude auth-auto and guarded config persistence. Production code is not changed in WP0; [121_orca_home_literal_patch.md](./121_orca_home_literal_patch.md) is the apply-ready implementation packet.

## TypeScript source of truth

- `src/codex/home.ts`: `collectOrcaCodexHomeDiagnostic` defines applicability, mismatch, Windows normalization, home redaction, warning text, and recovery commands.
- `src/codex/sync.ts`: both the external-provider-preservation branch and normal catalog-injection branch report the effective target and warning.
- `src/cli/status.ts` plus `src/cli/index.ts`: status JSON carries `codexHome`; text status prints the effective home and action.
- `src/cli/doctor.ts`: doctor renders a dedicated Codex app home-targeting section.

No additional management, service, Claude, or config-save surface belongs in this packet.

## Current Go gap

`go/internal/codex/home.go` resolves `CODEX_HOME` but has no Orca-specific diagnostic. `runSync` reports only a model count, status omits the target home, and doctor has no Orca mismatch section. A host-platform `filepath.Abs` call also makes injected `GOOS=windows` drive paths nondeterministic in non-Windows tests.

## Locked contract

Applicability is true only when all conditions hold:

1. effective platform is Windows;
2. explicit `CODEX_HOME` is non-empty;
3. `ORCA_CODEX_HOME` is non-empty;
4. normalized effective home equals normalized Orca home;
5. normalized Orca home ends in the exact `\orca\codex-runtime-home\home` shape.

Normalization trims whitespace/trailing separators, converts slash direction, and compares case-insensitively. Mismatch additionally requires the effective home to differ from `%USERPROFILE%\.codex`.

Returned display paths redact the user-home prefix to `~`. Warning and action text must not expose the profile name. Recovery text contains executable Command Prompt and PowerShell forms, including service uninstall/reinstall ordering.

## Ownership and activation

- `go/internal/codex/home.go`: pure diagnosis and deterministic Windows path handling.
- `go/internal/cli/sync.go`: one post-injection reporter. Because Go's injection owner returns both normal-injection and external-provider-preserved outcomes through the same call site, this placement covers both logical sync branches.
- `go/internal/cli/status.go`: `codexHome` JSON plus text target/warning/action.
- `go/internal/cli/doctor.go` and `doctor_checks.go`: structured report field and text section.
- Tests: pure positive/negative matrix, redaction and command assertions, both sync outcomes, doctor activation.

## Patch inventory

The literal patch modifies eight files and contains 14 unified-diff hunks:

- `go/internal/codex/home.go`
- `go/internal/codex/codex_test.go`
- `go/internal/cli/sync.go`
- `go/internal/cli/orca_home_test.go` (new)
- `go/internal/cli/status.go`
- `go/internal/cli/doctor.go`
- `go/internal/cli/doctor_checks.go`
- `go/internal/cli/doctor_test.go`

## Validation receipt

Applied independently to a clean archive of `ddd968a0`, then formatted and tested:

```text
gofmt -w [8 scoped Go files]
go test ./internal/codex -run 'TestHomeDiscovery|TestCollectOrcaCodexHomeDiagnostic' -count=1
ok github.com/lidge-jun/opencodex-go/internal/codex

go test ./internal/cli -run 'TestReportCodexHomeTargetCoversSyncOutcomes|TestDoctorReportsOrcaCodexHomeWithoutLeakingUserPath' -count=1
ok github.com/lidge-jun/opencodex-go/internal/cli

GOOS=windows GOARCH=amd64 go test -c ./internal/codex
GOOS=windows GOARCH=amd64 go test -c ./internal/cli
GOOS=windows GOARCH=amd64 go build ./...
PASS
```

The unscoped `./internal/cli` run in the disposable `/var/folders` archive also reached an existing crash-log redaction assertion whose stack uses the canonical `/private/var` alias. That baseline path-alias failure is unrelated to this packet; scoped CLI tests and Windows compile are green.

## Apply order

Apply [121_orca_home_literal_patch.md](./121_orca_home_literal_patch.md) once against `ddd968a0`, run `gofmt` on the eight listed files, then run the validation commands above. The full current-base sequence is revalidated in `009_2_full_roadmap_validation.md`.
