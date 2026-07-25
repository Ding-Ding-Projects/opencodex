# 070_final_proof — Final gates + archive

## Objective

Prove final `dev2-go` tip and archive the loop unit.

## Files

### MOVE

| From | To | Before | After |
|---|---|---|---|
| `devlog/_plan/260725_dev2_go_dev_delta/` | `devlog/_fin/260725_dev2_go_dev_delta/` | unit under `_plan` | unit under `_fin` after D |

### MODIFY

| Path | Before | After |
|---|---|---|
| `.codexclaw/goalplans/dev2-go-go-dev-delta-ts-6-go-types-config-probe/goalplan.json` | residual criteria open | criteria met with non-empty capturedEvidence |

## Copy-executable checklist

```bash
cd /Users/jun/.codex/worktrees/6cce/opencodex
git status --short --branch
FINAL=$(git rev-parse HEAD)
git merge-base --is-ancestor dev HEAD
cd go && go build ./... && go vet ./... && go test ./... -count=1 -timeout 120s && go test -race ./internal/server ./internal/service ./internal/adapter/cursor ./internal/types ./internal/config ./internal/providers -count=1 -timeout 180s && cd ..
git add -f devlog/_plan/260725_dev2_go_dev_delta
git mv devlog/_plan/260725_dev2_go_dev_delta devlog/_fin/260725_dev2_go_dev_delta
```

## Accept

- ancestry true
- local gates green (build, vet, test, race on changed packages)
- residuals honest (probe lease, compaction gate deferred with evidence)
- archive path exists under `_fin`
- goalplan criteria capturedEvidence non-empty
