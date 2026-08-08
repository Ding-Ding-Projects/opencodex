/**
 * Chat Completions inbound: OpenAI-compatible request -> internal /v1/responses body.
 *
 * Used by GitHub Copilot App (and other OpenAI-compatible clients) via POST /v1/chat/completions.
 * Same translate-and-replay pattern as Claude Messages: the produced body must pass
 * responsesRequestSchema so routing/OAuth/pool/sidecars are inherited unchanged.
 */
export class ChatCompletionsRequestError extends Error {
  constructor(message: string, readonly status = 400, readonly code: string | null = null) {
    super(message);
    this.name = "ChatCompletionsRequestError";
  }
}

export interface ChatCompletionsInboundOptions {
  profile?: "github-copilot-desktop";
}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const OUTPUT_CONFIG_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const COPILOT_MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const COPILOT_REQUEST_FIELDS = new Set([
  "model", "messages", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls",
  "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "user", "metadata",
  "prompt_cache_key", "reasoning_effort", "reasoning", "response_format", "n", "logprobs", "top_logprobs",
  "presence_penalty", "frequency_penalty", "functions", "function_call", "audio", "modalities", "prediction",
  "seed", "logit_bias", "service_tier", "web_search_options",
]);
const COPILOT_MAX_STRING_BYTES = 8 * 1024 * 1024;

function requireFiniteNumber(value: unknown, field: string, min: number, max: number, integer = false): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new ChatCompletionsRequestError(`${field} must be ${integer ? "an integer" : "a number"} from ${min} through ${max}`);
  }
}

function validateTextPart(part: Rec, allowed: ReadonlySet<string>, field: string): void {
  if (typeof part.type !== "string" || !allowed.has(part.type)) {
    throw new ChatCompletionsRequestError(`${field} contains unsupported content type: ${String(part.type)}`);
  }
  if (typeof part.text !== "string") throw new ChatCompletionsRequestError(`${field}.${part.type}.text must be a string`);
}

function validateImagePart(part: Rec, field: string): void {
  const image = part.image_url;
  const url = typeof image === "string" ? image : isRec(image) && typeof image.url === "string" ? image.url : "";
  if (!url) throw new ChatCompletionsRequestError(`${field}.image_url.url must be a non-empty string`);
  if (new TextEncoder().encode(url).byteLength > COPILOT_MAX_STRING_BYTES) {
    throw new ChatCompletionsRequestError(`${field}.image_url.url is too large`, 413, "request_too_large");
  }
  const dataImage = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(url);
  let httpsImage = false;
  try { httpsImage = new URL(url).protocol === "https:"; } catch { /* invalid below */ }
  if (!dataImage && !httpsImage) {
    throw new ChatCompletionsRequestError(`${field}.image_url.url must be an HTTPS URL or a base64 image data URL`);
  }
  if (isRec(image) && image.detail !== undefined && image.detail !== "auto" && image.detail !== "low" && image.detail !== "high") {
    throw new ChatCompletionsRequestError(`${field}.image_url.detail must be auto, low, or high`);
  }
}

function validateContent(content: unknown, role: string, field: string): void {
  if (content === null && role === "assistant") return;
  if (typeof content === "string") return;
  if (!Array.isArray(content)) throw new ChatCompletionsRequestError(`${field} must be a string or content array`);
  for (let index = 0; index < content.length; index += 1) {
    const raw = content[index];
    if (typeof raw === "string") continue;
    if (!isRec(raw)) throw new ChatCompletionsRequestError(`${field}[${index}] must be an object`);
    if (raw.type === "audio" || raw.type === "input_audio" || raw.type === "file" || raw.type === "input_file") {
      throw new ChatCompletionsRequestError(`${field}[${index}] ${String(raw.type)} content is not supported`);
    }
    if (raw.type === "image_url") {
      if (role !== "user") throw new ChatCompletionsRequestError(`${field}[${index}] image_url is supported only for user messages`);
      validateImagePart(raw, `${field}[${index}]`);
      continue;
    }
    const allowed = role === "assistant"
      ? new Set(["text", "output_text"])
      : new Set(["text", "input_text"]);
    validateTextPart(raw, allowed, `${field}[${index}]`);
  }
}

function validateAssistantToolCalls(toolCalls: unknown, field: string): void {
  if (toolCalls === undefined) return;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) throw new ChatCompletionsRequestError(`${field} must be a non-empty array`);
  for (let index = 0; index < toolCalls.length; index += 1) {
    const call = toolCalls[index];
    if (!isRec(call) || call.type !== "function" || typeof call.id !== "string" || !call.id.trim()) {
      throw new ChatCompletionsRequestError(`${field}[${index}] must be a named function call with an id`);
    }
    if (!isRec(call.function) || typeof call.function.name !== "string" || !call.function.name.trim()) {
      throw new ChatCompletionsRequestError(`${field}[${index}].function.name is required`);
    }
    if (typeof call.function.arguments !== "string") {
      throw new ChatCompletionsRequestError(`${field}[${index}].function.arguments must be a JSON string`);
    }
    try { JSON.parse(call.function.arguments); } catch {
      throw new ChatCompletionsRequestError(`${field}[${index}].function.arguments must contain valid JSON`);
    }
  }
}

function validateCopilotTools(tools: unknown): void {
  if (tools === undefined) return;
  if (!Array.isArray(tools)) throw new ChatCompletionsRequestError("tools must be an array");
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];
    if (!isRec(tool) || tool.type !== "function" || !isRec(tool.function)) {
      throw new ChatCompletionsRequestError(`tools[${index}] must be an OpenAI function tool`);
    }
    if (typeof tool.function.name !== "string" || !tool.function.name.trim()) {
      throw new ChatCompletionsRequestError(`tools[${index}].function.name is required`);
    }
    if (tool.function.description !== undefined && typeof tool.function.description !== "string") {
      throw new ChatCompletionsRequestError(`tools[${index}].function.description must be a string`);
    }
    if (tool.function.parameters !== undefined && !isRec(tool.function.parameters)) {
      throw new ChatCompletionsRequestError(`tools[${index}].function.parameters must be an object`);
    }
    if (tool.function.strict !== undefined && typeof tool.function.strict !== "boolean") {
      throw new ChatCompletionsRequestError(`tools[${index}].function.strict must be a boolean`);
    }
  }
}

function validateCopilotToolChoice(choice: unknown): void {
  if (choice === undefined) return;
  if (choice === "auto" || choice === "none" || choice === "required") return;
  if (!isRec(choice) || choice.type !== "function" || !isRec(choice.function)
    || typeof choice.function.name !== "string" || !choice.function.name.trim()) {
    throw new ChatCompletionsRequestError("tool_choice must be auto, none, required, or a named function choice");
  }
}

function validateCopilotRequest(raw: Rec): void {
  const unknownField = Object.keys(raw).find(field => !COPILOT_REQUEST_FIELDS.has(field));
  if (unknownField) throw new ChatCompletionsRequestError(`unsupported request field: ${unknownField}`);
  if (raw.functions !== undefined || raw.function_call !== undefined) {
    throw new ChatCompletionsRequestError("legacy functions and function_call are not supported; use tools and tool_choice");
  }
  if (raw.n !== undefined && raw.n !== 1) throw new ChatCompletionsRequestError("n must be 1");
  if (raw.logprobs !== undefined && raw.logprobs !== false) throw new ChatCompletionsRequestError("logprobs are not supported");
  if (raw.top_logprobs !== undefined && raw.top_logprobs !== 0) throw new ChatCompletionsRequestError("top_logprobs are not supported");
  for (const field of ["audio", "modalities", "prediction", "seed", "logit_bias", "service_tier", "web_search_options"] as const) {
    if (raw[field] !== undefined) throw new ChatCompletionsRequestError(`${field} is not supported by the GitHub Copilot Desktop profile`);
  }
  if (raw.presence_penalty !== undefined || raw.frequency_penalty !== undefined) {
    throw new ChatCompletionsRequestError("presence_penalty and frequency_penalty are not supported by the GitHub Copilot Desktop profile");
  }
  if (raw.stream !== undefined && typeof raw.stream !== "boolean") throw new ChatCompletionsRequestError("stream must be a boolean");
  if (raw.stream_options !== undefined) {
    if (!isRec(raw.stream_options)) throw new ChatCompletionsRequestError("stream_options must be an object");
    const keys = Object.keys(raw.stream_options);
    if (keys.some(key => key !== "include_usage") || typeof raw.stream_options.include_usage !== "boolean") {
      throw new ChatCompletionsRequestError("stream_options supports only the boolean include_usage field");
    }
    if (raw.stream !== true) throw new ChatCompletionsRequestError("stream_options requires stream: true");
  }
  requireFiniteNumber(raw.max_completion_tokens, "max_completion_tokens", 1, 1_000_000, true);
  requireFiniteNumber(raw.max_tokens, "max_tokens", 1, 1_000_000, true);
  requireFiniteNumber(raw.temperature, "temperature", 0, 2);
  requireFiniteNumber(raw.top_p, "top_p", 0, 1);
  if (raw.stop !== undefined) {
    const valid = typeof raw.stop === "string"
      || (Array.isArray(raw.stop) && raw.stop.length > 0 && raw.stop.length <= 4 && raw.stop.every(value => typeof value === "string"));
    if (!valid) throw new ChatCompletionsRequestError("stop must be a string or an array of 1 through 4 strings");
  }
  if (raw.parallel_tool_calls !== undefined && typeof raw.parallel_tool_calls !== "boolean") {
    throw new ChatCompletionsRequestError("parallel_tool_calls must be a boolean");
  }
  if (raw.metadata !== undefined && !isRec(raw.metadata)) throw new ChatCompletionsRequestError("metadata must be an object");
  if (raw.user !== undefined && typeof raw.user !== "string") throw new ChatCompletionsRequestError("user must be a string");
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) return;
  for (let index = 0; index < raw.messages.length; index += 1) {
    const message = raw.messages[index];
    if (!isRec(message) || typeof message.role !== "string" || !COPILOT_MESSAGE_ROLES.has(message.role)) {
      throw new ChatCompletionsRequestError(`messages[${index}] has an unsupported role`);
    }
    if (message.role === "tool") {
      if (typeof message.tool_call_id !== "string" || !message.tool_call_id.trim()) {
        throw new ChatCompletionsRequestError(`messages[${index}].tool_call_id is required`);
      }
    }
    validateContent(message.content, message.role, `messages[${index}].content`);
    if (message.role === "assistant") validateAssistantToolCalls(message.tool_calls, `messages[${index}].tool_calls`);
    else if (message.tool_calls !== undefined) throw new ChatCompletionsRequestError(`messages[${index}].tool_calls is valid only for assistant messages`);
  }
  validateCopilotTools(raw.tools);
  validateCopilotToolChoice(raw.tool_choice);
}

export function copilotStreamIncludesUsage(raw: unknown): boolean {
  return isRec(raw) && isRec(raw.stream_options) && raw.stream_options.include_usage === true;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      parts.push(raw);
      continue;
    }
    if (!isRec(raw)) continue;
    if ((raw.type === "text" || raw.type === "input_text" || raw.type === "output_text") && typeof raw.text === "string") {
      parts.push(raw.text);
    }
  }
  return parts.join("\n");
}

function imageUrlFromPart(part: Rec): string | null {
  if (part.type !== "image_url") return null;
  const imageUrl = part.image_url;
  if (typeof imageUrl === "string" && imageUrl.length > 0) return imageUrl;
  if (isRec(imageUrl) && typeof imageUrl.url === "string" && imageUrl.url.length > 0) return imageUrl.url;
  return null;
}

function userContentToBlocks(content: unknown): Rec[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Rec[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      if (raw.length > 0) blocks.push({ type: "input_text", text: raw });
      continue;
    }
    if (!isRec(raw)) continue;
    if ((raw.type === "text" || raw.type === "input_text") && typeof raw.text === "string") {
      blocks.push({ type: "input_text", text: raw.text });
      continue;
    }
    const imageUrl = imageUrlFromPart(raw);
    if (imageUrl) blocks.push({ type: "input_image", image_url: imageUrl });
  }
  return blocks;
}

function assistantContentToBlocks(content: unknown): Rec[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "output_text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Rec[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      if (raw.length > 0) blocks.push({ type: "output_text", text: raw });
      continue;
    }
    if (!isRec(raw)) continue;
    if ((raw.type === "text" || raw.type === "output_text") && typeof raw.text === "string") {
      blocks.push({ type: "output_text", text: raw.text });
    }
  }
  return blocks;
}

function pushSystemText(parts: string[], content: unknown): void {
  const text = contentToText(content).trim();
  if (text) parts.push(text);
}

function toolCallsToItems(toolCalls: unknown, input: Rec[]): void {
  if (!Array.isArray(toolCalls)) return;
  // Recover names from earlier function_call items in the same transcript when a client
  // re-sends tool_calls with only id/arguments (replace-style merge lost function.name).
  const knownNameByCallId = new Map<string, string>();
  for (const item of input) {
    if (!isRec(item) || item.type !== "function_call") continue;
    if (typeof item.call_id === "string" && typeof item.name === "string" && item.name.length > 0) {
      knownNameByCallId.set(item.call_id, item.name);
    }
  }
  for (const raw of toolCalls) {
    if (!isRec(raw)) continue;
    const fn = isRec(raw.function) ? raw.function : null;
    let name = typeof fn?.name === "string" ? fn.name : typeof raw.name === "string" ? raw.name : "";
    const args = typeof fn?.arguments === "string"
      ? fn.arguments
      : typeof raw.arguments === "string"
        ? raw.arguments
        : JSON.stringify(fn?.arguments ?? raw.arguments ?? {});
    const callId = typeof raw.id === "string" && raw.id.length > 0
      ? raw.id
      : typeof raw.call_id === "string" && raw.call_id.length > 0
        ? raw.call_id
        : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    if (!name) name = knownNameByCallId.get(callId) ?? "";
    if (!name) throw new ChatCompletionsRequestError("tool_calls entries require function.name");
    knownNameByCallId.set(callId, name);
    input.push({ type: "function_call", call_id: callId, name, arguments: args });
  }
}

function toolsToResponses(tools: unknown): Rec[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: Rec[] = [];
  for (const raw of tools) {
    if (!isRec(raw)) continue;
    if (raw.type === "function" && typeof raw.name === "string" && raw.name.length > 0) {
      out.push({
        type: "function",
        name: raw.name,
        ...(typeof raw.description === "string" ? { description: raw.description } : {}),
        ...(isRec(raw.parameters) ? { parameters: raw.parameters } : {}),
        ...(typeof raw.strict === "boolean" ? { strict: raw.strict } : {}),
      });
      continue;
    }
    if (raw.type === "function" && isRec(raw.function) && typeof raw.function.name === "string" && raw.function.name.length > 0) {
      out.push({
        type: "function",
        name: raw.function.name,
        ...(typeof raw.function.description === "string" ? { description: raw.function.description } : {}),
        ...(isRec(raw.function.parameters) ? { parameters: raw.function.parameters } : {}),
        ...(typeof raw.function.strict === "boolean" ? { strict: raw.function.strict } : {}),
      });
      continue;
    }
    if (raw.type === "web_search" || raw.type === "web_search_preview") {
      out.push({ type: "web_search" });
    }
  }
  return out.length > 0 ? out : undefined;
}

function toolChoiceToResponses(choice: unknown, body: Rec): void {
  if (choice === undefined || choice === null) return;
  if (choice === "auto" || choice === "none" || choice === "required") {
    body.tool_choice = choice;
    return;
  }
  if (!isRec(choice)) return;
  if (choice.type === "function") {
    const name = typeof choice.name === "string"
      ? choice.name
      : isRec(choice.function) && typeof choice.function.name === "string"
        ? choice.function.name
        : "";
    if (!name) throw new ChatCompletionsRequestError("tool_choice.function requires a name");
    body.tool_choice = { type: "function", name };
    return;
  }
  if (isRec(choice.function) && typeof choice.function.name === "string") {
    body.tool_choice = { type: "function", name: choice.function.name };
  }
}

function responseFormatToText(format: unknown): Rec | undefined {
  if (format === undefined) return undefined;
  if (!isRec(format)) throw new ChatCompletionsRequestError("response_format must be an object");
  if (format.type === "json_object") return { format: { type: "json_object" } };
  if (format.type === "json_schema") {
    if (!isRec(format.json_schema)) {
      throw new ChatCompletionsRequestError("response_format.json_schema is required for type json_schema");
    }
    const schema = format.json_schema;
    return {
      format: {
        type: "json_schema",
        name: typeof schema.name === "string" ? schema.name : "response",
        ...(typeof schema.description === "string" ? { description: schema.description } : {}),
        ...(schema.schema !== undefined ? { schema: schema.schema } : {}),
        ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
      },
    };
  }
  if (format.type === "text") return undefined;
  throw new ChatCompletionsRequestError(`unsupported response_format.type: ${String(format.type)}`);
}

function resolveReasoningEffort(raw: Rec): string | undefined {
  if (typeof raw.reasoning_effort === "string" && OUTPUT_CONFIG_EFFORTS.has(raw.reasoning_effort)) {
    return raw.reasoning_effort;
  }
  if (isRec(raw.reasoning) && typeof raw.reasoning.effort === "string" && OUTPUT_CONFIG_EFFORTS.has(raw.reasoning.effort)) {
    return raw.reasoning.effort;
  }
  return undefined;
}

/**
 * Translate an OpenAI Chat Completions request body into a /v1/responses request body.
 * Throws ChatCompletionsRequestError (-> 400) on malformed input.
 */
export function chatCompletionsToResponsesBody(raw: unknown, options: ChatCompletionsInboundOptions = {}): Rec {
  if (!isRec(raw)) throw new ChatCompletionsRequestError("request body must be a JSON object");
  if (options.profile === "github-copilot-desktop") validateCopilotRequest(raw);
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    throw new ChatCompletionsRequestError("model is required");
  }
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new ChatCompletionsRequestError("messages must be a non-empty array");
  }

  const systemParts: string[] = [];
  const input: Rec[] = [];

  for (const msg of raw.messages) {
    if (!isRec(msg)) continue;
    const role = typeof msg.role === "string" ? msg.role : "";
    switch (role) {
      case "system":
      case "developer":
        pushSystemText(systemParts, msg.content);
        break;
      case "user": {
        const blocks = userContentToBlocks(msg.content);
        if (blocks.length > 0) input.push({ type: "message", role: "user", content: blocks });
        break;
      }
      case "assistant": {
        const blocks = assistantContentToBlocks(msg.content);
        if (blocks.length > 0) input.push({ type: "message", role: "assistant", content: blocks });
        if (msg.tool_calls !== undefined) toolCallsToItems(msg.tool_calls, input);
        break;
      }
      case "tool": {
        const callId = typeof msg.tool_call_id === "string" ? msg.tool_call_id
          : typeof msg.tool_use_id === "string" ? msg.tool_use_id
          : "";
        if (!callId) throw new ChatCompletionsRequestError("tool messages require tool_call_id");
        const output = typeof msg.content === "string" ? msg.content : contentToText(msg.content);
        input.push({ type: "function_call_output", call_id: callId, output });
        break;
      }
      default:
        break;
    }
  }

  if (input.length === 0 && systemParts.length === 0) {
    throw new ChatCompletionsRequestError("messages must include at least one user/assistant/tool turn");
  }

  const body: Rec = {
    model: raw.model,
    input,
    stream: raw.stream === true,
    store: false,
  };

  if (systemParts.length > 0) body.instructions = systemParts.join("\n\n");

  const tools = toolsToResponses(raw.tools);
  if (tools) body.tools = tools;
  toolChoiceToResponses(raw.tool_choice, body);

  const maxTokens = typeof raw.max_completion_tokens === "number"
    ? raw.max_completion_tokens
    : typeof raw.max_tokens === "number"
      ? raw.max_tokens
      : undefined;
  if (typeof maxTokens === "number") body.max_output_tokens = maxTokens;
  if (typeof raw.temperature === "number") body.temperature = raw.temperature;
  if (typeof raw.top_p === "number") body.top_p = raw.top_p;
  if (raw.stop !== undefined) body.stop = raw.stop;
  if (typeof raw.user === "string") body.user = raw.user;
  if (typeof raw.parallel_tool_calls === "boolean") body.parallel_tool_calls = raw.parallel_tool_calls;
  if (typeof raw.prompt_cache_key === "string") body.prompt_cache_key = raw.prompt_cache_key;
  if (raw.metadata !== undefined) body.metadata = raw.metadata;

  const effort = resolveReasoningEffort(raw);
  if (effort) body.reasoning = { effort };

  const text = responseFormatToText(raw.response_format);
  if (text) body.text = text;

  return body;
}
