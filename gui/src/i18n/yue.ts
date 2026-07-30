/**
 * Hong Kong Cantonese (廣東話) — written, not Mandarin transliterated.
 *
 * Deliberately typed `Partial`, unlike the five full product dictionaries.
 * Those are `Record<TKey, string>` so a missing translation is a compile error,
 * which is the right guarantee for a locale that shipped complete. Requiring
 * the same of a locale being filled in would mean either 1 500 placeholder
 * strings — which is not a translation, it is English wearing a `yue` label —
 * or not shipping Cantonese at all.
 *
 * So this resolves through the same fallback chain the M3 shell keys already
 * use: a translated key renders Cantonese, an untranslated one renders English.
 * The screens people read most are translated first.
 *
 * House style: real spoken Hong Kong Cantonese (係, 冇, 嘅, 咗, 喺, 睇, 撳),
 * not written Standard Chinese. Technical identifiers — model ids, file paths,
 * HTTP verbs, `ocx` subcommands — stay exact and untranslated in every string,
 * because a reader has to be able to type them.
 */

import type { TKey } from "./shared";

export const yue: Partial<Record<TKey, string>> = {
  // ---- shell / navigation ----
  "nav.dashboard": "總覽",
  "nav.codexAuth": "Codex 登入",
  "nav.providers": "供應商",
  "nav.models": "模型",
  "nav.combos": "組合",
  "nav.subagents": "子代理",
  "nav.logs": "紀錄同除錯",
  "nav.usage": "用量",
  "nav.storage": "儲存",
  "nav.api": "API",
  "nav.claude": "Claude",
  "nav.grok": "Grok",
  "nav.startup": "開機",
  "nav.appearance": "外觀",
  "nav.language": "語言同語音",
  "nav.regex": "Regex 產生器",
  "nav.changelog": "更新紀錄",
  "nav.history": "版本紀錄",
  "nav.notifications": "通知",
  "nav.network": "遠端存取同備份",
  "nav.terminal": "終端機",
  "nav.mobile": "遙控",
  "nav.settings": "設定",

  // ---- common ----
  "common.loading": "載入緊…",
  "common.settings": "設定",

  // ---- launch card ----
  "launch.title": "開啟",
  "launch.sub": "喺呢部機開啲 agent CLI 同佢哋嘅桌面 app。",
  "launch.cli": "CLI",
  "launch.desktop": "桌面 app",
  "launch.open": "開啟",
  "launch.opening": "開緊 {label}…",
  "launch.opened": "{label} 已開啟",
  "launch.failed": "開唔到 {label}",
  "launch.notInstalled": "未安裝",
  "launch.install": "攞佢",
  "launch.installing": "安裝緊 {label}…",
  "launch.installed": "{label} 已安裝",
  "launch.installFailed": "裝唔到 {label}",
  "launch.installOpenPage": "開下載頁",
  "launch.installManual": "冇官方套件 —— 會開下載頁",
  "launch.installRestart": "已安裝。重開 opencodex 佢先會出現喺 PATH。",
  "launch.installLog": "安裝程式輸出",
  "launch.emptyTitle": "暫時冇嘢可以開",
  "launch.emptyBody": "喺呢部機搵唔到任何 agent CLI 或者桌面 app。裝咗其中一個就會喺呢度出現。",
  "launch.loadFailed": "讀唔到啟動目標",

  // ---- terminal ----
  "terminal.title": "終端機",
  "terminal.subtitle": "唔使離開 opencodex 就執行到指令。Session 由你個 home 資料夾開始。",
  "terminal.idleTitle": "冇 session",
  "terminal.idleBody": "喺上面揀個 shell 或者 CLI 就可以開始。",
  "terminal.stop": "停止",
  "terminal.send": "執行",
  "terminal.inputLabel": "指令",
  "terminal.inputPlaceholder": "打指令，撳 Enter",
  "terminal.exited": "Session 已經結束",
  "terminal.transcript": "{label} 輸出",
  "terminal.startFailed": "開唔到 {label}",
  "terminal.writeFailed": "送唔到入去個 session",
  "terminal.blockedTitle": "終端機已停用",
  "terminal.blocked": "只有當 proxy 綁喺呢部機嗰陣，先用得內置終端機。",
  "terminal.fullScreenWarn": "呢個 CLI 嘅全螢幕介面要真 console 先畫到，喺呢度出唔到。非互動指令（--help、exec、--version）正常用得。要完整體驗就用「開啟」喺 console 度開。",

  // ---- mobile remote ----
  "mobile.title": "opencodex 遙控",
  "mobile.chat": "傾偈",
  "mobile.sessions": "工作階段",
  "mobile.control": "控制",
  "mobile.model": "模型",
  "mobile.prompt": "訊息",
  "mobile.send": "傳送",
  "mobile.stop": "停止",
  "mobile.transcript": "對話",
  "mobile.chatHint": "喺上面揀個模型然後打段嘢。佢會好似其他 client 一樣經呢個 proxy 行，所以一樣有紀錄同計數。",
  "mobile.emptyReply": "（個模型咩都冇回）",
  "mobile.stopped": "（未開始回覆就已經停咗）",
  "mobile.sendFailed": "send 唔到呢個訊息",
  "mobile.noSessions": "仲未有請求",
  "mobile.sessionsFailed": "讀唔到工作階段紀錄",
  "mobile.proxy": "Proxy",
  "mobile.exposed": "其他裝置連得到",
  "mobile.loopback": "淨係限呢部機",
  "mobile.noCredential": "已經開放咗畀網絡，但係未設定憑證。",
  "mobile.apiKey": "API key",
  "mobile.apiKeyHint": "proxy 開放咗畀網絡先需要。淨係擺喺記憶體，唔會寫入儲存空間，所以重新載入之後要再入一次。",
  "mobile.tokens": "{n} 個 token",
  "mobile.httpStatus": "Proxy 回咗 {status}，冇其他資料。",
  "mobile.modelsFailed": "連唔到 proxy，載入唔到模型清單。",
  "mobile.retry": "再試一次",

  // ---- notifications ----
  "notif.dismiss": "關閉",
  "notif.centre": "通知",
  "notif.empty": "而家乜都冇",
  "notif.emptyBody": "proxy 嘅訊息，同你做過嘅動作，都會喺呢度出現。",
  "notif.viewAll": "睇晒所有通知",
  "notif.historyTitle": "通知紀錄",
  "notif.historySub": "由第一次打開呢個控制台之後顯示過嘅所有訊息。",
  "notif.clear": "清除紀錄",
  "notif.search": "搜尋通知",
  "notif.toneAll": "全部",
  "notif.toneError": "錯誤",
  "notif.toneWarn": "警告",
  "notif.toneSuccess": "成功",
  "notif.toneInfo": "資訊",

  // ---- dim sum ----
  "dimsum.title": "點心時間到！",
  "dimsum.hint": "百分之一開機機率嘅小驚喜。想熄可以喺外觀度熄。",
  "dimsum.toggle": "點心驚喜",
  "dimsum.toggleHint": "大約每一百次開機，會有一次彈張細細張點心卡。第一次執行同啱啱更新完就唔會出。",
  "dimsum.showNow": "而家睇一個",

  // ---- onboarding ----
  "onboard.title": "歡迎使用 opencodex",
  "onboard.sub": "三個步驟，之後全部都改得。",
  "onboard.skip": "跳過設定",
  "onboard.back": "返上一步",
  "onboard.next": "下一步",
  "onboard.finish": "完成",
  "onboard.stepOf": "第 {n} 步，共 {total} 步",
  "onboard.langTitle": "揀種語言",
  "onboard.dontShow": "唔好再顯示",
};
