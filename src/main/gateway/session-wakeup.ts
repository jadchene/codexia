import { quotaWindowExhausted, usableAccount, type GatewayAccount } from "../selection.ts";

export const notifySessionQuotaExhausted = (
  headers: Record<string, unknown>,
  accounts: GatewayAccount[],
  ignoreFiveHourLimit: boolean,
  notify: ((sessionId: string) => void) | undefined,
  confirmedQuotaFailure = false,
  unavailableIds: string[] = []
): void => {
  if (!notify) return;
  const pool = accounts.filter((account) => account.enabled && account.status !== "disabled" && account.access_token);
  if (!pool.length) return;
  const options = { ignoreFiveHourLimit };
  if (pool.some((account) => !unavailableIds.includes(account.id) && usableAccount(account, undefined, options))) return;
  if (!confirmedQuotaFailure && !pool.some((account) => quotaWindowExhausted(account, undefined, options))) return;
  const value = headers.session_id || headers["session-id"] || headers["x-session-id"];
  const sessionId = String(Array.isArray(value) ? value[0] || "" : value || "").trim();
  if (sessionId) notify(sessionId);
};
