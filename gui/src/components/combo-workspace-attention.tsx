import type { TFn } from "../i18n/shared";

/**
 * The sentence that explains one `buildComboAttention` reason.
 *
 * Lives in its own module because both the overview list and the detail panel's
 * banner render it, and a component file cannot export a shared helper without
 * breaking fast refresh.
 */
export function attentionCopy(
  reason: "empty-targets" | "few-targets" | "catalog-omitted",
  t: TFn,
): string {
  if (reason === "empty-targets") return t("cws.attention.empty");
  if (reason === "catalog-omitted") return t("cws.attention.catalogOmitted");
  return t("cws.attention.few");
}
