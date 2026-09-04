# R10 A-phase failure and fourth current-dev replan

Date: 2026-07-27

## Independent audit result

The first formal A-phase reviewer (`gpt-5.6-sol`, medium, priority) returned
`VERDICT: FAIL` with four findings:

1. `110/111` limited Claude's host-managed assertion to opencodex-owned tokens,
   while the TypeScript launch owner defaults it for every non-empty final
   `ANTHROPIC_AUTH_TOKEN` and preserves an explicit user override.
2. `origin/dev` advanced during audit from `2d5d4916` to `1eb7269f`.
3. `000/030/031` described unsupported-target Bun fallback as source-fixture
   behavior even though unsupported installed hosts also enter the bridge.
4. `009_2` recorded a split temporary-path Go gate without formally matching or
   amending the goalplan's exact `go test ./...` verifier.

The FSM returned A→P before any WP0 commit.

## Fourth rebase receipt

- previous HEAD: `244ca5ed95f9cb0d2f7f7b3b511b98d425fb4668`
- new oracle: `1eb7269f447c913c31e5609dda503da8b623d7ac`
- rebased HEAD: `3abeadd9d503973188607f4c2d7719ef83df5e2c`
- incoming commit: `1eb7269f test(claude): prove the settings.json hijack defence per auth resolution`
- conflicts: none
- `git merge-base --is-ancestor origin/dev HEAD`: exit 0
- `gpt-artifacts/`: untouched

The incoming commit changes only `tests/claude-auth-mode.test.ts`, but it locks a
security-relevant behavior already present in `src/cli/claude.ts`: after final
token resolution, the host-managed flag defaults to `1` exactly when a token is
present. The paired invariant prevents the flag from logging out a subscription
when no host token exists; the settings-merge model proves the flag strips a
competing cc-switch/CCR provider block.

## Replan

- Regenerate packet `111` so `buildClaudeLaunchEnv` defaults the flag for every
  non-empty final token, preserves an explicit inherited value, ports the
  six-resolution token/flag invariant, and proves settings-source hijack
  resistance.
- Keep plain system-environment ownership narrow: it may reconcile only values
  opencodex actually writes. This does not weaken the `ocx claude` launch
  contract locked by `1eb7269f`.
- Document unsupported installed targets as Bun-bridge compatibility targets
  outside the six-platform native promise; add explicit FreeBSD/x64 and
  Linux/riscv64 selection assertions.
- Run the final composition from a canonical `/Users/...` checkout and record
  the literal `go test ./... -count=1 -timeout 400s` command. The temporary-path
  crash-log alias is not accepted as a permanent verifier substitution.
- Re-run the complete literal sequence, repository gates, and the same
  independent reviewer before returning to B.
