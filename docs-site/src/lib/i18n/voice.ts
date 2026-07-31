/**
 * The funny level, as actual copy.
 *
 * The two sliders on Settings → Language & voice persist one number per
 * language. This file is what those numbers read: the level-specific wording for
 * the copy where voice actually carries, in both tracks.
 *
 * ## What varies, and what never does
 *
 * The level styles **voice only**. Every variant of a key states the same fact:
 * the same pattern error, the same date format, the same thing that was deleted,
 * the same "nothing left the machine". Level 1 is what you would write for a
 * colleague under pressure; level 5 is what you would say to a friend. Neither
 * is allowed to leave the reader unsure what a button does — a warning nobody
 * can act on is a broken warning, not a funny one. `tests/i18n-voice.test.ts`
 * re-derives every `{placeholder}` and every load-bearing token (`YYYY-MM-DD`,
 * "export", "browser") from the neutral wording and asserts it survives all five
 * levels in both languages.
 *
 * ## Level 3 is deliberately absent
 *
 * The shipped wording in `deck.ts` / `locales.ts` **is** level 3. Repeating it
 * here would be a second copy of every string to keep in step, and the first
 * time the two drifted the slider would start lying. A level with no entry falls
 * through the ordinary dictionary chain.
 *
 * ## Every category, and the one that is empty
 *
 * `VOICE_CATEGORIES` has eleven members and this overlay covers ten. `financial`
 * is empty because **this site shows no financial messages** — it is a
 * documentation site with no prices, no balances and no billing. That is a fact
 * about the surface, not an exemption from the rule: the test asserts `financial`
 * is the *only* empty category, so the first time a paid surface lands here the
 * build says so instead of quietly shipping an unvoiced warning.
 *
 * ## Why it is a curated overlay rather than five whole decks
 *
 * Most keys are labels — "Save", "Close", "Next month" — with exactly one
 * sensible rendering at any level. Voicing all of them would be five copies of
 * the deck to keep in step for no gain. So this covers the copy where voice
 * reads: errors, warnings, empty states, confirmations, the destructive wording
 * and the delight. `voice.coverage()` reports the real number so the settings
 * screen can state it rather than implying the whole site is rewritten.
 */

import { makeVoice, type VoiceTable } from "../../../../shared/m3/i18n";
import type { UiKey } from "./keys";

const TABLE: VoiceTable<UiKey> = {
  /* ------------------------------------------------------- destructive -- */

  "notif.clear": {
    cat: "destructive",
    en: {
      1: "Clear history",
      2: "Clear the notification history",
      4: "Clear the lot",
      5: "Bin the whole history",
    },
    yue: {
      1: "清除記錄",
      2: "清除通知記錄",
      4: "全部清走",
      5: "成個記錄倒晒",
    },
  },

  "notif.historyCleared": {
    cat: "destructive",
    en: {
      1: "Notification history cleared.",
      2: "The notification history has been cleared.",
      4: "The notification history is gone.",
      5: "The notification history is gone — nothing kept, nothing to get back.",
    },
    yue: {
      1: "通知記錄已清除。",
      2: "通知記錄已經清除咗。",
      4: "通知記錄冇晒喇。",
      5: "通知記錄清得一乾二淨，冇留底，攞唔返。",
    },
  },

  "settings.resetAll": {
    cat: "destructive",
    en: {
      1: "Reset every setting",
      2: "Reset every setting to its default",
      4: "Put every setting back the way it shipped",
      5: "Factory-reset the lot — language, voice, notifications, dim sum",
    },
    yue: {
      1: "重設全部設定",
      2: "將全部設定還原做預設",
      4: "將所有設定打返出廠嗰個樣",
      5: "一鍵打回原形：語言、語氣、通知、點心，全部還原",
    },
  },

  "tabs.closeOthers": {
    cat: "destructive",
    en: {
      1: "Close other tabs",
      2: "Close every other tab",
      4: "Close the rest, keep this one",
      5: "Close every other tab and leave just this one standing",
    },
    yue: {
      1: "閂其他分頁",
      2: "閂晒其他每一個分頁",
      4: "閂晒其餘嗰啲，淨返呢個",
      5: "閂晒其他分頁，得呢個企得住",
    },
  },

  /* ---------------------------------------------------------- security -- */

  "settings.lead": {
    cat: "security",
    en: {
      1: "These settings are stored in this browser only and are not transmitted.",
      2: "Everything here is stored in this browser only. Nothing is sent anywhere.",
      4: "All of this lives in your browser and nowhere else. Nothing leaves the machine.",
      5: "Every switch on this page stays in your browser. No server hears about it, because there is no server listening.",
    },
    yue: {
      1: "呢啲設定淨係存喺呢部瀏覽器，唔會傳送出去。",
      2: "呢度嘅嘢淨係擺喺你部瀏覽器，冇送去任何地方。",
      4: "全部都喺你部瀏覽器度，冇第二個地方有。乜都唔會離開部機。",
      5: "呢版每一個掣都淨係留喺你部瀏覽器。冇 server 知，因為根本冇 server 喺度聽。",
    },
  },

  /* ----------------------------------------------------- accessibility -- */

  "notifpref.autoDismissHint": {
    cat: "accessibility",
    en: {
      1: "Informational messages dismiss themselves after the delay above. Warnings and errors stay until you dismiss them.",
      2: "Informational messages disappear on their own after the delay above. Warnings and errors always wait for you.",
      4: "The merely-informative ones show themselves out after the delay above. Warnings and errors sit there until you say otherwise.",
      5: "The chatty ones let themselves out after the delay above. Warnings and errors do not — they wait for you however long it takes, because a message you never saw is a message that never happened.",
    },
    yue: {
      1: "報告性質嘅訊息會喺上面設定嘅時間之後自己收埋。警告同錯誤會留低，直到你收咗佢。",
      2: "報告性質嘅訊息過咗上面設定嘅時間會自己走。警告同錯誤永遠等你。",
      4: "淨係報料嗰啲，夠鐘就自己閃。警告同錯誤照坐喺度，等你出聲先郁。",
      5: "多嘴嗰啲夠鐘就自己走。警告同錯誤唔會 — 佢哋等到你為止，因為你冇見過嘅訊息，等於冇出現過。",
    },
  },

  /* ------------------------------------------------------------- error -- */

  "tabs.invalidQuery": {
    cat: "error",
    en: {
      1: "Invalid pattern: {error}",
      2: "That pattern will not compile: {error}",
      4: "The regex engine read that and gave up: {error}",
      5: "Your pattern went one bracket too far and the engine bailed out: {error}",
    },
    yue: {
      1: "式唔正確：{error}",
      2: "呢個式編譯唔到：{error}",
      4: "正則引擎睇完，攤攤手：{error}",
      5: "個式多咗個括號，引擎即刻收工：{error}",
    },
  },

  "changelog.invalidDate": {
    cat: "error",
    en: {
      1: "“{value}” is not a valid date. Use YYYY-MM-DD.",
      2: "“{value}” cannot be read as a date. Use YYYY-MM-DD.",
      4: "“{value}” is not a date this filter can read. It wants YYYY-MM-DD.",
      5: "“{value}” means nothing to a calendar. Hand it YYYY-MM-DD and it behaves.",
    },
    yue: {
      1: "「{value}」唔係有效日期。請用 YYYY-MM-DD。",
      2: "「{value}」讀唔到做日期。請用 YYYY-MM-DD。",
      4: "「{value}」呢個篩選睇唔明。佢淨係識 YYYY-MM-DD。",
      5: "「{value}」對住個月曆完全冇意思。畀 YYYY-MM-DD 佢，佢即刻乖。",
    },
  },

  "changelog.copyFailed": {
    cat: "error",
    en: {
      1: "The clipboard write failed. Use the export button to write the same text to a file.",
      2: "The browser refused the clipboard write. The export button writes the same text to a file.",
      4: "The clipboard said no. The export button writes exactly the same text to a file.",
      5: "The clipboard slammed the door. The export button writes the identical text to a file, no negotiation required.",
    },
    yue: {
      1: "寫入剪貼簿失敗。可以用匯出掣，將同一段字寫落檔案。",
      2: "瀏覽器唔畀寫入剪貼簿。匯出掣會將同一段字寫落檔案。",
      4: "剪貼簿耍手擰頭。匯出掣照樣將同一段字寫落檔案。",
      5: "剪貼簿一句「唔得」就閂咗門。匯出掣照寫同一段字落檔案，唔使同佢傾。",
    },
  },

  /* ----------------------------------------------------------- warning -- */

  "funny.disclosure": {
    cat: "warning",
    en: {
      1: "This setting changes the wording of every message this site shows, including warnings and errors. It does not change what they say: a message always names the real thing it is about.",
      2: "This styles every message the site shows you, warnings and errors included. It never changes the facts — a message always names the real thing it is about.",
      4: "This restyles every message the site shows you, warnings and errors included. The facts are nailed down: whatever voice it uses, a message always names the real thing it is about.",
      5: "Yes, this restyles the warnings and the errors too — that is the deal, and you are opting into it on purpose. What it cannot touch is the facts: even at level 5 a message is still obliged to name the real thing it is about, in words you can act on.",
    },
    yue: {
      1: "呢個設定會改變網站每一句訊息嘅寫法，包括警告同錯誤。佢唔會改內容：句嘢一定會講明佢講緊乜。",
      2: "呢個會影響網站彈畀你睇嘅每一句，警告同錯誤都唔例外。事實唔會變 — 句嘢一定會講明佢講緊乜。",
      4: "呢個會將網站每一句都換過個語氣，警告同錯誤照計。但事實釘死咗：唔理用邊種語氣，句嘢一定會講明佢講緊乜。",
      5: "係呀，連警告同錯誤都一齊改語氣 — 呢個就係條數，而你係特登撳落去嘅。改唔到嘅係事實：就算去到第 5 級，句嘢一樣要用你做到嘢嘅字眼，講清楚佢講緊乜。",
    },
  },

  /* ----------------------------------------------------------- success -- */

  "changelog.copied": {
    cat: "success",
    en: {
      1: "The filtered changelog was copied to the clipboard.",
      2: "Copied the filtered changelog to the clipboard.",
      4: "Copied — the filtered changelog is on your clipboard.",
      5: "On your clipboard: exactly the filtered changelog you were looking at, nothing more.",
    },
    yue: {
      1: "篩選後嘅更新紀錄已複製到剪貼簿。",
      2: "篩選後嘅更新紀錄已經複製咗去剪貼簿。",
      4: "複製咗 — 篩選後嘅更新紀錄而家喺你剪貼簿。",
      5: "剪貼簿入面就係你頭先睇緊嗰份篩選後嘅更新紀錄，一個字都冇多。",
    },
  },

  "changelog.exported": {
    cat: "success",
    en: {
      1: "Exported {count} releases as Markdown.",
      2: "Exported {count} releases as Markdown.",
      4: "{count} releases, written out as Markdown.",
      5: "{count} releases packed into one Markdown file — the same ones you were looking at, in the same order.",
    },
    yue: {
      1: "已將 {count} 個版本匯出做 Markdown。",
      2: "已經將 {count} 個版本匯出做 Markdown。",
      4: "{count} 個版本，寫晒做 Markdown。",
      5: "{count} 個版本入晒一個 Markdown 檔 — 同你頭先睇嗰批一樣，次序都冇變。",
    },
  },

  "settings.resetDone": {
    cat: "success",
    en: {
      1: "Settings reset to their defaults.",
      2: "Every setting is back to its default.",
      4: "Every setting is back to the way it shipped.",
      5: "Clean slate — every setting is exactly where it was on your first visit.",
    },
    yue: {
      1: "設定已還原做預設。",
      2: "全部設定已經還原做預設。",
      4: "全部設定打返出廠嗰陣個樣。",
      5: "一乾二淨 — 每個設定都同你第一次嚟嗰陣一模一樣。",
    },
  },

  /* ---------------------------------------------------------- progress -- */

  "common.loading": {
    cat: "progress",
    en: {
      1: "Loading…",
      2: "Loading…",
      4: "Loading, nearly there…",
      5: "Still loading — the bytes are on their way…",
    },
    yue: {
      1: "載入中…",
      2: "載入中…",
      4: "載緊，就快好…",
      5: "仲載緊 — 啲 bytes 喺路上…",
    },
  },

  /* ------------------------------------------------------------- empty -- */

  "notif.empty": {
    cat: "empty",
    en: {
      1: "No notifications.",
      2: "Nothing has happened yet.",
      4: "Nothing has happened yet. Quiet is good.",
      5: "Nothing has happened yet. Either the site is behaving itself, or you have only just arrived.",
    },
    yue: {
      1: "冇通知。",
      2: "暫時乜都未發生。",
      4: "暫時乜都未發生。靜靜地都幾好。",
      5: "暫時乜都未發生。唔係個網站好乖，就係你啱啱先到。",
    },
  },

  "changelog.noResults": {
    cat: "empty",
    en: {
      1: "No release matches the current filters.",
      2: "No release matches both filters.",
      4: "Nothing matches both filters at once.",
      5: "Not one release survives both filters at the same time.",
    },
    yue: {
      1: "冇版本符合而家嘅篩選。",
      2: "冇版本同時符合兩個篩選。",
      4: "兩個篩選一齊夾，一個都夾唔到。",
      5: "兩個篩選一齊落，連一個版本都頂唔住。",
    },
  },

  "settings.none": {
    cat: "empty",
    en: {
      1: "No setting matches the search.",
      2: "No setting matches that.",
      4: "Nothing on this page matches that.",
      5: "Not one setting answers to that name.",
    },
    yue: {
      1: "冇設定符合搜尋。",
      2: "冇設定夾到。",
      4: "呢版冇一個夾得到。",
      5: "冇一個設定應呢個名。",
    },
  },

  "changelog.empty": {
    cat: "empty",
    en: {
      1: "No changelog entries were found in the source file.",
      2: "No changelog entries were found in the source file.",
      4: "The source file parsed, and there was not a single entry in it.",
      5: "The source file parsed cleanly and contained exactly nothing — which is either a very quiet release or a build that lost its CHANGELOG.md.",
    },
    yue: {
      1: "來源檔入面搵唔到任何更新紀錄。",
      2: "來源檔入面搵唔到任何更新紀錄。",
      4: "來源檔解析到，但入面一條都冇。",
      5: "來源檔解析得好乾淨，入面乜都冇 — 唔係今次真係咁靜，就係個 build 搞唔見咗 CHANGELOG.md。",
    },
  },

  /* ---------------------------------------------------------- guidance -- */

  "changelog.noResultsHint": {
    cat: "guidance",
    en: {
      1: "Widen the date range or change the search text. Both filters apply together, so either one can be excluding every release.",
      2: "Widen the dates or change the search text — the two compose, so either one can be what is excluding everything.",
      4: "Widen the dates or change the search text. They stack, so the culprit could be either one.",
      5: "Widen the dates, or change the search text. They stack on top of each other, which means the one quietly throwing away every release could be either of them.",
    },
    yue: {
      1: "放寬日期範圍或者改搵字。兩個篩選係一齊生效，任何一個都可以濾走晒所有版本。",
      2: "放寬日期或者改搵字 — 兩個係疊埋一齊用，邊個都可能係濾走晒嘢嗰個。",
      4: "放寬日期或者改搵字。佢哋疊住嚟，兇手可以係任何一個。",
      5: "放寬日期，或者改搵字。兩個係疊住嚟嘅，所以靜靜雞掃走晒啲版本嗰個，可以係其中任何一個。",
    },
  },

  "changelog.dateHint": {
    cat: "guidance",
    en: {
      1: "Format: YYYY-MM-DD. A calendar is available.",
      2: "YYYY-MM-DD, or pick from the calendar.",
      4: "Type YYYY-MM-DD, or open the calendar and point at one.",
      5: "Type it as YYYY-MM-DD, or open the calendar and point at a day — both end up in the same box.",
    },
    yue: {
      1: "格式：YYYY-MM-DD。亦可以用月曆。",
      2: "YYYY-MM-DD，或者喺月曆度撳一個。",
      4: "打 YYYY-MM-DD，或者開月曆撳一日。",
      5: "打 YYYY-MM-DD，又或者開月曆篤一日 — 兩條路最後都入返同一格。",
    },
  },

  "lang.modeHint": {
    cat: "guidance",
    en: {
      1: "This sets the language of the interface: the tab strip, the menus and this page. The language of the documentation is chosen with the language menu in the header.",
      2: "This is the language of the interface — the strip, the menus, this page. The language of the documentation itself is chosen with the language menu in the header.",
      4: "This is the language of the furniture — the strip, the menus, this page. The language of the articles themselves is the menu up in the header.",
      5: "This one dresses the furniture: the strip, the menus, this very page. The articles keep their own language, chosen from the menu up in the header — two dials, and they do not fight.",
    },
    yue: {
      1: "呢個設定介面嘅語言：分頁列、選單同呢一版。文件本身嘅語言，喺頂欄嗰個語言選單度揀。",
      2: "呢個係介面嘅語言 — 分頁列、選單、呢一版。文件本身用邊種語言，係喺頂欄嗰個語言選單度揀。",
      4: "呢個係「傢俬」嘅語言 — 分頁列、選單、呢一版。啲文章講邊種話，睇頂欄嗰個選單。",
      5: "呢個掣管傢俬：分頁列、選單、你而家睇緊呢一版。啲文章自己有把口，喺頂欄嗰個選單揀 — 兩個掣，唔會打交。",
    },
  },

  /* ----------------------------------------------------------- delight -- */

  "dimsum.title": {
    cat: "delight",
    en: {
      1: "Dim sum",
      2: "A dim sum appeared",
      4: "A dim sum wandered in",
      5: "One dumpling, steamed and unannounced",
    },
    yue: {
      1: "點心",
      2: "有籠點心出現咗",
      4: "有籠點心自己行咗入嚟",
      5: "一籠蒸好嘅點心，冇通知就上枱",
    },
  },

  "dimsum.explain": {
    cat: "delight",
    en: {
      1: "A dish is shown on one visit in a hundred. It can be turned off in Settings.",
      2: "One launch in a hundred shows a dish. Turn it off in Settings.",
      4: "One visit in a hundred gets a dish. Settings has the off switch.",
      5: "One visit in a hundred gets a dish — that is the whole feature. The off switch is in Settings and it is honoured before the coin is even flipped.",
    },
    yue: {
      1: "每一百次到訪會出一次點心。可以喺設定度閂咗佢。",
      2: "一百次入面得一次開站會出點心。唔想睇就去設定閂咗佢。",
      4: "一百次到訪得一次有點心。設定度有個掣熄得。",
      5: "一百次到訪得一次有點心 — 成個功能就係咁多。設定度嗰個掣，喺擲毫之前就已經計咗數。",
    },
  },

  "dimsumpref.hint": {
    cat: "delight",
    en: {
      1: "Shown at most once per hundred visits. Never on a first visit and never during another task. The image ships with the site: no network request is made and no visit is counted.",
      2: "One launch in a hundred, never on your first visit, never while you are in the middle of something. The picture is bundled with the site — nothing is fetched and nothing is counted.",
      4: "One visit in a hundred. Never your first, never while you are busy. The picture is already in the download — nothing fetched, nobody counting.",
      5: "One visit in a hundred, and it still waits its turn: not your first, not while you are mid-task. The picture came down with the site, so nothing is fetched and there is nobody on the other end counting.",
    },
    yue: {
      1: "最多每一百次到訪出一次。第一次到訪唔會出，做緊嘢嗰陣亦唔會出。張相同網站一齊送落嚟：唔會發任何網絡請求，亦唔會記你嘅到訪。",
      2: "一百次開站得一次，第一次嚟唔會出，你做緊嘢嗰陣都唔會出。張相同網站一齊 bundle 埋，唔會出去攞嘢，亦都唔會數你。",
      4: "一百次到訪得一次。唔會喺你第一次，唔會喺你忙嗰陣。張相早就落咗嚟 — 唔使攞，冇人數。",
      5: "一百次到訪得一次，而且仲要排隊：唔會揀你第一次，唔會揀你做緊嘢。張相係同網站一齊落嚟嘅，所以乜都唔使攞，另一邊亦都冇人喺度數。",
    },
  },
};

export const voice = makeVoice<UiKey>(TABLE);

/** The number of keys in the deck, so a coverage line can state a real ratio. */
export { TABLE as VOICE_TABLE };
