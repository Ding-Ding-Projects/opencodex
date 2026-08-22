/** Deterministic, capture-only controls injected before the reference source runs. */

const argument = process.argv.find(value => value.startsWith("--ocx-capture-config="));
const config = argument ? JSON.parse(Buffer.from(argument.slice("--ocx-capture-config=".length), "base64url").toString("utf8")) : null;
const FIXED_TIME_MS = Number(config?.fixedTimeMs || Date.parse("2026-07-29T12:00:00.000Z"));
const LOCALE = config?.locale === "yue" ? "zh-HK" : "en-US";
const TIMEZONE = String(config?.timezone || "UTC");
const nativeDate = Date;
const nativeNow = Date.now;
const nativeRandom = Math.random;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const nativeRaf = globalThis.requestAnimationFrame;
const nativeCancelRaf = globalThis.cancelAnimationFrame;

let randomState = 0x9e3779b9;
for (const code of String(config?.seed || "#2F6B4F")) randomState = (randomState ^ code.charCodeAt(0)) >>> 0;
function deterministicRandom() {
  randomState = (Math.imul(randomState ^ (randomState >>> 16), 2246822519) + 3266489917) >>> 0;
  return (randomState >>> 0) / 4294967296;
}

class DeterministicDate extends nativeDate {
  constructor(...args) { super(...(args.length ? args : [FIXED_TIME_MS])); }
  static now() { return FIXED_TIME_MS; }
}
DeterministicDate.parse = nativeDate.parse;
DeterministicDate.UTC = nativeDate.UTC;
globalThis.Date = DeterministicDate;
Math.random = deterministicRandom;
if (globalThis.crypto?.getRandomValues) {
  try { globalThis.crypto.getRandomValues = typed => {
    for (let i = 0; i < typed.length; i += 1) typed[i] = Math.floor(deterministicRandom() * 256);
    return typed;
  }; } catch {}
}

const nativeDateTimeFormat = Intl.DateTimeFormat;
Intl.DateTimeFormat = function(locales, options) {
  const merged = { ...(options || {}) };
  if (!merged.timeZone) merged.timeZone = TIMEZONE;
  return new nativeDateTimeFormat(locales || LOCALE, merged);
};
Intl.DateTimeFormat.prototype = nativeDateTimeFormat.prototype;
try {
  Object.defineProperty(navigator, "language", { configurable: true, get: () => LOCALE });
  Object.defineProperty(navigator, "languages", { configurable: true, get: () => [LOCALE] });
} catch {}

// Keep asynchronous module resolution alive but make timer behavior bounded and
// time inputs fixed. The receipt records this policy; it is not app behavior.
globalThis.setTimeout = (fn, delay = 0, ...args) => nativeSetTimeout(fn, Math.min(Math.max(Number(delay) || 0, 0), 1000), ...args);
globalThis.setInterval = (fn, delay = 0, ...args) => nativeSetInterval(fn, Math.min(Math.max(Number(delay) || 0, 0), 1000), ...args);
globalThis.clearTimeout = nativeClearTimeout;
globalThis.clearInterval = nativeClearInterval;
try { Object.defineProperty(globalThis.performance, "now", { configurable: true, value: () => 0 }); } catch {}
globalThis.requestAnimationFrame = callback => nativeSetTimeout(() => callback(FIXED_TIME_MS), 0);
globalThis.cancelAnimationFrame = nativeCancelRaf || nativeClearTimeout;

const nativeMatchMedia = globalThis.matchMedia;
globalThis.matchMedia = query => {
  const text = String(query);
  const matches = text.includes("prefers-reduced-motion") ? true : text.includes("prefers-color-scheme: dark") ? config?.theme === "dark" : false;
  const media = nativeMatchMedia ? nativeMatchMedia.call(globalThis, query) : { matches, media: text, addEventListener() {}, removeEventListener() {} };
  try { Object.defineProperty(media, "matches", { configurable: true, value: matches }); } catch {}
  return media;
};

try {
  const state = JSON.parse(localStorage.getItem("ocx-m3:v1") || "{}");
  localStorage.setItem("ocx-m3:v1", JSON.stringify({
    ...state,
    theme: config?.theme || "light",
    locale: config?.locale || "en",
    seed: config?.seed || "#2F6B4F",
    tabs: [{ id: "capture", page: config?.screen || "dashboard", pinned: true }],
    activeTab: "capture",
  }));
} catch {}

const motionStyle = () => {
  const style = document.createElement("style");
  style.setAttribute("data-ocx-deterministic-motion", "true");
  style.textContent = "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important}";
  (document.head || document.documentElement)?.appendChild(style);
};
if (document.head || document.documentElement) motionStyle();
else document.addEventListener("DOMContentLoaded", motionStyle, { once: true });

globalThis.__OCX_DETERMINISM__ = Object.freeze({
  version: 1,
  FIXED_TIME_MS,
  locale: LOCALE,
  timezone: TIMEZONE,
  random: "seeded-xorshift",
  timers: "bounded-native",
  motion: "css-disabled-fixed-raf",
  route: config,
});

// Keep references live for diagnostics and make accidental unused-binding
// removal obvious when this file is maintained.
void nativeNow; void nativeRandom; void nativeRaf; void nativeClearTimeout; void nativeSetInterval;
