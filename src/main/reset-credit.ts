import { guardedFetch } from "./upstream-ip-guard.ts";
import { randomUUID } from "node:crypto";
import type { ResetCreditConsumeStatus } from "../shared/contracts/accounts";

export interface ResetCreditLike {
  id?: string;
  status?: string;
  expires_at?: number | null;
}

export interface ResetCreditAccountLike {
  access_token?: string;
  account_id?: string;
  workspace_id?: string;
}

const CONSUME_RESULT_STATUSES = new Set<ResetCreditConsumeStatus>([
  "reset",
  "already_redeemed",
  "nothing_to_reset",
  "no_credit"
]);

/** 解析账号里已保存的归一化重置卡列表。 */
export function parseStoredResetCredits(value: unknown): ResetCreditLike[] {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return Array.isArray(parsed?.credits) ? parsed.credits : [];
  } catch {
    return [];
  }
}

/** 从可用重置卡中选一张，优先使用最早过期的；无过期时间的排在最后。 */
export function pickAvailableResetCredit(credits: ResetCreditLike[] | null | undefined): ResetCreditLike | null {
  const available = (Array.isArray(credits) ? credits : [])
    .filter((item) => String(item?.status || "").toLowerCase() === "available");
  if (available.length === 0) return null;
  return [...available].sort((left, right) => {
    const leftExpiry = Number(left?.expires_at || 0);
    const rightExpiry = Number(right?.expires_at || 0);
    if (leftExpiry && rightExpiry) return leftExpiry - rightExpiry;
    if (leftExpiry) return -1;
    if (rightExpiry) return 1;
    return 0;
  })[0] ?? null;
}

/** 按用户选择的 credit id 查找重置卡。 */
export function pickResetCreditById(credits: ResetCreditLike[] | null | undefined, creditId: string | undefined | null): ResetCreditLike | null {
  const target = String(creditId || "").trim();
  if (!target) return null;
  return (Array.isArray(credits) ? credits : []).find((item) => String(item?.id || "").trim() === target) ?? null;
}

/** 每次重置操作生成新的 UUID v4；同一次重试复用同一个 redeem_request_id。 */
export function buildConsumeRequestBody(credit: ResetCreditLike | null): { redeem_request_id: string; credit_id?: string } {
  const body: { redeem_request_id: string; credit_id?: string } = { redeem_request_id: randomUUID() };
  const creditId = String(credit?.id || "").trim();
  if (creditId) body.credit_id = creditId;
  return body;
}

export async function requestResetCreditConsume(options: {
  fetchImpl?: typeof fetch;
  endpoint: string;
  account: ResetCreditAccountLike;
  body: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<unknown> {
  const { endpoint, account, body } = options;
  const fetchImpl = options.fetchImpl || guardedFetch;
  const timeoutMs = Math.max(1000, Math.trunc(options.timeoutMs || 20_000));
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.access_token || ""}`,
      "ChatGPT-Account-Id": account.account_id || account.workspace_id || "",
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "codex_cli_rs/0.136.0",
      origin: "https://chatgpt.com",
      referer: "https://chatgpt.com/"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  if (!response.ok) {
    const error: Error & { status?: number } = new Error(`${response.status} ${text.slice(0, 240)}`);
    error.status = response.status;
    throw error;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function normalizeConsumeResult(payload: unknown): { status: ResetCreditConsumeStatus; message: string } {
  const source = isRecord(payload) ? payload : {};
  const nested = isRecord(source.data) ? source.data : {};
  const raw = String(source.code ?? source.result ?? source.status ?? nested.code ?? nested.result ?? nested.status ?? "")
    .toLowerCase().trim();
  if (CONSUME_RESULT_STATUSES.has(raw as ResetCreditConsumeStatus)) {
    const status = raw as ResetCreditConsumeStatus;
    return { status, message: consumeStatusMessage(status) };
  }
  const detail = JSON.stringify(payload || {}).slice(0, 200);
  return { status: "error", message: `无法识别的重置结果：${detail || "空响应"}` };
}

export function consumeStatusMessage(status: ResetCreditConsumeStatus): string {
  switch (status) {
    case "reset":
      return "重置成功";
    case "already_redeemed":
      return "该重置请求已执行过，按成功处理";
    case "nothing_to_reset":
      return "当前额度无需重置";
    case "no_credit":
      return "没有可用重置卡";
    default:
      return "重置失败";
  }
}

export function isConsumeSuccess(status: ResetCreditConsumeStatus): boolean {
  return status === "reset" || status === "already_redeemed";
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
