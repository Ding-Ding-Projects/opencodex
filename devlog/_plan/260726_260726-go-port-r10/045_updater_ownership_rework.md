# 045 — Packaged updater ownership rework (deferred work-phase)

## Status: NOT STARTED. Requirements only.

This document is not an approved implementation plan. It is the accumulated requirement
set from four C4 audit rounds, preserved so the next work-phase starts from evidence
instead of rediscovering it. The release-gate half of the original WP4 repair scope was
split out to [044_wp4_release_gates.md](./044_wp4_release_gates.md) and is the current
work unit; this one gets its own P/A/B/C cycle afterwards.

Both round-4 auditors independently judged the combined scope too large for a single
work-phase, and one named the split explicitly: updater handoff/install/restart;
locking, recovery, and process identity; dry-run behavior; release and embedded-GUI
gates. The last two are in 044. The first two are here.

Implementing this requires updating two governing invariants that currently mandate the
present design: `structure/06_docs-and-release.md:101` (the update supervisor copies the
validated Bun executable outside the package before launch, listed among the bounded Bun
exceptions beginning at line 99) and `structure/01_runtime.md:42` (the retained-but-dormant
`bun` dependency existing for an older updater to install the transition package). Those
edits are part of this work-phase, not a side effect.

All file:line citations in this document were refreshed against HEAD `066e84b9`. Refresh
them again at the next P before treating them as authoritative, since `origin/dev` moves
frequently.

## Original trigger and scope

Two independent GPT-5.6 Sol medium/priority C4 audits rejected the WP4 candidate at
`b4ebd346`. Each returned one release-blocking finding plus supporting mediums. The
stale check then moved `origin/dev` again from `75f9fe5a5` to `703c6191` (Kiro
retryability fixes plus the freeform issue-quality template gate), so the candidate was
rebased onto `703c6191`. The rebased tree is `08015fd1`; this plan document itself is
`6d5a67af`, which is the anchor the implementation and the next audit must use.

Two further audit rounds on this document returned FAIL. Round 2 showed the dry-run
repair was scoped too narrowly, the worker claim was not cross-process atomic, and the
GUI embed guard did not guard anything in CI. Round 3 showed something more important:
every remaining blocker was a restatement of one structural fact, so patching them
individually could not converge.

### The structural finding, and the design change it points to

`update-job.json` currently has three independent writers: Go
(`go/internal/update/job.go`), the Node launcher (`bin/ocx.mjs:79`), and the Bun worker
(`src/update/job.ts:125`). Each performs its own unlocked read-modify-write. Round 3
established that no amount of nonce, generation counter, or lease discipline fixes this,
because Node and Bun cannot take the Go file lock: neither runtime exposes `flock`
without a new native dependency, and `package.json` has none. A generation check that is
not serialized by the same lock is not a compare-and-swap. Both auditors reached this
independently, and both then derived the same downstream blockers: the claim tracks the
Node supervisor rather than the Bun process that actually mutates the package, a live
worker with an expired lease becomes permanently unrecoverable, and re-validating the
launcher path before `exec` still leaves a window before the OS opens the file.

Rather than add a fourth mechanism to a three-writer design, the candidate direction is
to remove the writers. The packaged Go binary already owns every capability the Bun
worker was retained for:

- integrity pre-flight, tray handoff, tray refresh, and tray restore-on-failure
  (`go/internal/update/job.go:330-372`, `LifecycleDependencies` at
  `go/internal/update/planning.go:84`)
- service reinstall arguments and direct-start fallback
  (`go/internal/cli/runtime_management.go:495`, `service.ServiceReinstallArgs`)
- port reclaim before restart (`go/internal/update/job.go:423`)
- old-PID and target-version restart correlation
  (`CorrelateRestartIdentity`, `go/internal/update/planning.go:117`)
- detached process creation on both families
  (`update_worker_process_unix.go:11` uses `Setsid`;
  `update_worker_process_windows.go:15` uses `CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS`)

So the candidate direction is a packaged update worker that is a second, detached
invocation of the **same Go binary**, copied out of the package first so the original can
be replaced underneath it.

Round 4 audited that direction and returned FAIL on both tracks, with findings that are
requirements for whoever implements it rather than reasons to abandon it. They are
recorded in "Round-4 requirements" below. In particular, the round-3 sketch's claim that
Node keeps npm replacement while Go also runs `InstallCommand` is self-contradictory and
must be resolved to one owner before any code is written.

## Round-4 requirements (must be satisfied by any implementation)

**Ownership must be singular and explicit.** The plan cannot say Node keeps npm
replacement (`bin/ocx.mjs:288-435` performs stop, tray, service reinstall, restart, and
exit — not a package-only operation) while the Go worker also calls `InstallCommand`.
Direct Go execution is additionally invalid on Windows as written:
`go/internal/update/job.go:75-107` builds `npm.cmd` and runs it through `exec.CommandContext`
without a shell, while the launcher already documents and handles the required shell
invocation at `bin/ocx.mjs:271`. Either Go becomes the sole job and lifecycle writer with an
OS-safe npm invocation, or Node keeps a package-only internal command that returns to Go and
never touches lifecycle or job state.

**The CLI update path must take the same lock.** Routing only the GUI worker through the
claim leaves `bin/ocx.mjs:267` and `bin/ocx.mjs:376` mutating the package outside it, so
a CLI update can still overlap a GUI worker despite perfect job-state transitions.

**The serving process must be stopped before replacement.** `go/internal/update/job.go:325`
goes from tray preparation straight to installation; port reclaim happens only afterwards
at `go/internal/update/job.go:423`. On Windows the original package-local executable stays
locked and `npm install -g` can still fail. A pre-install stage must stop the service or
proxy and prove the serving PID and port are gone.

**Lifecycle state cannot be rebuilt inside the copy.** Outside `bin/native`,
`processRuntimeCommand` returns the copied executable with no launcher
(`go/internal/cli/runtime_command.go:48`), so `productionUpdateLifecycle` would record the
disposable copy as `RuntimeExecutable`, an empty launcher, and the worker's own PID as
`OldPID` (`go/internal/cli/runtime_management.go:558`). Restart planning would then start
the disposable worker and correlate against the wrong PID
(`go/internal/update/planning.go:182`). The serving PID, host/port, service arguments,
package root, and stable Node/launcher identity must be persisted before detachment, and
the restart must go through the newly installed package launcher.

**Legacy coexistence is real, not hypothetical.** Both stores use
`<config-dir>/update-job.json` (`src/update/job.ts:116`,
`go/internal/cli/runtime_management.go:441`) and both derive the same caller-controlled
`OPENCODEX_HOME` (`go/internal/cli/provider.go:33`, `src/config.ts:315`). During the
TypeScript-to-Go transition the old Bun worker installs the new package, starts and probes
the replacement runtime, and only then writes terminal status
(`src/update/job.ts:818-857`) — so a new Go server genuinely runs while an old Bun worker
still owns that file. This needs either separate legacy and Go job files or explicit
backward-compatible ownership semantics, plus a real old-package-to-new-package transition
test. Go must not reclaim a legacy Bun-owned active job until its worker is proven dead.

**Copy staging must be handle-based and fail-closed.** Hashing after copy does not close
the destination TOCTOU. Required: atomic creation of an unguessable directory; opening the
destination through a trusted directory handle with `O_CREAT|O_EXCL|O_NOFOLLOW` or Windows
`CREATE_NEW`; copying and hashing through that same handle; rejecting symlink and reparse
components; sealing and verifying permissions or DACL; revalidating by handle immediately
before spawn.

**Recovery must prove the whole mutation unit is dead, not one PID.** A live `npm` child
can outlive its parent and keep replacing the package. POSIX workers get a new session
(`update_worker_process_unix.go:11`) but Windows only gets a detached process group
(`update_worker_process_windows.go:15`), and the existing Windows termination targets a PID
tree via a later command (`go/internal/platform/process.go:88`). Required: a stable process
handle or pidfd where available, a Windows Job Object containing descendants, whole-group
death proof, and refusal to terminalize when containment cannot be proven empty.

**Process identity needs boot/session context and fail-closed parsing.** Linux `/proc/<pid>/stat`
field 22 is boot-relative, so PID plus start ticks can collide across reboots, and parsing
must survive spaces and `)` inside `comm`. Unavailable or namespaced `/proc` must read as
"unverifiable", never "dead". macOS uses `unix.SysctlKinfoProc`, Windows uses
`GetProcessTimes`; `golang.org/x/sys` is already a dependency (`go/go.mod`), so no cgo is
needed, but build-tagged implementations and a canonical representation are real work.

**Windows staging hardening must not soft-fail.** The existing DACL helper soft-fails on
timeout (`go/internal/platform/winacl_common.go:57`), which is unsuitable for an executable
staging boundary. Required: verified-success hardening, handle-based reparse-point
rejection on every existing component, Windows case/volume canonicalization when proving
the staging root is outside the package root, and failure when no safe root exists.
