import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPackageIdentity } from "../lib/build-identity";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

type HelpEntry = {
  usage: string;
  summary: string;
  details?: string[];
};

const helpEntries: Record<string, HelpEntry> = {
  init: { usage: "ocx init", summary: "Interactive setup for providers and Codex config injection." },
  setup: { usage: "ocx setup", summary: "Interactive setup for providers and Codex config injection (alias of init)." },
  start: { usage: "ocx start [--port <port>]", summary: "Start the proxy server and sync models to Codex." },
  stop: { usage: "ocx stop", summary: "Stop the proxy and restore native Codex config." },
  restore: {
    usage: "ocx restore [back]",
    summary: "Restore native Codex config without stopping the proxy; `restore back` re-points codex at the running proxy.",
  },
  eject: {
    usage: "ocx eject [back]",
    summary: "Restore native Codex config without stopping the proxy; `eject back` re-points codex at the running proxy.",
  },
  "recover-history": {
    usage: "ocx recover-history --legacy-openai",
    summary: "Explicitly recover pre-backup syncResumeHistory rows.",
  },
  uninstall: {
    usage: "ocx uninstall",
    summary: "Remove service/shim/config and restore native Codex.",
    details: [
      "Alias: ocx remove",
      "Config cleanup requires ownership metadata created by a fresh install; legacy or shared directories are left in place.",
    ],
  },
  remove: {
    usage: "ocx remove",
    summary: "Remove service/shim/config and restore native Codex.",
    details: [
      "Alias of: ocx uninstall",
      "Config cleanup requires ownership metadata created by a fresh install; legacy or shared directories are left in place.",
    ],
  },
  service: {
    usage: "ocx service [install|repair|restart|start|stop|status|uninstall|remove]",
    summary: "Run as a background service.",
    details: [
      "With no subcommand, installs when absent or repairs/restarts an existing service.",
      "`restart` is an alias of `repair` and does not re-register an installed service.",
      "Use `ocx service status` to see diagnostics and log paths.",
    ],
  },
  "codex-shim": {
    usage: "ocx codex-shim <install|status|uninstall|remove>",
    summary: "Auto-start the proxy when `codex` launches.",
    details: ["Use `remove` as an alias for `uninstall`."],
  },
  tray: {
    usage: "ocx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]",
    summary: "Install and control the Windows status tray icon.",
    details: [
      "The tray starts at Windows login and provides one-click proxy controls.",
      "Tray start/stop controls the icon only; use its menu to start or stop the proxy.",
      "--no-start (install only) installs the tray without launching it immediately.",
    ],
  },
  ensure: { usage: "ocx ensure", summary: "Ensure the proxy is running and Codex config/cache are current." },
  sync: {
    usage: "ocx sync [--restart-codex]",
    summary: "Fetch provider models and inject them into Codex config.",
    details: [
      "After writing the catalog, warns if long-lived Codex app-server processes are still running.",
      "--restart-codex sends SIGTERM only to matching app-server / code-mode-host processes (may interrupt active turns).",
    ],
  },
  "sync-cache": {
    usage: "ocx sync-cache [--restart-codex]",
    summary: "Refresh Codex's model cache from the active catalog.",
    details: [
      "Warns when Codex app-server processes still hold an in-memory model list.",
      "--restart-codex sends SIGTERM only to matching app-server / code-mode-host processes (may interrupt active turns).",
    ],
  },
  status: { usage: "ocx status", summary: "Check proxy server status." },
  doctor: { usage: "ocx doctor", summary: "Diagnose environment/network issues (paths, WSL /mnt, proxy env, ChatGPT reachability)." },
  debug: {
    usage: "ocx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>",
    summary: "Show or toggle runtime provider, usage, injection, and Claude debug capture.",
    details: [
      "Provider: ocx debug provider on | off | status | reset | logs [-f]",
      "Usage JSONL: ocx debug usage on | off | status | reset | logs [-f]",
      "Env default: OCX_DEBUG=1 (legacy OCX_DEBUG_FRAMES still works)",
    ],
  },
  login: { usage: "ocx login <provider>", summary: "OAuth or API-key login for a provider." },
  logout: { usage: "ocx logout <provider>", summary: "Remove a stored provider login." },
  gui: { usage: "ocx gui", summary: "Open the opencodex dashboard." },
  changelog: {
    usage: "ocx changelog [--from <date>] [--to <date>] [--search <text>] [--regex] [--limit <n>] [--json]",
    summary: "Show released versions and their changes.",
    details: [
      "--from/--to       Inclusive ISO date range (YYYY-MM-DD).",
      "--search <text>   Case-insensitive text search; add --regex for a JavaScript regex.",
      "--limit <n>       Maximum releases (default 20, 0 means all).",
      "--json            Machine-readable output.",
    ],
  },
  export: {
    usage: "ocx export <path> --yes | ocx export --history [--json] | ocx export data <dataset> [--format <format>] [--out <path>] [--list]",
    summary: "Export data or a full state backup; full state exports contain plaintext secrets.",
    details: [
      "data <dataset>    Export a redacted dashboard dataset; use --list to see datasets and formats.",
      "--history         List local account/config snapshots.",
      "<path> --yes      Export complete config, account, and auth state, including plaintext secrets.",
      "",
      "The full-state form requires a private mode-0600 file and cannot write to stdout.",
      "Store its output encrypted and never commit or upload it.",
    ],
  },
  host: {
    usage: "ocx host <status|enable|disable> [--hostname <addr>] [--new-key [name]] [--yes] [--json]",
    summary: "Expose the authenticated proxy and dashboard to trusted devices on your network.",
    details: [
      "status    Show the bind address, credential state, and URLs for other devices.",
      "enable    Bind to the network. Requires --yes and a data-plane credential.",
      "disable   Return to loopback (this machine only).",
      "--new-key [name] generates a credential; name is only a short label, never a secret value.",
      "",
      "A remote dashboard must authenticate with that remote proxy's ADMIN token.",
      "The command never accepts that token (or any credential) in argv; enter it only in the dashboard prompt.",
      "Direct HTTP is suitable only on a trusted LAN; prefer an SSH tunnel for untrusted links.",
    ],
  },
  launch: {
    usage: "ocx launch [list|<target>] [--json]",
    summary: "Open an installed agent CLI or desktop app.",
    details: [
      "list      Show the fixed catalog and installation state (the safe default).",
      "<target>  Launch one catalog id; arbitrary executable paths and arguments are not accepted.",
    ],
  },
  terminal: {
    usage: "ocx terminal [list|run <preset>] [--command \"...\"] [--wait <ms>] [--json]",
    summary: "Run a command through a local opencodex terminal session.",
    details: [
      "list                 Show the fixed preset catalog (the safe default).",
      "run <preset>         Start one local session, collect output, then close it.",
      "--command \"...\"    Optional command sent to the session.",
      "--wait <ms>          Collection time from 1 to 120000 (default 4000).",
      "",
      "Command-line arguments may be visible to other local processes. Never put secrets in --command.",
    ],
  },
  update: {
    usage: "ocx update [--tag latest|preview]",
    summary: "Update opencodex. Preview installs stay on the preview tag unless overridden.",
  },
  provider: {
    usage: "ocx provider <list|add|edit|test|remove|show|set-default|selected|quota|presets|account-mode>",
    summary: "Non-interactive provider management.",
    details: [
      "Subcommands: list, add/edit/test/remove/show, set-default, selected, quota, presets, account-mode",
      "Registry providers are auto-configured by name. Custom providers need --adapter and --base-url.",
      "Run `ocx provider --help` for full usage and examples.",
    ],
  },
  account: {
    usage: "ocx account <list|current|use|refresh|auto-switch|login|reauth|code|cancel|remove|add-key|reset-credits> ...",
    summary: "List and switch provider accounts and API-key pools (GUI parity).",
    details: [
      "list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).",
      "current <provider>  Show the active account or key.",
      "use <provider> <id> Switch the active credential; 'main' selects the Codex App login.",
      "refresh <provider>  Force-refresh Codex or provider quota reports.",
      "auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.",
      "remove <provider> <id> --yes  Remove a stored account or key after an existence check.",
      "add-key <provider> [--label <label>]  Add a key read only from piped stdin.",
      "login/reauth/code/cancel  Run browser or manual-code auth from a headless shell.",
      "reset-credits <id|main> [--consume --yes] [--operation-id <uuid>]  Inspect or consume Codex reset credits.",
      "Codex pool switches apply to new sessions; running threads keep their account.",
    ],
  },
  models: {
    usage: "ocx models <list|live|add|edit|remove|enable|disable|provider|selected|context|shadow> ...",
    summary: "List models and manage custom (manually registered) models.",
    details: [
      "List available models from static config with no subcommand (liveModels may add more at runtime).",
      "add: register a model the provider catalog does not advertise yet.",
      "  --display-name <name>     Human label (no slashes).",
      "  --context-window <tokens> e.g. 200000.",
      "  --modalities text,image   Comma-separated (text|image|audio).",
      "remove: delete a custom model by UUID or <provider>/<modelId>.",
      "list-custom: show all custom models.",
      "Changes apply immediately to a running proxy (catalog sync).",
    ],
  },
  model: {
    usage: "ocx model <subcommand>",
    summary: "Alias of ocx models.",
  },
  combo: {
    usage: "ocx combo <list|show|set|remove> ...",
    summary: "Manage combo failover and round-robin virtual models.",
    details: ["Alias hierarchy: ocx route combo ...", "Use --targets provider/model[:weight],provider/model[:weight]."],
  },
  route: {
    usage: "ocx route combo <list|show|set|remove> ...",
    summary: "Manage routing features; combo is currently the supported routing resource.",
  },
  agent: {
    usage: "ocx agent <status|injection|effort|subagents|roles|fallback|sidecar> ...",
    summary: "Manage headless multi-agent, roster, named roles, effort, injection, and sidecar settings.",
  },
  observe: {
    usage: "ocx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...",
    summary: "Inspect proxy requests, usage, storage, memory, and debug data.",
  },
  narrator: {
    usage: "ocx narrator <status|voices|speak> [--source <local|edge|all>] [--lang <tag>] [--voice <name>] [--edge] [--json]",
    summary: "List narrator voices and speak a line without a browser.",
    details: [
      "status    Installed voices, the synthesis bounds, and where the narrator's settings actually live.",
      "voices    List installed platform voices; --source edge|all adds the Microsoft Edge online catalogue.",
      "speak     Synthesize one line to an MP3; --out <path> or --out - for stdout.",
      "--lang <tag> filters by language (zh matches zh-HK and zh-CN); --search matches names and locales.",
      "--rate and --pitch are multipliers from 0.5 to 2, where 1 is the voice's own normal delivery.",
      "",
      "--edge is required by every path that reaches the network, and is never implied.",
      "Edge online voices send the text you pass to Microsoft over the internet every time they speak;",
      "installed platform voices stay on this computer and need no network at all.",
      "That service is the undocumented one Edge uses to read pages aloud and can change or be blocked",
      "at any time, so a sudden refusal is the service refusing this client rather than a fault in your text.",
      "",
      "Whether the narrator speaks, its language, and the voice chosen per language are the dashboard's own",
      "browser-profile state, not server configuration, so this command reports them as unreadable rather",
      "than guessing. Change them in the dashboard under Language & voice.",
    ],
  },
  "school-mode": {
    usage: "ocx school-mode <status|enable|disable|credential|rename> ...",
    summary: "Read and change the shared School Mode record without a browser.",
    details: [
      "status                    Whether the mode is on, the name in use, whether an unlock credential",
      "                          exists, whether the shared record is readable, and the exact folder",
      "                          that resets everything if deleted. Never reports anything about the",
      "                          credential's value, length or composition.",
      "enable                    Turn it on. Refused until an unlock credential exists, because there",
      "                          would otherwise be no way to turn it back off.",
      "disable                   Turn it off. The secret is read from STANDARD INPUT, never an",
      "                          argument: an argument reaches the process list, the shell history and",
      "                          any log that records a command line.",
      "credential                Set or change the unlock secret; both are read from standard input.",
      "                          Changing an existing one requires the current one.",
      "rename <name> | --clear   The name every surface must use, or restore the shipped one.",
      "",
      "Unlike ocx narrator and ocx schedule, these are real answers rather than signposts: School",
      "Mode's whole purpose is one record shared across apps, so it lives on disk and the server owns",
      "it. It is a user-experience lock, not a security boundary — deleting the folder resets it.",
    ],
  },
  schedule: {
    usage: "ocx schedule <status|list|show|active|test-api|test-ha|ha-token> ...",
    summary: "Headless checks for scheduled-settings rules, without a browser.",
    details: [
      "status/list/show/active   Rules live only in the dashboard's own browser profile (local storage",
      "                          key ocx-m3:schedule), so these report that plainly and name where to",
      "                          manage rules instead — the same shape ocx narrator status uses for the",
      "                          narrator's own browser-only preferences.",
      "test-api <url>            Test an api-sourced rule's endpoint through the same server-side",
      "                          resolve-api route the dashboard uses (SSRF-checked, bounded, https or",
      "                          loopback http only).",
      "test-ha --base-url <url> --entity-id <id> --token-ref <ref>",
      "                          Test a Home Assistant-gated rule's entity through the same server-side",
      "                          ha-state route the dashboard uses.",
      "ha-token status --token-ref <ref>",
      "                          Whether a Home Assistant token is stored for a rule — never its value.",
      "ha-token clear --token-ref <ref>",
      "                          Delete a stored Home Assistant token.",
      "",
      "There is deliberately no ha-token set: storing a token requires the plaintext value, and this",
      "command never accepts, prints, or logs a secret. Type it once into the dashboard's own password",
      "field under Scheduled settings.",
    ],
  },
  pdf: {
    usage: "ocx pdf <inspect|metadata|split|merge|extract|reorder|rotate> ...",
    summary: "Inspect, split, merge, extract, reorder, rotate and edit metadata on local PDF files.",
    details: [
      "inspect <path>            Page count, per-page size/rotation, metadata, and capability boundaries",
      "                          (not-a-pdf/malformed/encrypted/bounds-exceeded) — the same disclosure the",
      "                          dashboard's PDF tools page shows before any write.",
      "metadata read <path>      Print title/author/subject/keywords/creator/producer/dates.",
      "metadata write <path> --destination <path> [--title ...] [--author ...] ...",
      "                          Write only the fields given; every other field is left exactly as it was.",
      "split <path> --ranges 1-2,3-5 --destinations a.pdf,b.pdf",
      "                          One output file per range, in the same order as --ranges/--destinations.",
      "merge --sources a.pdf,b.pdf --destination out.pdf",
      "                          Concatenate every source's pages, in the order given.",
      "extract <path> --pages 3,1,2 --destination out.pdf",
      "                          Pull the listed pages into one new PDF, in the order listed (repeats allowed).",
      "reorder <path> --order 3,1,2 --destination out.pdf",
      "                          Every existing page exactly once, in the new order.",
      "rotate <path> --rotations 1:90,2:180 --destination out.pdf [--relative]",
      "                          Set (or, with --relative, add to) each listed page's rotation.",
      "",
      "Every mutating command requires --acknowledge-signed when the source carries a digital signature —",
      "pdf-lib cannot preserve one, so an edit always invalidates it, and this flag is the caller confirming",
      "it saw that disclosure. Encrypted sources are refused outright: there is no password-input channel.",
      "Every write is atomic and is reopened from disk to confirm the actual page order, count, rotation",
      "and metadata match the request before the command reports success; a mismatch deletes the output",
      "and reports the exact failure. Local-machine-gated like ocx export data --open-vscode: refused the",
      "instant the proxy is reachable from the LAN.",
    ],
  },
  convert: {
    usage: "ocx convert <catalog|detect> ...",
    summary: "The universal file converter's categorized adapter catalogue and byte-level file detection.",
    details: [
      "catalog                    Every known format across all eight categories, and whether it is bundled",
      "                          and enabled right now or disabled with its exact missing dependency.",
      "detect <path>               Byte-level detection of a local file — magic numbers and bounded text",
      "                          heuristics only, never a filename extension or claimed content-type.",
      "",
      "Only the Documents/PDF family is actually enabled today, adopting the seven operations ocx pdf",
      "already implements (see 'ocx pdf'). Every other category is listed honestly as disabled, naming",
      "the real dependency it is missing, rather than hidden from the catalogue. Local-machine-gated like",
      "ocx pdf: refused the instant the proxy is reachable from the LAN.",
    ],
  },
  logs: { usage: "ocx logs [filters] [--follow] [--json|--jsonl]", summary: "Alias of ocx observe logs." },
  usage: { usage: "ocx usage [--range <7d|30d|all>] [--surface <all|codex|claude|grok>] [--json]", summary: "Alias of ocx observe usage." },
  storage: { usage: "ocx storage [--json]", summary: "Alias of ocx observe storage." },
  memory: { usage: "ocx memory [--json]", summary: "Alias of ocx observe memory." },
  "memory-sync": {
    usage: "ocx memory-sync <status|install|uninstall|profile> ...",
    summary: "Synchronize canonical global agent memory or inspect project profiles without injecting them.",
    details: [
      "Repository options: --repo PATH, OPENCODEX_GLOBAL_MEMORY_REPO, or ../agent-global-memory from a source checkout.",
      "Mutations require --yes unless --dry-run is supplied. The repository origin must be Ding-Ding-Projects/agent-global-memory.",
      "Profiles: ocx memory-sync profile list|show <slug> [--json] (read-only project-scoped reference material).",
    ],
  },
  access: {
    usage: "ocx access <key|endpoints|models|test> ...",
    summary: "Manage OpenCodex admission API keys and inspect external endpoints.",
  },
  "api-key": { usage: "ocx api-key <list|create|remove> ...", summary: "Alias of ocx access key." },
  grok: { usage: "ocx grok <status|exclude|include|set|clear|apply> ...", summary: "Manage and apply the Grok Build model fence." },
  integration: { usage: "ocx integration <claude|grok> ...", summary: "Manage supported client integrations." },
  system: {
    usage: "ocx system <status|settings|startup|diagnostics|sync|update> ...",
    summary: "Manage headless runtime settings, startup, sync, diagnostics, and updates.",
  },
  config: {
    usage: "ocx config <show|get|set|unset|validate|export|import> ...",
    summary: "Inspect and safely modify validated OpenCodex configuration.",
    details: ["Secrets are masked by show/get. Import requires --yes and validates before writing."],
  },
  codex: {
    usage: "ocx codex [codex args...]",
    summary: "Start OpenCodex when needed and launch Codex through the live proxy.",
    details: [
      "Refreshes the Codex provider configuration against the live proxy port before launch.",
      "Every remaining argument is forwarded to the selected Codex runtime unchanged.",
      "Example: ocx codex exec --skip-git-repo-check \"Reply with READY\"",
    ],
  },
  claude: {
    usage: "ocx claude [claude args...]",
    summary: "Launch Claude Code wired to the proxy (env injection + gateway model discovery).",
    details: [
      "Ensures the proxy is running, then execs `claude` with ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN,",
      "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 and model slots from config.claudeCode.",
      "Routed models appear in the native /model picker with stable claude-opus-4-8-2026MMDD slot aliases (Claude Code >= 2.1.129).",
      "Older versions: pick models via ANTHROPIC_MODEL or /model <id> directly (any string passes through).",
      "User-exported ANTHROPIC_* variables always take precedence.",
      "",
      "Claude Desktop profile:",
      "  ocx claude desktop [apply]                         Save and apply the four-family profile",
      "  ocx claude desktop show [--json]                   Show routes, families, and defaults",
      "  ocx claude desktop move <route> <family> [--default]",
      "  ocx claude desktop default <family> <route|none>",
      "  ocx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)",
      "  ocx claude desktop import <path> [--apply]         Validate and import JSON",
      "Families: opus, fable, sonnet, haiku. New routes start in opus.",
      "`none` is valid only when that family is empty.",
      "Legacy apply flags remain supported: --static, --hybrid, --discovery-only.",
      "",
      "Claude Code settings: ocx claude config <status|set> ...",
    ],
  },
  opencode: {
    usage: "ocx opencode [opencode args...]",
    summary: "Launch opencode wired to the proxy (runtime provider config).",
    details: [
      "Ensures the proxy is running, then execs `opencode` with the generated `provider.opencodex`",
      "block injected through OpenCode's inline runtime layer (`OPENCODE_CONFIG_CONTENT`). Any",
      "existing inline config in the environment is preserved and only `provider.opencodex` is",
      "overwritten for this launch.",
      "Global/project opencode.json may be read to warn about an existing provider.opencodex",
      "override; on-disk files are never modified.",
      "Routed models appear in the model picker as opencodex/<provider>/<model>.",
      "Stop using `ocx opencode` and plain `opencode` behaves exactly as before.",
    ],
  },
  restart: {
    usage: "ocx restart",
    summary: "Stop the proxy and restart it (background). Equivalent to stop + ensure.",
  },
  v2: {
    usage: "ocx v2 <status|on|off|mode <v1|default|v2>|threads <n>>",
    summary: "Toggle the Codex multi_agent_v2 feature (multi-agent surface).",
    details: [
      "status                Show flag, multi-agent mode, and thread limit.",
      "on | off              Enable/disable multi_agent_v2 (catalog resyncs).",
      "mode <v1|default|v2>  Force all models to one surface, or respect upstream pins.",
      "threads <n>           Set max_concurrent_threads_per_session (integer >= 1).",
      "Flips preserve the active thread limit while moving between v1/v2 modes.",
    ],
  },
  health: {
    usage: "ocx health [--json]",
    summary: "Check proxy health. Exits 0 if healthy, 1 otherwise.",
    details: ["Use --json for structured output: {ok, pid, port}."],
  },
};

function packageVersion(): string {
  const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : "unknown";
}

export function printVersion(): void {
  // The package name rides along on this same line, kept single-line and
  // script-friendly (tests parse the leading "opencodex <version>" with a
  // regex and require exactly one output line): a user with more than one
  // `ocx` on their machine — a stale global install, a different fork — can
  // tell which npm package this one actually is without a second command.
  // `ocx doctor` carries the fuller build/commit identity where multi-line
  // output is safe.
  const { name } = readPackageIdentity();
  console.log(`opencodex ${packageVersion()} (${name})`);
}

export function printUsage(): void {
  console.log(`opencodex (ocx) — Universal provider proxy for Codex

Usage:
  ocx setup                   Interactive setup (alias: init)
  ocx start [--port <port>]   Start the proxy server (auto-syncs models to Codex)
  ocx stop                    Stop the proxy AND restore native Codex (plain codex works again)
  ocx restore                 Restore native Codex without stopping (alias: eject)
  ocx restore back            Re-point codex at the running proxy (undo restore)
  ocx recover-history --legacy-openai
                               Explicitly recover pre-backup syncResumeHistory rows
  ocx uninstall               Remove service/shim/config and restore native Codex (alias: remove)
  ocx service [sub]           Run as a background service (default: install-if-absent/repair-if-installed)
  ocx codex-shim <sub>        Auto-start proxy when \`codex\` launches (install|status|uninstall|remove)
  ocx tray <sub>              Windows status tray (install|start|stop|status|uninstall)
  ocx ensure                  Ensure the proxy is running and Codex config/cache are current
  ocx sync [--restart-codex]  Fetch models from providers and inject into Codex config
  ocx sync-cache [--restart-codex]
                              Refresh Codex's model cache from the active catalog
  ocx status                  Check proxy server status
  ocx doctor                  Diagnose environment/network issues (WSL, proxy, ChatGPT reachability)
  ocx debug <scope>           provider/usage/injection/claude on|off|status|reset
  ocx login <provider>        OAuth or API-key provider login
  ocx logout <provider>       Remove a stored OAuth login
  ocx gui                     Open the opencodex dashboard
  ocx changelog [opts]        Show released versions and their changes
  ocx export <sub>            Export dashboard data or a confirmed full-state backup
  ocx host <sub>              Configure trusted-LAN remote access
  ocx launch [target]         Open an installed agent CLI or desktop app
  ocx terminal <sub>          Run a command through a local opencodex terminal session
  ocx update [--tag <tag>]    Update opencodex (keeps preview installs on @preview)
  ocx restart                  Stop and restart the proxy
  ocx v2 <sub>                multi_agent_v2 surface (status|on|off|mode|threads)
  ocx health [--json]          Check proxy health (exit 0=healthy, 1=not)
  ocx provider <sub>          Providers, connectivity, quota, and selected models
  ocx account <sub>           Accounts, login/reauth, key pools, and quota controls
  ocx models <sub>            Live/custom models, visibility, context, and shadow calls
  ocx combo <sub>             Combo failover/round-robin routing
  ocx agent <sub>             Subagents, injection, effort caps, and sidecars
  ocx observe <sub>           Logs, usage, storage, memory, and debug data
  ocx narrator <sub>          Narrator voices and speech (installed voices; --edge adds Microsoft's)
  ocx schedule <sub>          Headless checks for scheduled-settings rules (status|test-api|test-ha|ha-token)
  ocx pdf <sub>               Inspect, split, merge, extract, reorder, rotate, edit metadata on local PDFs
  ocx convert <sub>           File converter catalogue and byte-level detection (catalog|detect)
  ocx memory-sync <sub>       Canonical global agent memory sync and profile inventory
  ocx access <sub>            External API keys and endpoint information
  ocx grok <sub>              Grok Build model selection and apply
  ocx school-mode <sub>       Universal cross-app English-only toggle (status|enable|disable|rename)
  ocx changelog [opts]        Released versions and their changes
  ocx host <sub>              Expose the proxy to other devices on your network
  ocx launch [target]         Open an agent CLI or desktop app (Codex, Grok, Claude)
  ocx terminal <sub>          Run a command in an opencodex terminal session (list|run)
  ocx export <path> --yes     Full state backup — config, accounts, auth (secrets included)
  ocx system <sub>            Runtime settings, startup, sync, and updates
  ocx config <sub>            Validated configuration show/get/set/import/export
  ocx codex [args...]         Start if needed and launch Codex through the proxy
  ocx claude [args...]        Launch Claude Code wired to the proxy (model discovery on)
  ocx claude desktop [sub]    Manage and apply Claude Desktop's four-family profile
  ocx opencode [args...]      Launch opencode wired to the proxy (runtime provider config)
  ocx help [command]          Show help
  ocx --version | -v          Print version

Examples:
  ocx init                    Set up provider and inject into Codex
  ocx start                   Start on default port (10100)
  ocx start --port 8080       Start on custom port
  ocx help service            Show service command help
  ocx sync                    Sync available models to Codex`);
}

export function hasHelpFlag(values: string[]): boolean {
  return values.some(value => value === "--help" || value === "-h" || value === "help");
}

export function printSubcommandUsage(name: string | undefined): void {
  const entry = name ? helpEntries[name] : undefined;
  if (!entry) {
    console.error(`Unknown command: ${name ?? ""}`.trim());
    printUsage();
    process.exit(1);
  }
  console.log(`Usage: ${entry.usage}\n\n${entry.summary}`);
  if (entry.details?.length) console.log(`\n${entry.details.join("\n")}`);
}
