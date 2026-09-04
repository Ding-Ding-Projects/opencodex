# R10 post-audit canonical validation receipt

Date: 2026-07-27  
Authoritative branch: `dev2-go`  
Authoritative HEAD: `3abeadd9d503973188607f4c2d7719ef83df5e2c`  
Oracle: `origin/dev@1eb7269f447c913c31e5609dda503da8b623d7ac`

## Audit corrections closed

- Packet `111` now defaults Claude's host-managed assertion for every non-empty
  final `ocx claude` token while preserving an explicit inherited override. Its
  Go tests cover all six auth resolutions, the token/flag invariant, protected
  proxy and admission-key settings merges, and the deliberate unhosted
  subscription residual.
- `000/030/031` now describe unsupported installed hosts as Bun-bridge
  compatibility targets outside the six-platform native promise. The Node suite
  explicitly covers FreeBSD/x64 and Linux/riscv64 selection.
- The final Go verifier ran in a canonical `/Users/jun/.codex/worktrees/...`
  checkout, so the literal goalplan command passed without `-trimpath` or package
  exclusion.
- The fourth rebase and final fetch both resolve `origin/dev` to `1eb7269f`; it is
  an ancestor of `3abeadd9`.

## Final composition

From a clean canonical checkout at `3abeadd9`, every packet passed
`git apply --check` and applied in this order:

```text
061 → 071 → 091 → 101 → 111 → 121 → 123 → 127 → 081 → 011 → 021 → 031 → 041
```

The literal composition contained 117 changed paths before generated GUI
assets. After deterministic full-tree GUI synchronization it contained 123
changed paths. A second clean extraction matched the verified composition
byte-for-byte when generated static assets were excluded. `git diff --check`
passed.

The GUI build produced 46 files. Source and embedded inventories and SHA-256
lists were identical. Manifest digest:

```text
5757e06c8cce47da37b53add1b596dbb642d036a65d8fa63c879d2fc88e85c6b  go/internal/server/static-manifest.json
```

## Exact final gates

Run from `/Users/jun/.codex/worktrees/opencodex-r10-final.vA056u/repo`:

```text
bun run typecheck                                      PASS
bun test --isolate tests                              4741 pass, 0 fail, 23522 assertions
bun run lint:gui                                       PASS
cd gui && bun test tests                              294 pass, 0 fail, 1328 assertions
cd gui && bun run build                                PASS
node --test scripts/ocx-native-launcher.test.mjs       9 pass, 0 fail
bun run privacy:scan                                   PASS

cd go && go test ./... -count=1 -timeout 400s          PASS
cd go && go test -race ./... -count=1 -timeout 400s    PASS
cd go && go vet ./...                                  PASS
cd go && go build ./...                                PASS
GOOS=windows GOARCH=amd64 go build ./cmd/ocx           PASS
GOOS=linux GOARCH=amd64 go build ./cmd/ocx             PASS
git diff --check                                       PASS
```

The earlier `/private/tmp` crash-log alias result is therefore only a disposable
path artifact, not a verifier exception or amended gate. The authoritative
worktree remained docs-only with user-owned `gpt-artifacts/` untouched.

## Remote receipt

```text
origin/dev     1eb7269f447c913c31e5609dda503da8b623d7ac
origin/dev2-go faf51d83a45ebd0bae85203d184239bc576020d3
local HEAD     3abeadd9d503973188607f4c2d7719ef83df5e2c
origin/dev ancestor of HEAD: yes
```

The same `gpt-5.6-sol` medium priority reviewer rechecked the corrected current
tree and returned `VERDICT: PASS` on the second A-phase audit. WP0 may advance
to its docs-only commit; implementation and publication authority are
unchanged.
