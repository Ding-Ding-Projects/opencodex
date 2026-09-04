# R10 second current-dev stale check

## Trigger and receipt

After the seven literal packets composed and passed focused tests on `bfe1e842`,
`origin/dev` advanced from `5078ffc3` to `9d1bb146`. WP0 stayed in P and rebased
the 284 Go-track commits again without conflict.

- prior Go-track HEAD: `bfe1e84255ccad7cfb58693c581036080ab664b6`
- new oracle: `9d1bb14606161000af63cc2cb7ea82242c639de8`
- rebased Go-track HEAD: `ddd968a0169e4c190bf1037e78a824c6780568e9`
- incoming commits: 27
- conflicts: none
- current-dev ancestry: pass
- `gpt-artifacts/`: untouched

## Incoming behavior

The new oracle adds three-state Claude auth mode (`auto`, `api_key`,
`subscription`), auth-presence detection and migration, effective-mode GUI/API
reporting, launch-time environment resolution, request-writer config-save
hardening, and guarded Codex/config mutation. It also changes the GUI bundle that
`081` must build and embed.

Two independent read-only Sol medium priority audits classified the Claude auth
family and guarded-save family against Go production roots. The goalplan now
adds four bounded phases before the final GUI build:

- `wp-claude-auth-core`: three-valued detector, conservative resolver,
  own-token filtering, schema, and migration sentinel;
- `wp-config-persistence`: one eagerly armed, mutex-protected persistence owner
  for every long-lived writer plus durable request-path API-key rotation;
- `wp-claude-activation`: shared CLI/system-env resolution and the full
  three-state management contract;
- `wp-orca-home`: separate Windows-only high-confidence home diagnosis.

Go already satisfies complete-file atomic replacement, torn-write prevention,
management-route serialization, and unknown-field preservation. Those are not
reimplemented. They do not rebut the genuine stale whole-config overwrite: the
new shared owner must span management, Claude Desktop background saves, Codex
account runtime writes, selected-port persistence, and request-path 429 rotation.

The additional estimate is 700–1,050 production Go lines and 850–1,250 tests for
Claude auth-auto, plus roughly 150–250 production lines for the shared persistence
owner and a smaller independent Orca diagnostic slice.

## Existing packet compatibility

On `ddd968a0`, the complete hand-authored sequence still applies cleanly in order:

`061 → 071 → 081 → 011 → 021 → 031 → 041`

The sequence remains provisional until the new Claude/config audits finish and
the latest GUI source is rebuilt through the `081` full-tree sync packet.
