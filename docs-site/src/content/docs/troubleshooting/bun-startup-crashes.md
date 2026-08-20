---
title: Bun Startup Crashes on Windows
description: How opencodex recovers a stale Codex journal and retries a panic-qualified Bun startup without hiding ordinary CLI failures.
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
   proxy. If a healthy proxy owns routing, its injected Codex files, PID state, and journal are left
   untouched. Only a definitively dead owner can trigger recovery. PID removal is compare-guarded so
   a concurrent new starter cannot have its fresh state deleted.
2. **One external retry for a real Bun panic.** The Node launcher retains at most 64 KiB of the Bun
   child's stderr while forwarding every byte live. It retries only `start` and `ensure`, only after
   an abnormal exit whose stderr contains Bun's official `oh no: Bun has crashed` marker, and only
   once. The second attempt receives a fresh stderr tail, so output from the first crash cannot turn
   an ordinary second failure into another crash.

An ordinary nonzero CLI exit, a spawn failure, a warning without the Bun marker, exit code `139`
without the marker, or a user termination signal is never retried. If both eligible attempts produce
the Bun crash marker, the real second failure is returned and the launcher prints one runtime-override
hint instead of looping.

The generated Codex launcher shims follow the same bounded policy: they run `ocx ensure`, retry it
once after a nonzero result, and then launch the real Codex command even if both ensure attempts
failed. The two ensure attempts are synchronous so Codex does not race ahead of proxy readiness.

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

   The direct npm launcher reads this variable on every invocation. Durable service and Codex-shim
   artifacts capture the chosen runtime when they are generated, so reinstall the artifact from the
   same shell after setting the variable:

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
download, a writable shared directory, or an arbitrary large executable. opencodex rejects missing,
unreadable, and incomplete placeholder binaries, but a size check is not a publisher-signature check.

## State and failure guarantees

- Recovery restores only the journaled opencodex-owned state. Hash-identified user edits are
  preserved instead of overwritten.
- Startup restoration uses the asynchronous hardened atomic-write path on Windows. If one file was
  restored before another write failed, a later attempt recognizes the exact original bytes and can
  finish the remaining restore.
- The warning is printed only after at least one journaled file was restored.
- A persistent native crash remains visible: stderr is not replayed or swallowed, the second exit
  status is propagated, and there is no unbounded retry loop.
- Do not delete `config.toml` or `opencodex-journal.json` merely to silence the warning. Those files
  are the evidence used to distinguish opencodex-owned injection from user-owned configuration.

The bundled runtime version is pinned in `package.json` and `bun.lock`. Runtime upgrades remain the
long-term fix for native Bun defects; the startup supervisor is a bounded availability safeguard.
