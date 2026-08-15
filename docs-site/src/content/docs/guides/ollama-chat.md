---
title: Ollama chat
description: A real, streaming, token-by-token chat session against a locally installed Ollama model — multi-session history, an editable system prompt, documented parameters, capability-gated attachments, and a redacted export, all local.
---

opencodex ships a chat surface for [Ollama](https://ollama.com) — reachable from its own page in the
shell, and from the **Open chat** action on the [Ollama suite manager](/guides/ollama-manager) page.
It talks only to Ollama's documented local `POST /api/chat` route
(`https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion`), on the loopback
interface, through this app's own privileged process — never a cloud chat provider, and the renderer
never talks to the Ollama daemon directly.

## Real streaming, not polling

Sending a message opens one HTTP request whose response body is newline-delimited JSON, read live with
`response.body.getReader()` as the runtime generates each token. Every content delta lands in the
transcript the instant it is decoded — there is no polling anywhere on this page. The exact same
callback that forwards a token to the browser also appends it to the session's persisted record on a
throttled cadence, so a page reload mid-reply shows the real partial content rather than nothing.

**Stop actually aborts the request.** There is no documented "cancel this generation" route on
Ollama's API; every client, including this one, treats closing the connection as the cancellation
signal. Clicking Stop aborts the browser's own fetch to opencodex's local server, which in turn aborts
its own upstream call to Ollama — the same close-the-connection action all the way down. The partial
reply already generated is kept, marked *Stopped*, never discarded.

## What this page does

1. **Multi-session history**, each with its own model, system prompt, parameters and full transcript,
   saved locally. The session list has the app's usual regex-wired search, a rename action, and a
   delete action behind the standard confirmation dialog.
2. **Explicit model and variant choice**, drawn from the same installed-model catalogue the manager
   page shows — never a model this machine does not actually have.
3. **An editable system prompt**, sent once ahead of every message in that session.
4. **Documented model parameters with recommended defaults and validation** — temperature, top-p,
   top-k, context window, repeat penalty and an optional seed, each Ollama's own documented `options`
   field with Ollama's own documented default. A value outside its sane range is clamped, and you are
   told exactly which field was clamped and to what, rather than the request silently changing on you.
5. **Stop and regenerate.** Stop is covered above; Regenerate drops the last finished reply and streams
   a fresh one in its place — never a second reply appended beside the first.
6. **Attachments, gated on real capability, never hidden.** The attach control is always visible and
   reachable. It disables itself, with the exact reason named right beside it, only when the session's
   selected model's real fetched capabilities do not include `vision` — with a "show vision-capable
   models only" action sitting right there to fix it. The server enforces the identical rule again on
   every send and **fails closed** when a model's capabilities could not even be verified, so a model
   this page could not confirm supports images is never sent one regardless of what the client claims.
7. **A complete, redacted export**, per session or for everything, as JSON or Markdown. "Redacted"
   means exactly one thing is ever omitted: an attachment's raw image bytes. Every message's role,
   text, timestamps and real usage stats are the session's actual content — exporting the transcript
   honestly is the point — and the export states plainly, in the file itself, what was left out.

## Everything here is bounded

A chat session is user-authored, persisted state, so every dimension of it carries an explicit
ceiling: how many sessions can exist, how many messages a session can hold, how large a system prompt
or a single message can be, how many attachments a message can carry and how large each one may be,
and how many sessions may have a reply streaming at once across the whole app. Sending a message that
would generate an unreasonably long reply is capped too — the reply is stopped at the size limit
rather than allowed to grow without bound, with the partial content kept and the reason stated.

## Chats and attachments stay local

No telemetry, no network call other than the loopback request to Ollama itself. Secrets, credentials,
environment values, private paths and raw model request/response payloads never reach logs, captures,
or the ordinary export — the export's own redaction rule is covered above.

## From the API

```
GET    /api/model-runtime/chat/sessions                    -> { ok:true, sessions: ChatSessionSummary[] }
POST   /api/model-runtime/chat/sessions   { model, title?, systemPrompt?, parameters? } -> { ok:true, session } | refused
GET    /api/model-runtime/chat/sessions/:id                -> { ok:true, session } | 404
PATCH  /api/model-runtime/chat/sessions/:id  { title?, model?, systemPrompt?, parameters? } -> { ok:true, session } | refused
DELETE /api/model-runtime/chat/sessions/:id                -> { ok:true } | 404
POST   /api/model-runtime/chat/sessions/:id/messages  { content, attachments? } -> a real streamed application/x-ndjson body
POST   /api/model-runtime/chat/sessions/:id/regenerate      -> same streamed shape, replacing the last finished reply
POST   /api/model-runtime/chat/sessions/:id/stop            -> { ok:true } | 404
GET    /api/model-runtime/chat/export?sessionId=<id>&format=json|md -> a redacted export (every session when sessionId is omitted)
```

None of these routes require the app to be reached only from the loopback interface. Sending a
message calls an already-running daemon's inference route rather than starting a new host process or
installing anything, and session history is this app's own local JSON state — the same class of
action the batch-pull queue's own housekeeping routes already treat as ungated. Removing an installed
model and starting a model download remain gated on the [Ollama suite manager](/guides/ollama-manager)
page, because those genuinely put bytes on the host.

## Failure modes

| Symptom | Cause |
| --- | --- |
| The page shows a health banner instead of a composer | The runtime is not `healthy` right now — the banner links straight to the manager page's own guided recovery for that state |
| Sending fails with 409 | The runtime went unhealthy between opening the page and sending, or a reply is already streaming for that session |
| Sending fails with 429 | The app-wide concurrent-streaming limit is already in use by other sessions — wait for one to finish |
| The attach button is disabled | The selected model's real, fetched capabilities do not include `vision` — switch to a vision-capable model, or use the "show vision-capable models only" filter |
| A reply is marked *Stopped* with no message from you | It hit this app's own reply-size ceiling; the partial content is kept |
| A reply is marked *Stopped* right after a restart | Nothing was actually generating it any more once the process that was streaming it stopped — the honest reconciliation, not a bug |

## Security considerations

Chat send/regenerate/stop and session CRUD are local-only actions with no install or process-spawn
side effect, so they are not behind the loopback gate the manager page's mutating routes use — see
[Ollama suite manager](/guides/ollama-manager)'s own security section for what *is* gated and why.
Attachment mime types are allowlisted; every size ceiling named above is enforced server-side, not
only in the page's own client-side checks, which exist purely for fast, honest feedback before a
round trip. Vision-capability gating fails closed: a model whose capabilities this page could not
verify is treated as not vision-capable, never as an unverified yes.

## Verification

- `tests/model-runtime-chat-types.test.ts` — parameter validation and clamping.
- `tests/model-runtime-chat-client.test.ts` — every streamed-turn outcome (success, reported error,
  a stream that ends with no completion line, an oversized line, a refused redirect, an aborted
  request) against Ollama's documented `/api/chat` shape.
- `tests/model-runtime-chat-store.test.ts` — atomic persistence, and the restart-reconciliation
  guarantee that a `streaming` message found on disk is always turned into `stopped` the moment the
  file is first read, watched red before being trusted green.
- `tests/model-runtime-chat-engine.test.ts` — session CRUD, the full attachment validation ladder, the
  fail-closed vision gate, the app-wide concurrency bound, stop actually aborting the request, and
  regenerate replacing rather than appending a reply.
- `tests/model-runtime-chat-export.test.ts` — the redaction guarantee: a marker planted in fake
  attachment bytes never appears anywhere in a JSON or Markdown export.
- `tests/model-runtime-chat-routes.test.ts` — route-level behaviour, including the real streamed
  response and its message-id headers.

All new copy is localized in `m3.ts`/`yue.ts`, watched by `gui/tests/i18n-voice-and-locales.test.ts`.

## Suggested articles

- [Ollama suite manager](/guides/ollama-manager) — installs and shows the models this page talks to,
  and hosts the destructive/install-side actions this page deliberately does not duplicate.
- [Web dashboard](/guides/web-dashboard) — the tabbed shell this page's own nav entry lives inside.
- [Export & Bulk Actions](/guides/export-and-bulk-actions) — the app-wide export contract this page's
  redacted transcript export follows.
