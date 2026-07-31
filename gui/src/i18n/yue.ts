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
  // The confirmation dialogs default their dismiss button to this key, so an
  // untranslated one used to render a lone English "Cancel" beside Cantonese copy.
  "common.cancel": "算數",

  // ---- 確認對話框 ----
  // 之前用瀏覽器嗰個 confirm() 畫，所以連個掣寫乜都改唔到 —— 一律「OK」。
  // 而家個標題同個掣都講明撳落去會做乜。
  "confirm.stopTitle": "停咗個 proxy",
  "confirm.exitTitle": "關閉 OpenCodex",
  "confirm.exitAction": "關閉",
  "confirm.exitForceAction": "照關",
  "confirm.restoreTitle": "還原去呢個快照",
  "confirm.restoreForceAction": "照還原",
  "confirm.exposeTitle": "將個 proxy 公開畀你個網絡",
  "confirm.exposeAction": "公開",

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
  "launch.wtInstall": "裝 Windows Terminal",
  "launch.wtRestart": "Windows Terminal 裝咗喇，不過今次開住嘅 opencodex 仲未見到佢。重開 opencodex，然後再開返個 CLI。",
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
  "onboard.networkTitle": "畀其他裝置連得到",
  "onboard.networkSub": "opencodex 而家喺呢部機行緊。你可以搵下網絡上面有冇已經行緊嘅，或者將呢部公開出去，等電話或者手提電腦用得到。",
  "onboard.netScan": "喺我個網絡度搵",
  "onboard.netScanning": "搵緊…",
  "onboard.netNone": "個網絡度冇嘢應。如果你得呢一個安裝，咁樣好正常。",
  "onboard.netThisMachine": "呢部機",
  "onboard.netConnect": "開啟",
  "onboard.netExpose": "將呢部公開畀我個網絡",
  "onboard.netExposeHint": "預設係熄。你唔開，其他裝置係連唔到嘅。",
  "onboard.netExposeWarn": "咁樣會連個控制台一齊公開，而個控制台改得供應商、睇得紀錄、仲匯出得你啲帳戶。下面條密碼係兩者之間唯一嘅嘢。淨係喺你信得過嘅網絡先好咁做。",
  "onboard.netKey": "連線密碼",
  "onboard.netKeyPlaceholder": "其他裝置會用嘅密碼",
  "onboard.netKeyRule": "最少 {n} 個字符。唔好用返你其他地方用緊嘅密碼。",
  "onboard.netExposeAction": "公開並設定密碼",
  "onboard.netExposed": "已經公開畀你個網絡",
  "onboard.netExposeFailed": "公開唔到個 proxy",

  // ---- 貼住搜尋欄嘅 regex 產生器 ----
  "regexpop.apply": "用呢個 pattern",
  "regexpop.applyHint": "會將搜尋欄嘅字換成呢個 pattern，同埋將個欄轉做 regex 模式。",
  "regexpop.applyHintPlain": "會將搜尋欄嘅字換成呢個 pattern。",
  "regexpop.close": "閂咗個產生器",

  // ---- 分頁 ----
  "tabs.listAria": "開咗嘅頁",
  "tabs.close": "閂咗 {name}",
  "tabs.hidden": "收埋咗嘅分頁（{count}）",
  "tabs.newTab": "開新分頁",

  // ---- 撳右掣嗰個選單 ----
  "tabs.menuAria": "{name} 嘅動作",
  "tabs.closeTab": "閂咗呢個分頁",
  "tabs.closeOthers": "閂晒其他分頁",
  "tabs.closeRight": "閂晒右邊嘅分頁",
  "tabs.pin": "釘住呢個分頁",
  "tabs.unpin": "唔釘住喇",
  "tabs.duplicate": "複製呢個分頁",
  "tabs.closeContaining": "閂咗個名有某啲字嘅分頁…",
  "tabs.closeNotContaining": "閂咗個名冇某啲字嘅分頁…",
  "tabs.editAppearance": "改呢個分頁嘅樣…",

  // ---- 一次過閂一堆 ----
  "tabs.bulkContainTitle": "閂咗個名有某啲字嘅分頁",
  "tabs.bulkNotContainTitle": "閂咗個名冇某啲字嘅分頁",
  "tabs.bulkScope": "淨係對住分頁見到嘅名嚟比，唔會偷睇頁入面嘅內容。",
  "tabs.bulkQuery": "攞嚟比對分頁名嘅字",
  "tabs.bulkQueryPlaceholder": "分頁名入面嘅字",
  "tabs.bulkBuilder": "為呢次批量關閉砌個 pattern",
  "tabs.bulkMode": "比對模式",
  "tabs.bulkModePlain": "普通文字",
  "tabs.bulkModeRegex": "Regex",
  "tabs.bulkEmpty": "打啲嘢先。乜都唔打即係乜都中，咁就會成條 strip 閂晒。",
  "tabs.bulkInvalid": "Pattern 有問題：{error}",
  "tabs.bulkCount": "會閂 {count} 個，總共開咗 {total} 個",
  "tabs.bulkPreview": "會被閂嘅分頁",
  "tabs.bulkPinnedSpared": "釘住咗嘅照留低：有 {count} 個。",
  "tabs.bulkIncludePinned": "連釘住嗰啲都閂",
  "tabs.bulkConfirm": "閂 {count} 個",
  "tabs.cancel": "算數",

  // ---- 新分頁搜尋 ----
  "tabs.searchPages": "搵頁",
  "tabs.searchPlaceholder": "篩頁",
  "tabs.searchBuilder": "砌個 pattern 嚟篩啲頁",
  "tabs.searchNone": "冇一頁夾到「{query}」。",
  "tabs.searchInvalid": "Pattern 有問題：{error}",

  // ---- 逐個分頁改樣 ----
  "tabs.styleFor": "{name} 嘅外觀",
  "tabs.styleClose": "閂咗個外觀編輯器",
  "tabs.stylePreview": "預覽",
  "tabs.styleColor": "字嘅顏色",
  "tabs.styleColorPicker": "揀字嘅顏色",
  "tabs.styleBg": "背景",
  "tabs.styleBgPicker": "揀背景色",
  "tabs.styleFont": "字型",
  "tabs.styleFontInherit": "跟主題",
  "tabs.styleSize": "字嘅大細",
  "tabs.styleWeight": "字嘅粗幼",
  "tabs.styleBadge": "小標籤",
  "tabs.styleBadgeHint": "最多 {max} 個字符，會喺個名後面出。",
  "tabs.styleReset": "還原",
  "tabs.styleResetOne": "將{name}還原做主題預設",
  "tabs.styleResetAll": "全部還原",
  "tabs.styleInherits": "跟主題",
  "tabs.styleSwatchFallback": "個色板顯示唔到呢個值 —— 真正用緊嘅係隔籬個欄入面嗰個。",

  // ---- 紀錄檔同刪咗之後點救 ----
  // 講到明幾多行、擺喺邊、留幾耐。刪嘢之前唔講清楚會冇咗啲乜,
  // 就等於叫人閉住眼簽名。
  "logs.file.title": "紀錄檔",
  "logs.file.where": "寫咗落 {path} —— 用任何文字編輯器都開得。",
  "logs.file.usage": "請求嗰啲行：{path}",
  "logs.file.retention": "每個紀錄檔最多 {size}，舊嘅留 {count} 個，所以成個資料夾點都唔會超過 {total}。",
  "logs.file.footprint": "{rows} 行請求 · {lines} 行程式紀錄 · 佔咗 {size}",
  "logs.clear": "清走紀錄",
  "logs.clearTitle": "清走呢部機嘅紀錄",
  "logs.clearBody": "會刪咗 {rows} 行請求同 {lines} 行程式紀錄。紀錄表、除錯分頁同用量統計全部都係讀呢啲檔嘅，所以三樣都會變返吉。\n\n刪之前會先 commit 落本機嘅版本歷史，所以喺「版本歷史」度撳返轉頭就攞得返。嗰個歷史淨係留喺呢部機，唔會上傳去邊。",
  "logs.cleared": "紀錄清走咗",
  "logs.clearedBody": "已經存咗落版本歷史，個名叫「{label}」。想攞返就去「版本歷史」。",
  "logs.clearedNoSnapshot": "紀錄係清走咗，但係寫唔到落版本歷史 —— 呢次冇得反悔。",
  "logs.clearFailed": "清唔到啲紀錄",
  "logs.clearNothing": "冇紀錄可以清。",
  "logs.revisionLabel": "紀錄",

  // ---- 紀錄快照喺同一條時間線 ----
  // 紀錄快照同帳號快照嘅還原方式唔同 —— 唔使等請求做完，又唔使重啟,
  // 所以自己有自己個掣，唔會借人哋嗰個。
  "history.snapshotLogs": "紀錄檔",
  "history.snapshotState": "帳號同設定",
  "history.snapshotMixed": "帳號、設定同紀錄",
  "history.restoreLogs": "還原紀錄",
  "history.restoreLogsConfirm": "要將啲紀錄還原做「{label}」嗰陣個樣？\n\n而家啲紀錄會先 commit 咗，所以呢次還原本身都反悔得返。唔會斷任何請求，proxy 亦都唔使重啟。",
  "history.logsRestored": "紀錄還原咗",
  "history.logsRestoredBody": "寫返咗 {count} 個檔，仲記低咗做一條新紀錄 —— 所以呢次都反悔得返。",
  "history.logsRestoredKept": "嗰條紀錄之後先加嘅檔照留低：{files}",
  "history.logsRestoreFailed": "還原唔到啲紀錄",
};
