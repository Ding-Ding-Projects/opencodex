# WP12 — Windows Orca CODEX_HOME diagnostics

Date: 2026-07-27  
Base: `167c9b60351af2d7b66cb27d95bf60ee81be809c`  
Class: C3 (privacy-sensitive diagnostics and public CLI JSON)

## Outcome

Port the Windows Orca `CODEX_HOME` mismatch diagnosis already owned by the
TypeScript runtime. The Go runtime must detect only the high-confidence Orca
shape, mask Windows and POSIX usernames with the shared redactor, preserve
nullable JSON fields, print executable recovery commands, and report the target
home from real sync, status, and doctor entry points.

The sync path must also match the TypeScript oracle's early external-provider
branch: detect and preserve a selected non-OpenAI provider before fetching or
materializing the OpenCodex catalog.

## TypeScript source of truth

- `src/codex/home.ts`: applicability, mismatch, Windows normalization, public
  JSON shape, warning, and recovery command text.
- `src/lib/redact.ts`: global `C:\Users\<name>`, `/Users/<name>`, and
  `/home/<name>` masking plus sensitive-segment and secret redaction.
- `src/codex/sync.ts`: external-provider preservation exits before catalog
  refresh; both that branch and normal injection report the target home.
- `src/cli/status.ts` and `src/cli/doctor.ts`: structured `codexHome` output and
  human-readable warning/action surfaces.

No management, service, Claude, release, GUI, or `gpt-artifacts/` change belongs
in this phase.

## Locked contract

Applicability is true only when all conditions hold:

1. effective platform is Windows;
2. explicit `CODEX_HOME` is non-empty;
3. `ORCA_CODEX_HOME` is non-empty;
4. normalized effective home equals normalized Orca home;
5. normalized Orca home ends at the exact
   `\orca\codex-runtime-home\home` component shape.

Normalization trims whitespace and trailing separators, accepts slash variants,
and compares case-insensitively. Mismatch additionally requires the effective
home to differ from `%USERPROFILE%\.codex`.

All displayed paths use `internal/lib.RedactUserPath`, including when the
process account differs from the profile in `CODEX_HOME`. Windows slash variants
are first normalized to native backslashes so the shared Windows-profile
redactor cannot be bypassed; Unix separators remain untouched. This masks
arbitrary Windows/POSIX profile names and secret-shaped segments.
`orcaCodexHome`, `warning`, and `action` remain present as JSON `null` when
inactive, matching the TypeScript contract.

Recovery text contains executable Command Prompt and PowerShell forms and keeps
service uninstall/reinstall ordering explicit.

## Production activation

- `go/internal/codex/home.go`: deterministic Windows path handling and pure
  classification using the shared redactor.
- `go/internal/cli/sync.go`: inspect the effective Codex config before model
  fetch. A selected external provider is passed through the real injector,
  reported, and returned without `/api/models`, catalog, or cache mutation.
  Normal injection reports through the same production call site.
- `go/internal/cli/status.go`: human output plus versioned status JSON.
- `go/internal/cli/doctor.go` and `doctor_checks.go`: structured report field
  and dedicated text section.

Production-root tests start a real identity-bearing health/model HTTP fixture,
write the actual runtime-port/config files, and call `runSync`. They prove one
normal model fetch and zero external-provider fetches/catalog writes. Separate
tests call real status JSON, serialize doctor JSON, and exercise Windows doctor
collection.

## First audit and fixes

The first `gpt-5.6-sol` medium-priority A audit returned `VERDICT: FAIL` and the
packet was replanned. The corrected packet closes every verified finding:

- replaces home-relative masking with the existing global Go redactor;
- replaces label-only sync tests with real normal/external production paths;
- uses pointer fields so inactive JSON values serialize as explicit `null`;
- preserves Unix separators by removing Windows-only display rewriting;
- refreshes the packet base and validation evidence to this lineage.

## Patch inventory

`121_orca_home_literal_patch.md` is the exact 18-hunk diff across eight files:

- `go/internal/codex/home.go`
- `go/internal/codex/codex_test.go`
- `go/internal/cli/sync.go`
- `go/internal/cli/orca_home_test.go` (new)
- `go/internal/cli/status.go`
- `go/internal/cli/doctor.go`
- `go/internal/cli/doctor_checks.go`
- `go/internal/cli/doctor_test.go`

The audited candidate is 428 insertions and 16 deletions.

## Gates

```bash
cd go
gofmt -d internal/codex/home.go internal/codex/codex_test.go \
  internal/cli/sync.go internal/cli/orca_home_test.go \
  internal/cli/status.go internal/cli/doctor.go \
  internal/cli/doctor_checks.go internal/cli/doctor_test.go
go test ./internal/codex ./internal/cli -count=1
go test -race ./internal/codex ./internal/cli \
  -run 'TestCollectOrca|TestReportCodex|TestRunSyncProduction|TestStatusJSONKeeps|TestDoctorReports' \
  -count=10
go test ./... -count=1 -timeout 400s
go test -race ./... -count=1 -timeout 600s
go vet ./...
GOOS=windows GOARCH=amd64 go build ./...
GOOS=linux GOARCH=amd64 go build ./...
```

Before D, re-fetch `origin/dev`, keep it as an ancestor, rebase if necessary,
and regenerate this packet against the final parent. Stop only after the exact
packet applies to a clean clone, source `git diff --check` passes, the
independent re-audit says PASS, and all gates above are green.
