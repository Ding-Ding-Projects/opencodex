/* opencodex M3 — localization + funny-level voice layer.
   en strings are verbatim from gui/src/i18n/en.ts unless the key is new to this redesign.
   Where a string carries VOICE (titles, hints, warnings, confirmations, toasts, empty
   states) it is authored as a 5-entry array = funny levels 1..5. Level 1 is fully
   professional, level 5 is maximum playfulness. Facts never change between levels:
   the same numbers, model ids, paths and consequences appear at every level.
   Pure data labels (column headers, units, badges) are voice-neutral single strings. */

const S = {
  // ---- shell / nav ----
  "app.name": { en: "opencodex", yue: "opencodex" },
  "app.tagline": {
    en: [
      "Local model proxy console.",
      "Local model proxy console.",
      "Console for the local model proxy.",
      "Mission control for your local model proxy.",
      "Mission control for the little proxy that yells at model APIs for you.",
    ],
    yue: [
      "本地模型代理控制台。",
      "本地模型代理控制台。",
      "本地模型代理嘅控制台。",
      "你部本地代理嘅指揮中心。",
      "呢個細細粒代理幫你同model API嘈架，控制台就係呢度。",
    ],
  },
  "nav.dashboard": { en: "Dashboard", yue: "總覽" },
  "nav.codexAuth": { en: "Codex Auth", yue: "Codex 登入" },
  "nav.providers": { en: "Providers", yue: "供應商" },
  "nav.models": { en: "Models", yue: "模型" },
  "nav.combos": { en: "Combos", yue: "組合" },
  "nav.subagents": { en: "Subagents", yue: "子代理" },
  "nav.logs": { en: "Logs & Debug", yue: "紀錄同除錯" },
  "nav.usage": { en: "Usage", yue: "用量" },
  "nav.storage": { en: "Storage", yue: "儲存" },
  "nav.api": { en: "API", yue: "API" },
  "nav.claude": { en: "Claude", yue: "Claude" },
  "nav.grok": { en: "Grok", yue: "Grok" },
  "nav.startup": { en: "Startup", yue: "開機" },
  "nav.appearance": { en: "Appearance", yue: "外觀" },
  "nav.language": { en: "Language & voice", yue: "語言同語氣" },
  "nav.regex": { en: "Regex builder", yue: "Regex 產生器" },
  "nav.changelog": { en: "Changelog", yue: "更新紀錄" },
  "nav.history": { en: "Version history", yue: "版本紀錄" },
  "nav.notifications": { en: "Notifications", yue: "通知" },
  "nav.product": { en: "Proxy", yue: "代理" },
  "nav.system": { en: "System", yue: "系統" },
  "nav.more": { en: "More", yue: "更多" },
  "nav.openMenu": { en: "Open menu", yue: "打開選單" },
  "nav.closeMenu": { en: "Close menu", yue: "閂選單" },

  // ---- common ----
  "common.save": { en: "Save", yue: "儲存" },
  "common.saving": { en: "Saving…", yue: "儲存中…" },
  "common.cancel": { en: "Cancel", yue: "取消" },
  "common.close": { en: "Close", yue: "閂" },
  "common.remove": { en: "Remove", yue: "移除" },
  "common.retry": { en: "Retry", yue: "再試" },
  "common.copy": { en: "Copy", yue: "複製" },
  "common.copied": { en: "Copied", yue: "已複製" },
  "common.reset": { en: "Reset to defaults", yue: "回復預設" },
  "common.export": { en: "Export", yue: "匯出" },
  "common.apply": { en: "Apply", yue: "套用" },
  "common.search": { en: "Search", yue: "搜尋" },
  "common.github": { en: "GitHub", yue: "GitHub" },
  "common.enabled": { en: "Enabled", yue: "已開" },
  "common.disabled": { en: "Disabled", yue: "已閂" },
  "common.on": { en: "On", yue: "開" },
  "common.off": { en: "Off", yue: "閂" },
  "common.none": { en: "None", yue: "無" },
  "common.default": { en: "Default", yue: "預設" },
  "common.active": { en: "Active", yue: "使用中" },
  "common.settings": { en: "Settings", yue: "設定" },
  "common.stopProxy": { en: "Stop proxy", yue: "停止代理" },

  // ---- dashboard ----
  "dash.subtitle": {
    en: [
      "Live status of the local opencodex proxy, its providers, and the models routed into Codex.",
      "Live status of the local opencodex proxy, its providers, and the models routed into Codex.",
      "Live status of the local proxy, its providers, and the models routed into Codex.",
      "Everything your local proxy is doing right now — providers, models, the lot.",
      "Live from your laptop: one proxy, twelve providers, and a pile of models pretending to be one API.",
    ],
    yue: [
      "本地 opencodex 代理、供應商同路由入 Codex 嘅模型即時狀態。",
      "本地 opencodex 代理、供應商同模型嘅即時狀態。",
      "睇住本地代理、供應商同路由入 Codex 嘅模型。",
      "你部本地代理現時做嘅所有嘢：供應商、模型，全部有。",
      "由你部機直播：一個代理、十二個供應商，仲有一堆模型假扮同一個 API。",
    ],
  },
  "dash.overview": { en: "Overview", yue: "概覽" },
  "dash.status": { en: "Status", yue: "狀態" },
  "dash.online": { en: "Online", yue: "上線" },
  "dash.offline": { en: "Offline", yue: "離線" },
  "dash.version": { en: "Version", yue: "版本" },
  "dash.uptime": { en: "Uptime", yue: "運行時間" },
  "dash.providers": { en: "Providers", yue: "供應商" },
  "dash.tokens30d": { en: "Tokens (30d)", yue: "Token（30日）" },
  "dash.coverage": { en: "{pct} coverage", yue: "覆蓋率 {pct}" },
  "dash.multiAgent": { en: "Sub-agent", yue: "子代理" },
  "dash.activeProviders": { en: "Active providers", yue: "使用中供應商" },
  "dash.availableModels": { en: "Available models", yue: "可用模型" },
  "dash.maintenance": { en: "Maintenance", yue: "維護" },
  "dash.maintenanceHint": {
    en: [
      "Refresh Codex's model catalog or install a newer opencodex release.",
      "Refresh Codex's model catalog or install a newer opencodex release.",
      "Refresh Codex's model catalog, or install a newer opencodex release.",
      "Poke Codex until it notices the new models, or grab a newer opencodex.",
      "Two buttons: one tells Codex the catalog moved on, one drags opencodex into the present.",
    ],
    yue: [
      "重新整理 Codex 嘅模型目錄，或安裝較新版本嘅 opencodex。",
      "重新整理 Codex 模型目錄，或安裝新版 opencodex。",
      "整理 Codex 模型目錄，又或者裝新版 opencodex。",
      "戳一戳 Codex 叫佢望下新模型，或者拉 opencodex 上新版。",
      "兩粒掛：一粒話 Codex「目錄轉喇」，一粒拖 opencodex 返現代。",
    ],
  },
  "dash.syncModels": { en: "Sync models", yue: "同步模型" },
  "dash.checkUpdate": { en: "Check update", yue: "檢查更新" },
  "dash.syncOk": { en: "Sync complete. {count} model(s) appended.", yue: "同步完成，新增 {count} 個模型。" },
  "dash.stopConfirm": {
    en: [
      "Stop the proxy and restore native Codex routing?",
      "Stop the proxy and restore native Codex routing?",
      "Stop the proxy and put Codex back on native routing?",
      "Pull the plug? Codex goes back to native OpenAI routing straight away.",
      "Yank the proxy? Codex crawls back to native OpenAI routing and your twelve providers go dark.",
    ],
    yue: [
      "停止代理並回復 Codex 原生路由？",
      "停止代理，Codex 回復原生路由？",
      "熄代理，Codex 返去原生路由？",
      "真係拉閘？Codex 即刻返去原生 OpenAI 路由。",
      "熄咗代理？Codex 即刻爬返原生 OpenAI，你十二個供應商全部黑燈。",
    ],
  },
  "dash.projectConfigTitle": {
    en: [
      "Project Codex config bypasses OpenCodex",
      "Project Codex config bypasses OpenCodex",
      "A project config is bypassing OpenCodex",
      "One of your repos is going around OpenCodex",
      "A repo-local config is sneaking past OpenCodex entirely",
    ],
    yue: [
      "專案 Codex 設定繞過 OpenCodex",
      "有專案設定繞過 OpenCodex",
      "有個 repo 嘅設定繞開 OpenCodex",
      "你有個 repo 偷偷繞過 OpenCodex",
      "有個 repo 本地設定完全偷雞過咗 OpenCodex",
    ],
  },
  "dash.projectConfigHint": {
    en: [
      "These repo-local settings override the OpenCodex proxy. Remove them so ~/.codex/config.toml routing applies in that project.",
      "These repo-local settings override the OpenCodex proxy. Remove them so ~/.codex/config.toml routing applies.",
      "These repo-local settings win over the proxy. Remove them so ~/.codex/config.toml routing applies in that project.",
      "The repo's own settings beat the proxy. Delete them and ~/.codex/config.toml gets its say again.",
      "The repo brought its own opinions and they beat the proxy. Delete them; ~/.codex/config.toml would like a turn.",
    ],
    yue: [
      "呢啲 repo 本地設定會覆蓋 OpenCodex 代理。刪咗佢，~/.codex/config.toml 嘅路由就會生效。",
      "呢啲 repo 設定覆蓋咗代理。刪咗佢先會用 ~/.codex/config.toml。",
      "repo 設定贏過代理。刪咗佢，~/.codex/config.toml 就有得出聲。",
      "個 repo 自己有主見，贏過代理。刪咗佢，~/.codex/config.toml 想講兩句。",
      "個 repo 自帶意見仲贏咗代理。刪佢啦，~/.codex/config.toml 都想輪到佢。",
    ],
  },
  "dash.cannotConnect": {
    en: [
      "Cannot connect to proxy. Is it running?",
      "Cannot connect to proxy. Is it running?",
      "Can't reach the proxy. Is it running?",
      "No answer from the proxy — is it actually running?",
      "The proxy is not picking up. Run ocx start and try again.",
    ],
    yue: [
      "無法連接代理，佢有無運行？",
      "連唔到代理，佢開住未？",
      "搭唔到代理，佢真係開住？",
      "代理無人應機，係唔係未開？",
      "代理唔覆你喎。行 ocx start 再試啦。",
    ],
  },

  // ---- codex auth ----
  "auth.subtitle": {
    en: [
      "ChatGPT accounts available to the proxy, their rate-limit windows, and the account the next request will use.",
      "ChatGPT accounts available to the proxy, their rate-limit windows, and the next account to be used.",
      "Your ChatGPT accounts, their limit windows, and who takes the next request.",
      "Every ChatGPT account you've fed the proxy, how burnt each one is, and who's up next.",
      "The account bench: who's fresh, who's cooked, and who's going in next.",
    ],
    yue: [
      "代理可用嘅 ChatGPT 帳戶、限額窗口，以及下一個請求會用邊個帳戶。",
      "ChatGPT 帳戶、限額窗口同下一個要用嘅帳戶。",
      "你嘅 ChatGPT 帳戶、限額幾多，同下個請求用邊個。",
      "你餵咗代理嘅帳戶、每個燒到幾盡、同下個輪到邊個。",
      "帳戶板凳：邊個仲生猛、邊個熟透、下一個派邊個上場。",
    ],
  },
  "auth.mainAccount": { en: "Main Account", yue: "主帳戶" },
  "auth.accountPool": { en: "Account Pool", yue: "帳戶池" },
  "auth.current": { en: "CURRENT", yue: "現用" },
  "auth.selected": { en: "SELECTED", yue: "已選" },
  "auth.paused": { en: "PAUSED", yue: "已暫停" },
  "auth.pause": { en: "Pause", yue: "暫停" },
  "auth.resume": { en: "Resume", yue: "恢復" },
  "auth.refreshQuota": { en: "Refresh quotas", yue: "重新讀取限額" },
  "auth.fiveHour": { en: "5h", yue: "5小時" },
  "auth.weekly": { en: "Week", yue: "一週" },
  "auth.monthly": { en: "30d", yue: "30日" },
  "auth.autoSwitch": { en: "Automatic account switching", yue: "自動切換帳戶" },
  "auth.autoSwitchDesc": {
    en: [
      "Switches at {threshold}% usage or above when an eligible account has lower usage.",
      "Switches at {threshold}% usage or above when an eligible account has lower usage.",
      "At {threshold}% usage the proxy hands over to a fresher account.",
      "Hit {threshold}% and the proxy quietly moves you to a less-burnt account.",
      "At {threshold}% the proxy taps the account on the shoulder and sends in a fresher one.",
    ],
    yue: [
      "當用量達 {threshold}% 或以上，而有合資格帳戶用量較低時切換。",
      "用量到 {threshold}% 就切去用量較低嘅帳戶。",
      "用到 {threshold}%，代理就會轉去一個新鮮啲嘅帳戶。",
      "到 {threshold}%，代理就靜靜雞幫你轉去冇咁燶嘅帳戶。",
      "夠 {threshold}%，代理就拍拍個帳戶膊頭，換個生猛嘅入場。",
    ],
  },
  "auth.switchTitle": { en: "Switch active account?", yue: "切換使用中帳戶？" },
  "auth.switchDesc": {
    en: [
      "This applies to the next request from existing and new Codex sessions. In-flight requests keep their captured account.",
      "This applies to the next request from existing and new Codex sessions. In-flight requests keep their account.",
      "Takes effect on the next request; requests already in flight keep the account they started on.",
      "Next request switches over. Anything already in the air lands on its original account.",
      "Next request changes lanes. Requests already mid-air land where they took off — no mid-flight seat swaps.",
    ],
    yue: [
      "會套用到現有同新 Codex 對話嘅下一個請求。正在進行嘅請求維持原有帳戶。",
      "下一個請求生效；正在進行嘅請求維持原帳戶。",
      "下個請求開始生效，飛緊嘅請求照用原本帳戶。",
      "下個請求轉線。已經飛咗嘅，就照原機降落。",
      "下個請求轉線。飛到半空嘅照原機落，唔會半空換位。",
    ],
  },
  "auth.cacheWarning": {
    en: [
      "Prompt cache resets on account switch. A new session starts with an empty cache.",
      "Prompt cache resets on account switch. New sessions start with an empty cache.",
      "Switching clears the prompt cache — the next session starts cold.",
      "Heads up: the prompt cache resets, so the next session starts cold and costs a bit more.",
      "Fair warning: the prompt cache gets binned. Next session starts cold and pays full price for the reread.",
    ],
    yue: [
      "切換帳戶會重設 prompt cache，新對話由空白 cache 開始。",
      "切換會重設 prompt cache，新對話由零開始。",
      "轉帳戶會清 prompt cache，下個對話由冷機開始。",
      "提醒你：prompt cache 會清空，下個對話冷機起步、貴少少。",
      "老實講：prompt cache 會被倒咗，下個對話冷機開工，重讀要俾足全價。",
    ],
  },
  "auth.resetCredits": { en: "Reset Credits", yue: "重設額度" },
  "auth.resetCreditsDesc": {
    en: [
      "Each credit resets your current hourly and weekly usage limits instantly.",
      "Each credit resets your current hourly and weekly usage limits instantly.",
      "One credit instantly clears your current 5-hour and weekly limits.",
      "One credit, one instant wipe of your 5-hour and weekly limits. Oldest credit goes first.",
      "One credit = your 5-hour and weekly limits pretend nothing happened. Oldest credit gets used first, no arguing.",
    ],
    yue: [
      "每個額度可即時重設現時每小時同每週用量上限。",
      "每個額度即時重設 5 小時同每週上限。",
      "一個額度即時清咗你嘅 5 小時同每週上限。",
      "一個額度即刻抹走 5 小時同每週上限，最舊嘅先用。",
      "一個額度 = 5 小時同每週上限當冇事發生過。最舊嘅先用，唔准講價。",
    ],
  },
  "auth.irreversible": {
    en: [
      "This action cannot be undone.",
      "This action cannot be undone.",
      "This cannot be undone.",
      "No undo on this one.",
      "No undo, no take-backs, no crying afterwards.",
    ],
    yue: ["此操作無法復原。", "唔可以還原。", "呢個做完冇得返轉頭。", "呢個冇 undo 架。", "冇 undo、冇後悔、事後唔准喊。"],
  },

  // ---- providers ----
  "prov.subtitle": {
    en: [
      "Configure the upstream providers opencodex routes into Codex. Log in with an account, add a provider, or edit the raw config.",
      "Configure the upstream providers opencodex routes into Codex. Log in, add a provider, or edit the raw config.",
      "The upstream providers opencodex routes into Codex. Log in, add one, or edit the raw config.",
      "Everything upstream that opencodex pretends is one API. Log in, add one, or go straight to the JSON.",
      "Your upstream zoo, which opencodex heroically pretends is one tidy API. Log in, add one, or edit the JSON like a grown-up.",
    ],
    yue: [
      "設定 opencodex 路由入 Codex 嘅上游供應商。可以登入帳戶、新增供應商，或直接改設定檔。",
      "設定上游供應商：登入、新增，或改原始設定。",
      "opencodex 路由入 Codex 嘅上游供應商。登入、新增，或直接改 JSON。",
      "你上游嘅一堆嘢，opencodex 假裝佢係一個 API。登入、新增，或者直接開 JSON。",
      "你個上游動物園，opencodex 英勇咁假裝佢係一個靚 API。登入、新增，或者好似大人咁改 JSON。",
    ],
  },
  "prov.add": { en: "Add provider", yue: "新增供應商" },
  "prov.editJson": { en: "Edit JSON", yue: "編輯 JSON" },
  "prov.ready": { en: "Ready", yue: "就緒" },
  "prov.needsSetup": { en: "Needs setup", yue: "需要設定" },
  "prov.needsAttention": { en: "Needs attention", yue: "需要處理" },
  "prov.testConnection": { en: "Test connection", yue: "測試連線" },
  "prov.connectionOk": { en: "Connection OK", yue: "連線正常" },
  "prov.removeConfirmBody": {
    en: [
      "Remove provider \"{name}\"? Its models disappear from Codex's picker.",
      "Remove provider \"{name}\"? Its models disappear from Codex's picker.",
      "Remove \"{name}\"? Its models vanish from the Codex picker.",
      "Delete \"{name}\"? Its models drop out of the Codex picker immediately.",
      "Bin \"{name}\"? Its models evaporate from the Codex picker on the spot.",
    ],
    yue: [
      "移除供應商「{name}」？佢嘅模型會由 Codex 選單消失。",
      "移除「{name}」？佢嘅模型會由 Codex 選單消失。",
      "移除「{name}」？佢嘅模型即刻唔見於 Codex 選單。",
      "刪咗「{name}」？佢嘅模型即刻跌出 Codex 選單。",
      "掟走「{name}」？佢嘅模型即刻由 Codex 選單蒸發。",
    ],
  },

  // ---- models ----
  "models.subtitle": {
    en: [
      "Toggle which models Codex sees. Hidden models stay off the catalog and picker but remain callable by exact id. Changes apply on the next Codex turn.",
      "Toggle which models Codex sees. Hidden models stay off the picker but remain callable by exact id. Changes apply on the next Codex turn.",
      "Choose which models Codex sees. Hidden ones leave the picker but still answer to their exact id. Applies next turn.",
      "Pick what shows up in Codex's picker. Hidden models still answer if you know their exact id. No restart needed.",
      "Curate the picker. Hidden models aren't deleted — they just stop volunteering, and still answer to their full id.",
    ],
    yue: [
      "選擇 Codex 睇到邊啲模型。隱藏嘅唔會出現在目錄同選單，但仍可用完整 id 呼叫。下一回合生效。",
      "選擇 Codex 睇到邊啲模型。隱藏嘅仍可用完整 id 呼叫，下一回合生效。",
      "揀 Codex 睇到咩模型。隱藏咗嘅照可以用完整 id 叫，下回合生效。",
      "揀邊啲模型出現在選單。隱藏嘅你知足 id 一樣叫得到，唔需要重啟。",
      "整理下個選單。隱藏嘅模型冇被刪，只係唔再自薦，你叫全名佢照應。",
    ],
  },
  "models.search": { en: "Search models…", yue: "搜尋模型…" },
  "models.allOn": { en: "All on", yue: "全開" },
  "models.allOff": { en: "All off", yue: "全閂" },
  "models.visible": { en: "{active}/{total} visible", yue: "{active}/{total} 可見" },
  "models.applied": {
    en: [
      "Applied — takes effect on the next Codex turn.",
      "Applied — takes effect on the next Codex turn.",
      "Applied. It lands on the next Codex turn.",
      "Applied. Next Codex turn picks it up, no restart.",
      "Applied. Next Codex turn will act like it was always this way.",
    ],
    yue: [
      "已套用 — 下一個 Codex 回合生效。",
      "已套用，下一回合生效。",
      "已套用，下個 Codex 回合就會用到。",
      "已套用。下個 Codex 回合自己會執到，唔需要重啟。",
      "已套用。下個 Codex 回合會裝作一路都係咁。",
    ],
  },
  "models.contextCap": { en: "Context cap", yue: "上下文上限" },
  "models.nativeGroup": { en: "OpenAI native", yue: "OpenAI 原生" },

  // ---- combos ----
  "cws.overviewBlurb": {
    en: [
      "Virtual models that fail over across provider/model targets, or balance them with deterministic weighted round-robin.",
      "Virtual models that fail over across provider/model targets, or balance them with weighted round-robin.",
      "Virtual models that fail over across targets, or split traffic by weight.",
      "One model name, several backends. It hops on failure, or splits traffic by weight.",
      "One model name wearing several backends as a coat. Hops when one falls over, or shares the load by weight.",
    ],
    yue: [
      "虛擬模型：可跨供應商/模型目標故障轉移，或用確定性加權輪替分流。",
      "虛擬模型：故障轉移，或加權輪替分流。",
      "虛擬模型：跌咗就跳下一個，或按權重分流。",
      "一個模型名、幾個後端。壞咗就跳，或者按權重分流。",
      "一個模型名披住幾個後端做大衣。一個瀆咗就跳，或者按權重分擔。",
    ],
  },
  "cws.add": { en: "Add combo", yue: "新增組合" },
  "cws.strategy": { en: "Strategy", yue: "策略" },
  "cws.failover": { en: "Failover", yue: "故障轉移" },
  "cws.roundRobin": { en: "Round-robin", yue: "輪替" },
  "cws.targets": { en: "Targets", yue: "目標" },
  "cws.attentionFew": {
    en: [
      "Only one target — failover has nowhere to hop.",
      "Only one target — failover has nowhere to hop.",
      "One target only. Failover has nowhere to go.",
      "One target. That's not failover, that's hoping.",
      "One target. That is not failover, that is optimism with extra steps.",
    ],
    yue: [
      "只有一個目標 — 故障轉移無處可跳。",
      "只有一個目標，冇得轉移。",
      "得一個目標，跳都冇地方跳。",
      "得一個目標。咁唔係故障轉移，係祈禱。",
      "得一個目標。咁唔叫故障轉移，叫做樂觀加幾個步驟。",
    ],
  },

  // ---- subagents ----
  "sub.subtitle": {
    en: [
      "Codex advertises only the first 5 models by priority as spawn_agent overrides. Pick up to 5 here and opencodex sets their catalog priority.",
      "Codex advertises only the first 5 models by priority as spawn_agent overrides. Pick up to 5 here.",
      "Codex only advertises 5 models as spawn_agent overrides. Pick which 5.",
      "Codex only shows off 5 sub-agent models. You decide which 5 get the spotlight.",
      "Codex only brags about 5 sub-agent models. You pick the five it brags about.",
    ],
    yue: [
      "Codex 只會按優先順序公佈頭 5 個模型做 spawn_agent 覆寫。在此揀最多 5 個，opencodex 會設定佢哋嘅目錄優先次序。",
      "Codex 只公佈頭 5 個模型做 spawn_agent 覆寫，在此揀最多 5 個。",
      "Codex 只會公佈 5 個 spawn_agent 模型，你揀邊 5 個。",
      "Codex 只會show 5 個子代理模型，你決定邊 5 個上台。",
      "Codex 只會吹 5 個子代理模型，你揀佢吹邊五個。",
    ],
  },
  "sub.featured": { en: "Featured", yue: "精選" },
  "sub.models": { en: "Models", yue: "模型" },

  // ---- logs / debug ----
  "logs.subtitle": {
    en: [
      "Recent requests routed through the local opencodex proxy, newest first.",
      "Recent requests routed through the local opencodex proxy, newest first.",
      "Recent requests through the proxy, newest first.",
      "Every request the proxy has handled lately, newest first.",
      "The receipts. Newest first, and yes it remembers the 502s.",
    ],
    yue: [
      "經本地 opencodex 代理路由嘅近期請求，最新在上。",
      "近期經代理嘅請求，最新在上。",
      "近期經代理嘅請求，新嘅在上。",
      "代理近排處理過嘅請求，最新排前。",
      "全部單據。新嘅排前，係，佢記得個個 502。",
    ],
  },
  "logs.tabLogs": { en: "Logs", yue: "紀錄" },
  "logs.tabDebug": { en: "Debug", yue: "除錯" },
  "logs.autoRefresh": { en: "Auto-refresh", yue: "自動更新" },
  "logs.noRequests": { en: "No requests yet.", yue: "暫時未有請求。" },
  "logs.details": { en: "Details", yue: "詳情" },
  "debug.subtitle": {
    en: [
      "Opt-in provider transport and usage-extraction diagnostics. Request errors and 502s stay on the Logs tab.",
      "Opt-in provider transport and usage-extraction diagnostics. Errors and 502s stay on the Logs tab.",
      "Optional transport and usage diagnostics. Errors and 502s live on the Logs tab.",
      "Turn these on only when something smells. Plain errors stay on the Logs tab.",
      "Only switch these on when something smells. Ordinary errors stay on the Logs tab where they belong.",
    ],
    yue: [
      "自選啟用嘅供應商傳輸同用量抽取診斷。請求錯誤同 502 留在紀錄分頁。",
      "自選啟用嘅傳輸同用量診斷。錯誤同 502 在紀錄分頁。",
      "可選嘅傳輸同用量診斷。錯誤同 502 在紀錄分頁。",
      "有嘢唔妥先開。普通錯誤留在紀錄分頁。",
      "聞到有味先開。普通錯誤留在紀錄分頁做返本份。",
    ],
  },

  // ---- usage ----
  "usage.subtitle": {
    en: [
      "Local token accounting from your proxy. Missing usage is never shown as zero.",
      "Local token accounting from your proxy. Missing usage is never shown as zero.",
      "Token accounting from your own proxy. Missing usage is never faked as zero.",
      "Your own token accounting. Where a provider said nothing, this says nothing — not zero.",
      "Your own token books. If a provider stayed quiet, this stays quiet too — it will not invent a zero.",
    ],
    yue: [
      "由你嘅代理本地統計 token。缺少嘅用量絕不顯示為零。",
      "本地 token 統計，缺少用量唔會當零。",
      "你自己代理嘅 token 統計。冇資料就係冇，唔會當零。",
      "你自己嘅 token 帳。供應商冇講，呢度就冇講，唔會當零。",
      "你自己嘅 token 帳簿。供應商唔出聲，我都唔出聲，唔會捏個零出嚟。",
    ],
  },
  "usage.requests": { en: "Requests", yue: "請求" },
  "usage.totalTokens": { en: "Total tokens", yue: "總 token" },
  "usage.cacheReads": { en: "Cache reads", yue: "快取讀取" },
  "usage.coverage": { en: "Coverage", yue: "覆蓋率" },
  "usage.activeDays": { en: "Active days", yue: "活躍日數" },
  "usage.heatmap": { en: "Daily activity", yue: "每日活動" },
  "usage.costDisclaimer": {
    en: [
      "API list-price equivalent, not a billing receipt. Subscription usage or provider credits may apply instead.",
      "API list-price equivalent, not a billing receipt. Subscription usage or credits may apply instead.",
      "List-price equivalent, not a bill. Your subscription or credits may cover this instead.",
      "This is list-price maths, not a bill. Your subscription probably ate most of it.",
      "List-price maths, not a bill. Nobody is charging you this; your subscription already took the hit.",
    ],
    yue: [
      "只係 API 標價等值，唔係帳單。可能實際用訂閱用量或供應商額度。",
      "標價等值，唔係帳單。可能用訂閱或額度支付。",
      "標價計法，唔係帳單。可能你訂閱已經包咗。",
      "呢個係標價數學，唔係帳單。你訂閱應該已經食咗大部分。",
      "標價數學，唔係帳單。冇人真收你咁多，你訂閱早就頂咗。",
    ],
  },

  // ---- storage ----
  "storage.subtitle": {
    en: [
      "Diagnostics for CODEX_HOME disk use. Archived cleanup can quarantine or permanently delete the oldest archived sessions — active sessions stay read-only.",
      "Diagnostics for CODEX_HOME disk use. Cleanup can quarantine or permanently delete the oldest archives — active sessions stay read-only.",
      "What CODEX_HOME is doing to your disk. Cleanup only ever touches archived sessions.",
      "Where your disk went. Cleanup only touches archived sessions — active ones are read-only, always.",
      "Where your disk went. Cleanup only ever touches archived sessions; the live ones are read-only and will stay that way.",
    ],
    yue: [
      "CODEX_HOME 磁碟用量診斷。封存清理可以隔離或永久刪除最舊嘅封存對話；使用中對話保持唯讀。",
      "CODEX_HOME 磁碟診斷。清理只會處理最舊封存；使用中對話唯讀。",
      "睇下 CODEX_HOME 食咗你幾多碟。清理只會動封存對話。",
      "你嘅碟去咗邊。清理只會動封存對話，使用中嘅永遠唯讀。",
      "你隻碟去咗邊。清理只會掂封存對話，使用中嘅永遠唯讀，唔會變。",
    ],
  },
  "storage.totalSize": { en: "Total size", yue: "總大小" },
  "storage.files": { en: "Files", yue: "檔案" },
  "storage.buckets": { en: "Buckets", yue: "分類" },
  "storage.largest": { en: "Largest files", yue: "最大檔案" },
  "storage.cleanup": { en: "Archived cleanup", yue: "封存清理" },
  "storage.quarantine": { en: "Quarantine", yue: "隔離區" },
  "storage.permanentWarn": {
    en: [
      "Permanent delete cannot be undone.",
      "Permanent delete cannot be undone.",
      "Permanent delete cannot be undone.",
      "Permanent means permanent — there is no quarantine to fish it back out of.",
      "Permanent means permanent. No quarantine, no .trash, no fishing it back out later.",
    ],
    yue: [
      "永久刪除無法復原。",
      "永久刪除無法復原。",
      "永久刪除係冇得返轉頭。",
      "永久就係永久 — 冇隔離區可以撈返。",
      "永久就真永久。冇隔離區、冇 .trash、之後撈都撈唔返。",
    ],
  },

  // ---- api ----
  "api.subtitle": {
    en: [
      "Use generated API keys to access the opencodex proxy from external apps. Keys authenticate via the x-opencodex-api-key or Authorization header.",
      "Use generated API keys to access the proxy from external apps, via x-opencodex-api-key or Authorization.",
      "Generated keys let external apps use the proxy, via x-opencodex-api-key or Authorization.",
      "Hand a key to any OpenAI-compatible app and it can talk to your proxy.",
      "Hand a key to any OpenAI-compatible app and it can order from your proxy like it owns the place.",
    ],
    yue: [
      "用產生嘅 API key 由外部程式存取 opencodex 代理。Key 經 x-opencodex-api-key 或 Authorization header 驗證。",
      "用 API key 由外部程式存取代理，經 x-opencodex-api-key 或 Authorization。",
      "產生嘅 key 可以令外部程式用你嘅代理。",
      "俾條 key 任何 OpenAI 相容程式，佢就用得你嘅代理。",
      "俾條 key 任何 OpenAI 相容程式，佢就好似自己屋企咁落單。",
    ],
  },
  "api.baseUrl": { en: "Base URL", yue: "基礎網址" },
  "api.endpoints": { en: "Endpoints", yue: "端點" },
  "api.generate": { en: "Generate key", yue: "產生 key" },
  "api.activeKeys": { en: "Active keys ({count})", yue: "有效 key（{count}）" },
  "api.newKeyNote": {
    en: [
      "Copy this key now — it will not be shown again.",
      "Copy this key now — it will not be shown again.",
      "Copy it now. It is never shown again.",
      "Copy it now, because this is the only time you will ever see it.",
      "Copy it now. This is its one and only public appearance, no encores.",
    ],
    yue: [
      "即刻複製呢條 key — 之後唔會再顯示。",
      "即刻複製，之後唔會再顯示。",
      "即刻 copy，之後永遠唔會再出現。",
      "即刻 copy，因為你一世只會見佢一次。",
      "即刻 copy。呢係佢唯一一次公開演出，冇加場。",
    ],
  },

  // ---- claude / grok ----
  "claude.subtitle": {
    en: [
      "Use GPT, Gemini, and other models inside Claude Code and Claude Desktop.",
      "Use GPT, Gemini, and other models inside Claude Code and Claude Desktop.",
      "Run GPT, Gemini and friends inside Claude Code and Claude Desktop.",
      "Put GPT and Gemini inside Claude Code. Yes, really.",
      "Smuggle GPT and Gemini into Claude Code. Your claude.ai login stays perfectly intact.",
    ],
    yue: [
      "在 Claude Code 同 Claude Desktop 使用 GPT、Gemini 等模型。",
      "在 Claude Code 同 Desktop 用 GPT、Gemini 等模型。",
      "在 Claude Code 同 Desktop 跑 GPT、Gemini 等等。",
      "將 GPT 同 Gemini 塞入 Claude Code。真係得。",
      "偷運 GPT 同 Gemini 入 Claude Code，你 claude.ai 個 login 完好無缺。",
    ],
  },
  "claude.connection": { en: "Claude connection", yue: "Claude 連線" },
  "claude.authMode": { en: "Auth mode", yue: "驗證模式" },
  "claude.fastMode": { en: "Fast Mode (OpenAI)", yue: "快速模式（OpenAI）" },
  "claude.modelMap": { en: "Model interception", yue: "模型攔截" },
  "claude.tabCode": { en: "Code", yue: "Code" },
  "claude.tabDesktop": { en: "Desktop", yue: "Desktop" },
  "grok.subtitle": {
    en: [
      "Models opencodex has registered in your Grok config.",
      "Models opencodex has registered in your Grok config.",
      "The models opencodex registered in your Grok config.",
      "What opencodex has quietly written into your Grok config.",
      "What opencodex has quietly filed into your Grok config, in its own managed block.",
    ],
    yue: [
      "opencodex 已在你嘅 Grok 設定註冊嘅模型。",
      "opencodex 在 Grok 設定註冊嘅模型。",
      "opencodex 寫入你 Grok 設定嘅模型。",
      "opencodex 靜靜雞寫入你 Grok 設定嘅嘢。",
      "opencodex 靜靜雞喺你 Grok 設定歸檔嘅嘢，有自己管理區。",
    ],
  },
  "grok.registered": { en: "{on} of {total} registered", yue: "已註冊 {on}/{total}" },

  // ---- startup ----
  "startup.subtitle": {
    en: [
      "Verify that Codex can reach opencodex after a restart, before local proxy routing becomes a reconnect loop.",
      "Verify that Codex can reach opencodex after a restart, before routing becomes a reconnect loop.",
      "Check that Codex can still reach opencodex after a reboot.",
      "Make sure a reboot doesn't leave Codex talking to a proxy that isn't there.",
      "Make sure a reboot doesn't leave Codex politely knocking on a proxy that no longer exists.",
    ],
    yue: [
      "確認重啟後 Codex 仍可連到 opencodex，避免本地代理路由變成重連迴圈。",
      "確認重啟後 Codex 仍連得到 opencodex。",
      "確認重開機後 Codex 仲搭得到 opencodex。",
      "確保重開機之後，Codex 唔會對住一個唔存在嘅代理講嘢。",
      "確保重開機之後，Codex 唔會好禮貌咁敲一個已經唔存在嘅代理門。",
    ],
  },
  "startup.protected": { en: "opencodex will be available after restart", yue: "重啟後 opencodex 會可用" },
  "startup.atRisk": {
    en: [
      "Codex can lose model access after restart.",
      "Codex can lose model access after restart.",
      "Codex may lose model access after a restart.",
      "A reboot could leave Codex with no models at all.",
      "A reboot could leave Codex staring at an empty model list.",
    ],
    yue: [
      "重啟後 Codex 可能失去模型存取。",
      "重啟後 Codex 可能冇模型用。",
      "重開機後 Codex 可能搵唔到模型。",
      "重開機可能令 Codex 一個模型都冇。",
      "重開機可能令 Codex 對住一個空模型清單發呆。",
    ],
  },
  "startup.install": { en: "Install", yue: "安裝" },
  "startup.routing": { en: "Codex routing", yue: "Codex 路由" },
  "startup.restartProtection": { en: "Restart protection", yue: "重啟保護" },

  // ---- appearance ----
  "appearance.subtitle": {
    en: [
      "Theme, density, seed colour, and typography. Changes apply to the live interface and persist across restarts.",
      "Theme, density, seed colour, and typography. Changes apply live and persist across restarts.",
      "Theme, density, seed colour and type. Applies live, remembered next launch.",
      "Make it yours: theme, density, seed colour, type. Applies live and sticks around.",
      "Redecorate: theme, density, seed colour, type. Applies live and remembers your questionable choices.",
    ],
    yue: [
      "主題、密度、種子色同字體。改動即時套用並會記住。",
      "主題、密度、種子色同字體，即時套用並記住。",
      "主題、密度、種子色、字體。即時套用，下次記得。",
      "改成你嘅樣：主題、密度、種子色、字體。即時套用又記得住。",
      "重新裝修：主題、密度、種子色、字體。即時套用，仲會記住你啲奇怪選擇。",
    ],
  },
  "appearance.theme": { en: "Theme", yue: "主題" },
  "appearance.light": { en: "Light", yue: "淺色" },
  "appearance.dark": { en: "Dark", yue: "深色" },
  "appearance.system": { en: "System", yue: "跟系統" },
  "appearance.seed": { en: "Seed colour", yue: "種子色" },
  "appearance.seedHint": {
    en: [
      "The whole Material 3 tonal palette is derived from this one colour.",
      "The whole Material 3 tonal palette is derived from this one colour.",
      "Every Material 3 role colour is derived from this one value.",
      "Pick one colour; Material 3 works out the other fifty.",
      "Pick one colour and Material 3 quietly derives the other fifty for you.",
    ],
    yue: [
      "整個 Material 3 色調系統由呢一隻色推導出嚟。",
      "所有 Material 3 角色色由呢個值推導。",
      "揀一隻色，其餘五十隻由 Material 3 推導。",
      "揀一隻色，Material 3 幫你算好其餘五十隻。",
      "揀一隻色，Material 3 靜靜雞幫你推導其餘五十隻。",
    ],
  },
  "appearance.density": { en: "Density", yue: "密度" },
  "appearance.densityHint": {
    en: [
      "1 is the Material 3 comfortable default; 5 matches the original infra-console density.",
      "1 is the Material 3 comfortable default; 5 matches the original console density.",
      "1 is comfortable Material 3; 5 is the tight original console.",
      "1 for roomy, 5 for the original wall-of-data feel.",
      "1 for roomy, 5 for the original wall-of-data experience. No judgement either way.",
    ],
    yue: [
      "1 係 Material 3 舒適預設；5 對應原本控制台密度。",
      "1 係舒適預設；5 係原本控制台密度。",
      "1 舒適，5 就係原本密實嘅控制台。",
      "1 疏落，5 就係原本一牆數據嘅感覺。",
      "1 疏落，5 就係原本一牆數據嘅體驗。兩樣都唔會笑你。",
    ],
  },
  "appearance.font": { en: "Interface font", yue: "介面字體" },
  "appearance.fontScale": { en: "Font size", yue: "字體大小" },
  "appearance.fontWeight": { en: "Font weight", yue: "字重" },
  "appearance.perElement": { en: "Per-element appearance", yue: "個別元件外觀" },
  "appearance.perElementHint": {
    en: [
      "Override font, colour, size, radius and spacing for individual surfaces. Each override is stored separately and can be reset.",
      "Override font, colour, size, radius and spacing per surface. Each override is stored separately and can be reset.",
      "Override type, colour, size, radius and spacing per surface. Reset any of them individually.",
      "Fine-tune single surfaces without touching the rest. Reset each one on its own.",
      "Fine-tune one surface at a time without dragging the rest along. Every override resets on its own.",
    ],
    yue: [
      "為個別介面覆寫字體、顏色、大小、圓角同間距。每項覆寫獨立儲存，可個別重設。",
      "個別介面可覆寫字體、顏色、大小、圓角、間距，可個別重設。",
      "逐個介面覆寫字體、顏色、大小、圓角、間距，可個別重設。",
      "只調某一個介面，唔會影響其他。每項可獨立重設。",
      "一次只調一個介面，唔會拖埋其他落水。每項覆寫都可以自己重設。",
    ],
  },
  "appearance.preview": { en: "Live preview", yue: "即時預覽" },
  "appearance.viewport": { en: "Preview size", yue: "預覽尺寸" },

  // ---- language & voice ----
  "lang.subtitle": {
    en: [
      "Language mode, per-language funny level, spoken narration, and the dim sum surprise.",
      "Language mode, per-language funny level, spoken narration, and the dim sum surprise.",
      "Language mode, funny level per language, narration, and the dim sum surprise.",
      "How this app talks to you — and how silly it is allowed to be while doing it.",
      "How this app talks to you, in which language, and how silly it may be while doing it.",
    ],
    yue: [
      "語言模式、每種語言嘅搞笑程度、語音旁白，同點心彩蛋。",
      "語言模式、搞笑程度、語音旁白同點心彩蛋。",
      "語言模式、每種語言嘅搞笑程度、旁白，同點心彩蛋。",
      "呢個 app 點同你講嘢 — 同埋佢可以搞笑到咩程度。",
      "呢個 app 用邊種語言、點同你講嘢，同埋可以幾癲。",
    ],
  },
  "lang.mode": { en: "Language mode", yue: "語言模式" },
  "lang.en": { en: "English", yue: "英文" },
  "lang.yue": { en: "廣東話 (Cantonese)", yue: "廣東話" },
  "lang.both": { en: "Bilingual", yue: "雙語" },
  "lang.funnyEn": { en: "Funny level — English", yue: "搞笑程度 — 英文" },
  "lang.funnyYue": { en: "Funny level — 廣東話", yue: "搞笑程度 — 廣東話" },
  "lang.funnyDisclosure": {
    en: [
      "The funny level styles every message, including errors, warnings, and destructive confirmations. It never changes what a message says will happen — the file, the account, the irreversible step are always named exactly. Reset it at any time.",
      "The funny level styles every message, including errors, warnings, and destructive confirmations. It never changes the facts — the file, the account, the irreversible step are always named exactly.",
      "The funny level styles every message, errors and destructive warnings included. Facts never change: the file, the account and the irreversible bit are always named.",
      "Yes, it restyles the scary messages too. It cannot change the facts though — the file, the account and the irreversible bit stay named exactly.",
      "Yes, even the scary messages get restyled. It still cannot lie to you: the file, the account, and the irreversible bit are named exactly, every level, every time.",
    ],
    yue: [
      "搞笑程度會影響所有訊息，包括錯誤、警告同破壞性確認。但唔會改變訊息內容 — 檔案、帳戶、不可還原嘅步驟一定講清楚。隨時可以重設。",
      "搞笑程度影響所有訊息，包括錯誤同破壞性警告。事實唔會變 — 檔案、帳戶、不可還原嘅步驟一定會講明。",
      "搞笑程度連驚嚇訊息都會改，但事實唔會變：檔案、帳戶、不可還原嘅部分照樣講清楚。",
      "係，驚嚇訊息都會改語氣。但佢改唔到事實 — 檔案、帳戶、不可還原嘅部分照樣講清楚。",
      "係，連驚嚇訊息都會改語氣。但佢唔會呃你：檔案、帳戶、不可還原嘅部分每個級數都照講清楚。",
    ],
  },
  "lang.narrator": { en: "Spoken narrator", yue: "語音旁白" },
  "lang.narratorHint": {
    en: [
      "Off by default. Speaks app events one at a time, yields to screen readers, and follows the funny level. Error narration always names the actual failure.",
      "Off by default. Speaks app events one at a time, yields to screen readers, and follows the funny level.",
      "Off by default. Speaks one event at a time and yields to screen readers.",
      "Off unless you ask. Speaks one line at a time and gets out of your screen reader's way.",
      "Off unless you ask for it. One line at a time, never talks over your screen reader, never over itself.",
    ],
    yue: [
      "預設關閉。逐一朗讀事件，會讓路俾螢幕閱讀器，並跟隨搞笑程度。錯誤旁白一定會講出真正嘅失敗原因。",
      "預設關閉。逐一朗讀事件，會讓路俾螢幕閱讀器。",
      "預設關閉。一次讀一句，會讓路俾螢幕閱讀器。",
      "你唔叫就唔開。一次讀一句，唔會撞你嘅螢幕閱讀器。",
      "你唔叫就唔開。一次一句，唔會撞你螢幕閱讀器，都唔會自己撞自己。",
    ],
  },
  "lang.narratorLang": { en: "Narration language", yue: "旁白語言" },
  "lang.narratorTest": { en: "Test narration", yue: "測試旁白" },
  "lang.dimsum": { en: "Dim sum surprise", yue: "點心彩蛋" },
  "lang.dimsumHint": {
    en: [
      "A 1% chance at launch of a non-blocking dim sum card. It never appears during first run, an error, or an update, and never twice in one launch.",
      "A 1% chance at launch of a non-blocking dim sum card. Never during first run, an error, or an update.",
      "1% chance at launch of a small dim sum card. Never during first run, an error, or an update.",
      "1% chance at launch of a small dim sum card. It never interrupts anything that matters.",
      "1% chance at launch of a small dim sum card. It waits politely and never interrupts anything that matters.",
    ],
    yue: [
      "每次啟動有 1% 機會出現唔阻手嘅點心卡。首次執行、出錯或更新時唔會出現，一次啟動亦唔會出現兩次。",
      "每次啟動 1% 機會出現點心卡。首次執行、出錯或更新時唔會出現。",
      "每次啟動有 1% 機會出現一張細細嘅點心卡，首次執行、出錯或更新時唔會出。",
      "每次啟動 1% 機會出現一張細點心卡，唔會阻你做正經事。",
      "每次啟動 1% 機會出現一張細點心卡。佢好識做，唔會阻你做正經事。",
    ],
  },
  "lang.dimsumTest": { en: "Show one now", yue: "即刻睇一次" },

  // ---- regex builder ----
  "regex.subtitle": {
    en: [
      "Build and test patterns against the engine this project actually uses: ECMAScript (RegExp) in the dashboard, evaluated locally. Patterns and sample text are never transmitted.",
      "Build and test patterns against the engine this project uses: ECMAScript RegExp, evaluated locally. Nothing is transmitted.",
      "Build and test patterns on the real engine: ECMAScript RegExp, evaluated locally. Nothing leaves this machine.",
      "Build a pattern without guessing. Real ECMAScript RegExp, evaluated locally, nothing leaves the machine.",
      "Build a pattern without the guesswork. Real ECMAScript RegExp, evaluated locally, and nothing leaves this machine.",
    ],
    yue: [
      "針對本專案實際使用嘅引擎建立同測試 pattern：dashboard 用 ECMAScript RegExp，本機評估。Pattern 同樣本文字唔會傳送出去。",
      "針對實際引擎建立同測試 pattern：ECMAScript RegExp，本機評估，唔會傳送。",
      "用真正引擎砌同測 pattern：ECMAScript RegExp，本機評估，唔會出機。",
      "唔用猜。真正 ECMAScript RegExp，本機評估，冇嘢出機。",
      "唔靠猜。真 ECMAScript RegExp，本機評估，冇一個字出過機。",
    ],
  },
  "regex.engine": { en: "Engine", yue: "引擎" },
  "regex.pattern": { en: "Pattern", yue: "Pattern" },
  "regex.flags": { en: "Flags", yue: "Flags" },
  "regex.sample": { en: "Sample text", yue: "樣本文字" },
  "regex.matches": { en: "Matches", yue: "符合" },
  "regex.groups": { en: "Capture groups", yue: "捕捉群組" },
  "regex.build": { en: "Guided construction", yue: "引導建立" },
  "regex.noMatch": { en: "No matches in the sample text.", yue: "樣本文字冇符合項。" },
  "regex.invalid": { en: "Invalid pattern: {error}", yue: "Pattern 無效：{error}" },
  "regex.useHere": { en: "Use in search", yue: "用於搜尋" },
  "regex.regexMode": { en: "Regex mode", yue: "Regex 模式" },
  "regex.plainDefault": {
    en: [
      "Plain text is the default. Regex applies only when you switch it on.",
      "Plain text is the default. Regex applies only when you switch it on.",
      "Plain text by default; regex only when you turn it on.",
      "Plain text by default. Regex only when you ask for it.",
      "Plain text by default. Regex only when you deliberately ask for it.",
    ],
    yue: [
      "預設係純文字。Regex 只在你開啟時生效。",
      "預設純文字，開咗 regex 才生效。",
      "預設純文字，regex 要自己開。",
      "預設純文字。Regex 你叫先有。",
      "預設純文字。Regex 要你自己特意開先有。",
    ],
  },

  // ---- changelog ----
  "changelog.subtitle": {
    en: [
      "Every released version, with its date and categorized changes. Filter by date, search the text, and export what you see.",
      "Every released version with its date and categorized changes. Filter by date, search, and export.",
      "Every released version, dated and categorized. Filter, search, export.",
      "Every version ever shipped, dated and sorted. Filter it, search it, export it.",
      "Every version ever shipped, dated and sorted. Filter it, search it, export it — even the embarrassing ones.",
    ],
    yue: [
      "所有已發佈版本、日期同分類改動。可按日期篩選、搜尋文字並匯出。",
      "所有已發佈版本、日期同分類改動。可篩選、搜尋、匯出。",
      "所有發佈過嘅版本，有日期有分類。篩選、搜尋、匯出。",
      "所有出過嘅版本，有日期有分類。篩得、搜得、匯出得。",
      "所有出過嘅版本，有日期有分類。篩得、搜得、匯出得，包括醜嘅嗰啲。",
    ],
  },
  "changelog.from": { en: "From", yue: "由" },
  "changelog.to": { en: "To", yue: "至" },
  "changelog.preset": { en: "Presets", yue: "快選" },
  "changelog.noEntries": { en: "No versions match the current filter and search.", yue: "冇版本符合現時篩選同搜尋。" },
  "changelog.exportNote": { en: "Exported range: {range}", yue: "匯出範圍：{range}" },

  // ---- version history ----
  "history.subtitle": {
    en: [
      "Local Git-backed snapshots of every record this app owns — providers, accounts, keys, combos, and settings. History is append-only: restoring records a new revision instead of rewriting the past.",
      "Local Git-backed snapshots of every record this app owns. History is append-only: restoring records a new revision.",
      "Local snapshots of every record this app owns. Restoring records a new revision rather than rewriting history.",
      "Undo for everything, not just documents. Restoring adds a revision, so you can undo the undo.",
      "Undo for everything, not just documents. A restore adds a revision, so you can undo the undo, then undo that too.",
    ],
    yue: [
      "本機 Git 快照，涵蓋此應用擁有嘅所有記錄 — 供應商、帳戶、key、組合同設定。紀錄只會追加：還原會記錄新版本，唔會改寫過去。",
      "本機 Git 快照，涵蓋所有記錄。紀錄只會追加：還原會記錄新版本。",
      "本機快照，涵蓋所有記錄。還原會加一個新版本，唔會改寫歷史。",
      "唔止文件有 undo。還原會加一個版本，所以 undo 都可以 undo。",
      "唔止文件有 undo。還原會加一個版本，所以 undo 可以 undo，再 undo 都得。",
    ],
  },
  "history.revisions": { en: "Revisions", yue: "版本" },
  "history.diff": { en: "Diff", yue: "差異" },
  "history.restore": { en: "Restore", yue: "還原" },
  "history.label": { en: "Label", yue: "標籤" },
  "history.restored": { en: "Restored \"{label}\" as a new revision.", yue: "已將「{label}」還原為新版本。" },

  // ---- notifications ----
  "notif.subtitle": {
    en: [
      "Everything the app has told you, including notifications you already dismissed.",
      "Everything the app has told you, including notifications you already dismissed.",
      "Everything the app has told you, dismissed ones included.",
      "Everything the app has said to you, including what you swiped away.",
      "Everything the app has said to you, including the bits you swiped away without reading.",
    ],
    yue: [
      "呢個 app 同你講過嘅所有嘢，包括你已經關閉嘅通知。",
      "所有通知，包括已關閉嘅。",
      "app 同你講過嘅所有嘢，包括你關咗嘅。",
      "app 同你講過嘅所有嘢，包括你揈走嗰啲。",
      "app 同你講過嘅所有嘢，包括你冇睇就揈走嗰啲。",
    ],
  },
  "notif.centre": { en: "Notification centre", yue: "通知中心" },
  "notif.empty": { en: "Nothing yet.", yue: "暫時冇。" },
  "notif.clear": { en: "Clear history", yue: "清除紀錄" },
  "notif.undo": { en: "Undo", yue: "還原" },
  "notif.viewDetails": { en: "View details", yue: "睇詳情" },

  // ---- tabs ----
  "tabs.newTab": { en: "New tab", yue: "新分頁" },
  "tabs.closeTab": { en: "Close {name}", yue: "閂 {name}" },
  "tabs.pin": { en: "Pin tab", yue: "釘住分頁" },
  "tabs.unpin": { en: "Unpin tab", yue: "取消釘住" },
  "tabs.overflow": { en: "All tabs", yue: "所有分頁" },
  "tabs.searchTabs": { en: "Search tabs…", yue: "搜尋分頁…" },
  "tabs.appearance": { en: "Tab appearance", yue: "分頁外觀" },
  "tabs.reorderHint": { en: "Drag to reorder. Pinned tabs stay first.", yue: "拖拉可重新排序，釘住嘅排前。" },

  // ---- settings search ----
  "settings.search": { en: "Search settings…", yue: "搜尋設定…" },
  "settings.otherTab": { en: "{count} match(es) on other tabs: {tabs}", yue: "其他分頁有 {count} 個符合：{tabs}" },
  "settings.noMatch": { en: "No settings match on this surface.", yue: "此介面冇符合設定。" },
  "settings.openBuilder": { en: "Open regex builder", yue: "打開 regex 產生器" },
};

const camel = k => k.replace(/[.\-_]+(.)/g, (_, c) => c.toUpperCase());

function pick(entry, lang, level) {
  const v = entry && entry[lang];
  if (v == null) return null;
  if (Array.isArray(v)) return v[Math.min(4, Math.max(0, level - 1))] ?? v[2];
  return v;
}

function fill(str, vars) {
  if (!vars || !str) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Returns {t(key, vars), L} for the active language mode and funny levels. */
export function makeI18n({ locale = "en", funnyEn = 3, funnyYue = 3 } = {}) {
  const t = (key, vars) => {
    const entry = S[key];
    if (!entry) return key;
    const en = fill(pick(entry, "en", funnyEn), vars);
    const yue = fill(pick(entry, "yue", funnyYue), vars);
    if (locale === "en") return en ?? yue ?? key;
    if (locale === "yue") return yue ?? en ?? key;
    if (!yue || yue === en) return en;
    return `${en}\n${yue}`;
  };
  const L = {};
  for (const key of Object.keys(S)) L[camel(key)] = t(key);
  return { t, L, keys: Object.keys(S) };
}

export const I18N_KEYS = Object.keys(S);
export const STRINGS = S;
