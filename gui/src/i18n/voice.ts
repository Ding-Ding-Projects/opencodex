/**
 * The funny level, as actual copy.
 *
 * The two sliders on Language & voice persist a number per language. This file
 * is what that number reads: the level-specific wording for the copy where voice
 * actually carries, in both tracks.
 *
 * ## What varies, and what never does
 *
 * The level styles **voice only**. Every variant of a key states the same fact:
 * the same file, the same account, the same number, the same irreversibility,
 * the same error. Level 1 is what you would write for a colleague under
 * pressure; level 5 is what you would say to a friend. Neither is allowed to
 * leave the reader unsure what a button does — a warning nobody can act on is a
 * broken warning, not a funny one.
 *
 * This applies to **every** category. There is no carve-out for destructive,
 * financial, security, accessibility or error copy: the setting discloses that
 * up front, onboarding repeats it, and the user opted in. What the carve-out
 * would have protected — the facts — is protected by the rule above instead,
 * and by `tests/i18n-voice-and-locales.test.ts`, which re-derives the
 * identifiers, placeholders and consequence words from each entry's neutral
 * wording and asserts they survive all five levels in both languages.
 *
 * ## Level 3 is deliberately absent
 *
 * The shipped neutral wording *is* level 3. Repeating it here would be a second
 * copy of ~75 strings per language to keep in step with the dictionaries, and
 * the first time they drifted the slider would start lying again. A level with
 * no entry resolves through the normal dictionary chain, so English falls to
 * `en.ts`/`m3.ts` and Cantonese falls to `yue.ts`.
 *
 * The one exception is the destructive warning the settings screen renders as a
 * five-rung ladder. That rung has to read as Cantonese even while the interface
 * locale is English, so it carries an explicit level 3 in both tracks.
 *
 * ## Why this is a curated overlay rather than five full dictionaries
 *
 * The product dictionary is ~2 000 keys. Five voice variants of all of them
 * would be 10 000 strings per language, most of which are labels like "Save"
 * that have exactly one sensible rendering at any level. So the overlay covers
 * the copy where voice reads — headings, empty states, confirmations, warnings,
 * errors, the destructive and security-critical wording — and every other key
 * falls through to the neutral string. `voiceCoverage()` and
 * `voiceCategoryCoverage()` report the real numbers so the settings screen can
 * state them instead of implying the whole app is rewritten.
 *
 * Adding a key here is additive and safe: no key is required at every level.
 */

import type { TKey } from "./shared";

/** 1 = fully serious, 5 = maximum playfulness. */
export type FunnyLevel = 1 | 2 | 3 | 4 | 5;

/** Voice track. Bilingual mode composes both, so each is stored separately. */
export type VoiceLang = "en" | "yue";

/**
 * The kinds of message the level restyles.
 *
 * Enumerated rather than implied so the promise "every category, no exemptions"
 * is testable: the coverage test walks this list and fails if any category has
 * no voiced key, which is what stops the overlay from quietly becoming
 * cheerful-toasts-only again.
 */
export type VoiceCategory =
  | "destructive"
  | "security"
  | "financial"
  | "accessibility"
  | "error"
  | "warning"
  | "success"
  | "progress"
  | "empty"
  | "guidance"
  | "delight";

export const VOICE_CATEGORIES: readonly VoiceCategory[] = [
  "destructive",
  "security",
  "financial",
  "accessibility",
  "error",
  "warning",
  "success",
  "progress",
  "empty",
  "guidance",
  "delight",
] as const;

type LevelMap = Partial<Record<FunnyLevel, string>>;

interface VoiceEntry {
  cat: VoiceCategory;
  en: LevelMap;
  yue: LevelMap;
}

/**
 * The overlay. English and Cantonese sit in one entry per key on purpose: they
 * have to say the same thing at the same level, and two separate tables is how
 * one track ends up two levels louder than the other.
 *
 * Cantonese is written Hong Kong 廣東話 and stays respectful at level 5 — the
 * joke is always about the machine, the file, or the situation, never about the
 * reader, their data loss, their money, or anything they cannot help.
 */
const VOICE: Partial<Record<TKey, VoiceEntry>> = {
  // ------------------------------------------------------------------
  // destructive — the copy that guards something you cannot get back
  // ------------------------------------------------------------------

  "storage.cleanup.permanentWarn": {
    cat: "destructive",
    en: {
      1: "Permanent delete cannot be undone.",
      2: "Permanent delete cannot be undone — the files do not go to quarantine.",
      3: "Permanent delete cannot be undone. These files skip quarantine entirely.",
      4: "Permanent delete means gone: no quarantine, no undo, no second copy anywhere.",
      5: "Point of no return. Permanent delete skips quarantine, so there is no undo and nothing left to dig out of a bin later.",
    },
    yue: {
      1: "永久刪除無法復原。",
      2: "永久刪除冇得復原 —— 啲檔案唔會入隔離區。",
      3: "永久刪除冇得復原。啲檔案唔會經隔離區，直接冇咗。",
      4: "永久刪除即係真係冇咗：唔入隔離區、冇 undo、邊度都唔會再有一份。",
      5: "撳落去就一去不回：永久刪除唔會經隔離區，冇 undo，之後想後悔都冇得喺回收筒度執返。",
    },
  },

  "storage.cleanup.confirmBody": {
    cat: "destructive",
    en: {
      1: "This operation processes {count} archived file(s), approximately {size}, comprising the oldest {percent}%.",
      2: "{count} archived file(s), about {size} — the oldest {percent}% of them.",
      4: "About to work through {count} archived file(s), roughly {size}: the oldest {percent}%.",
      5: "Rounding up the oldest {percent}% — that is {count} archived file(s), about {size}, heading for the exit.",
    },
    yue: {
      1: "此操作會處理 {count} 個封存檔案（約 {size}），即係最舊嗰 {percent}%。",
      2: "會處理 {count} 個封存檔案，大約 {size}，係最舊嗰 {percent}%。",
      4: "而家會清 {count} 個封存檔案，大約 {size}，全部係最舊嗰 {percent}%。",
      5: "捉晒最舊嗰 {percent}% 出嚟：{count} 個封存檔案，大約 {size}，準備送走。",
    },
  },

  "storage.cleanup.donePermanent": {
    cat: "destructive",
    en: {
      1: "{count} file(s) totalling {size} were permanently deleted.",
      2: "{count} file(s) permanently deleted ({size}).",
      4: "{count} file(s) gone for good — {size} back.",
      5: "{count} file(s) permanently deleted. {size} reclaimed, and none of it is coming back.",
    },
    yue: {
      1: "已永久刪除 {count} 個檔案，合共 {size}。",
      2: "{count} 個檔案已經永久刪除（{size}）。",
      4: "{count} 個檔案真係冇咗喇，慳返 {size}。",
      5: "{count} 個檔案永久刪除完成，收返 {size} 空間，一個都返唔到轉頭。",
    },
  },

  "history.clearConfirm": {
    cat: "destructive",
    en: {
      1: "Delete the entire revision log? This operation cannot be undone.",
      2: "Delete every entry in the revision log? This cannot be undone.",
      4: "This wipes the entire revision log — every recorded change, gone. It cannot be undone.",
      5: "Deleting the whole revision log: every change this app ever wrote down, erased in one go. There is no undo for this one.",
    },
    yue: {
      1: "確定刪除整份修訂紀錄？此操作無法復原。",
      2: "係咪要刪除成份修訂紀錄？刪咗就冇得復原。",
      4: "咁樣會清走成份修訂紀錄 —— 記低咗嘅每一次改動都冇晒，而且冇得復原。",
      5: "一嘢清走成份修訂紀錄：呢個 app 記低過嘅每一次改動，一次過抹走。呢個係冇 undo 㗎。",
    },
  },

  "api.deleteConfirmBody": {
    cat: "destructive",
    en: {
      1: "Deleting this key stops {prefix} working immediately for every application configured with it.",
      2: "{prefix} stops working immediately — every app configured with it loses access.",
      4: "The moment this goes, {prefix} stops working immediately, and every app you configured with it starts failing.",
      5: "Delete it and {prefix} is dead on the spot — every app still holding that key starts getting refused, no grace period.",
    },
    yue: {
      1: "{prefix} 會即刻停止運作，所有用緊佢嘅 app 都會失效。",
      2: "{prefix} 即刻用唔到，所有設定咗佢嘅 app 都會冇咗存取權。",
      4: "一刪咗，{prefix} 即刻失效，所有用緊佢嘅 app 都會開始出錯。",
      5: "刪咗 {prefix} 就即刻報銷 —— 所有仲攞住條 key 嘅 app 立刻被拒，冇寬限期。",
    },
  },

  "pws.removeConfirmDetail": {
    cat: "destructive",
    en: {
      1: "The provider's configuration is deleted from this proxy's config file, together with the accounts and API keys stored for it.",
      2: "Its configuration is deleted from this proxy's config file, and the accounts and API keys stored for it go with it.",
      4: "This cuts the provider out of the proxy's config file — and takes every account and API key stored for it along with it.",
      5: "Out it goes, straight out of the proxy's config file, and it drags every account and API key you saved for it out too.",
    },
    yue: {
      1: "其設定會由此 proxy 嘅設定檔中刪除，連同為佢儲存嘅帳戶同 API key 一併移除。",
      2: "佢嘅設定會喺呢個 proxy 嘅設定檔度刪走，為佢儲低嘅帳戶同 API key 都會一齊冇埋。",
      4: "咁樣會將呢個供應商由 proxy 嘅設定檔度剷走，順手連佢嘅帳戶同 API key 都一齊帶走。",
      5: "一鑊過剷走：proxy 設定檔入面呢個供應商唔見咗，佢名下嘅帳戶同 API key 都一齊跟住走。",
    },
  },

  "prov.removeIrreversible": {
    cat: "destructive",
    en: {
      1: "This operation is irreversible.",
      2: "Once done, it cannot be reversed.",
      4: "There is no undo for this one.",
      5: "No undo, no draft, no second thoughts — this cannot be undone.",
    },
    yue: {
      1: "此操作無法復原。",
      2: "呢個操作冇得復原。",
      4: "呢個係冇得復原㗎。",
      5: "冇 undo、冇草稿、冇得諗過 —— 呢個操作真係冇得復原。",
    },
  },

  "window.exitBusyConfirm": {
    cat: "destructive",
    en: {
      1: "{count} request(s) are still running and did not complete within the timeout. Exit anyway? Those requests will be terminated.",
      2: "{count} request(s) are still running and did not finish in time. Exit anyway — those requests will be cut off.",
      4: "{count} request(s) are still going and ran out of time to finish. Exit anyway and they get cut off mid-answer.",
      5: "{count} request(s) are still mid-sentence and did not finish in time. Exit anyway and they get cut off exactly where they are.",
    },
    yue: {
      1: "仲有 {count} 個請求執行緊，未能及時完成。係咪照關閉？嗰啲請求會被中斷。",
      2: "仲有 {count} 個請求行緊，等唔切完成。照關？嗰啲請求會被切斷。",
      4: "{count} 個請求仲行緊，等唔切完成。照關嘅話，佢哋就會答到一半被切斷。",
      5: "{count} 個請求講到一半仲未完，時間已經用晒。照關嘅話，佢哋就停喺嗰句度，冇下文。",
    },
  },

  "network.restoreForceConfirm": {
    cat: "destructive",
    en: {
      1: "{count} request(s) are still running and did not complete within the timeout. Restore anyway? Those requests will be terminated.",
      2: "{count} request(s) are still running and did not finish in time. Restore anyway — those requests will be cut off.",
      4: "{count} request(s) are still going and ran out of time. Restore anyway and they get cut off before they answer.",
      5: "{count} request(s) never made it to the finish line. Restore anyway and they get cut off where they stand.",
    },
    yue: {
      1: "仲有 {count} 個請求執行緊，未能及時完成。係咪照還原？嗰啲請求會被中斷。",
      2: "仲有 {count} 個請求行緊，等唔切完成。照還原？嗰啲請求會被切斷。",
      4: "{count} 個請求仲行緊，時間到咗都未完。照還原嘅話，佢哋未答完就會被切斷。",
      5: "{count} 個請求跑唔到終點。照還原嘅話，佢哋就停喺原地，冇下文。",
    },
  },

  "dash.stopConfirm": {
    cat: "destructive",
    en: {
      1: "Stop the proxy and restore native Codex routing?",
      2: "Stop the proxy and hand Codex back to its native routing?",
      4: "Stop the proxy and give Codex back to OpenAI's own routing?",
      5: "Pull the plug on the proxy and hand Codex straight back to its native routing?",
    },
    yue: {
      1: "係咪停止 proxy 並還原 Codex 嘅原生路由？",
      2: "停咗個 proxy，同埋將 Codex 交返畀佢原生嘅路由？",
      4: "熄咗個 proxy，Codex 就交返畀 OpenAI 自己嗰條路由，係咪咁做？",
      5: "一嘢拔咗個 proxy 嘅插蘇，Codex 即刻交返畀原生路由，係咪確定？",
    },
  },

  "startup.tray.uninstallConfirm": {
    cat: "destructive",
    en: {
      1: "Remove the login tray icon? The proxy continues to run; only the tray controller is removed, and restart protection is unaffected.",
      2: "Remove the login tray icon? The proxy keeps running; only the tray controller goes, and restart protection is unaffected.",
      4: "This removes the login tray icon only. The proxy keeps running, and restart protection is unaffected — you just lose the tray controller.",
      5: "Evicting the tray icon. The proxy carries on regardless and restart protection does not care — you are only losing the little controller in the corner.",
    },
    yue: {
      1: "係咪移除登入時嘅系統匣圖示？proxy 會繼續運行，只係移除匣控制器，重啟保護不受影響。",
      2: "移除登入嘅系統匣圖示？proxy 照行，淨係移走個匣控制器，重啟保護唔受影響。",
      4: "呢個淨係移走登入嘅系統匣圖示。proxy 照樣行，重啟保護都唔受影響，你淨係少咗個匣控制器。",
      5: "趕走角落頭嗰粒匣圖示啫。proxy 照行如常，重啟保護一啲都唔理，你淨係冇咗個細細粒控制器。",
    },
  },

  // ------------------------------------------------------------------
  // security — credentials, plaintext, and publishing to a network
  // ------------------------------------------------------------------

  "network.exportWarning": {
    cat: "security",
    en: {
      1: "⚠️ The export contains PLAINTEXT SECRETS: provider API keys and OAuth access/refresh tokens. Any holder of the file can use every account it contains. Store it encrypted and delete it once it is no longer required.",
      2: "⚠️ The export holds PLAINTEXT SECRETS — provider API keys and OAuth access/refresh tokens. Anyone with the file can use every account in it. Store it encrypted and delete it when you are done.",
      4: "⚠️ This file is your whole keyring, and it holds PLAINTEXT SECRETS: provider API keys and OAuth access/refresh tokens. Whoever holds it can use every account in it. Encrypt it, and delete it the moment you are done.",
      5: "⚠️ This export is every secret you own, written out as PLAINTEXT SECRETS — provider API keys and OAuth access/refresh tokens, no lock on the door. Anybody who ends up with the file gets every account in it. Encrypt it, and delete it the second you are done.",
    },
    yue: {
      1: "⚠️ 匯出檔案含有明文機密：供應商 API key 同 OAuth access/refresh token。任何人攞到呢個檔案，就用得晒入面所有帳戶。請加密儲存，用完即刪。",
      2: "⚠️ 呢個匯出檔入面係明文機密 —— 供應商 API key 同 OAuth access/refresh token。邊個攞到就用得晒入面所有帳戶。記住加密儲存，用完即刪。",
      4: "⚠️ 呢個檔案就係你成串鎖匙，而且係明文：供應商 API key 同 OAuth access/refresh token 全部喺入面。邊個攞到就用得晒你所有帳戶。加密儲存，用完即刻刪。",
      5: "⚠️ 呢個匯出檔等於你所有機密以明文攤晒喺枱面：供應商 API key、OAuth access/refresh token，一道鎖都冇。邊個執到就當自己有齊你所有帳戶。加密儲存，用完即刻刪，唔好留低。",
    },
  },

  "network.exportConfirm": {
    cat: "security",
    en: {
      1: "Download the full state export? The file contains every API key and OAuth token in plaintext.",
      2: "Download the full state export? Every API key and OAuth token in it is in plaintext.",
      4: "About to download the full state export — every API key and OAuth token inside it is plaintext.",
      5: "One file, every API key and OAuth token you have, all of it plaintext. Download the full state export?",
    },
    yue: {
      1: "係咪下載完整狀態匯出檔？入面所有 API key 同 OAuth token 都係明文。",
      2: "下載完整狀態匯出檔？入面每一條 API key 同 OAuth token 都係明文。",
      4: "而家就下載完整狀態匯出檔 —— 入面每條 API key 同 OAuth token 都係明文擺住。",
      5: "一個檔案，裝住你所有 API key 同 OAuth token，全部明文。仲落唔落載？",
    },
  },

  "network.customKeyHint": {
    cat: "security",
    en: {
      1: "Specify your own key value (12+ characters, no spaces). It is stored in PLAINTEXT in config.json and is included in exports; do not reuse a password used anywhere else.",
      2: "Choose your own key value (12+ characters, no spaces). It is stored in PLAINTEXT in config.json and travels in exports, so never reuse a password you use anywhere else.",
      4: "Pick your own key (12+ characters, no spaces). It lands in config.json in PLAINTEXT and rides along in exports — so do not reuse a password from anywhere else.",
      5: "Pick any key you like (12+ characters, no spaces) — just know it sits in config.json in PLAINTEXT and hitches a ride in every export. So: do not reuse a password from anywhere else.",
    },
    yue: {
      1: "自訂你自己嘅 key（12 個字符以上、不含空格）。佢會以明文儲存喺 config.json，亦會包含喺匯出檔內 —— 千祈唔好用返你其他地方用緊嘅密碼。",
      2: "揀你自己嘅 key（12 個字符以上、唔好有空格）。佢會明文擺喺 config.json，匯出嗰陣都會跟埋出去，所以千祈唔好用返你其他地方嗰條密碼。",
      4: "自己揀條 key（12 個字符以上、唔好有空格）。佢會明文瞓喺 config.json，匯出嗰陣仲會跟埋去 —— 所以唔好攞你其他地方用緊嘅密碼嚟用。",
      5: "條 key 鍾意點揀都得（12 個字符以上、唔好有空格），不過要知：佢會明文擺喺 config.json，仲會搭順風車跟住每個匯出檔走。所以，唔好用你其他地方嗰條密碼。",
    },
  },

  "network.enableConfirm": {
    cat: "security",
    en: {
      1: "Expose the proxy to your network? Any device on that network holding a key can operate the proxy and every provider account behind it. Do this only on a network you trust. A restart applies the change.",
      2: "Expose the proxy to your network? Anyone on that network holding a key can drive the proxy and every provider account behind it. Only do this on a network you trust — a restart applies the change.",
      4: "This opens the proxy to your whole network. Anyone on it with a key can drive the proxy and every provider account behind it, so only do it on a network you trust. The change applies after a restart.",
      5: "This puts the proxy on your network for anyone with a key — and a key gets them the proxy plus every provider account sitting behind it. Trusted networks only. Takes effect after a restart.",
    },
    yue: {
      1: "係咪將 proxy 公開畀你個網絡？網絡上任何持有 key 嘅人都可以操控呢個 proxy 同背後所有供應商帳戶。請只喺你信得過嘅網絡咁做。重啟後生效。",
      2: "將 proxy 公開畀你個網絡？喺嗰個網絡度只要有 key，就用得呢個 proxy 同背後所有供應商帳戶。只喺你信得過嘅網絡先好咁做，重啟之後生效。",
      4: "咁樣會將 proxy 開放畀成個網絡。網絡上面有 key 嘅人就控制到個 proxy，連背後所有供應商帳戶都控制到，所以淨係喺你信得過嘅網絡先好做。重啟之後先生效。",
      5: "咁即係將 proxy 擺咗上網絡，有 key 就入到嚟 —— 而有 key 即係連背後所有供應商帳戶都一齊攞埋。信得過嘅網絡先好玩。重啟之後生效。",
    },
  },

  "onboard.netExposeWarn": {
    cat: "security",
    en: {
      1: "The dashboard is published together with the proxy, and the dashboard can change providers, read logs and export your accounts. The password below is the only control between the two. Do this only on a network you trust.",
      2: "This publishes the dashboard too — and the dashboard can change providers, read logs and export your accounts. The password below is the only thing standing between them. Only do this on a network you trust.",
      4: "The dashboard goes out with it, and the dashboard can change providers, read logs and export your accounts. The password below is the only thing in the way. Trusted networks only.",
      5: "The dashboard comes along for the ride — and it can change providers, read logs and export your accounts. The one thing standing in the way is the password below. Trusted networks only, please.",
    },
    yue: {
      1: "咁樣會連控制台一併公開，而控制台改得供應商、睇得紀錄、亦匯出得你啲帳戶。下面條密碼係兩者之間唯一嘅屏障。請只喺你信得過嘅網絡咁做。",
      2: "咁樣會連控制台一齊公開 —— 而個控制台改得供應商、睇得紀錄、仲匯出得你啲帳戶。下面條密碼係唯一擋住佢哋嘅嘢。只喺你信得過嘅網絡先好咁做。",
      4: "個控制台會一齊公開埋，而佢改得供應商、睇得紀錄、匯出得你啲帳戶。擋喺中間嘅淨係下面條密碼。信得過嘅網絡先好做。",
      5: "個控制台會跟埋出去，而佢改得供應商、睇得紀錄、仲匯得走你啲帳戶。企喺中間嘅得下面條密碼一個。所以：信得過嘅網絡先好咁做。",
    },
  },

  "network.keyShownOnce": {
    cat: "security",
    en: {
      1: "Data-plane key — displayed once only; record it now",
      2: "Data-plane key — this is the only time it is shown, so store it now",
      4: "Data-plane key. You get exactly one look at it — copy it somewhere safe now.",
      5: "Data-plane key, on screen once and never again. Copy it now, because nothing here can show it to you a second time.",
    },
    yue: {
      1: "資料層 key —— 只顯示一次，請即刻儲存",
      2: "資料層 key —— 淨係顯示呢一次，記住而家儲低佢",
      4: "資料層 key。你得呢一次機會睇到，快啲複製去安全嘅地方。",
      5: "資料層 key，出現一次之後就唔會再出。而家即刻複製走，因為呢度冇任何嘢可以再顯示畀你睇多次。",
    },
  },


  // The fact these five levels state changed with the behaviour: pairing now
  // saves a data-plane key in this browser, so a variant still promising "never
  // written to storage" would be the slider telling a security lie. See the
  // storage note at the top of gui/src/pages/Mobile.tsx for why that trade is
  // made, and mobile.pairedHint for what the user is told about revoking it.
  "mobile.apiKeyHint": {
    cat: "security",
    en: {
      1: "Required when the proxy is published to the network. Pairing supplies it automatically; enter one here only if a QR code is not being used.",
      2: "Needed once the proxy is published to the network. Pairing fills it in for you, so type one here only if you are not scanning a QR code.",
      4: "Only needed when the proxy is published to the network. Pairing fills it in — this box is for when you are not scanning a QR code.",
      5: "Only wanted when the proxy is out on the network. Pairing hands it over for you, so this box is strictly for the no-QR-code crowd.",
    },
    yue: {
      1: "當 proxy 已公開畀網絡時才需要。配對會自動提供；只有喺唔使用 QR code 嘅情況下才喺呢度輸入。",
      2: "proxy 公開咗畀網絡先需要。配對會幫你填好，所以唔掃 QR code 先至喺呢度打。",
      4: "淨係喺 proxy 公開咗畀網絡先要。配對會幫你填埋 —— 呢格係留畀唔掃 QR code 嗰陣用。",
      5: "proxy 出咗街先會問你攞。配對會自動奉上，所以呢格淨係服務唔掃 QR code 嗰班。",
    },
  },

  // ------------------------------------------------------------------
  // financial — money, list prices, and what this app cannot promise
  // ------------------------------------------------------------------

  "usage.cost.disclaimer": {
    cat: "financial",
    en: {
      1: "This figure is not a billing receipt. Subscription usage or provider credits may apply instead.",
      2: "This is not a billing receipt — subscription usage or provider credits may apply instead.",
      4: "Not a bill. Your subscription or provider credits may have covered some of this instead.",
      5: "Not a receipt, not a bill, not anything your accountant should see. Subscription usage or provider credits may have paid for some of this instead.",
    },
    yue: {
      1: "此數字並非帳單收據。你嘅訂閱用量或供應商點數可能已經涵蓋部分費用。",
      2: "呢個唔係帳單收據 —— 你嘅訂閱用量或者供應商點數可能已經抵咗部分。",
      4: "呢個唔係帳單。有啲可能已經用你嘅訂閱或者供應商點數找咗。",
      5: "唔係收據、唔係帳單、亦都唔係俾會計睇嗰種。當中有啲可能已經用你嘅訂閱用量或者供應商點數找咗數。",
    },
  },

  "usage.cost.total": {
    cat: "financial",
    en: {
      1: "API list-price equivalent for the selected range",
      2: "API list-price equivalent for this range",
      4: "What this range would cost at API list price",
      5: "What this range would have cost at API list price, if list price were the whole story",
    },
    yue: {
      1: "以 API 標價計算嘅等值金額（此範圍）",
      2: "呢個範圍以 API 標價計嘅等值金額",
      4: "呢個範圍如果照 API 標價計，大概係咁多",
      5: "呢個範圍照 API 標價計會係咁多 —— 前提係標價就係全部真相。",
    },
  },

  "usage.cost.unpricedNote": {
    cat: "financial",
    en: {
      1: "{count} requests excluded: no price or usage was recorded",
      2: "{count} requests excluded — no price or usage was recorded for them",
      4: "{count} requests left out of this total: no price or usage was recorded for them.",
      5: "{count} requests sat this one out — no price and no usage recorded, so counting them would be making numbers up.",
    },
    yue: {
      1: "已排除 {count} 個請求（冇價格或用量資料）",
      2: "已排除 {count} 個請求 —— 佢哋冇價格或者用量紀錄",
      4: "有 {count} 個請求冇計入呢個總數：佢哋冇價格亦冇用量紀錄。",
      5: "有 {count} 個請求今次唔參與 —— 冇價格又冇用量紀錄，夾硬計就等於作數。",
    },
  },

  "claude.smallFastModelNativeWarning": {
    cat: "financial",
    en: {
      1: "If this is left unset, OpenCodex does not set the helper-model overrides. Claude Code may then use its native Sonnet model, which may incur charges from your native provider.",
      2: "Left unset, OpenCodex leaves the helper-model overrides unset. Claude Code may then use its native Sonnet model, which may incur charges from your native provider.",
      4: "Leave it empty and OpenCodex leaves the helper-model overrides alone — Claude Code may fall back to its native Sonnet model, and your native provider may charge you for it.",
      5: "Leave it empty and OpenCodex keeps its hands off the helper-model overrides. Claude Code may then reach for its native Sonnet model, and your native provider may well charge you for it.",
    },
    yue: {
      1: "留空時，OpenCodex 唔會設定輔助模型嘅覆寫。Claude Code 可能會用返佢原生嘅 Sonnet 模型，而你嘅原生供應商可能會就此收費。",
      2: "留空嘅話，OpenCodex 就唔會設定輔助模型覆寫。Claude Code 可能會用返原生嘅 Sonnet 模型，你嘅原生供應商可能會收錢。",
      4: "留空即係 OpenCodex 唔郁輔助模型覆寫 —— Claude Code 可能會用返原生嘅 Sonnet 模型，而你嘅原生供應商可能會照收你錢。",
      5: "留空即係 OpenCodex 完全唔掂輔助模型覆寫。Claude Code 到時可能自己攞原生嘅 Sonnet 模型嚟用，而你嘅原生供應商好可能會照收你錢。",
    },
  },

  "cost.title": {
    cat: "financial",
    en: {
      1: "Estimated API cost for the selected range ({range}). Select to change the range.",
      2: "Estimated API cost over {range} — click to change the range",
      4: "Estimated API cost for the last {range}. Click to change the range.",
      5: "What the last {range} would have cost at API list price. Click to change the range.",
    },
    yue: {
      1: "估算 API 費用（{range}）—— 撳一下可更改範圍",
      2: "{range} 內嘅估算 API 費用 —— 撳一下改範圍",
      4: "最近 {range} 嘅估算 API 費用。撳一下改範圍。",
      5: "最近 {range} 照 API 標價計大約係咁多。撳一下改範圍。",
    },
  },

  // ------------------------------------------------------------------
  // accessibility — motion, narration, and what the OS decides for us
  // ------------------------------------------------------------------

  "appearance.reducedMotionOsOnly": {
    cat: "accessibility",
    en: {
      1: "Reduced motion is controlled by your operating system setting and cannot be changed on this screen.",
      2: "Reduced motion follows your operating system setting, so it cannot be changed here.",
      4: "Your operating system already decided this one — reduced motion follows it, and this screen does not override it.",
      5: "Your operating system has already called it. Reduced motion follows that setting, and this screen is not going to argue with it.",
    },
    yue: {
      1: "減少動態效果係跟你作業系統嘅設定，唔可以喺呢度更改。",
      2: "減少動態效果跟住你作業系統嘅設定，所以喺呢度改唔到。",
      4: "呢樣嘢你個作業系統已經決定咗 —— 減少動態效果跟佢，呢個畫面唔會蓋過佢。",
      5: "你個作業系統已經話咗事。減少動態效果就係跟佢嗰個設定，呢個畫面唔會同佢拗。",
    },
  },

  "appearance.motionSub": {
    cat: "accessibility",
    en: {
      1: "Transitions are collapsed automatically when the operating system requests reduced motion.",
      2: "When your system asks for reduced motion, transitions collapse automatically.",
      4: "Ask your system for reduced motion and every transition here collapses to nothing, automatically.",
      5: "Tell your system you want reduced motion and every transition in here quietly flattens itself. No setting needed on this side.",
    },
    yue: {
      1: "當你系統要求減少動態效果時，過場動畫會自動收起。",
      2: "當你系統要求減少動態效果，啲過場動畫會自動收起。",
      4: "你喺系統度開咗減少動態效果，呢度所有過場動畫就會自動收埋，唔使你再做嘢。",
      5: "你同系統講聲要減少動態效果，呢度啲過場動畫就會自己靜靜收埋，呢邊乜都唔使set。",
    },
  },

  "narrator.enableHint": {
    cat: "accessibility",
    en: {
      1: "Exactly one message is spoken at a time. A newer message replaces a pending message rather than queueing behind it.",
      2: "One message is spoken at a time, and a newer message replaces a pending one instead of queueing behind it.",
      4: "It reads one message at a time — a newer message takes the pending one's place rather than lining up behind it.",
      5: "One voice, one message at a time. A newer message elbows the pending one out rather than joining a queue behind it.",
    },
    yue: {
      1: "每次只會讀出一段訊息；新訊息會取代仲未讀嗰段，而唔會排隊等。",
      2: "一次淨係讀一段訊息，新訊息會頂走仲未讀嗰段，唔會排隊。",
      4: "佢一次淨係讀一段 —— 有新訊息就會取代仲未讀嗰段，唔會排隊等落尾。",
      5: "一把聲，一次一段。有新訊息就會擠走仲未讀嗰段，唔會乖乖排隊。",
    },
  },

  "narrator.offBody": {
    cat: "accessibility",
    en: {
      1: "Enable the narrator first. It remains off until you enable it.",
      2: "Turn the narrator on first — it stays off until you ask for it.",
      4: "The narrator is still off. It stays that way until you switch it on yourself.",
      5: "Nothing will be said until you switch the narrator on. It stays off by default and waits to be asked.",
    },
    yue: {
      1: "請先開啟朗讀。你唔開，佢就一直維持關閉。",
      2: "先開咗朗讀先得。你唔開，佢就一直閂住。",
      4: "朗讀仲係閂住嘅。你唔親手開，佢就會一直閂住。",
      5: "你唔開朗讀，佢一個字都唔會出聲。預設就係閂住，等你嗌佢先郁。",
    },
  },

  "narrator.unavailable": {
    cat: "accessibility",
    en: {
      1: "Speech synthesis is not available in this browser, so the narrator cannot run.",
      2: "The narrator cannot run here: this browser does not expose speech synthesis.",
      4: "This browser has no speech synthesis to offer, so the narrator has nothing to speak through here.",
      5: "This browser hands out no speech synthesis at all, so the narrator has no voice to borrow here.",
    },
    yue: {
      1: "此瀏覽器冇提供語音合成，所以朗讀喺呢度行唔到。",
      2: "呢個瀏覽器冇語音合成，所以朗讀喺呢度用唔到。",
      4: "呢個瀏覽器根本冇語音合成畀你用，所以朗讀喺呢度冇嘢可以出聲。",
      5: "呢個瀏覽器一啲語音合成都唔肯畀，朗讀想借把聲都借唔到。",
    },
  },

  "narrator.sub": {
    cat: "accessibility",
    en: {
      1: "Reads status messages aloud using the browser's speech synthesis. Disabled by default.",
      2: "Reads status messages aloud through your browser's speech synthesis. Off by default.",
      4: "Reads status messages out loud through your browser's speech synthesis. Off until you turn it on.",
      5: "Says the status messages out loud, using whatever voice your browser's speech synthesis has lying around. Off until you ask.",
    },
    yue: {
      1: "使用瀏覽器嘅語音合成讀出狀態訊息。預設關閉。",
      2: "用瀏覽器嘅語音合成讀出狀態訊息。預設係閂住。",
      4: "用你瀏覽器嘅語音合成，將狀態訊息讀出嚟。你唔開就一直閂住。",
      5: "攞你瀏覽器嗰把語音合成聲，將狀態訊息讀出嚟。你唔嗌佢，佢就一直閂住。",
    },
  },

  // ------------------------------------------------------------------
  // error — the category a carve-out would have taken away
  // ------------------------------------------------------------------

  "launch.installFailed": {
    cat: "error",
    en: {
      1: "Could not install {label}.",
      2: "{label} could not be installed.",
      4: "{label} refused to install. The installer's own words are below.",
      5: "{label} said no. Loudly. Its exact excuse is below.",
    },
    yue: {
      1: "{label} 安裝失敗。",
      2: "{label} 裝唔到。",
      3: "{label} 安裝唔成功。",
      4: "{label} 唔肯裝。佢自己嘅解釋喺下面。",
      5: "{label} 死都唔肯裝。佢嘅藉口原文擺喺下面，你自己睇。",
    },
  },

  "dash.cannotConnect": {
    cat: "error",
    en: {
      1: "The proxy did not respond. Confirm that it is running.",
      2: "Cannot connect to the proxy. Is it running?",
      4: "Nothing is answering on the proxy's port. Is the proxy running?",
      5: "Knocked on the proxy's door and nobody came. Is it actually running?",
    },
    yue: {
      1: "無法連接 proxy。佢有冇喺度行緊？",
      2: "連唔到個 proxy。佢係咪未行？",
      4: "proxy 個 port 度冇人應。個 proxy 係咪根本未開？",
      5: "拍咗個 proxy 度門好耐都冇人應。佢真係行緊咩？",
    },
  },

  "prov.networkError": {
    cat: "error",
    en: {
      1: "A network error occurred. Confirm that the proxy is running.",
      2: "Network error. Is the proxy running?",
      4: "The request never reached anything. Is the proxy running?",
      5: "That request went out and nothing came back. Is the proxy actually running?",
    },
    yue: {
      1: "網絡錯誤 —— proxy 有冇喺度行緊？",
      2: "網絡出錯。個 proxy 係咪未行？",
      4: "個請求根本冇送到去任何地方。個 proxy 係咪未開？",
      5: "個請求出咗去之後就冇聲冇氣。個 proxy 真係行緊咩？",
    },
  },

  "terminal.startFailed": {
    cat: "error",
    en: {
      1: "Could not start {label}.",
      2: "{label} could not be started.",
      4: "{label} would not start. The reason it gave is below.",
      5: "{label} flatly refused to start. Whatever it said about it is below.",
    },
    yue: {
      1: "無法啟動 {label}。",
      2: "開唔到 {label}。",
      4: "{label} 唔肯開。佢畀嘅原因喺下面。",
      5: "{label} 死都唔肯開。佢講咗咩就喺下面。",
    },
  },

  "mobile.modelsFailed": {
    cat: "error",
    en: {
      1: "The proxy could not be reached, so the model list was not loaded.",
      2: "Could not reach the proxy, so the model list did not load.",
      4: "The proxy did not answer, so there is no model list to show.",
      5: "The proxy never picked up, so the model list is still empty.",
    },
    yue: {
      1: "無法連接 proxy，未能載入模型清單。",
      2: "連唔到 proxy，所以個模型清單載入唔到。",
      4: "個 proxy 冇應機，所以而家冇模型清單可以顯示。",
      5: "個 proxy 由頭到尾都冇聽電話，所以個模型清單仲係空㗎。",
    },
  },

  "mobile.sendFailed": {
    cat: "error",
    en: {
      1: "Could not send that message.",
      2: "That message could not be sent.",
      4: "That message did not go out. Nothing was delivered to the model.",
      5: "That message never left the building — the model has not seen a word of it.",
    },
    yue: {
      1: "無法傳送呢個訊息。",
      2: "send 唔到呢個訊息。",
      4: "呢個訊息冇送出去，個模型一個字都收唔到。",
      5: "呢個訊息連門口都出唔到，個模型一個字都未見過。",
    },
  },

  "network.exportFailed": {
    cat: "error",
    en: {
      1: "Export failed.",
      2: "The export failed — no file was written.",
      4: "The export did not complete, so no file was written.",
      5: "The export fell over on the way out. No file was written, so nothing leaked either.",
    },
    yue: {
      1: "匯出失敗。",
      2: "匯出失敗 —— 冇寫出任何檔案。",
      4: "匯出未完成，所以冇寫出任何檔案。",
      5: "匯出中途仆咗街。冇寫出任何檔案，所以亦都冇漏出去。",
    },
  },

  "network.restoreFailed": {
    cat: "error",
    en: {
      1: "Restore failed.",
      2: "The restore failed.",
      4: "The restore did not complete. Check the history entry and try again.",
      5: "The restore gave up part way. Check the history entry and give it another go.",
    },
    yue: {
      1: "還原失敗。",
      2: "還原失敗咗。",
      4: "還原未完成。睇返嗰個紀錄項目，然後再試一次。",
      5: "還原做到一半就投降。返去睇下嗰個紀錄項目，再試多次。",
    },
  },

  "settings.saveFailed": {
    cat: "error",
    en: {
      1: "Could not save that setting.",
      2: "That setting was not saved.",
      4: "That setting did not save — the old value is still in effect.",
      5: "That setting bounced. The old value is still what is running.",
    },
    yue: {
      1: "無法儲存呢個設定。",
      2: "呢個設定冇儲存到。",
      4: "呢個設定儲存唔到 —— 而家行緊嘅仲係舊嗰個值。",
      5: "呢個設定彈返轉頭。而家行緊嘅仲係舊嗰個值。",
    },
  },

  "errorBoundary.message": {
    cat: "error",
    en: {
      1: "A rendering error occurred in this section. Reload it to try again.",
      2: "This section hit a rendering error — reload it to try again.",
      4: "This section crashed while drawing itself. Reload it to try again.",
      5: "This section fell over mid-render and took the rest of the page down with it. Reload it to try again.",
    },
    yue: {
      1: "此區段發生繪製錯誤。請重新載入再試。",
      2: "呢一段畫嘅時候出錯。重新載入再試過。",
      4: "呢一段畫自己畫到一半死咗。重新載入再試過。",
      5: "呢一段畫到一半仆咗街，連累埋成版嘢。重新載入再試過啦。",
    },
  },

  "dash.syncFailed": {
    cat: "error",
    en: {
      1: "The synchronisation failed with: {error}",
      2: "The sync failed: {error}",
      4: "The sync did not finish. What came back: {error}",
      5: "The sync gave up. Its exact words: {error}",
    },
    yue: {
      1: "同步操作失敗，原因：{error}",
      2: "同步失敗咗：{error}",
      4: "同步未完成。回傳嘅內容係：{error}",
      5: "同步中途放棄咗。佢原句咁講：{error}",
    },
  },

  "regex.copyFailed": {
    cat: "error",
    en: {
      1: "Could not write to the clipboard.",
      2: "Nothing was written to the clipboard.",
      4: "The clipboard refused the write, so nothing was copied.",
      5: "The clipboard would not take it, so nothing was copied. Select the pattern and copy it by hand.",
    },
    yue: {
      1: "無法寫入剪貼簿。",
      2: "冇嘢寫得入剪貼簿。",
      4: "剪貼簿唔收，所以乜都冇複製到。",
      5: "剪貼簿唔肯收貨，所以乜都冇複製到。自己揀住個 pattern 手動複製啦。",
    },
  },

  "storage.cleanup.err.fs_failed": {
    cat: "error",
    en: {
      1: "The filesystem cleanup failed. Some changes may already have been applied; check CODEX_HOME/.trash and any recovery path shown.",
      2: "Filesystem cleanup failed. Some changes may already be applied, so check CODEX_HOME/.trash and any recovery path shown.",
      4: "The filesystem cleanup stopped part way. Some changes may already be applied — check CODEX_HOME/.trash and any recovery path shown before retrying.",
      5: "The cleanup fell over half way through the filesystem. Some of it may already have happened, so go look in CODEX_HOME/.trash and at any recovery path shown before you try again.",
    },
    yue: {
      1: "檔案系統清理失敗。部分改動可能已經套用 —— 請檢查 CODEX_HOME/.trash 同畫面顯示嘅任何復原路徑。",
      2: "檔案系統清理失敗。部分改動可能已經生效，記住去睇 CODEX_HOME/.trash 同顯示咗嘅復原路徑。",
      4: "檔案系統清理做到一半停咗。有啲改動可能已經落咗去 —— 再試之前，去睇下 CODEX_HOME/.trash 同畫面顯示嘅復原路徑。",
      5: "清理喺檔案系統中途仆咗街。有部分可能已經做咗，所以再試之前，先去 CODEX_HOME/.trash 同顯示嗰條復原路徑度望真啲。",
    },
  },

  "startup.error": {
    cat: "error",
    en: {
      1: "The startup protection state could not be read.",
      2: "Startup protection could not be read.",
      4: "Startup protection could not be read, so nothing below is proof of anything.",
      5: "Could not read startup protection at all — so treat everything below as unknown rather than safe.",
    },
    yue: {
      1: "無法讀取開機保護狀態。",
      2: "讀唔到開機保護狀態。",
      4: "讀唔到開機保護狀態，所以下面啲嘢一律唔算得係證據。",
      5: "開機保護狀態完全讀唔到 —— 下面啲嘢當「未知」睇，唔好當「安全」。",
    },
  },

  "pool.saveFailed": {
    cat: "error",
    en: {
      1: "The {provider} pool settings could not be saved.",
      2: "The {provider} pool settings were not saved.",
      4: "The {provider} pool settings did not save — the previous settings are still in effect.",
      5: "The {provider} pool settings bounced on the way to disk. The previous settings are still what is running.",
    },
    yue: {
      1: "無法儲存 {provider} 嘅帳戶池設定。",
      2: "{provider} 嘅帳戶池設定冇儲存到。",
      4: "{provider} 嘅帳戶池設定儲存唔到 —— 而家行緊嘅仲係之前嗰套設定。",
      5: "{provider} 嘅帳戶池設定寫入到一半彈返轉頭。而家行緊嘅仲係之前嗰套。",
    },
  },

  // ------------------------------------------------------------------
  // warning — true but not yet broken
  // ------------------------------------------------------------------

  "startup.staleData": {
    cat: "warning",
    en: {
      1: "The most recent startup check failed. The values below are stale and must not be treated as proof of protection.",
      2: "The latest startup check failed, so the values below are stale and are not proof of protection.",
      4: "The latest startup check failed. Everything below is stale — read it as history, not as proof that you are protected.",
      5: "The latest startup check never came back. What is below is last known good, not proof of anything — do not read it as protection.",
    },
    yue: {
      1: "最近一次開機檢查失敗。以下數值已過時，唔可以當作有保護嘅證明。",
      2: "最近一次開機檢查失敗，所以下面啲數值已經過時，唔算得係有保護嘅證明。",
      4: "最近一次開機檢查失敗咗。下面啲嘢全部係舊資料 —— 當佢係歷史紀錄，唔好當你已經有保護。",
      5: "最近一次開機檢查冇返過嚟。下面顯示嘅係最後一次知道嘅狀態，唔係證據 —— 千祈唔好當你有保護。",
    },
  },

  "dash.shadowCallWarning": {
    cat: "warning",
    en: {
      1: "⚠ When this is enabled, ALL gpt-5.4-mini requests are replaced with the selected model.",
      2: "⚠ Once enabled, ALL gpt-5.4-mini requests are replaced with the selected model.",
      4: "⚠ Turn this on and every single gpt-5.4-mini request gets replaced with the selected model — no exceptions.",
      5: "⚠ Flip this and gpt-5.4-mini stops existing as far as this proxy is concerned: every one of its requests is replaced with the selected model.",
    },
    yue: {
      1: "⚠ 開啟後，所有 gpt-5.4-mini 請求都會被替換成你揀嘅模型。",
      2: "⚠ 一開咗，所有 gpt-5.4-mini 請求都會換成你揀嗰個模型。",
      4: "⚠ 開咗之後，每一個 gpt-5.4-mini 請求都會被換成你揀嗰個模型，一個都唔會漏。",
      5: "⚠ 撳落去之後，喺呢個 proxy 眼中 gpt-5.4-mini 就當唔存在：佢每一個請求都會被換成你揀嗰個模型。",
    },
  },

  "pool.experimentalWarning": {
    cat: "warning",
    en: {
      1: "Experimental. A provider may treat automated multi-account rotation as abuse and restrict the accounts involved. Accounts within a single organization frequently share a quota, so pooling them provides no benefit. Leave this disabled unless the risk for this provider is understood.",
      2: "Experimental. A provider may treat automated multi-account rotation as abuse and restrict the accounts involved. Accounts inside one organization often share a quota, so pooling those buys you nothing. Leave it off unless you understand the risk for this provider.",
      4: "Experimental, and the risk is real: a provider may read automated multi-account rotation as abuse and restrict the accounts involved. Accounts inside one organization usually share a quota anyway, so pooling those buys you nothing. Leave it off unless you understand the risk for this provider.",
      5: "Experimental, and the downside lands on your accounts: a provider can read automated multi-account rotation as abuse and restrict every account involved. And accounts inside one organization usually share a quota, so pooling those buys you exactly nothing. Leave it off unless you understand the risk for this provider.",
    },
    yue: {
      1: "此功能屬實驗性質。供應商可能將自動多帳戶輪換視為濫用，並限制涉及嘅帳戶；同一個組織內嘅帳戶通常共用同一份配額，將佢哋放入池冇任何得着。除非你清楚呢個供應商嘅風險，否則請保持關閉。",
      2: "實驗功能。供應商可能會當自動多帳戶輪換係濫用，跟住限制涉及嘅帳戶。同一個組織入面嘅帳戶通常共用一份配額，夾埋入池係冇著數嘅。除非你清楚呢個供應商嘅風險，否則唔好開。",
      4: "實驗功能，而個風險係真嘅：供應商可能會當自動多帳戶輪換係濫用，然後限制所有涉及嘅帳戶。而且同一個組織嘅帳戶通常共用一份配額，夾埋入池等於冇著數。除非你清楚呢個供應商嘅風險，否則唔好開。",
      5: "實驗功能，而且中招嘅係你啲帳戶：供應商可以當自動多帳戶輪換係濫用，然後將涉及嘅帳戶一次過限制晒。加上同一個組織嘅帳戶多數共用同一份配額，夾埋入池根本零著數。除非你清楚呢個供應商嘅風險，否則唔好開。",
    },
  },

  "terminal.fullScreenWarn": {
    cat: "warning",
    en: {
      1: "The full-screen interface of this CLI requires a real console and will not render here. Non-interactive commands (--help, exec, --version) function normally. Use Launch to open the full experience in a console.",
      2: "This CLI's full-screen interface needs a real console, so it will not draw here. Non-interactive commands (--help, exec, --version) work normally. Use Launch to open the full experience in a console.",
      4: "This CLI wants a real console for its full-screen interface, so nothing will draw here. Non-interactive commands (--help, exec, --version) are fine. Use Launch to get the full experience in a console.",
      5: "This CLI's full-screen interface wants a real console and will draw precisely nothing in here. Non-interactive commands (--help, exec, --version) are perfectly happy. Use Launch when you want the whole thing in a console.",
    },
    yue: {
      1: "呢個 CLI 嘅全螢幕介面需要真正嘅 console 先畫得出，喺呢度顯示唔到。非互動指令（--help、exec、--version）正常運作。想要完整體驗，請用「開啟」喺 console 度開。",
      2: "呢個 CLI 嘅全螢幕介面要真 console 先畫到，喺呢度出唔到。非互動指令（--help、exec、--version）正常用得。想要完整體驗就用「開啟」喺 console 度開。",
      4: "呢個 CLI 要真 console 先畫到佢個全螢幕介面，所以喺呢度乜都唔會出。非互動指令（--help、exec、--version）就完全冇問題。想要完整體驗，用「開啟」喺 console 度開佢。",
      5: "呢個 CLI 個全螢幕介面淨係認真 console，喺呢度佢一條線都唔會畫。非互動指令（--help、exec、--version）就爽快得好。想要成套嘢，用「開啟」喺 console 度開。",
    },
  },

  "startup.tray.notProtection": {
    cat: "warning",
    en: {
      1: "The tray is a controller and does not constitute restart protection. A viable background service remains required for unattended proxy recovery.",
      2: "The tray is a controller, not restart protection — a viable background service is still required for unattended proxy recovery.",
      4: "The tray only gives you buttons; it is not restart protection. Unattended recovery still needs a viable background service.",
      5: "The tray is a handful of buttons, not restart protection. If nobody is at the keyboard when the proxy dies, only a viable background service brings it back.",
    },
    yue: {
      1: "系統匣只係一個控制器，唔等於重啟保護。無人看管下要恢復 proxy，仍然需要一個可用嘅背景服務。",
      2: "系統匣係控制器，唔係重啟保護 —— 冇人睇住嗰陣要 proxy 自己返生，仍然要有個可用嘅背景服務。",
      4: "系統匣淨係畀幾粒掣你撳，唔算重啟保護。冇人睇住嗰陣要 proxy 自動復原，仲係要有個可用嘅背景服務。",
      5: "系統匣得幾粒掣咋，唔係重啟保護。proxy 死嗰陣如果冇人喺鍵盤前面，得個可用嘅背景服務救得返佢。",
    },
  },

  "dash.mem.restartNoSupervisor": {
    cat: "warning",
    en: {
      1: "No restart protection was detected. The proxy may remain stopped after a restart unless it is started again manually.",
      2: "No restart protection was detected, so the proxy may stay down after a restart unless you start it again.",
      4: "Nothing is watching this proxy. After a restart it may simply stay down until you start it again yourself.",
      5: "Nobody is on watch here. Restart the proxy and it may just stay down, quietly, until you start it again yourself.",
    },
    yue: {
      1: "偵測唔到重啟保護。重啟之後 proxy 可能會一直停住，除非你自己再開返佢。",
      2: "冇偵測到重啟保護，所以重啟之後個 proxy 可能會一直停住，要你自己開返佢。",
      4: "而家冇任何嘢睇住呢個 proxy。重啟之後佢可能就咁停住，直到你自己開返佢為止。",
      5: "呢度冇人守夜。重啟完個 proxy 可能就靜靜咁一直停住，等你自己開返佢先郁。",
    },
  },

  "launch.wtRestart": {
    cat: "warning",
    en: {
      1: "Windows Terminal is installed, but the current opencodex session cannot see it. Restart opencodex, then open the CLI again.",
      2: "Windows Terminal is installed, but this opencodex session cannot see it yet. Restart opencodex and open the CLI again.",
      4: "Windows Terminal is in, but this opencodex session was started before it existed and cannot see it. Restart opencodex, then open the CLI again.",
      5: "Windows Terminal has landed, but this opencodex session started before it arrived and is still looking at the old world. Restart opencodex, then open the CLI again.",
    },
    yue: {
      1: "Windows Terminal 已安裝，但今次開住嘅 opencodex 仲未見到佢。請重啟 opencodex，然後再開返個 CLI。",
      2: "Windows Terminal 裝咗喇，不過今次呢個 opencodex 仲未見到佢。重啟 opencodex，再開返個 CLI。",
      4: "Windows Terminal 已經入咗，但今次 opencodex 係喺佢裝之前開嘅，所以睇唔到佢。重啟 opencodex，然後再開返個 CLI。",
      5: "Windows Terminal 到咗喇，但今次 opencodex 開得太早，仲活喺舊世界度。重啟 opencodex，然後再開返個 CLI。",
    },
  },

  "claude.autoCompactWindowWarn": {
    cat: "warning",
    en: {
      1: "Changing this value can break GPT models. If it is set higher than a model's real limit, chats error before the summary takes effect.",
      2: "Changing this can break GPT models: set it higher than a model's real limit and chats error out before the summary kicks in.",
      4: "Careful — this one breaks GPT models. Set it higher than a model's real limit and chats error out before the summary ever kicks in.",
      5: "This is the setting that quietly breaks GPT models. Push it past a model's real limit and chats fall over with an error before the summary gets anywhere near kicking in.",
    },
    yue: {
      1: "改呢個可能會整壞 GPT 模型 —— 設得高過模型真正嘅上限，對話會喺摘要生效之前就出錯。",
      2: "改呢個可能會整壞 GPT 模型：設得高過模型真正嘅上限，對話就會喺摘要生效之前出錯。",
      4: "小心啲 —— 呢個設定係會整壞 GPT 模型㗎。設得高過模型真正嘅上限，對話喺摘要生效之前就已經出錯。",
      5: "呢個就係會靜靜雞整壞 GPT 模型嗰個設定。推過咗模型真正嘅上限，對話喺摘要仲未埋身之前就已經出錯收工。",
    },
  },

  // ------------------------------------------------------------------
  // success
  // ------------------------------------------------------------------

  /**
   * The rename confirmation. `{name}` is what the user just typed, so it is
   * the one token every rung has to carry — a level that celebrates without
   * repeating the name back does not confirm anything.
   */
  "appearance.appNameSavedBody": {
    cat: "success",
    en: {
      1: "The display name is now {name}.",
      2: "It is called {name} now.",
      4: "Say hello to {name}.",
      5: "It answers to {name} from here on. Same app underneath, new name on the door. 🪧",
    },
    yue: {
      1: "顯示名稱而家係 {name}。",
      2: "而家叫做 {name} 喇。",
      4: "同 {name} 打個招呼啦。",
      5: "由而家開始佢應「{name}」呢個名。底下仲係同一個 app，只係塊招牌換咗 🪧",
    },
  },

  "launch.installed": {
    cat: "success",
    en: {
      1: "{label} installed successfully.",
      2: "{label} is installed.",
      4: "{label} is in. Ready when you are.",
      5: "{label} has landed. 🎉",
    },
    yue: {
      1: "{label} 已成功安裝。",
      2: "{label} 已經裝好。",
      3: "{label} 裝好喇。",
      4: "{label} 搞掂，隨時可以用。",
      5: "{label} 已就位 🎉 想幾時開就幾時開。",
    },
  },

  "network.exported": {
    cat: "success",
    en: {
      1: "Export downloaded.",
      2: "The export has been downloaded.",
      4: "Export downloaded — it is on disk now, in plaintext.",
      5: "Export downloaded. It is sitting on your disk in plaintext, so treat it like the secret it is.",
    },
    yue: {
      1: "匯出檔已下載。",
      2: "匯出檔已經下載咗。",
      4: "匯出檔已下載 —— 而家以明文形式擺喺你部機度。",
      5: "匯出檔已下載，正正經經以明文瞓喺你部機度。當佢係機密咁對待。",
    },
  },

  "network.restored": {
    cat: "success",
    en: {
      1: "State restored — the proxy is restarting.",
      2: "The state has been restored and the proxy is restarting.",
      4: "State restored. The proxy is restarting to pick it up.",
      5: "State restored, and the proxy is restarting to catch up with its new old self.",
    },
    yue: {
      1: "狀態已還原 —— proxy 正在重啟。",
      2: "狀態已經還原，proxy 重啟緊。",
      4: "狀態已還原。proxy 重啟緊，等佢讀返新設定。",
      5: "狀態還原完成，proxy 而家重啟緊，追返佢個「新嘅舊自己」。",
    },
  },

  "settings.savedBody": {
    cat: "success",
    en: {
      1: "The change is recorded in the local history. Restore it from Version history if it was made in error.",
      2: "Recorded in the local history. If this was a mistake, restore it from Version history.",
      4: "Written to the local history, so if this was a mistake you can put it back from Version history.",
      5: "The local history wrote it down, which means a mistake here is only a trip to Version history away from being undone.",
    },
    yue: {
      1: "已記錄喺本機紀錄 —— 如果撳錯咗，可以喺「版本紀錄」度還原。",
      2: "已經記低咗喺本機紀錄。撳錯咗嘅話，去「版本紀錄」還原返。",
      4: "已經寫咗入本機紀錄，所以撳錯咗都可以喺「版本紀錄」度執返轉頭。",
      5: "本機紀錄已經幫你記低咗，即係撳錯都唔怕：行去「版本紀錄」還原返就得。",
    },
  },

  "regex.copied": {
    cat: "success",
    en: {
      1: "Pattern copied.",
      2: "The pattern is on the clipboard.",
      4: "Pattern copied — paste it wherever it needs to go.",
      5: "Pattern copied. Go paste it somewhere it can do some damage.",
    },
    yue: {
      1: "已複製 pattern。",
      2: "Pattern 已經喺剪貼簿度。",
      4: "Pattern 複製咗喇 —— 想貼去邊就貼去邊。",
      5: "Pattern 複製咗，攞去邊度搞事都得。",
    },
  },

  "dash.syncOk": {
    cat: "success",
    en: {
      1: "Synchronisation complete. {count} model(s) were appended.",
      2: "Sync complete — {count} model(s) appended.",
      4: "Sync done: {count} model(s) appended to Codex's catalog.",
      5: "Sync done. {count} model(s) added to Codex's catalog, whether it asked for them or not.",
    },
    yue: {
      1: "同步完成。已新增 {count} 個模型。",
      2: "同步完成 —— 新增咗 {count} 個模型。",
      4: "同步搞掂：Codex 個目錄多咗 {count} 個模型。",
      5: "同步搞掂，Codex 個目錄硬食咗 {count} 個新模型。",
    },
  },

  "switcher.switched": {
    cat: "success",
    en: {
      1: "Switched active account.",
      2: "The active account has been switched.",
      4: "Active account switched — the next request uses it.",
      5: "Active account switched. Whoever it is now, the next request is theirs.",
    },
    yue: {
      1: "已切換使用中嘅帳戶。",
      2: "使用中嘅帳戶已經轉咗。",
      4: "已經轉咗使用中嘅帳戶 —— 下一個請求就用佢。",
      5: "使用中嘅帳戶已經轉咗，下一個請求就記喺佢數。",
    },
  },

  // ------------------------------------------------------------------
  // progress
  // ------------------------------------------------------------------

  "window.exiting": {
    cat: "progress",
    en: {
      1: "Completing in-flight work before closing…",
      2: "Finishing the in-flight work, then closing…",
      4: "Letting the in-flight work finish, then closing…",
      5: "Letting everything still in flight land, then closing up…",
    },
    yue: {
      1: "正在完成進行中嘅工作，之後關閉…",
      2: "等緊進行中嘅工作做完，之後關閉…",
      4: "畀仲行緊嗰啲做完先，跟住就閂…",
      5: "等晒仲喺半空嗰啲嘢安全落地，然後就閂…",
    },
  },

  "dash.mem.draining": {
    cat: "progress",
    en: {
      1: "Waiting for {count} in-flight request(s); the proxy restarts once they complete",
      2: "Draining {count} request(s) — restarting once they complete",
      4: "Waiting out {count} request(s), then restarting.",
      5: "Waiting for {count} request(s) to finish their sentence, then restarting.",
    },
    yue: {
      1: "正在等待 {count} 個請求完成…完成後重啟",
      2: "等緊 {count} 個請求排完 —— 做完就重啟",
      4: "等 {count} 個請求行完先，跟住重啟。",
      5: "等 {count} 個請求講完最後嗰句，然後就重啟。",
    },
  },

  "launch.installing": {
    cat: "progress",
    en: {
      1: "Installation of {label} is in progress…",
      2: "Installing {label} now…",
      4: "Installing {label} — this one is out of our hands now.",
      5: "Installing {label}. The installer has the wheel from here.",
    },
    yue: {
      1: "正在安裝 {label}…",
      2: "而家安裝緊 {label}…",
      4: "安裝緊 {label} —— 而家輪到安裝程式話事。",
      5: "安裝緊 {label}，方向盤已經交咗畀個安裝程式。",
    },
  },

  "dash.updateReconnecting": {
    cat: "progress",
    en: {
      1: "Waiting for the restarted proxy to become available…",
      2: "Waiting for the restarted proxy to answer…",
      4: "Waiting for the restarted proxy to come back up…",
      5: "Waiting for the restarted proxy to wake up and answer the door…",
    },
    yue: {
      1: "正在等待重啟後嘅 proxy…",
      2: "等緊重啟後嘅 proxy 應機…",
      4: "等緊重啟後嘅 proxy 返返生…",
      5: "等緊重啟後嘅 proxy 瞓醒返嚟開門…",
    },
  },

  // ------------------------------------------------------------------
  // empty states
  // ------------------------------------------------------------------

  "mobile.noSessions": {
    cat: "empty",
    en: {
      1: "No requests have been recorded.",
      2: "No requests yet.",
      4: "Nothing has come through yet — the proxy is waiting.",
      5: "Dead quiet in here. Not a single request. The proxy is getting bored.",
    },
    yue: {
      1: "尚未記錄任何請求。",
      2: "暫時未有請求。",
      3: "仲未有請求。",
      4: "一個請求都未入嚟，proxy 喺度等緊。",
      5: "靜到得個吉。一個請求都冇，proxy 悶到發霉。",
    },
  },

  "terminal.idleBody": {
    cat: "empty",
    en: {
      1: "Select a shell or CLI to start a session.",
      2: "Pick a shell or a CLI from above to start a session.",
      4: "Pick a shell or a CLI from up there and let's get a session going.",
      5: "Nothing running. Pick a shell or a CLI above and let's make some noise.",
    },
    yue: {
      1: "請選擇 shell 或 CLI 以開始工作階段。",
      2: "喺上面揀個 shell 或者 CLI 就可以開始。",
      3: "上面揀個 shell 或者 CLI，就開得。",
      4: "上面揀個 shell 或者 CLI，我哋開個 session 玩下。",
      5: "而家乜都冇行緊。上面揀個 shell 或者 CLI，搞啲嘢出嚟啦。",
    },
  },

  "notif.empty": {
    cat: "empty",
    en: {
      1: "No notifications.",
      2: "Nothing so far",
      4: "All quiet — nothing has needed your attention.",
      5: "Suspiciously quiet. Either everything works, or nothing has tried yet.",
    },
    yue: {
      1: "沒有通知。",
      2: "暫時未有通知。",
      3: "而家乜都冇。",
      4: "一切平靜，冇嘢需要你處理。",
      5: "靜得有啲可疑。唔係一切正常，就係根本未有嘢試過。",
    },
  },

  "launch.emptyBody": {
    cat: "empty",
    en: {
      1: "No agent CLI or desktop app was detected on this machine. Install one and it will appear here.",
      2: "No agent CLI or desktop app was found on this machine. Install one and it appears here.",
      4: "Nothing to launch — no agent CLI or desktop app was found on this machine. Install one and it shows up here.",
      5: "Nothing at all to launch: not one agent CLI, not one desktop app, anywhere on this machine. Install one and it turns up here.",
    },
    yue: {
      1: "喺呢部機偵測唔到任何 agent CLI 或者桌面 app。安裝其中一個之後，佢就會喺呢度出現。",
      2: "呢部機冇任何 agent CLI 或桌面 app。裝咗一個之後就會喺呢度出現。",
      4: "冇嘢可以開 —— 呢部機搵唔到任何 agent CLI 或者桌面 app。裝一個佢就會喺呢度出現。",
      5: "真係一件都冇：呢部機上面連一個 agent CLI、一個桌面 app 都搵唔到。裝咗一個佢就會走出嚟。",
    },
  },

  "history.emptyBody": {
    cat: "empty",
    en: {
      1: "Changes to providers, accounts, keys, combos and settings are recorded here as they are made.",
      2: "Changes to providers, accounts, keys, combos and settings land here as you make them.",
      4: "Nothing recorded yet. Changes to providers, accounts, keys, combos and settings land here as you make them.",
      5: "Blank slate. The moment you touch a provider, account, key, combo or setting, it gets written down right here.",
    },
    yue: {
      1: "你對供應商、帳戶、key、組合同設定所做嘅改動，會即時記錄喺呢度。",
      2: "供應商、帳戶、key、組合同設定嘅改動，一做就會記低喺呢度。",
      4: "而家一條紀錄都冇。你改供應商、帳戶、key、組合或者設定，即刻就會記喺呢度。",
      5: "一張白紙。你一郁供應商、帳戶、key、組合或者設定，即刻就會有紀錄寫低喺呢度。",
    },
  },

  "usage.empty": {
    cat: "empty",
    en: {
      1: "No usage has been recorded. Send a request through the proxy to see activity here.",
      2: "No usage recorded yet — send a request through the proxy and activity appears here.",
      4: "Nothing counted yet. Send a request through the proxy and it shows up here.",
      5: "The counters are all zero. Send one request through the proxy and this page finally has something to do.",
    },
    yue: {
      1: "尚未記錄任何用量。經 proxy 送一個請求出去，呢度就會見到活動紀錄。",
      2: "暫時未有用量紀錄 —— 經 proxy send 個請求，呢度就會出嘢。",
      4: "而家乜都未計到。經 proxy send 個請求，佢就會喺呢度出現。",
      5: "啲計數器全部係零。經 proxy send 一個請求，呢版終於有嘢做。",
    },
  },

  "changelog.noResultsBody": {
    cat: "empty",
    en: {
      1: "Widen the date range, or clear the search, to see more releases.",
      2: "Widen the date range, or clear the search, to see more.",
      4: "Nothing survived both filters. Widen the date range or clear the search.",
      5: "Your date range and your search between them left nothing standing. Widen one, or clear the other.",
    },
    yue: {
      1: "請擴闊日期範圍或清除搜尋條件，睇多啲結果。",
      2: "擴闊個日期範圍，或者清除搜尋條件，就會見到多啲。",
      4: "兩個篩選夾埋之後乜都唔剩。擴闊個日期範圍，或者清除個搜尋。",
      5: "你個日期範圍加個搜尋，兩者夾埋殺清光。擴闊其中一個，又或者清走另一個。",
    },
  },

  "regex.noMatches": {
    cat: "empty",
    en: {
      1: "The pattern produced no matches in the sample text.",
      2: "The pattern matches nothing in the sample text.",
      4: "The pattern found nothing in the sample text.",
      5: "The pattern went right through the sample text and came out the other side with nothing.",
    },
    yue: {
      1: "喺樣本文字入面冇任何符合項。",
      2: "呢個 pattern 喺樣本文字度中唔到嘢。",
      4: "呢個 pattern 喺樣本文字入面乜都搵唔到。",
      5: "呢個 pattern 由頭掃到尾，喺樣本文字度一件都執唔到。",
    },
  },

  "logs.noMatch": {
    cat: "empty",
    en: {
      1: "No request matches the current search.",
      2: "No request matches that search.",
      4: "Nothing in the log matches that search.",
      5: "Not one request in the log wants anything to do with that search.",
    },
    yue: {
      1: "冇請求符合你嘅搜尋條件。",
      2: "冇任何請求夾到呢個搜尋。",
      4: "紀錄入面冇嘢夾到呢個搜尋。",
      5: "紀錄入面一個請求都唔肯認呢個搜尋。",
    },
  },

  // ------------------------------------------------------------------
  // guidance — the leads and hints that set a screen up
  // ------------------------------------------------------------------

  "dash.subtitle": {
    cat: "guidance",
    en: {
      1: "Current status of the local opencodex proxy, its configured providers, and the models routed into Codex.",
      2: "Live status of the local opencodex proxy, its providers, and the models it routes into Codex.",
      4: "Everything the local opencodex proxy is doing right now — its providers, and the models routed into Codex.",
      5: "Live from your own machine: one opencodex proxy, its providers, and the pile of models it routes into Codex.",
    },
    yue: {
      1: "本地 opencodex proxy、其供應商，以及路由入 Codex 嘅模型嘅即時狀態。",
      2: "本地 opencodex proxy、佢啲供應商同路由入 Codex 嘅模型嘅即時狀態。",
      4: "本地 opencodex proxy 而家做緊嘅所有嘢 —— 佢啲供應商，同埋路由入 Codex 嘅模型。",
      5: "由你部機直播：一個 opencodex proxy、佢啲供應商，同一大堆路由入 Codex 嘅模型。",
    },
  },

  /**
   * The rename card's lead.
   *
   * Voiced because the level ladder is exactly where a disclosure gets quietly
   * dropped: the fact that must survive to level 5 is that a new name moves
   * the label and nothing underneath it. Every rung says so.
   */
  "appearance.appNameSub": {
    cat: "guidance",
    en: {
      1: "Changes the name this app displays. Storage locations, update configuration and the on-disk application name are unaffected.",
      2: "Changes the name this app shows you. Where your settings live, how it updates and what it is called on disk all stay put.",
      4: "Call it whatever you like. It is only a label — your settings stay exactly where they are, and so does everything else under the hood.",
      5: "Name it after your cat if you want. It is a label and nothing more: your settings, your updates and the name on disk carry on exactly as they were, entirely unbothered.",
    },
    yue: {
      1: "更改此 app 顯示嘅名稱。儲存位置、更新設定同硬碟上嘅名稱一律不受影響。",
      2: "改呢個 app 顯示畀你睇嘅名。設定擺喺邊、點更新、喺硬碟叫咩，全部照舊。",
      4: "鍾意叫呢個 app 做咩就咩。淨係一個名牌 —— 你啲設定原封不動，底下嘅嘢一樣都唔會郁。",
      5: "改做你隻貓個名都得。呢個純粹係塊名牌：你啲設定、更新、硬碟上個 app 名，全部照舊，一啲都唔理你改咗咩。",
    },
  },

  "lang.sub": {
    cat: "guidance",
    en: {
      1: "The selection applies immediately. Strings that are not yet translated are displayed in English.",
      2: "Applies immediately — untranslated strings fall back to English.",
      4: "Takes effect the moment you pick one. Anything not translated yet falls back to English.",
      5: "Changes the instant you pick one. Anything still untranslated quietly falls back to English rather than showing you a key name.",
    },
    yue: {
      1: "即時生效。未翻譯嘅字串會退回英文。",
      2: "即時生效 —— 未翻譯嘅字串會退返英文。",
      4: "你一揀就即刻生效。仲未翻譯嗰啲會退返英文。",
      5: "一揀即刻變。仲未翻譯嗰啲會靜靜咁退返英文，唔會掟個 key 名出嚟嚇你。",
    },
  },

  "regex.safety": {
    cat: "guidance",
    en: {
      1: "Patterns are evaluated locally and are never transmitted. The pattern is capped at {pattern} characters, the sample at {sample}, and matches at {matches}, with zero-width advance so that a catastrophic pattern cannot hang the page.",
      2: "Evaluated locally and never transmitted. The pattern is capped at {pattern} characters, the sample at {sample}, and matches at {matches}, with zero-width advance so a catastrophic pattern cannot hang the page.",
      4: "Everything runs in this browser and nothing is transmitted. The pattern stops at {pattern} characters, the sample at {sample}, matches at {matches}, and zero-width advance keeps a catastrophic pattern from hanging the page.",
      5: "It all runs right here and nothing leaves the browser. The pattern is cut off at {pattern} characters, the sample at {sample}, matches at {matches}, and zero-width advance means even a spectacularly bad pattern cannot hang the page.",
    },
    yue: {
      1: "所有運算喺本機進行，唔會傳送出去。Pattern 上限 {pattern} 個字符、樣本 {sample}、符合項 {matches}，並使用零寬度推進，令災難性 pattern 都唔會令頁面卡死。",
      2: "全部喺本機行，唔會傳送出去。Pattern 上限 {pattern} 個字符，樣本 {sample}，符合項 {matches}，仲有零寬度推進，所以災難性 pattern 都卡死唔到個頁面。",
      4: "所有嘢喺你個瀏覽器度行，一個字都唔會送出去。Pattern 去到 {pattern} 個字符就截、樣本 {sample}、符合項 {matches}，加上零寬度推進，災難性 pattern 都拖唔死個頁面。",
      5: "全部喺你個瀏覽器度搞掂，一個字都唔會出街。Pattern 夠 {pattern} 個字符就截、樣本 {sample}、符合項 {matches}，再加零寬度推進 —— 即係寫到幾癲嘅 pattern 都卡死唔到個頁面。",
    },
  },

  "settings.sub": {
    cat: "guidance",
    en: {
      1: "All adjustable values in one place. Each change is recorded in the local history and can therefore be undone.",
      2: "Every adjustable value in one place — each change is recorded in the local history, so any of it can be undone.",
      4: "Every adjustable value, in one place. Each change goes into the local history, so any of it can be undone.",
      5: "One page, every knob in the app. Each change is written into the local history, so nothing here is a one-way door.",
    },
    yue: {
      1: "所有可調整嘅設定集中喺一處。每次改動都會記錄喺本機紀錄，隨時可以復原。",
      2: "所有可調整嘅設定都喺呢一版。每次改動都記低喺本機紀錄，全部復原得。",
      4: "全部可調嘅嘢，一版睇晒。每次改動都會入本機紀錄，所以樣樣都返轉頭得。",
      5: "一版嘢，成個 app 嘅掣都喺度。每次改動都寫入本機紀錄，所以呢度冇一道係單程門。",
    },
  },

  "onboard.sub": {
    cat: "guidance",
    en: {
      1: "Three steps. All of these settings can be changed later.",
      2: "Three steps — and you can change any of it later.",
      4: "Three steps. Nothing here is permanent; you can change all of it later.",
      5: "Three steps, and not one of them is binding — you can change every last bit of it later.",
    },
    yue: {
      1: "三個步驟，之後所有設定都可以更改。",
      2: "三個步驟 —— 之後樣樣都改得返。",
      4: "三步咋。呢度冇一樣係定死嘅，之後全部改得。",
      5: "三步啫，冇一步係賣身契 —— 之後每一樣都改得返。",
    },
  },

  "changelog.subtitle": {
    cat: "guidance",
    en: {
      1: "All released versions, with their dates and categorized changes. Filter by date, search the text, and export the current view.",
      2: "Every released version, with its date and categorized changes — filter by date, search the text, and export what you see.",
      4: "Every released version, dated and sorted into categories. Filter by date, search the text, and export exactly what you are looking at.",
      5: "Every version ever released, dated and filed into categories. Filter by date, search the text, and export exactly what is on screen — no more, no less.",
    },
    yue: {
      1: "每個已發佈版本，連日期同分類過嘅改動。可以按日期篩選、搜尋文字，並匯出你睇到嘅內容。",
      2: "每個已發佈版本，有日期同分類好嘅改動。按日期篩選、搜尋文字，仲可以匯出你見到嘅嘢。",
      4: "所有發佈過嘅版本，逐個標好日期同分類。按日期篩選、搜尋文字，然後匯出你眼前見到嗰啲。",
      5: "由第一版數到而家，每個版本都標好日期同分類。按日期篩、搵字，然後將畫面上見到嗰啲原封匯出 —— 唔多唔少。",
    },
  },

  "usage.subtitle": {
    cat: "guidance",
    en: {
      1: "Local token accounting recorded by your proxy. Missing usage is never reported as zero.",
      2: "Local token accounting from your proxy — missing usage is never shown as zero.",
      4: "Token accounting straight from your own proxy. Where usage is missing it says so, rather than showing a zero.",
      5: "Token accounting straight off your own proxy. Where the usage simply is not known, it says so instead of quietly writing a zero and calling it a fact.",
    },
    yue: {
      1: "由你個 proxy 本機記錄嘅 token 帳目。缺失嘅用量絕對唔會顯示成零。",
      2: "由你個 proxy 本機計嘅 token 帳目。冇用量資料嘅，唔會當佢係零。",
      4: "直接由你自己個 proxy 計嘅 token 帳目。冇用量資料就會照講，唔會扮零。",
      5: "直接由你自己個 proxy 出嘅 token 帳目。真係唔知用咗幾多嗰啲，佢會照認，唔會靜靜寫個零然後當係事實。",
    },
  },

  // ------------------------------------------------------------------
  // delight
  // ------------------------------------------------------------------

  "dimsum.title": {
    cat: "delight",
    en: {
      1: "Dim sum",
      2: "A dim sum break",
      4: "Dim sum o'clock!",
      5: "DIM SUM TIME! 🥟 Drop everything.",
    },
    yue: {
      1: "點心",
      2: "點心時間",
      3: "點心時間到！",
      4: "點心時間到！飲啖茶先。",
      5: "點心時間到！🥟 咩都放低先，食嘢緊要啲。",
    },
  },

  "dimsum.hint": {
    cat: "delight",
    en: {
      1: "A treat shown on roughly one launch in ten. It dismisses itself.",
      2: "A 1-in-10 launch treat — it sees itself out.",
      4: "One launch in ten gets you this. It leaves on its own.",
      5: "One launch in ten, this shows up uninvited — and then, unlike most uninvited guests, leaves on its own.",
    },
    yue: {
      1: "大約每十次開機出現一次嘅小驚喜。佢會自己收埋。",
      2: "十次開機有一次嘅小驚喜 —— 唔使你趕，佢自己走。",
      4: "十次開機中一次。你唔理佢，佢自己收工。",
      5: "十次開機就有一次突然彈出嚟，冇人請佢 —— 不過佢好識做，坐一陣就自己走人。",
    },
  },

  "dimsum.toggleHint": {
    cat: "delight",
    en: {
      1: "Approximately one launch in ten displays a small dim sum card. It is never shown on a first run or immediately after an update, and it does not interrupt work in progress.",
      2: "Roughly one launch in ten shows a small dim sum card — never on your first run or right after an update, and never over what you are doing.",
      4: "About one launch in ten puts a small dim sum card on screen. Never on your first run, never right after an update, and never in your way.",
      5: "About once every ten launches, a small dim sum card wanders in. Never on your first run, and never right after an update — it knows exactly when to stay out of the way, which is more than can be said for most notifications.",
    },
    yue: {
      1: "大約每十次開機，會顯示一張細細張嘅點心卡。第一次執行同啱啱更新完唔會出現，亦唔會打斷緊做緊嘅嘢。",
      2: "大約十次開機出一次點心卡 —— 第一次執行同啱啱更新完就唔會出，亦唔會阻住你。",
      4: "大約十次開機，會有一次彈張細細張點心卡出嚟。第一次執行同啱啱更新完就一定唔會出，亦唔會阻你做嘢。",
      5: "大約十次開機，會有一次有張細細張點心卡自己行入嚟。第一次執行同啱啱更新完就唔會出 —— 佢好識做，知道幾時唔應該阻你，呢點比好多通知都叻。",
    },
  },
};

/**
 * The variant for a key at a level, or null to use the neutral dictionary.
 *
 * There is deliberately no fallback *between* levels. A key that defines 4 and 5
 * renders neutral at 1, 2 and 3, which is correct: neutral is the shipped
 * wording, and borrowing level 4's phrasing for level 2 would make the slider
 * shout one notch early.
 */
export function voiceFor(lang: VoiceLang, key: TKey, level: FunnyLevel): string | null {
  return VOICE[key]?.[lang]?.[level] ?? null;
}

/** True when a key has any level-specific wording in this track. */
export function hasVoice(lang: VoiceLang, key: TKey): boolean {
  const entry = VOICE[key];
  return entry !== undefined && Object.keys(entry[lang]).length > 0;
}

/** How many keys carry level-specific wording — reported honestly in settings. */
export function voiceCoverage(lang: VoiceLang): number {
  return voicedKeys().filter(key => hasVoice(lang, key)).length;
}

/** Every key the overlay styles, optionally narrowed to one category. */
export function voicedKeys(cat?: VoiceCategory): TKey[] {
  const keys = Object.keys(VOICE) as TKey[];
  return cat ? keys.filter(key => VOICE[key]?.cat === cat) : keys;
}

/** Which category a key's copy belongs to, or null when it carries no voice. */
export function voiceCategoryOf(key: TKey): VoiceCategory | null {
  return VOICE[key]?.cat ?? null;
}

/** Per-category counts, so "every category" is a number rather than a claim. */
export function voiceCategoryCoverage(): Record<VoiceCategory, number> {
  const out = Object.fromEntries(VOICE_CATEGORIES.map(c => [c, 0])) as Record<VoiceCategory, number>;
  for (const key of voicedKeys()) {
    const cat = VOICE[key]?.cat;
    if (cat) out[cat] += 1;
  }
  return out;
}

/** The levels a key defines in one track. Used by the coverage tests. */
export function voiceLevels(lang: VoiceLang, key: TKey): FunnyLevel[] {
  const map = VOICE[key]?.[lang];
  return map ? (Object.keys(map).map(Number) as FunnyLevel[]) : [];
}
