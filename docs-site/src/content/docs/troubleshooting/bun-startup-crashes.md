---
title: Bun Startup Crash Recovery on Windows
description: How opencodex separates stale-journal recovery from a native Bun crash, protects a live owner, and performs one bounded retry.
---

On Windows, a previous abnormal proxy exit can be followed by output like this on the next
`ocx start` or `ocx ensure`:

```text
⚠️  Previous session (PID 13440) did not shut down cleanly. Codex state restored from journal.
panic(thread 3616): Segmentation fault at address 0xFFFFFFFFFFFFFFFF
oh no: Bun has crashed. This indicates a bug in Bun, not your code.
```

The first line is recovery evidence, not the cause of the native crash. It means opencodex found a
journal owned by a process that is definitively gone and restored the Codex files that opencodex had
temporarily changed. The later panic is emitted by the Bun runtime outside TypeScript, so code inside
that Bun process cannot catch it.

## Built-in recovery

opencodex handles this failure at two separate process boundaries:

1. **Owner check before journal recovery.** `start` and `ensure` first identity-probe the existing
   proxy. The journal records the PID together with its process start/creation identity and the
   executable identity available from the host. A healthy proxy whose PID and identity still match
   keeps its injected Codex files, PID state, and journal untouched. If the OS has reused that PID
   for an unrelated live process, the mismatch is treated as stale journal ownership and recovery
   may restore only the hash-bounded Codex snapshot; an identity that cannot be proved is preserved
   rather than guessed. PID and runtime-owner removals compare the complete records observed before
   the liveness probe. A changed or newly published owner record prevents this process from
   reconciling the journal.
2. **One external retry for a real Bun panic.** The Node launcher retains at most 64 KiB of the Bun
   child's stderr while forwarding every byte live with writable backpressure. A separate
   attempt-local streaming latch remembers Bun's exact `oh no: Bun has crashed` marker even if later
   diagnostic noise evicts it from that tail. It retries only `start` and `ensure`, only after an
   abnormal exit carrying that marker, and only once. The second attempt receives a fresh latch and
   stderr tail, so output from the first crash cannot turn an ordinary second failure into another
   crash.

### Which launch routes carry the retry

| Route | Panic retry | Notes |
| --- | --- | --- |
| npm bins (`ocx`, `opencodex`) | Yes | `bin/ocx.mjs` supervises every command. |
| Package scripts (`bun run start`, `dev`, `dev:proxy`) | Yes | They route through `bin/ocx.mjs`; `tests/proxy-start-supervision.test.ts` fails if any of them is pointed back at direct `bun run src/cli/index.ts start`. |
| Windows service wrappers | Restart on failure | The native (WinSW) backend restarts via `<onfailure action="restart" delay="5 sec"/>`; the Task Scheduler wrapper's `cmd` loop reruns only after a nonzero exit, and a clean exit ends it without restarting. Neither classifies panics. |
| Generated Codex shims | Two attempts | Best-effort `ocx ensure` twice, then the real Codex command launches regardless. |
| Windows tray (`__tray-host`) | No | Hidden stdio; a dead tray surfaces through tray status staleness rather than a console transcript. |

An ordinary nonzero CLI exit, a spawn failure, a warning without the Bun marker, exit code `139`
without the marker, or a user termination signal is never retried. If both eligible attempts produce
the Bun crash marker, the real second failure is returned and the launcher prints one runtime-override
hint instead of looping.

The panic is transient rather than deterministic in opencodex's own startup path. In field testing,
an armed reproduction — a stale journal owned by a provably dead process, with the journaled original
config restored into place — printed the recovery warning and reached a healthy listening proxy on
every attempt through both the installed launcher and a checkout of the same version. A crash
that does reproduce on the second supervised attempt is therefore genuine runtime evidence worth the
runtime override below.

The generated Codex launcher shims separately run `ocx ensure` synchronously, make at most two
best-effort ensure attempts, and then launch the real Codex command even if both attempts failed.
That shim behavior is not the npm launcher's Bun-crash classifier.

## What to do if it still crashes twice

1. Run `ocx status` and `ocx doctor`. These commands report the identity-checked proxy state and the
   selected runtime without deleting the recovery journal.
2. Retry `ocx ensure`. A healthy owner is adopted; a genuinely dead owner is recovered before the
   new start.
3. If Bun crashes twice with the official marker, use only a Bun binary you deliberately downloaded
   and trust. Point `OPENCODEX_BUN_PATH` at its absolute path before launching opencodex:

   ```powershell
   $env:OPENCODEX_BUN_PATH = 'C:\Tools\bun-canary\bun.exe'
   ocx ensure
   ```

   The direct npm launcher reads this variable on every invocation. For a durable runtime override,
   reinstall the service or Codex-shim artifact from the same shell after setting the variable;
   those artifacts capture the chosen runtime when they are generated:

   ```powershell
   ocx service install
   # or, for on-demand startup:
   ocx codex-shim install
   ```

4. To return to the bundled runtime, remove the override and reinstall any durable artifact that was
   generated with it:

   ```powershell
   Remove-Item Env:OPENCODEX_BUN_PATH -ErrorAction SilentlyContinue
   ocx service install
   ```

`OPENCODEX_BUN_PATH` executes the selected file as the proxy runtime. Do not point it at an untrusted
download, a writable shared directory, or an arbitrary large executable. The override must resolve
to a readable regular file of at least 1,000,000 bytes (approximately 1 MiB); directories, missing
files, and incomplete placeholder binaries are rejected. A rejected override produces a generic
warning that does not echo the supplied path, then the npm launcher falls back to its bundled Bun
runtime. This validation checks only file kind and size. It does not authenticate the binary's
identity or verify a publisher signature.

## Verification boundary

This is non-visual CLI lifecycle behavior. Its deterministic regression coverage uses harmless
fixture subprocesses that emit the exact diagnostic marker and terminate with controlled nonzero
results. The tests do not generate a real native crash, invalid memory access, or crash dump.
Separate isolated subprocess coverage exercises live-owner detection and the journal, PID, and
runtime-state transitions. UI captures are not evidence for this command-line recovery contract.

## State and failure guarantees

- Recovery restores only the journaled opencodex-owned state. Hash-identified user edits are
  preserved instead of overwritten.
- A forced stop captures the proxy identity before the graceful request and rechecks it immediately
  before `taskkill` or a POSIX signal. PID reuse or an unreadable identity refuses termination;
  numeric liveness alone never authorizes a destructive fallback.
- Startup restoration uses the asynchronous hardened atomic-write path on Windows. If one file was
  restored before another write failed, a later attempt recognizes the exact original bytes and can
  finish the remaining restore.
- The warning is printed only after at least one journaled file was restored.
- A persistent native crash remains visible: stderr is not replayed or swallowed, the second exit
  status is propagated, and there is no unbounded retry loop.
- The stale-session warning alone never classifies a Bun crash, and this supervisor does not repair
  Bun itself; it provides one bounded retry around a separately identified native failure.
- Do not delete `config.toml` or `opencodex-journal.json` merely to silence the warning. Those files
  are the evidence used to distinguish opencodex-owned injection from user-owned configuration.

The bundled runtime version is pinned in `package.json` and `bun.lock`. The startup supervisor is a
bounded availability measure, not a claim that the underlying Bun defect has been fixed.
