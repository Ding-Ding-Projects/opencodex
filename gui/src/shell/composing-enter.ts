/**
 * Was this Enter keydown only confirming an IME composition, not submitting?
 *
 * A Cantonese, Japanese or Korean input method turns typing into a multi-step
 * composition: candidates appear as the user types, and pressing Enter picks
 * one and commits it to the field. The browser reports that keystroke with
 * `key: "Enter"` and `nativeEvent.isComposing: true`, exactly the same `key`
 * value a plain, finished Enter carries. A handler that only checks `key`
 * cannot tell the two apart, so it treats "I just confirmed 銀" the same as
 * "I am done, submit now" and fires on whatever partial text sat in the field
 * at that instant.
 *
 * Guard every Enter-as-submit handler with this before acting on the key, the
 * same shape already proven correct in `AccountPoolStrategyControls.tsx` and
 * `CodexAutoSwitchSetting.tsx`.
 */
export function isComposingEnter(event: { key: string; nativeEvent: { isComposing: boolean } }): boolean {
  return event.key === "Enter" && event.nativeEvent.isComposing;
}
