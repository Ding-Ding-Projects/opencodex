/**
 * 廣東話 for the chrome that `src/lib/strings.ts` owns.
 *
 * That table publishes the five **documentation locales** and is complete in all
 * of them. Cantonese is not one of them — there is no `/yue/` documentation to
 * route to — so it lives on the other axis, the UI language mode, and this file
 * is the half of it that belongs to the tab strip, the four tab searches, the
 * site search and the regex builder.
 *
 * It is a separate file from `locales.ts` for one practical reason and one
 * structural one. Practical: `strings.ts` is owned by a concurrent stage, and a
 * Cantonese column added *inside* it would be two agents editing one file.
 * Structural: these keys are not this stage's copy. Keeping them apart makes it
 * obvious which dictionary a key came from when one of them is later moved.
 *
 * `Partial`, so an entry that has not been written falls back to the English in
 * `strings.ts` rather than rendering blank. Every key present today is covered;
 * the partial type is what stops the *next* key added upstream from breaking the
 * build in a language it was never going to have on day one.
 *
 * Terminology: 分頁 for a browser tab (HK usage, not 標籤頁), 釘 for pinning,
 * 閂 for closing, 撳 for pressing. The regex descriptions stay technical — a
 * joke inside "sticky — match only at lastIndex" would cost a reader the one
 * thing that line exists to tell them.
 */

import type { StringKey } from "../strings";

export const yueChrome: Partial<Record<StringKey, string>> = {
  /* ---- tab strip -------------------------------------------------------- */
  "tabs.tabs": "分頁",
  "tabs.newTab": "開新分頁",
  "tabs.close": "閂咗呢個分頁",
  "tabs.more": "仲有分頁",
  "tabs.pinned": "釘咗",
  "tabs.pin": "釘住個分頁",
  "tabs.unpin": "唔釘喇",
  "tabs.duplicate": "複製個分頁",
  "tabs.closeTab": "閂",
  "tabs.closeOthers": "閂晒其他分頁",
  "tabs.closeRight": "閂晒右邊啲分頁",
  "tabs.group": "分組",
  "tabs.newGroup": "開個新組…",
  "tabs.addTo": "加入組",
  "tabs.removeFrom": "抽離個組",
  "tabs.renameGroup": "改組名…",
  "tabs.ungroup": "解散個組",
  "tabs.collapse": "摺埋個組",
  "tabs.expand": "打開個組",
  "tabs.groupName": "組名",
  "tabs.save": "儲存",
  "tabs.cancel": "取消",
  "tabs.opened": "開咗",
  "tabs.closed": "閂咗",

  /* ---- the four tab searches and the two bulk closes --------------------- */
  "tabs.search": "搵分頁",
  "tabs.searchTitle": "分頁搜尋",
  "tabs.searchClose": "閂咗分頁搜尋",
  "tabs.stripSearch": "呢條分頁列",
  "tabs.stripSearchPh": "喺呢條分頁列度搵",
  "tabs.groupSearch": "分頁組",
  "tabs.groupSearchPh": "用名搵組",
  "tabs.inGroupSearch": "{name} 入面嘅分頁",
  "tabs.inGroupSearchPh": "喺呢個組度搵",
  "tabs.masterSearch": "所有開住嘅分頁",
  "tabs.masterSearchPh": "搵晒每個視窗每個分頁",
  "tabs.noMatches": "冇嘢夾到。",
  "tabs.noGroups": "重未有組。",
  "tabs.resultCount": "{total} 個入面 {count} 個",
  "tabs.thisWindow": "呢個視窗",
  "tabs.otherWindow": "視窗 {n}",
  "tabs.ungrouped": "冇分組",
  "tabs.goTo": "去呢個分頁",
  "tabs.groupOf": "組：{name}",
  "tabs.collapsedNote": "喺一個摺咗嘅組入面 — 去到會顯示個分頁，但唔會打開個組",
  "tabs.remote": "喺另一個視窗 — 動作會喺嗰邊發生",
  "tabs.bulk": "一次過閂多個分頁",
  "tabs.bulkContaining": "閂咗含有指定文字嘅分頁",
  "tabs.bulkNot": "閂咗「冇」指定文字嘅分頁",
  "tabs.bulkPh": "用嚟夾分頁標題嘅文字",
  "tabs.scope": "套用範圍",
  "tabs.scopeStrip": "呢條分頁列所有分頁",
  "tabs.scopeUngrouped": "淨係冇分組嘅分頁",
  "tabs.scopeGroup": "組：{name}",
  "tabs.includePinned": "連釘住嗰啲一齊計",
  "tabs.pinnedProtected": "有 {count} 個釘住嘅分頁受保護，唔會閂。",
  "tabs.pinnedIncluded": "有 {count} 個釘住嘅分頁「會」被閂。",
  "tabs.previewTitle": "預覽",
  "tabs.wouldClose": "會閂 {total} 個入面嘅 {count} 個分頁：",
  "tabs.wouldCloseNone": "冇嘢夾到 — 一個都唔會閂。",
  "tabs.emptyQuery": "打啲字嚟夾。空白嘅查詢乜都唔會閂。",
  "tabs.invalidQuery": "式唔正確：{error}",
  "tabs.modePlain": "純文字，唔分大細楷，淨係夾睇得見嘅分頁標題 — 永遠唔會夾頁面內容。",
  "tabs.modeRegex": "正則表達式 /{flags}，淨係夾睇得見嘅分頁標題 — 永遠唔會夾頁面內容。",
  "tabs.doClose": "閂 {count} 個分頁",
  "tabs.neverEmpty": "永遠會留低一個分頁：條分頁列唔會變空。",
  "tabs.closedN": "閂咗 {count} 個分頁",

  /* ---- the site's own content search ------------------------------------- */
  "search.label": "搜尋",
  "search.open": "喺文件度搵嘢",
  "search.ph": "喺文件度搵嘢",
  "search.close": "閂咗搜尋",
  "search.modeLabel": "點樣夾",
  "search.plainMode": "純文字",
  "search.regexMode": "正則",
  "search.results": "{count} 個結果",
  "search.none": "冇嘢夾到。",
  "search.loading": "搵緊…",
  "search.indexing": "載緊呢種語言嘅頁面索引…",
  "search.engine": "純文字用緊本站嘅 Pagefind 索引。正則就喺你部瀏覽器度，對住載落嚟嘅頁面索引本地評估。",
  "search.indexFailed": "載唔到頁面索引，所以呢一版用唔到正則搜尋。",
  "search.pagefindFailed": "呢個 build 冇 Pagefind，所以純文字改為搵本地頁面索引。",
  "search.clear": "清走查詢",
  "search.hint": "撳 / 開始搵",
  "search.matchesOnPage": "夾到 {count} 處",
  "search.moreResults": "先顯示頭 {count} 個。收窄查詢就見到其餘嗰啲。",

  /* ---- the settings search ----------------------------------------------- */
  "settings.search": "搵設定",
  "settings.searchPh": "用名、說明或者而家嘅值嚟搵",
  "settings.shown": "{total} 個設定入面顯示 {shown} 個",
  "settings.none": "冇設定夾到。",
  "settings.elsewhere": "另一版仲有 {count} 個：{tabs}",
  "settings.clear": "清走查詢",

  /* ---- the regex builder ------------------------------------------------- */
  "regex.open": "打開正則產生器",
  "regex.title": "正則產生器",
  "regex.close": "閂咗正則產生器",
  "regex.engineNote": "引擎：ECMAScript RegExp，喺你部瀏覽器度本地評估。你打嘅嘢唔會送去任何地方。",
  "regex.pattern": "式",
  "regex.patternCap": "{cap} 個字入面用咗 {used} 個",
  "regex.flags": "旗標",
  "regex.invalid": "式唔正確",
  "regex.build": "逐步砌",
  "regex.palette": "符號盤",
  "regex.sample": "樣本文字",
  "regex.sampleCap": "{cap} 個字入面用咗 {used} 個",
  "regex.sampleSeeded": "由呢個搜尋真正睇到嘅嘢填入，所以喺呢度夾到，喺嗰邊一樣夾到。",
  "regex.matches": "夾到嘅嘢",
  "regex.matchCountValue": "夾到 {count} 處",
  "regex.matchTruncated": "去到 {cap} 個上限就停咗 — 收窄個式就見到其餘嗰啲。",
  "regex.noMatches": "樣本文字入面冇嘢夾到。",
  "regex.groups": "擷取組",
  "regex.noGroups": "呢個式冇宣告任何具名擷取組。",
  "regex.safety": "本地評估，永遠唔會傳送出去。式上限 {pattern} 個字，樣本 {sample} 個，夾到嘅結果 {matches} 個，加上零寬度自動推進，所以一個災難級嘅式都唔會吊死個頁面。",
  "regex.apply": "套用",
  "regex.applyHint": "套用會將呢個式放入欄位，同時轉做正則模式。",
  "regex.applyHintPlain": "套用會將呢個式放入欄位。",
  "regex.flagG": "global — 搵晒每一處，唔係淨係第一處",
  "regex.flagI": "唔分大細楷",
  "regex.flagM": "multiline — ^ 同 $ 夾行嘅開頭同結尾",
  "regex.flagS": "dotall — . 連換行都夾",
  "regex.flagU": "unicode",
  "regex.flagY": "sticky — 淨係喺 lastIndex 嗰個位夾",
  "regex.groupLiterals": "字面",
  "regex.groupClasses": "字元類",
  "regex.groupAnchors": "錨點",
  "regex.groupGroups": "組",
  "regex.groupAlternation": "或者",
  "regex.groupQuantifiers": "數量",
  "regex.tokLiteral": "字面文字",
  "regex.tokEscapedDot": "轉義嘅點 — 真係一個 .",
  "regex.tokBackslash": "一個真正嘅反斜線",
  "regex.tokDigit": "任何數字",
  "regex.tokWord": "任何字詞字元",
  "regex.tokSpace": "任何空白",
  "regex.tokAny": "任何一個字元",
  "regex.tokClass": "字元類",
  "regex.tokNegated": "除咗 / 之外任何字元",
  "regex.tokUnicodeScript": "Unicode 書寫系統 — 要開 u 旗標",
  "regex.tokStart": "輸入嘅開頭",
  "regex.tokEnd": "輸入嘅結尾",
  "regex.tokBoundary": "字詞邊界",
  "regex.tokCapture": "擷取組",
  "regex.tokNamed": "具名擷取組",
  "regex.tokGroup": "唔擷取嘅組",
  "regex.tokLookahead": "向前望",
  "regex.tokAlt": "兩邊任何一邊",
  "regex.tokStar": "零次或以上",
  "regex.tokPlus": "一次或以上",
  "regex.tokOpt": "可有可無",
  "regex.tokRange": "一至三次",
  "regex.tokLazy": "一次或以上，最短嗰個",
};
