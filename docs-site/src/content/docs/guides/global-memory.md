---
title: Global agent memory
description: Safely inspect and synchronize the canonical agent-global-memory repository from ocx.
---

`ocx memory` and `ocx memory-sync` are deliberately different commands.

- `ocx memory` is the existing proxy-process observability command. It reports the runtime's in-memory state through the management API.
- `ocx memory-sync` is a thin, provenance-checked integration with the canonical global-memory repository. It does not copy the canonical payload or skills into the OpenCodex package, and it does not automatically apply project profiles to prompts.

## Canonical repository and provenance

The only accepted global-memory repository is:

```text
https://github.com/Ding-Ding-Projects/agent-global-memory
```

Before a synchronizer script runs, OpenCodex verifies all of the following:

1. The repository is an existing regular directory.
2. Its Git root is exactly the selected directory.
3. `git remote get-url origin` is the canonical URL, with an optional `.git` suffix. Forks, the retired `codingmachineedge` URL, missing remotes, and other origins fail closed.
4. `memory/SHARED_INSTRUCTIONS.md`, `skills/agent-global-memory`, and the platform synchronizer script exist inside the verified repository root.
5. None of the verified files or directories resolves through a symlink, reparse point, or path that escapes the repository.

The repository is resolved in this order:

1. `--repo PATH`.
2. `OPENCODEX_GLOBAL_MEMORY_REPO`.
3. `../agent-global-memory` beside an OpenCodex source checkout.
4. An actionable failure. OpenCodex never clones or downloads a repository automatically.

Do not put credentials, tokens, private instruction payloads, or other secrets in a project profile. Keep sensitive material in the appropriate operating-system credential store or private canonical workflow.

## Synchronization commands

```text
ocx memory-sync status [--repo PATH] [--target all|claude,codex,opencode] [--home PATH]
ocx memory-sync install [--repo PATH] [--target all|claude,codex,opencode] [--home PATH] [--dry-run] [--yes]
ocx memory-sync uninstall [--repo PATH] [--target all|claude,codex,opencode] [--home PATH] [--dry-run] [--yes]
```

Targets are `all`, `claude`, `codex`, and `opencode`. The canonical synchronizer owns target paths and its marker, backup, encoding, ownership, and partial-uninstall behavior. `--home PATH` changes the base home used by the canonical script for default target locations; it does not persist a path in `config.json`. Existing `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR`, and `XDG_CONFIG_HOME` environment overrides remain owned by the canonical synchronizer.

Install and uninstall require `--yes` for non-interactive safety. `--dry-run` is the explicit exception and never writes target files or backups. The adapter launches without a shell:

- Windows: `pwsh -NoProfile -ExecutionPolicy Bypass -File <repo>/scripts/sync-agent-memory.ps1`.
- POSIX: `bash <repo>/scripts/sync-agent-memory.sh`.

The canonical exit contract is preserved:

| Exit code | Meaning |
| ---: | --- |
| `0` | All selected status items are current, or the requested mutation succeeded. |
| `1` | Status found a missing or drifted target, or the canonical script reported a user cancellation. |
| `2` | Provenance, conflict, operational, or synchronizer error. |

Human output includes the verified repository and the canonical synchronizer output. `--json` is available on the command through the normal CLI result path and includes the action, repository, origin, bounded stdout/stderr, parsed target states, and exit code.

## Project-profile inventory

Profiles are passive Markdown references under `memory/projects/*.md`. OpenCodex exposes read-only inventory:

```text
ocx memory-sync profile list [--repo PATH] [--json]
ocx memory-sync profile show <slug> [--repo PATH] [--json]
```

Profile names must match `^[a-z0-9][a-z0-9-]*$`. The adapter rejects traversal, symlinked or reparse-point entries, files outside `memory/projects`, and files larger than 256 KiB. List results are sorted and use schema version `1`:

```json
{
  "schemaVersion": 1,
  "repository": "<verified repository path>",
  "profiles": [{ "slug": "material-bluemap", "path": "memory/projects/material-bluemap.md" }]
}
```

`show` returns the same schema version and repository metadata plus the selected profile's Markdown text. Reading a profile never writes to Claude, Codex, OpenCode, OpenCodex configuration, or any global instruction file. A profile is project-scoped reference material, not an automatic prompt injection mechanism.

## Source checkout versus npm installation

`ocx memory-sync` is available from a source checkout and from the installed CLI. Repository discovery is intentionally filesystem-local in both cases. A source checkout may use the sibling fallback; an npm installation should use `--repo` or `OPENCODEX_GLOBAL_MEMORY_REPO`. Neither path downloads, clones, or silently selects an unknown fork.

## Canonical synchronizer acceptance

The canonical behavior remains tested in the canonical repository and is not duplicated here:

```bash
bash scripts/test-sync-agent-memory.sh
bash scripts/test-project-profiles.mjs
```

On Windows, run the PowerShell acceptance suite with disposable homes:

```powershell
pwsh -NoProfile -File scripts/test-sync-agent-memory.ps1
```

Those tests remain the authority for marker preservation, backups, encoding handling, ownership markers, path safety, and partial uninstall. OpenCodex tests the adapter boundary, provenance checks, process arguments, exit-code preservation, profile containment, and the fact that the adapter itself does not mutate a temporary target home.

## Suggested articles

- [CLI reference](/reference/cli/)
- [Configuration reference](/reference/configuration/)
- [Installation](/getting-started/installation/)
