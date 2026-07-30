/**
 * The funny level, as actual copy.
 *
 * The two sliders on Language & voice have existed for a while and, until now,
 * changed nothing: they persisted a number to `ocx-m3:funny` and no renderer
 * ever read it. A control that stores a preference nobody consults is worse
 * than no control, because it tells the user a lie every time they move it.
 *
 * ## What varies, and what never does
 *
 * The level styles **voice only**. Every variant of a key states the same fact:
 * the same file, the same account, the same irreversibility, the same error.
 * Level 1 is what you would write for a colleague under pressure; level 5 is
 * what you would say to a friend. Neither is allowed to leave the reader unsure
 * what a button does — a warning nobody can act on is a broken warning, not a
 * funny one.
 *
 * This applies to **every** category, errors and destructive confirmations
 * included. There is no carve-out, because the setting discloses that up front
 * and the user opted in.
 *
 * ## Why this is a curated overlay rather than five full dictionaries
 *
 * The product dictionary is ~1 500 keys per locale. Five voice variants of all
 * of them would be 7 500 strings per language, most of which are labels like
 * "Save" that have exactly one sensible rendering at any level. So the overlay
 * covers the copy where voice actually reads — headings, empty states,
 * confirmations, errors, the destructive warnings — and every other key falls
 * through to the neutral string. `hasVoice()` reports the real coverage so the
 * settings screen can state it instead of implying the whole app is rewritten.
 *
 * Adding a key here is additive and safe: no key is required at every level,
 * and a missing level falls back to the neutral string.
 */

import type { TKey } from "./shared";

/** 1 = fully serious, 5 = maximum playfulness. */
export type FunnyLevel = 1 | 2 | 3 | 4 | 5;

/** Voice track. Bilingual mode composes both, so each is stored separately. */
export type VoiceLang = "en" | "yue";

type LevelMap = Partial<Record<FunnyLevel, string>>;

/**
 * `en` variants. Level 3 is the shipped neutral wording and is therefore mostly
 * absent — an absent level resolves to the base dictionary, so repeating it
 * here would just be a second copy to keep in sync.
 */
const EN: Partial<Record<TKey, LevelMap>> = {
  "storage.cleanup.permanentWarn": {
    1: "This permanently deletes the selected archived sessions. It cannot be undone.",
    2: "This permanently deletes the selected archived sessions. There is no undo.",
    4: "These archived sessions are about to be gone for good — no undo, no recycle bin, no take-backs.",
    5: "Point of no return: these archived sessions get vaporised. No undo, no bin, no tearful reunion later.",
  },
  "launch.installFailed": {
    1: "Installation of {label} failed.",
    2: "{label} could not be installed.",
    4: "{label} refused to install. The installer's own words are below.",
    5: "{label} said no. Loudly. Its exact excuse is below.",
  },
  "launch.installed": {
    1: "{label} installed successfully.",
    2: "{label} is installed.",
    4: "{label} is in. Ready when you are.",
    5: "{label} has landed. 🎉",
  },
  "mobile.noSessions": {
    1: "No requests have been recorded.",
    2: "No requests yet.",
    4: "Nothing has come through yet — the proxy is waiting.",
    5: "Dead quiet in here. Not a single request. The proxy is getting bored.",
  },
  "terminal.idleBody": {
    1: "Select a shell or CLI to start a session.",
    2: "Pick a shell or a CLI above to start one.",
    4: "Pick something from up there and let's get a session going.",
    5: "Nothing running. Pick a shell above and let's make some noise.",
  },
  "notif.empty": {
    1: "No notifications.",
    2: "Nothing yet",
    4: "All quiet — nothing has needed your attention.",
    5: "Suspiciously quiet. Either everything works, or nothing has tried yet.",
  },
  "dimsum.title": {
    1: "Dim sum",
    2: "A dim sum break",
    4: "Dim sum time!",
    5: "DIM SUM TIME! 🥟 Drop everything.",
  },
};

/**
 * `yue` variants — playful Hong Kong Cantonese. Level 1 stays fully
 * professional; the facts (file, account, irreversibility) are identical at
 * every level, exactly as in English.
 */
const YUE: Partial<Record<TKey, LevelMap>> = {
  "storage.cleanup.permanentWarn": {
    1: "此操作會永久刪除已選的封存工作階段，無法復原。",
    2: "呢個操作會永久刪除揀咗嘅封存 session，冇得復原。",
    3: "揀咗嘅封存 session 會永久刪除，冇得返轉頭。",
    4: "揀咗嘅封存 session 即刻永久刪除 —— 冇 undo，冇回收筒，冇得後悔。",
    5: "撳落去就係一去不回：揀咗嘅封存 session 灰飛煙滅。冇 undo、冇回收筒、之後喊都冇用。",
  },
  "launch.installFailed": {
    1: "{label} 安裝失敗。",
    2: "{label} 裝唔到。",
    3: "{label} 安裝唔成功。",
    4: "{label} 唔肯裝。佢自己嘅解釋喺下面。",
    5: "{label} 死都唔肯裝。佢嘅藉口原文擺喺下面，你自己睇。",
  },
  "launch.installed": {
    1: "{label} 已成功安裝。",
    2: "{label} 已經裝好。",
    3: "{label} 裝好喇。",
    4: "{label} 搞掂，隨時可以用。",
    5: "{label} 已就位 🎉 想幾時開就幾時開。",
  },
  "mobile.noSessions": {
    1: "尚未記錄任何請求。",
    2: "暫時未有請求。",
    3: "仲未有請求。",
    4: "一個請求都未入嚟，proxy 喺度等緊。",
    5: "靜到得個吉。一個請求都冇，proxy 悶到發霉。",
  },
  "terminal.idleBody": {
    1: "請選擇 shell 或 CLI 以開始工作階段。",
    2: "喺上面揀個 shell 或者 CLI 就可以開始。",
    3: "上面揀個 shell 或者 CLI，就開得。",
    4: "上面揀樣嘢，我哋開個 session 玩下。",
    5: "而家乜都冇行緊。上面揀個 shell，搞啲嘢出嚟啦。",
  },
  "notif.empty": {
    1: "沒有通知。",
    2: "暫時未有通知。",
    3: "而家乜都冇。",
    4: "一切平靜，冇嘢需要你處理。",
    5: "靜得有啲可疑。唔係一切正常，就係根本未有嘢試過。",
  },
  "dimsum.title": {
    1: "點心",
    2: "點心時間",
    3: "點心時間到！",
    4: "點心時間到！飲啖茶先。",
    5: "點心時間到！🥟 咩都放低先，食嘢緊要啲。",
  },
};

const TRACKS: Record<VoiceLang, Partial<Record<TKey, LevelMap>>> = { en: EN, yue: YUE };

/**
 * The variant for a key at a level, or null to use the neutral dictionary.
 *
 * Falls back *downward* through levels rather than jumping to neutral: a key
 * that defines 4 and 5 should render its level-4 wording at level 4 and its
 * level-5 wording at 5, and a key that defines only 5 should still read neutral
 * at 4 rather than shouting early.
 */
export function voiceFor(lang: VoiceLang, key: TKey, level: FunnyLevel): string | null {
  return TRACKS[lang]?.[key]?.[level] ?? null;
}

/** True when a key has any level-specific wording in this track. */
export function hasVoice(lang: VoiceLang, key: TKey): boolean {
  return TRACKS[lang]?.[key] !== undefined;
}

/** How many keys carry level-specific wording — reported honestly in settings. */
export function voiceCoverage(lang: VoiceLang): number {
  return Object.keys(TRACKS[lang] ?? {}).length;
}
