/**
 * Background-helper picker options.
 *
 * This picker is backed by a native `<select>`, whose `<option>` labels must be
 * plain strings. Keeping the slug as the label avoids the old `[object Object]`
 * rendering when a React node is coerced into option text.
 */
export function backgroundHelperOptions(
  available: readonly string[] | undefined,
  unsetLabel: string,
): { value: string; label: string }[] {
  const options = (available ?? []).map(m => ({ value: m, label: m }));
  return [{ value: "", label: unsetLabel }, ...options];
}
