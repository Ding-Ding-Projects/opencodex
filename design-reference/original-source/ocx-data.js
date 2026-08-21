/* opencodex M3 — realistic offline mock data.
   Shapes mirror the real /api/* payloads used by gui/src/pages/*. */

export const health = { status: "ok", version: "0.0.33.1", uptime: 191_460, port: 4318 };

export const providers = [
  { id: "openai", name: "openai", adapter: "responses", baseUrl: "https://chatgpt.com/backend-api/codex", models: 18, status: "ready", auth: "Codex login", pricing: "paid", type: "login", isDefault: true, req30d: 4820, tok30d: 61_402_118, note: "Built-in. Pool mode across 4 accounts." },
  { id: "anthropic", name: "anthropic", adapter: "anthropic", baseUrl: "https://api.anthropic.com", models: 9, status: "ready", auth: "OAuth (subscription)", pricing: "paid", type: "login", req30d: 1935, tok30d: 24_118_540, note: "Experimental account pool off." },
  { id: "gemini", name: "gemini", adapter: "openai-compat", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", models: 7, status: "ready", auth: "API key", pricing: "paid", type: "cloud", req30d: 1142, tok30d: 18_774_960 },
  { id: "openrouter", name: "openrouter", adapter: "openai-compat", baseUrl: "https://openrouter.ai/api/v1", models: 312, status: "ready", auth: "API key", pricing: "paid", type: "cloud", req30d: 604, tok30d: 7_211_330, allowlist: 12 },
  { id: "deepseek", name: "deepseek", adapter: "openai-compat", baseUrl: "https://api.deepseek.com", models: 4, status: "ready", auth: "API key", pricing: "paid", type: "cloud", req30d: 388, tok30d: 5_902_441 },
  { id: "alibaba", name: "alibaba", adapter: "openai-compat", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", models: 11, status: "ready", auth: "API key", pricing: "paid", type: "cloud", req30d: 141, tok30d: 2_004_712 },
  { id: "cursor", name: "cursor", adapter: "openai-compat", baseUrl: "http://127.0.0.1:0/cursor-static", models: 6, status: "ready", auth: "No key needed", pricing: "free", type: "local", req30d: 0, tok30d: 0, note: "Static public catalog only; live transport disabled." },
  { id: "ollama", name: "ollama", adapter: "openai-compat", baseUrl: "http://127.0.0.1:11434/v1", models: 5, status: "ready", auth: "No key needed", pricing: "free", type: "selfHosted", req30d: 96, tok30d: 812_004 },
  { id: "zai", name: "zai", adapter: "openai-compat", baseUrl: "https://api.z.ai/api/paas/v4", models: 3, status: "needsSetup", auth: "API key", pricing: "paid", type: "cloud", req30d: 0, tok30d: 0, attention: "Missing credentials" },
  { id: "groq", name: "groq", adapter: "openai-compat", baseUrl: "https://api.groq.com/openai/v1", models: 8, status: "needsSetup", auth: "API key", pricing: "free", type: "cloud", req30d: 0, tok30d: 0, attention: "Missing credentials" },
  { id: "xai", name: "xai", adapter: "openai-compat", baseUrl: "https://api.x.ai/v1", models: 4, status: "needsAttention", auth: "API key", pricing: "paid", type: "cloud", req30d: 22, tok30d: 118_204, attention: "Discovery failed (HTTP 401)" },
  { id: "moonshot", name: "moonshot", adapter: "openai-compat", baseUrl: "https://api.moonshot.ai/v1", models: 3, status: "disabled", auth: "API key", pricing: "paid", type: "cloud", req30d: 0, tok30d: 0 },
];

export const modelGroups = [
  {
    provider: "openai", label: "OpenAI native", native: true, models: [
      { id: "gpt-5.5", ctx: 400_000, on: true, modalities: "text, image", effort: "minimal→xhigh" },
      { id: "gpt-5.5-codex", ctx: 400_000, on: true, modalities: "text, image", effort: "low→xhigh" },
      { id: "gpt-5.4-mini", ctx: 272_000, on: true, modalities: "text, image", effort: "low→high" },
      { id: "codex-sol", ctx: 400_000, on: true, modalities: "text, image", effort: "medium→xhigh", badge: "v2" },
      { id: "codex-terra", ctx: 400_000, on: true, modalities: "text", effort: "medium→xhigh", badge: "v2" },
      { id: "codex-luna", ctx: 272_000, on: false, modalities: "text", effort: "low→high", badge: "v1" },
    ],
  },
  {
    provider: "anthropic", label: "anthropic", models: [
      { id: "claude-opus-4-6", ctx: 200_000, on: true, modalities: "text, image", effort: "thinking" },
      { id: "claude-sonnet-4-5", ctx: 1_000_000, on: true, modalities: "text, image", effort: "thinking", cap: "350k cap" },
      { id: "claude-haiku-4-5", ctx: 200_000, on: true, modalities: "text, image" },
      { id: "claude-fable-4-1", ctx: 200_000, on: false, modalities: "text" },
    ],
  },
  {
    provider: "gemini", label: "gemini", models: [
      { id: "gemini-3-pro", ctx: 1_048_576, on: true, modalities: "text, image, audio", cap: "350k cap" },
      { id: "gemini-3-flash", ctx: 1_048_576, on: true, modalities: "text, image" },
      { id: "gemini-2.5-flash-lite", ctx: 1_000_000, on: false, modalities: "text, image" },
    ],
  },
  {
    provider: "deepseek", label: "deepseek", models: [
      { id: "deepseek-v4", ctx: 163_840, on: true, modalities: "text", effort: "reasoner" },
      { id: "deepseek-v4-flash", ctx: 163_840, on: true, modalities: "text" },
    ],
  },
  {
    provider: "openrouter", label: "openrouter", models: [
      { id: "qwen/qwen4-max", ctx: 262_144, on: true, modalities: "text" },
      { id: "z-ai/glm-5", ctx: 204_800, on: true, modalities: "text" },
      { id: "mistral/mistral-large-3", ctx: 131_072, on: false, modalities: "text" },
    ],
  },
  {
    provider: "ollama", label: "ollama", models: [
      { id: "qwen3-coder:30b", ctx: 262_144, on: true, modalities: "text" },
      { id: "gpt-oss:20b", ctx: 131_072, on: false, modalities: "text" },
    ],
  },
];

export const accounts = [
  { id: "main", email: "codingmachineedge@gmail.com", plan: "Pro", main: true, current: true, paused: false, resetCredits: 2, quota: { fiveHour: 41, weekly: 63, monthly: 28 }, resets: { fiveHour: "Today 18:40", weekly: "Mon 09:00", monthly: "Aug 12" } },
  { id: "codex-work", email: "edge.work@gmail.com", plan: "Plus", selected: true, paused: false, resetCredits: 0, quota: { fiveHour: 12, weekly: 22, monthly: 9 }, resets: { fiveHour: "Today 20:05", weekly: "Wed 09:00", monthly: "Aug 03" } },
  { id: "codex-alt", email: "edge.alt@gmail.com", plan: "Plus", paused: false, resetCredits: 1, quota: { fiveHour: 96, weekly: 88, monthly: 74 }, resets: { fiveHour: "Today 17:12", weekly: "Fri 09:00", monthly: "Aug 21" } },
  { id: "team", email: "edge.team@gmail.com", plan: "Go", paused: true, resetCredits: 0, quota: { fiveHour: 100, weekly: 100, monthly: 100 }, resets: { fiveHour: "Tomorrow 06:00", weekly: "Sun 09:00", monthly: "Aug 30" }, needsReauth: true },
];

export const combos = [
  { id: "flash", alias: "deepseek-v4-flash", strategy: "failover", sticky: 4, targets: [{ p: "deepseek", m: "deepseek-v4-flash", w: 1 }, { p: "openrouter", m: "z-ai/glm-5", w: 1 }, { p: "gemini", m: "gemini-3-flash", w: 1 }] },
  { id: "heavy", alias: "vendor/heavy-thinker", strategy: "failover", sticky: 2, targets: [{ p: "openai", m: "gpt-5.5", w: 1 }, { p: "anthropic", m: "claude-opus-4-6", w: 1 }] },
  { id: "spread", alias: "", strategy: "roundRobin", sticky: 8, targets: [{ p: "gemini", m: "gemini-3-pro", w: 3 }, { p: "openrouter", m: "qwen/qwen4-max", w: 2 }, { p: "deepseek", m: "deepseek-v4", w: 1 }] },
  { id: "local-only", alias: "local/fast", strategy: "failover", sticky: 4, targets: [{ p: "ollama", m: "qwen3-coder:30b", w: 1 }], attention: "few" },
];

export const subagentPicks = ["gpt-5.5-codex", "claude-opus-4-6", "gemini-3-pro", "deepseek-v4", "qwen/qwen4-max"];

export const logs = [
  { t: "18:22:41", id: "resp_9fA2c1", model: "gpt-5.5-codex", effort: "high", provider: "openai", status: 200, tokens: { in: 41_204, out: 3_118, cr: 38_912, cw: 2_292, r: 1_904 }, tps: 78.4, cost: 0.412, ms: 39_800, surface: "codex", conv: "conv_7c31" },
  { t: "18:19:07", id: "resp_9f9x02", model: "claude-opus-4-6", effort: "thinking", provider: "anthropic", status: 200, tokens: { in: 22_010, out: 1_842, cr: 19_004, cw: 3_006, r: 640 }, tps: 44.1, cost: 0.386, ms: 41_760, surface: "claude", conv: "conv_7c31" },
  { t: "18:14:55", id: "resp_9f8m41", model: "combo/spread", effort: "medium", provider: "gemini", status: 200, tokens: { in: 8_120, out: 964, cr: 0, cw: 0, r: 0 }, tps: 61.0, cost: 0.021, ms: 15_800, surface: "codex", attempts: 2 },
  { t: "18:11:02", id: "resp_9f7q88", model: "gpt-5.5", effort: "xhigh", provider: "openai", status: 429, tokens: null, tps: null, cost: null, ms: 1_240, surface: "codex", error: "rate_limit_exceeded", upstream: "5h limit reached on codex-alt" },
  { t: "18:10:58", id: "resp_9f7q87", model: "gpt-5.5", effort: "xhigh", provider: "openai", status: 200, tokens: { in: 88_412, out: 6_042, cr: 81_004, cw: 7_408, r: 4_118 }, tps: 91.2, cost: 0.884, ms: 66_280, surface: "codex" },
  { t: "18:04:31", id: "resp_9f6z10", model: "gemini-3-pro", effort: null, provider: "gemini", status: 200, tokens: { in: 12_884, out: 2_204, cr: 0, cw: 0, r: 0 }, tps: 55.7, cost: 0.048, ms: 39_560, surface: "codex" },
  { t: "17:58:12", id: "resp_9f5a02", model: "deepseek-v4", effort: "reasoner", provider: "deepseek", status: 200, tokens: { in: 6_412, out: 3_884, cr: 5_002, cw: 1_410, r: 2_940 }, tps: 38.2, cost: 0.009, ms: 101_600, surface: "codex" },
  { t: "17:51:44", id: "resp_9f4b71", model: "qwen/qwen4-max", effort: null, provider: "openrouter", status: 502, tokens: null, tps: null, cost: null, ms: 8_920, surface: "codex", error: "upstream_unavailable", upstream: "provider returned malformed SSE frame" },
  { t: "17:44:03", id: "resp_9f3c55", model: "claude-sonnet-4-5", effort: "thinking", provider: "anthropic", status: 200, tokens: { in: 141_002, out: 4_118, cr: 132_880, cw: 8_122, r: 1_204 }, tps: 62.8, cost: 0.522, ms: 65_560, surface: "claude" },
  { t: "17:39:21", id: "resp_9f2d18", model: "gpt-5.4-mini", effort: "low", provider: "openai", status: 200, tokens: { in: 2_104, out: 188, cr: 0, cw: 0, r: 0 }, tps: 120.4, cost: 0.002, ms: 1_560, surface: "codex", note: "shadow-call intercept" },
  { t: "17:31:09", id: "resp_9f1e44", model: "grok-4-1", effort: null, provider: "xai", status: 401, tokens: null, tps: null, cost: null, ms: 420, surface: "grok", error: "invalid_api_key", upstream: "key rejected by provider" },
  { t: "17:22:56", id: "resp_9f0f01", model: "qwen3-coder:30b", effort: null, provider: "ollama", status: 200, tokens: { in: 4_882, out: 1_204, cr: 0, cw: 0, r: 0 }, tps: 22.1, cost: 0, ms: 54_480, surface: "codex", unpriced: true },
];

export const debugLines = [
  { t: "18:22:39", stream: "usage", text: "usage.extract openai/gpt-5.5-codex reported=true input=41204 output=3118 cache_read=38912" },
  { t: "18:19:04", stream: "usage", text: "usage.extract anthropic/claude-opus-4-6 reported=true thinking_tokens=640" },
  { t: "18:14:52", stream: "provider", text: "combo/spread attempt=1 provider=gemini result=ok weight=3 sticky=8/8" },
  { t: "18:11:02", stream: "provider", text: "openai 429 retry_after=52s cooldown=account:codex-alt" },
  { t: "17:51:44", stream: "provider", text: "openrouter malformed SSE frame dropped (bytes=118) — request failed closed" },
  { t: "17:39:21", stream: "injection", text: "shadow-call intercept gpt-5.4-mini → gemini-3-flash effort=low" },
  { t: "17:22:50", stream: "injection", text: "multi-agent guidance injected surface=v2 effort_cap=high (requested=max)" },
];

export const usage = {
  summary: { requests: 9148, measured: 8804, reported: 8412, totalTokens: 120_246_375, cachedTokens: 96_402_118, cacheWrites: 8_004_221, coverageRatio: 0.962, activeDays: 27, cost: 42.18, unpriced: 96 },
  models: [
    { id: "gpt-5.5-codex", provider: "openai", requests: 3120, tokens: 48_212_004, share: 0.401 },
    { id: "claude-opus-4-6", provider: "anthropic", requests: 1240, tokens: 22_118_540, share: 0.184 },
    { id: "gemini-3-pro", provider: "gemini", requests: 988, tokens: 18_774_960, share: 0.156 },
    { id: "gpt-5.5", provider: "openai", requests: 1700, tokens: 13_190_114, share: 0.110 },
    { id: "deepseek-v4", provider: "deepseek", requests: 388, tokens: 5_902_441, share: 0.049 },
    { id: "qwen/qwen4-max", provider: "openrouter", requests: 604, tokens: 7_211_330, share: 0.060 },
    { id: "claude-sonnet-4-5", provider: "anthropic", requests: 695, tokens: 2_000_000, share: 0.017 },
    { id: "qwen3-coder:30b", provider: "ollama", requests: 96, tokens: 812_004, share: 0.007 },
  ],
  providersBreakdown: [
    { id: "openai", requests: 4820, tokens: 61_402_118, share: 0.511 },
    { id: "anthropic", requests: 1935, tokens: 24_118_540, share: 0.201 },
    { id: "gemini", requests: 1142, tokens: 18_774_960, share: 0.156 },
    { id: "openrouter", requests: 604, tokens: 7_211_330, share: 0.060 },
    { id: "deepseek", requests: 388, tokens: 5_902_441, share: 0.049 },
    { id: "alibaba", requests: 141, tokens: 2_004_712, share: 0.017 },
    { id: "ollama", requests: 96, tokens: 812_004, share: 0.007 },
  ],
  coverage: [
    { key: "measured", label: "Measured", value: 8804 },
    { key: "reported", label: "Provider reported", value: 8412 },
    { key: "estimated", label: "Estimated", value: 392 },
  ],
  // 13 weeks × 7 days of intensity 0..4
  heatmap: [0,1,2,3,1,0,0, 2,3,4,4,3,1,0, 1,2,2,3,4,2,0, 0,1,3,4,4,3,1, 2,2,3,3,2,0,0, 1,3,4,4,4,2,1, 0,0,2,3,3,1,0, 1,2,3,4,3,2,0, 2,3,3,4,4,3,1, 0,1,2,2,3,1,0, 1,2,4,4,3,2,1, 2,3,3,3,4,2,0, 1,2,3,4,2,1,0],
};

export const storage = {
  home: "~/.codex",
  totalBytes: 18_412_884_992,
  files: 41_882,
  buckets: [
    { key: "sessions", label: "Active sessions", bytes: 6_112_884_992, files: 12_402, oldest: "2026-02-04", newest: "2026-07-29" },
    { key: "archived_sessions", label: "Archived sessions", bytes: 9_882_004_112, files: 26_118, oldest: "2025-08-11", newest: "2026-07-02" },
    { key: "logs_db", label: "Logs database", bytes: 1_204_884_000, files: 3, oldest: "2025-08-11", newest: "2026-07-29", rows: 812_004 },
    { key: "state_db", label: "State database", bytes: 884_112_000, files: 3, oldest: "2025-08-11", newest: "2026-07-29", rows: "unknown (locked)" },
    { key: "attachments", label: "Attachments", bytes: 288_004_112, files: 3_204, oldest: "2025-11-02", newest: "2026-07-28" },
    { key: "deletion_manifests", label: "Deletion manifests", bytes: 41_004, files: 148, oldest: "2026-01-14", newest: "2026-07-22" },
    { key: "other", label: "Other", bytes: 40_951_776, files: 7, oldest: "2025-08-11", newest: "2026-07-29" },
  ],
  largest: [
    { path: "archived_sessions/2025-11/rollout-2025-11-14T02-41-08.jsonl", bytes: 812_884_112 },
    { path: "logs.sqlite", bytes: 704_112_000 },
    { path: "archived_sessions/2026-01/rollout-2026-01-02T19-04-55.jsonl", bytes: 611_004_882 },
    { path: "state.sqlite", bytes: 588_112_000 },
    { path: "archived_sessions/2025-09/rollout-2025-09-28T11-22-40.jsonl", bytes: 402_884_004 },
  ],
  trash: [
    { id: "trash-20260722-1", when: "2026-07-22 04:18", files: 1_204, bytes: 2_004_882_112, mode: "quarantine" },
    { id: "trash-20260614-2", when: "2026-06-14 21:02", files: 402, bytes: 611_004_002, mode: "quarantine" },
  ],
  policy: { enabled: false, thresholdGiB: 12, target: "percent", percent: 25, reduceToGiB: 8, schedule: "manual", mode: "quarantine", lastRun: "2026-07-22 04:18", lastRunDetail: "Removed 1,204 · freed 1.87 GiB", nextRun: "Never" },
};

export const apiKeys = [
  { name: "raycast", key: "ocx_live_9f2c…a41d", created: "2026-06-02" },
  { name: "obsidian-copilot", key: "ocx_live_11ab…7c02", created: "2026-05-14" },
  { name: "(unnamed)", key: "ocx_live_4d88…0f31", created: "2026-03-30" },
];

export const apiCatalog = [
  { id: "gpt-5.5-codex", source: "ChatGPT pool", protocols: "Responses · Chat Completions" },
  { id: "claude-opus-4-6", source: "anthropic", protocols: "Messages · Chat Completions" },
  { id: "combo/spread", source: "Combo route", protocols: "Responses · Chat Completions" },
  { id: "deepseek-v4-flash", source: "Combo route", protocols: "Chat Completions" },
  { id: "qwen4-max-preview", source: "Custom", protocols: "Chat Completions" },
];

export const claudeSettings = {
  enabled: true,
  authMode: "auto",
  effective: "Auto: subscription — Claude auth found via macOS Keychain",
  systemEnv: false,
  fastMode: "auto",
  autoContext: true,
  autoCompactWindow: 350_000,
  injectAgents: true,
  smallFastModel: "gemini-3-flash",
  mappings: [
    { from: "claude-sonnet-4-5", to: "gemini/gemini-3-pro" },
    { from: "claude-haiku-4-5", to: "openai/gpt-5.4-mini" },
  ],
  aliases: [
    { id: "ocx-gpt-5.5-codex", provider: "openai", ctx: "400k" },
    { id: "ocx-gemini-3-pro", provider: "gemini", ctx: "1M" },
    { id: "ocx-deepseek-v4", provider: "deepseek", ctx: "164k" },
    { id: "ocx-qwen4-max", provider: "openrouter", ctx: "262k" },
  ],
};

export const claudeDesktop = {
  port: 4318,
  status: "applied",
  families: [
    { key: "opus", label: "Opus", models: [{ id: "gpt-5.5", def: true, ctx: "400k", effort: true }, { id: "claude-opus-4-6", ctx: "200k", effort: true }] },
    { key: "sonnet", label: "Sonnet", models: [{ id: "gemini-3-pro", def: true, ctx: "1M", big: true }, { id: "deepseek-v4", ctx: "164k" }] },
    { key: "haiku", label: "Haiku", models: [{ id: "gpt-5.4-mini", def: true, ctx: "272k" }] },
    { key: "fable", label: "Fable", models: [] },
  ],
};

export const grok = {
  configured: true,
  endpoint: "http://127.0.0.1:4318/v1",
  path: "~/.grok/settings.json",
  native: [
    { id: "grok-4-1", alias: "grok-4-1", ctx: "256k", on: true },
    { id: "grok-4-1-fast", alias: "grok-4-1-fast", ctx: "256k", on: true },
  ],
  routed: [
    { id: "gpt-5.5-codex", alias: "ocx-gpt-5.5-codex", ctx: "400k", on: true },
    { id: "claude-opus-4-6", alias: "ocx-claude-opus-4-6", ctx: "200k", on: false },
    { id: "gemini-3-pro", alias: "ocx-gemini-3-pro", ctx: "1M", on: true },
    { id: "deepseek-v4", alias: "ocx-deepseek-v4", ctx: "164k", on: false },
  ],
};

export const startup = {
  health: "protected",
  routing: "Local proxy",
  protection: "Background service",
  onDemand: true,
  service: { installed: true, state: "Healthy" },
  shim: { installed: true, state: "CLI only" },
  tray: { installed: true, state: "Running" },
  commands: [
    { label: "Recommended: persistent background service", cmd: "ocx service install" },
    { label: "Alternative: CLI launcher shim", cmd: "ocx shim install" },
    { label: "Fail-safe: restore native Codex routing", cmd: "ocx stop --restore-native" },
  ],
};

export const changelog = [
  { version: "0.0.33.1", date: "2026-07-24", changes: [
    { cat: "Added", text: "Material Design 3 dashboard shell with browser-style tabs, per-element appearance editors, and an adaptive nav rail." },
    { cat: "Added", text: "Regex builder surface plus regex-wired search on every settings panel." },
    { cat: "Fixed", text: "Sidebar locale menu no longer escapes the rail when a sixth locale is added." },
  ] },
  { version: "0.0.32.1", date: "2026-07-11", changes: [
    { cat: "Added", text: "Version history panel: append-only snapshots of providers, accounts, keys, combos and settings." },
    { cat: "Changed", text: "Restoring a revision now records a new revision instead of rewriting history." },
    { cat: "Security", text: "Snapshot AAD is bound to a stable record identifier so restored rows stay decryptable." },
  ] },
  { version: "0.0.31.1", date: "2026-06-28", changes: [
    { cat: "Added", text: "Non-blocking snackbars with a notification centre; informational modals removed." },
    { cat: "Fixed", text: "Quota bars clipped their reset time at 150% display scale." },
  ] },
  { version: "0.0.30.0", date: "2026-06-09", changes: [
    { cat: "Added", text: "Claude Desktop family routing with drag-and-drop lanes and JSON import/export." },
    { cat: "Changed", text: "Auto-summarize point defaults to 350k and never exceeds a model's real limit." },
  ] },
  { version: "0.0.29.0", date: "2026-05-22", changes: [
    { cat: "Added", text: "Combo round-robin strategy with deterministic smooth weighting and sticky successes." },
    { cat: "Fixed", text: "Combo attempts were priced twice in the estimated-cost column." },
  ] },
  { version: "0.0.28.0", date: "2026-05-02", changes: [
    { cat: "Added", text: "Archived-session cleanup with quarantine, preview digests and a restore path." },
    { cat: "Security", text: "Permanent deletion requires an explicit second confirmation." },
  ] },
  { version: "0.0.27.0", date: "2026-04-14", changes: [
    { cat: "Added", text: "Codex account pool: quota-aware rotation, cooldowns, and automatic switching thresholds." },
    { cat: "Fixed", text: "Reset credits were consumed newest-first instead of oldest-first." },
  ] },
  { version: "0.0.26.0", date: "2026-03-27", changes: [
    { cat: "Added", text: "Language modes (English, Cantonese, bilingual) and per-language funny-level sliders." },
    { cat: "Added", text: "In-app changelog viewer with date filtering and text search." },
  ] },
];

export const revisions = [
  { id: "r48", when: "2026-07-29 04:18", label: "Added provider \"groq\"", kind: "create", scope: "providers", detail: "+ providers.groq (adapter openai-compat, base https://api.groq.com/openai/v1)" },
  { id: "r47", when: "2026-07-28 22:02", label: "Changed seed colour and density", kind: "settings", scope: "settings", detail: "~ appearance.seed #6750A4 → #2F6B4F\n~ appearance.density 2 → 3" },
  { id: "r46", when: "2026-07-28 19:40", label: "Deleted account \"edge.old@gmail.com\"", kind: "delete", scope: "accounts", detail: "- accounts.codex-old (ciphertext preserved, AAD bound to stable uid)" },
  { id: "r45", when: "2026-07-27 11:14", label: "Restored revision r41 (\"Added combo spread\")", kind: "restore", scope: "combos", detail: "+ combos.spread restored as new revision r45 (r44 kept)" },
  { id: "r44", when: "2026-07-26 08:33", label: "Deleted combo \"spread\"", kind: "delete", scope: "combos", detail: "- combos.spread (3 targets)" },
  { id: "r43", when: "2026-07-25 16:57", label: "Rotated API key \"raycast\"", kind: "settings", scope: "keys", detail: "~ keys.raycast (ciphertext replaced; created 2026-06-02)" },
  { id: "r42", when: "2026-07-24 09:21", label: "Enabled Claude auto-register subagents", kind: "settings", scope: "settings", detail: "~ claude.injectAgents false → true" },
  { id: "r41", when: "2026-07-23 20:05", label: "Added combo \"spread\"", kind: "create", scope: "combos", detail: "+ combos.spread (roundRobin, 3 targets, sticky 8)" },
];

export const seededNotifications = [
  { id: "n6", tone: "ok", title: "Sync complete. 6 model(s) appended.", body: "Codex's model cache was invalidated — no restart needed.", when: "18:24", surface: "Dashboard" },
  { id: "n5", tone: "warn", title: "codex-alt reached its 5-hour limit", body: "Automatic switching moved the next request to edge.work@gmail.com.", when: "18:11", surface: "Codex Auth", action: "View details" },
  { id: "n4", tone: "err", title: "openrouter returned a malformed SSE frame", body: "resp_9f4b71 failed closed rather than falling back to the default provider.", when: "17:51", surface: "Logs", action: "View details" },
  { id: "n3", tone: "ok", title: "Combo \"spread\" saved.", body: "Round-robin across 3 targets, sticky 8.", when: "17:44", surface: "Combos", action: "Undo" },
  { id: "n2", tone: "warn", title: "xai discovery failed (HTTP 401)", body: "The stored key was rejected. Showing configured models for now.", when: "17:31", surface: "Providers" },
  { id: "n1", tone: "ok", title: "Quarantined 1,204 file(s) (1.87 GiB).", body: "Files moved to ~/.codex/.trash and can be restored.", when: "04:18", surface: "Storage", action: "Undo" },
];

export const dimSum = [
  { en: "Shrimp dumpling", yue: "蝦餃", note: "har gow" },
  { en: "Pork and shrimp dumpling", yue: "燒賣", note: "siu mai" },
  { en: "Barbecue pork bun", yue: "叉燒包", note: "char siu bao" },
  { en: "Rice noodle roll", yue: "腸粉", note: "cheung fun" },
  { en: "Egg tart", yue: "蛋撻", note: "daan taat" },
  { en: "Steamed spare ribs", yue: "豉汁排骨", note: "pai gwat" },
  { en: "Turnip cake", yue: "蘿蔔糕", note: "lo bak go" },
  { en: "Lotus leaf rice", yue: "糯米雞", note: "no mai gai" },
];

export const regexPresets = [
  { label: "Model id", pattern: "^(?<vendor>[a-z0-9-]+)\\/(?<model>[a-z0-9.\\-:]+)$", sample: "openrouter/qwen4-max\nz-ai/glm-5\ngpt-5.5-codex" },
  { label: "Request id", pattern: "resp_(?<id>[0-9a-f]{6})", sample: "resp_9fA2c1 200 · resp_9f7q88 429 · resp_9f4b71 502" },
  { label: "Base URL host", pattern: "https?:\\/\\/(?<host>[^\\/]+)(?<path>\\/.*)?", sample: "https://api.deepseek.com\nhttp://127.0.0.1:11434/v1" },
  { label: "Rollout file", pattern: "rollout-(?<date>\\d{4}-\\d{2}-\\d{2})T(?<time>[\\d-]+)\\.jsonl", sample: "archived_sessions/2026-01/rollout-2026-01-02T19-04-55.jsonl" },
];

export const regexTokens = [
  { group: "Literals", items: [{ ins: "abc", label: "abc" }, { ins: "\\.", label: "\\. escaped dot" }, { ins: "\\\\", label: "\\\\ backslash" }] },
  { group: "Character classes", items: [{ ins: "\\d", label: "\\d digit" }, { ins: "\\w", label: "\\w word" }, { ins: "\\s", label: "\\s space" }, { ins: "[a-z]", label: "[a-z] range" }, { ins: "[^/]", label: "[^/] negated" }, { ins: "\\p{Script=Han}", label: "\\p{Script=Han} (u flag)" }] },
  { group: "Anchors", items: [{ ins: "^", label: "^ start" }, { ins: "$", label: "$ end" }, { ins: "\\b", label: "\\b word boundary" }] },
  { group: "Groups", items: [{ ins: "(…)", label: "( ) capture" }, { ins: "(?<name>…)", label: "(?<name> ) named" }, { ins: "(?:…)", label: "(?: ) non-capturing" }, { ins: "(?=…)", label: "(?= ) lookahead" }] },
  { group: "Alternation", items: [{ ins: "a|b", label: "a|b either" }] },
  { group: "Quantifiers", items: [{ ins: "*", label: "* zero or more" }, { ins: "+", label: "+ one or more" }, { ins: "?", label: "? optional" }, { ins: "{2,4}", label: "{2,4} range" }, { ins: "+?", label: "+? lazy" }] },
];

export const settingsIndex = [
  { tab: "appearance", label: "Theme", desc: "Light, dark or follow the system", value: "System" },
  { tab: "appearance", label: "Seed colour", desc: "Derives the whole Material 3 tonal palette", value: "#2F6B4F" },
  { tab: "appearance", label: "Density", desc: "Comfortable Material 3 through to the original console density", value: "3" },
  { tab: "appearance", label: "Interface font", desc: "Installed and bundled faces with CJK-safe fallback", value: "Roboto Flex" },
  { tab: "appearance", label: "Font size", desc: "Type scale multiplier", value: "100%" },
  { tab: "appearance", label: "Font weight", desc: "Base weight for interface text", value: "400" },
  { tab: "language", label: "Language mode", desc: "English, Cantonese or bilingual", value: "English" },
  { tab: "language", label: "Funny level — English", desc: "1 fully serious through 5 maximum playfulness", value: "3" },
  { tab: "language", label: "Funny level — 廣東話", desc: "1 fully serious through 5 maximum playfulness", value: "3" },
  { tab: "language", label: "Spoken narrator", desc: "Off by default; serialized one utterance at a time", value: "Off" },
  { tab: "language", label: "Dim sum surprise", desc: "1% chance at launch of a non-blocking dim sum card", value: "On" },
  { tab: "claude", label: "Claude connection", desc: "When off, Claude Code cannot use this proxy", value: "On" },
  { tab: "claude", label: "Auth mode", desc: "Subscription, proxy, or auto-detect", value: "Auto" },
  { tab: "claude", label: "Fast Mode (OpenAI)", desc: "Controls service_tier for OpenAI models", value: "Auto" },
  { tab: "claude", label: "Auto-summarize point", desc: "Older messages are summarized at this context size", value: "350k" },
  { tab: "storage", label: "Auto-cleanup policy", desc: "Batch cleanup when archived sessions exceed a threshold", value: "Off" },
  { tab: "storage", label: "Deletion mode", desc: "Quarantine or permanent delete", value: "Quarantine" },
  { tab: "codex-auth", label: "Automatic account switching", desc: "Switches at a usage threshold to a fresher account", value: "On, 85%" },
  { tab: "codex-auth", label: "Rotation strategy", desc: "Quota, round-robin or fill-first", value: "Quota" },
  { tab: "startup", label: "On-demand startup", desc: "Allows a launcher shim to run ocx ensure", value: "Enabled" },
];

export const fontChoices = [
  { id: "roboto-flex", label: "Roboto Flex", stack: "'Roboto Flex', 'Noto Sans HK', system-ui, sans-serif" },
  { id: "roboto", label: "Roboto", stack: "Roboto, 'Noto Sans HK', system-ui, sans-serif" },
  { id: "system", label: "System UI", stack: "system-ui, -apple-system, 'Noto Sans HK', sans-serif" },
  { id: "noto-hk", label: "Noto Sans HK", stack: "'Noto Sans HK', 'Roboto Flex', sans-serif" },
  { id: "mono", label: "Roboto Mono", stack: "'Roboto Mono', ui-monospace, monospace" },
];

export const elementTargets = [
  { id: "navRail", label: "Navigation rail" },
  { id: "tabStrip", label: "Tab strip" },
  { id: "appBar", label: "Top app bar" },
  { id: "card", label: "Cards" },
  { id: "table", label: "Data tables" },
  { id: "button", label: "Filled buttons" },
];
