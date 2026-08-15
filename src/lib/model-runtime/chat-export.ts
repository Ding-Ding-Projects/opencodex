/**
 * Redacted chat export.
 *
 * "Redacted" means exactly one thing is ever omitted: an attachment's raw
 * `dataBase64` bytes. Everything else — every message's role, text, model,
 * system prompt, parameters, timestamps and real usage stats — is the
 * session's actual content, and exporting the transcript honestly *is* the
 * point of this feature. Omitting attachment bytes is not optional
 * discretion, it is what "chats and attachments stay local" from the task
 * contract requires: an export leaves this machine (a saved file, a pasted
 * message elsewhere), so the one thing that must never ride along is a raw
 * image payload. The export says so explicitly via `redactionNote`, per
 * attachment via `omitted: true`, rather than silently shrinking the file.
 */

import type { ChatSession } from "./chat-types";

export interface ChatExportAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Always `true` — the raw bytes are never included in an export. */
  omitted: true;
}

export interface ChatExportMessage {
  id: string;
  role: string;
  content: string;
  createdAt: number;
  state: string;
  error: string | null;
  stats: ChatSession["messages"][number]["stats"];
  attachments: ChatExportAttachment[] | null;
}

export interface ChatExportSession {
  id: string;
  title: string;
  model: string;
  systemPrompt: string;
  parameters: ChatSession["parameters"];
  createdAt: number;
  updatedAt: number;
  messages: ChatExportMessage[];
}

export interface ChatExport {
  version: 1;
  exportedAt: number;
  redactionNote: string;
  sessions: ChatExportSession[];
}

const REDACTION_NOTE = "Attachment image bytes are omitted from every export (name, type and size are kept). Nothing in this export was sent anywhere but this machine before you exported it.";

export function buildChatExport(sessions: ChatSession[]): ChatExport {
  return {
    version: 1,
    exportedAt: Date.now(),
    redactionNote: REDACTION_NOTE,
    sessions: sessions.map(s => ({
      id: s.id,
      title: s.title,
      model: s.model,
      systemPrompt: s.systemPrompt,
      parameters: s.parameters,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messages: s.messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        state: m.state,
        error: m.error,
        stats: m.stats,
        attachments: m.attachments && m.attachments.length > 0
          ? m.attachments.map(a => ({ id: a.id, name: a.name, mimeType: a.mimeType, sizeBytes: a.sizeBytes, omitted: true as const }))
          : null,
      })),
    })),
  };
}

function mdEscape(text: string): string {
  return text.replace(/```/g, "​```"); // a zero-width break so a message containing a fence cannot escape its own code block
}

/** A durable, human-readable text format — the same "at least one durable text format" bar the changelog viewer's own export sets. */
export function chatExportToMarkdown(exportData: ChatExport): string {
  const lines: string[] = [];
  lines.push(`# Chat export`);
  lines.push("");
  lines.push(`Exported: ${new Date(exportData.exportedAt).toISOString()}`);
  lines.push("");
  lines.push(`> ${exportData.redactionNote}`);
  lines.push("");
  for (const session of exportData.sessions) {
    lines.push(`## ${session.title}`);
    lines.push("");
    lines.push(`- Model: \`${session.model}\``);
    lines.push(`- Created: ${new Date(session.createdAt).toISOString()}`);
    lines.push(`- Updated: ${new Date(session.updatedAt).toISOString()}`);
    lines.push(`- Parameters: temperature ${session.parameters.temperature}, top_p ${session.parameters.topP}, top_k ${session.parameters.topK}, num_ctx ${session.parameters.numCtx}, repeat_penalty ${session.parameters.repeatPenalty}${session.parameters.seed !== null ? `, seed ${session.parameters.seed}` : ""}`);
    if (session.systemPrompt.trim()) {
      lines.push("");
      lines.push("**System prompt:**");
      lines.push("");
      lines.push("```");
      lines.push(mdEscape(session.systemPrompt));
      lines.push("```");
    }
    lines.push("");
    for (const message of session.messages) {
      const roleLabel = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "System";
      lines.push(`### ${roleLabel} — ${new Date(message.createdAt).toISOString()} (${message.state})`);
      lines.push("");
      lines.push(mdEscape(message.content) || "_(empty)_");
      if (message.attachments && message.attachments.length > 0) {
        lines.push("");
        for (const a of message.attachments) lines.push(`- Attachment: ${a.name} (${a.mimeType}, ${a.sizeBytes} bytes) — image data omitted`);
      }
      if (message.error) {
        lines.push("");
        lines.push(`> Error: ${mdEscape(message.error)}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}
