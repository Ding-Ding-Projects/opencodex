---
title: Ollama suite manager
description: Health and guided recovery for the local Ollama runtime, an exhaustive catalogue of every model actually installed on this machine, and a conservative, evidence-backed hardware-fit estimate for each — built only on Ollama's documented local HTTP API.
---

opencodex ships a manager for [Ollama](https://ollama.com), the local model runtime — reachable from
the dashboard's **Ollama** page. It talks only to Ollama's documented local HTTP API
(`https://github.com/ollama/ollama/blob/main/docs/api.md`), on the loopback interface, through this
app's own privileged process. It never reaches an unofficial proxy, never embeds a cloud service, and
the renderer never talks to the Ollama daemon directly.

## What this page does

1. **Distinguishes every runtime state, with guidance for each.** `healthy`, `missing` (no `ollama`
   executable was found on this machine — a real check, never a guess), `stopped` (installed, daemon
   not answering), `unhealthy` (reachable but not answering correctly), and `offline` (a network-level
   failure) are each reported separately, each with plain-language guidance, and a **Retry** action.
   While the runtime is not healthy, the page rechecks automatically every twelve seconds, so recovery
   — starting the daemon, finishing an install — is picked up without you having to come back and
   click anything.
2. **Lists every installed model tag, exhaustively.** `GET /api/tags` is the runtime's own inventory
   of what is actually on this machine; every entry is enriched with `POST /api/show` for real
   capability metadata (context length, parameter count, quantization, family, capabilities) and
   combined with `GET /api/ps` so a currently-loaded model is marked running. Nothing is filtered out
   before it reaches the page.
3. **Reports one of four hardware-fit verdicts per model, with the evidence behind it.** *Runs well*,
   *runs with limits*, *unlikely to run*, or *unknown* — computed from real, detected system memory,
   GPU video memory (via `nvidia-smi` where present, falling back to Windows' own WMI video-controller
   query with a documented accuracy caveat), and free disk space, against the model's real reported
   size, parameter count and quantization. A missing fact never becomes a zero; it widens the verdict
   toward *unknown*. Every verdict's reasoning is one click away.
4. **Searches, filters and sorts the full list.** Plain text is the default; an adjacent anchored
   builder opens the app's usual regex builder for the same search field. Filter by family, by fit
   verdict, or to running models only.

It can also remove an installed model (`DELETE /api/delete`), behind the same confirmation dialog the
rest of the app uses for a recoverable, single-item removal.

## What "exhaustive catalogue" means here, and what it deliberately does not

Ollama's *documented local HTTP API* has no endpoint that lists every model `ollama.com` publishes —
`/api/tags` only ever answers with what is already pulled onto this machine. Fetching ollama.com's own
website, or an undocumented API, would be exactly the "unofficial proxy" this feature is built not to
be. So "exhaustive" here means: **every model tag actually installed on this machine, in full, with
real capability metadata for each — never a curated subset of what is installed.** It is not an
internet-wide, browsable library. The response still carries `pageCount`, `sourceRevision` (the
runtime's own reported version) and a `completeness` verdict explicitly, so a future paginated
`/api/tags` — or a documented, official source for the internet-wide half — could slot in without a
breaking change to the shape.

**The batch-pull cart, the streaming chat surface, and allowlisted harness launch are separate, larger
lanes, still `absent`.** This page can show what is installed and remove it; it cannot pull a new
model, and it has no chat surface. A half-built pull queue, or a harness launcher that accepts an
unvalidated shell argument, would be worse than not having one yet — see
`docs/FEATURE-INVENTORY.md`'s Ollama row for the exact accounting.

## Hardware-fit verdicts are conservative evidence, never a promise

Every verdict is computed from numbers this app could actually detect on the real machine, combined
with the model's own reported size:

- **System memory** — `os.totalmem()`/`os.freemem()`, always available.
- **GPU video memory** — `nvidia-smi --query-gpu=name,memory.total` when present (Windows and Linux
  alike); when it is not, a Windows-only fallback queries `Win32_VideoController` via WMI. That
  fallback's `AdapterRAM` field is a documented 32-bit quirk — some drivers report a high-VRAM card
  truncated to under 4 GiB — and the resulting caveat travels with the figure all the way to the page
  rather than being silently corrected, because there is no reliable way to tell a truncated reading
  from a real one.
- **Free disk space** — `Win32_LogicalDisk` on Windows, `df -Pk` elsewhere.

The estimate adds roughly 20% on top of the model's reported weight size for context/KV-cache
overhead, then checks that against GPU video memory first (preferring a comfortable fit, then a
partial-offload band), falling back to system memory for CPU-only execution — capped to *runs with
limits* rather than *runs well* for anything larger than a small model, because CPU-only generation
for a large model is normally slow even when it technically fits. Low free disk space caps an
otherwise-comfortable verdict down by one step, as a caution rather than a hard rule. **A missing
fact — no GPU detected, memory that could not be read — never becomes a zero in the arithmetic; it
widens the verdict toward *unknown* instead.** The full reasoning for any one verdict is visible from
its row.

## From the API

Every route is a thin caller of `src/lib/model-runtime/*`:

```
GET    /api/model-runtime/health    -> { state, baseUrl, version, detail, hostWarning, checkedAt }
GET    /api/model-runtime/catalog   -> { health, catalog: CatalogResult | null }
DELETE /api/model-runtime/models    { name } -> { ok:true } | refused
```

`catalog` is `null` whenever the runtime is not `healthy` — the page never fabricates an installed-model
list for a runtime it could not actually reach. Removing a model is gated exactly like PDF tools' and
the scheduler's Home Assistant token storage: refused the instant the proxy is reachable from the LAN,
because it starts real local state changes that a remote administrator credential should not be able
to trigger.

## Where the local runtime is reached

The default is `http://127.0.0.1:11434`, Ollama's own documented default. Ollama's own `OLLAMA_HOST`
environment-variable convention is honoured **only** when it names a loopback or `localhost` address;
a value pointing anywhere else is rejected and the default is used instead, with the rejection reported
plainly in the health result — this manager only ever reaches the local runtime, never a remote one.

## Suggested articles

- [PDF tools](/guides/pdf-tools) — the other locally-gated file/process management surface this page's
  route and confirmation conventions are drawn from.
- [Web dashboard](/guides/web-dashboard) — the tabbed shell the Ollama page lives inside.
- [Model routing](/guides/model-routing) — how the separate, pre-existing `ollama` **provider** route
  (a chat base-URL entry) differs from this page, and how the two relate.
