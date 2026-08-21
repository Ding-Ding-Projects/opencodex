import type { OcxAssistantMessage, OcxMessage, OcxToolCall, OcxToolResultMessage } from "../types";

function assistant(message: OcxMessage): message is OcxAssistantMessage { return message.role === "assistant"; }
function result(message: OcxMessage): message is OcxToolResultMessage { return message.role === "toolResult"; }

/** Keep only complete call/result pairs before CCA translates them to Anthropic tool blocks. */
export function repairGoogleToolPairs(messages: readonly OcxMessage[]): OcxMessage[] {
  const callsWithResults = new Set<string>();
  const resultsWithCalls = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (assistant(message)) {
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        const id = (part as OcxToolCall).id;
        if (messages.slice(i + 1).some(candidate => result(candidate) && candidate.toolCallId === id)) callsWithResults.add(id);
      }
    } else if (result(message)) {
      if (messages.slice(0, i).some(candidate => assistant(candidate) && candidate.content.some(part => part.type === "toolCall" && (part as OcxToolCall).id === message.toolCallId))) {
        resultsWithCalls.add(message.toolCallId);
      }
    }
  }
  const repaired: OcxMessage[] = [];
  for (const message of messages) {
    if (result(message)) {
      if (resultsWithCalls.has(message.toolCallId)) repaired.push(message);
      continue;
    }
    if (!assistant(message)) { repaired.push(message); continue; }
    const content = message.content.filter(part => part.type !== "toolCall" || callsWithResults.has((part as OcxToolCall).id));
    if (content.length > 0) repaired.push(content.length === message.content.length ? message : { ...message, content });
  }
  return repaired;
}

/** Claude-on-CCA treats a trailing model turn as a prefill; remove only trailing model turns. */
export function stripTrailingClaudePrefill(contents: unknown[]): unknown[] {
  while (contents.length >= 2) {
    const last = contents[contents.length - 1];
    if (!last || typeof last !== "object" || (last as { role?: unknown }).role !== "model") break;
    contents.pop();
  }
  return contents;
}
