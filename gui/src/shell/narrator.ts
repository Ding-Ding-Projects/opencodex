/**
 * Speech-synthesis narrator.
 *
 * Off by default and never auto-enables. The queue holds exactly one pending
 * utterance: a new request *supersedes* the pending one rather than stacking
 * behind it, so a burst of status changes reads the latest state instead of
 * narrating a backlog the user has already moved past.
 */

let enabled = false;
let lang = "en";
let pending: string | null = null;
let speaking = false;

export function configureNarrator(next: { enabled: boolean; lang: string }): void {
  enabled = next.enabled;
  lang = next.lang;
  if (!enabled) cancelNarration();
}

export function narratorAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function drain(): void {
  if (!pending || speaking || !narratorAvailable()) return;
  const text = pending;
  pending = null;
  speaking = true;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.onend = utterance.onerror = () => { speaking = false; drain(); };
  window.speechSynthesis.speak(utterance);
}

export function narrate(text: string): void {
  if (!enabled || !text || !narratorAvailable()) return;
  pending = text;
  drain();
}

export function cancelNarration(): void {
  pending = null;
  speaking = false;
  if (narratorAvailable()) window.speechSynthesis.cancel();
}
