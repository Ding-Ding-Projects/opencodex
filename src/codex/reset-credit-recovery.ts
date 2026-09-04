import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";

export type CodexResetCreditRecoveryGeneration = Readonly<{
  accountId: string;
  credentialGeneration: number;
  exhaustionGeneration: number;
}>;

export type CodexResetCreditConsumeCode = "reset" | "already_redeemed" | "nothing_to_reset" | "no_credit";

declare const CODEX_RESERVED_OPERATION_ID_BRAND: unique symbol;
export type CodexReservedOperationId = string & { readonly [CODEX_RESERVED_OPERATION_ID_BRAND]: true };

export const CODEX_RESET_CREDIT_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCodexResetCreditOperationId(value: unknown): value is string {
  return typeof value === "string" && CODEX_RESET_CREDIT_OPERATION_ID_PATTERN.test(value);
}

export function compareCodexResetCreditRecoveryGenerationOrder(
  left: CodexResetCreditRecoveryGeneration,
  right: CodexResetCreditRecoveryGeneration,
): -1 | 0 | 1 {
  if (left.accountId === MAIN_CODEX_ACCOUNT_ID && right.accountId !== MAIN_CODEX_ACCOUNT_ID) return 1;
  if (left.accountId !== MAIN_CODEX_ACCOUNT_ID && right.accountId === MAIN_CODEX_ACCOUNT_ID) return -1;
  if (left.credentialGeneration !== right.credentialGeneration) {
    return left.credentialGeneration < right.credentialGeneration ? -1 : 1;
  }
  if (left.exhaustionGeneration !== right.exhaustionGeneration) {
    return left.exhaustionGeneration < right.exhaustionGeneration ? -1 : 1;
  }
  return 0;
}
