# 000 — Go port R10: native npm cutover roadmap

Date: 2026-07-26

Baseline:

- branch: `dev2-go`
- HEAD after the fourth 2026-07-26 stale-source rebase: `3abeadd9d503973188607f4c2d7719ef83df5e2c`
- TypeScript oracle: `origin/dev@1eb7269f447c913c31e5609dda503da8b623d7ac`
- ancestry: `git merge-base --is-ancestor origin/dev HEAD` exits 0
- worktree exception: untracked `gpt-artifacts/` is user-owned and excluded

## Objective

Finish the locally implementable Go cutover after the runtime port had reached
strict byte parity and every surviving Go package had reached S3 at `faf51d83`.
The `5078ffc3` oracle added response-state recovery and usage-log scalability;
`9d1bb146` then added Claude auth-auto, guarded runtime config persistence, and
Orca home diagnosis. The later `ea2766a7` oracle made manual Codex account
selection immediate and corrected unknown-quota/failover-threshold semantics.
The final `1eb7269f` oracle locks Claude Code settings-source hijack defense:
the host-managed assertion must track the final launch token and never travel
alone.
Those families are below S1 again and must return to S3 before distribution work.
Then deterministically put all six supported Go binaries in the existing npm
package, make supported CLI invocations select Go without executing Bun, prove
legacy preview users cross the package boundary, and wire the same checksummed
artifacts into the release workflow. No package is published in this loop.

## Loop spec

- Archetype: verifier-defined spec-satisfaction repair.
- Trigger: current dev introduced several unported runtime contracts, and `npm pack`
  still contains no `bin/native/ocx_*`; `bin/ocx.mjs` therefore falls through to
  the bundled Bun runtime.
- Goal: `npm install -g @bitkyc08/opencodex` installs a Go-first package for
  darwin/linux/windows on amd64/arm64, and `ocx update` can use the native
  checksummed release path.
- Non-goals: live npm publish, tag creation, secret access, provider credential
  smoke, signing policy redesign, deleting the Bun/TypeScript source tree, or
  weakening the current TypeScript oracle.
- Verifiers: focused Node launcher/staging tests; real `npm pack --json` inventory;
  isolated install with no Bun on PATH; Go build/vet/test; privacy scan; workflow
  syntax/security audit; current-oracle parity and empty `knownRuntimeDiffs`.
- Stop condition: every local criterion is green on one SHA, or a release/platform
  boundary is evidence-classified as `UNSAFE`/`NEEDS_HUMAN`.
- Memory artifacts: this unit, the bound goalplan, and the PABCD ledger.
- Terminal outcomes: `DONE`, `NOOP`, `BLOCKED`, `UNSAFE`,
  `NEEDS_HUMAN`; context pressure is not a terminal outcome.
- Escalation upward: after two distinct workers fail the same bounded packet, the
  main agent reclaims it. Downward dispatch is allowed only as a P amendment with
  disjoint write scope.
- Tool/credential scope: local filesystem, git, Go/Bun/Node/npm, read-only workflow
  inspection, and tests; no registry credentials or live publish.
- Write scope: `go/**`, `bin/**`, `scripts/**`, `package.json`, `gui/**`,
  `bun.lock`, `.gitignore`; bridge-only
  `src/{update/index.ts,update/job.ts,lib/runtime-entry.ts,service.ts,tray/windows.ts,codex/shim.ts}`;
  named `tests/**`, README/CONTRIBUTING/contributing and structure docs; focused workflow files
  in the audited release phase; this unit. No other TS behavior is authorized.
- Bounds: user supplied no token or wall-clock cap. Each wait stays at or below
  120 seconds and repeated same-failure repairs trigger replan.

## Necessity gate

- Do nothing: rejected because the package has no native artifacts.
- Delete: duplicate S1 packages were already deleted; no remaining production
  package can be removed to solve distribution.
- Configure only: rejected because `files: ["bin", ...]` is already broad enough;
  the missing work is artifact production and a fail-closed launcher.
- Reuse: selected. Extend `scripts/build-go-release.go`,
  `bin/native-runtime.mjs`, `bin/ocx.mjs`, and existing update resolvers instead
  of introducing a second release format or updater.

## Dependency-ordered work phases

| WP | Decade doc | Outcome | Depends on |
| --- | --- | --- | --- |
| 0 | this plan + `001`–`008` | docs-only current-dev roadmap lock | current tree |
| state | `060_response_state_recovery.md` + `061_response_state_literal_patch.md` | canonical temp writing, bounded recovery, production activation | WP0 |
| usage snapshot | `070_usage_snapshot.md` + `071_usage_snapshot_literal_patch.md` | exact revision snapshots and same-revision in-flight sharing | state |
| Claude core | `090_claude_auth_core.md` + `091_claude_auth_core_literal_patch.md` | detector, resolver, schema, and migration | usage snapshot |
| config persistence | `100_config_persistence.md` + `101_config_persistence_literal_patch.md` | shared guarded saver, all live writers, durable 429 rotation | Claude core |
| Claude activation | `110_claude_auth_activation.md` + `111_claude_auth_activation_literal_patch.md` | CLI/system-env/management production activation | config persistence |
| Orca home | `120_orca_home_diagnostics.md` + `121_orca_home_literal_patch.md` | redacted Windows mismatch diagnosis and sync guidance | Claude activation |
| Codex routing production | `122_codex_routing_production.md` + `123_codex_routing_production_literal_patch.md` | activate the canonical Codex router/auth resolver in the real OpenAI request path | Orca home |
| Codex manual selection | `126_codex_manual_selection.md` + `127_codex_manual_selection_literal_patch.md` | immediate manual account choice, threshold-correct failover, and stable hard cooldown | Codex routing production |
| usage summary | `080_usage_summary_gui.md` + `081_usage_summary_gui_literal_patch.md` | compact API cache, stable failure DTO, current embedded GUI | Codex manual selection |
| 1 | `010_native_package_staging.md` + `011_wp1_literal_patch.md` | deterministic six-binary staging and pack inventory | usage summary |
| 2 | `020_update_transition.md` + `021_wp2_literal_patch.md` | legacy npm/Bun installs cross to Go and rebake durable paths | WP1 |
| 3 | `030_go_only_launcher.md` + `031_wp3_literal_patch.md` | supported targets run Go; dormant Bun remains only as legacy bridge | WP2 |
| 4 | `040_release_workflow.md` + `041_wp4_literal_patch.md` | audited workflow builds and attaches the exact package artifacts | WP3 |
| 5 | `050_convergence_verdict.md` | latest-dev rebase, full gates, corrected scorecard, push receipt | WP4 |

One row is one complete P→A→B→C→D cycle. WP0 is docs-only; implementation begins
with the state phase. Each later P revalidates its decade doc against the then-current tree.
The `*1_literal_patch.md` files are part of their owning decade, not extra
work-phases; they hold copy-paste-executable hunks separated from rationale.

## Acceptance criteria

1. Go emits canonical response-state temp names and production lazy loading
   reclaims only old, regular, definitely dead-writer residuals within strict caps.
2. Go reads one exact regular-file usage revision, shares only same-revision
   in-flight work, and detects replacement, truncation, and short reads.
3. `/api/usage` retains only compact revision-keyed DTOs, expires at range/day
   boundaries, returns the stable read-failure response, and serves the current
   independently polled embedded GUI.
4. Claude auth detection is three-valued and conservative; auto/manual intent,
   migration sentinel, own-token filtering, and bounded keychain metadata probes
   round-trip across Go and TS.
5. Every native long-lived config writer shares one guarded persistence owner;
   disk-only Claude edits survive, runtime conflicts win, and 429 key rotation is
   durable across restart.
6. `ocx claude`, plain-Claude system environment, and `/api/claude-code` consume
   one resolver and expose the full effective-mode contract without marker feedback.
7. Windows Orca home mismatches are narrowly detected, path-redacted, and reported
   with executable Command Prompt and PowerShell recovery commands.
8. The real OpenAI Codex request path consumes the canonical `codex.Router` and
   `codex.AuthResolver`; generic OAuth behavior remains unchanged for every other
   provider, and quota/affinity/outcome state is no longer test-only.
9. Manual Codex account selection takes effect on the next request by clearing
   affinity and transient routing evidence while preserving a real 429 cooldown;
   unknown quota does not override an explicit choice, and transient avoidance
   activates only at the configured failover threshold.
10. Native staging emits exactly six version-matched binaries and one checksum
   manifest, with stale artifacts excluded and generated files uncommitted.
11. Existing TS/Bun updater processes finish replacement by reinstalling services,
   tray state, and shims through the new Node launcher → Go path; no durable startup
   path on the six supported targets still executes the obsolete package-local
   Bun runtime.
12. The packed CLI launches Go without executing Bun; missing, non-executable, or
   stale native artifacts on a supported target fail clearly instead of silently
   running TS. Unsupported installed or source-development targets retain the
   explicit Bun bridge fallback documented and tested in `030/031`; they are
   outside the six-platform native release promise.
13. The first bridge preview retains the package-local Bun dependency solely so
   pre-bridge updater/service recovery cannot lose its executable mid-repair. Tests
   prove Bun is dormant on the supported Go path. Removing it requires bridge
   adoption or a major-cutover receipt and is not falsely claimed by R10.
14. Existing npm and Bun global updater commands can install the new package;
   the installed Go CLI's direct update path verifies a trusted SHA-256 asset.
15. Release CI uses pinned actions, the Go version from `go/go.mod`, exact version
   matching, and attaches the same six binaries plus checksum manifest. No live
   publication is performed during implementation.
16. Current Go gates, privacy scan, strict parity guards, npm pack/install smoke,
   workflow audit, origin/dev ancestry, and origin/dev2-go SHA parity pass.

## Source-of-truth sync

WP5 updates:

- `devlog/_plan/260726_260726-go-port-r8/095_reachability_dashboard.md`
- `devlog/_plan/260726_260726-go-port-r8/100_final_port_verdict.md`
- `devlog/_plan/260726_260726-native-go-npm-distribution/000_plan.md`

The first two are stale after the three S1 packages were deleted and CLI/usage
activation landed. Their current 33-package denominators must become the surviving
30-package inventory, all S3, without inflating unmeasured live-provider coverage.

The chosen launcher remains a small Node script, so Node is still required on each
`ocx` invocation. The cutover removes Bun from the steady-state runtime; it does
not claim a Node-free npm bootstrap or an immediate removal of the dormant bridge
dependency from package metadata.
