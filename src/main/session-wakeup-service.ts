import { randomUUID } from "node:crypto";
import type { SessionWakeup, SessionWakeupInput, SessionWakeupStatus } from "../shared/contracts/session-wakeup.ts";
import { sessionWakeupInputSchema } from "../shared/schemas/session-wakeup.ts";
import type { GatewayAccount } from "./selection.ts";

interface WakeupOptions {
  repository: { list: () => SessionWakeup[]; put: (record: SessionWakeup) => void; delete: (id: string) => void };
  listAccounts: () => GatewayAccount[];
  ignoreFiveHourLimit: () => boolean;
  refreshUsage: () => Promise<Array<{ id: string; ok: boolean; kind?: string }>>;
  wake: (record: SessionWakeup, canRun: () => boolean) => Promise<"awakened" | "skipped">;
  changed: () => void;
  log: (message: string) => void;
  now?: () => number;
}

const RETRY_DELAY_MS = 5 * 60_000;
const RESET_GRACE_MS = 60_000;
const terminalStatuses = new Set<SessionWakeupStatus>(["expired", "exhausted", "failed", "skipped"]);

export const nextPoolResetAt = (accounts: GatewayAccount[], ignoreFiveHour: boolean, now: number): number => {
  const resets = accounts.filter((account) => account.enabled && account.status !== "disabled" && account.access_token)
    .flatMap((account) => ignoreFiveHour ? [account.quota_7d_reset_at] : [account.quota_5h_reset_at, account.quota_7d_reset_at])
    .map((value) => Number(value) * 1000).filter((value) => Number.isFinite(value) && value > now);
  return resets.length ? Math.min(...resets) + RESET_GRACE_MS : now + RETRY_DELAY_MS;
};

// 唤醒必须以本次刷新成功且确有余额的账号为依据，不把过期的旧快照当作恢复。
export const hasRefreshedQuota = (accounts: GatewayAccount[], successfulIds: Set<string>, ignoreFiveHour: boolean): boolean =>
  accounts.some((account) => {
    if (!account.enabled || account.status === "disabled" || !account.access_token || !successfulIds.has(account.id)) return false;
    const windows = ignoreFiveHour ? [account.quota_7d_used_percent] : [account.quota_5h_used_percent, account.quota_7d_used_percent];
    return windows.every((used) => used !== null && used !== undefined && Number.isFinite(Number(used)) && Number(used) < 99.9);
  });

export const createSessionWakeupService = (options: WakeupOptions) => {
  const now = options.now || Date.now;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | null = null;
  const list = () => options.repository.list();
  const put = (record: SessionWakeup, patch: Partial<SessionWakeup>): SessionWakeup => {
    const updated = { ...record, ...patch };
    options.repository.put(updated);
    options.changed();
    return updated;
  };
  const current = (record: SessionWakeup) => list().find((item) => item.id === record.id && item.revision === record.revision);
  const eligible = (record: SessionWakeup) => !stopped && record.enabled && now() >= record.startsAt && now() < record.endsAt;
  const nextAttempt = () => nextPoolResetAt(options.listAccounts(), options.ignoreFiveHourLimit(), now());
  const schedule = (record: SessionWakeup, message: string, nextAt = nextAttempt()) => {
    if (record.attempts >= record.maxAttempts) {
      put(record, { status: "exhausted", nextAttemptAt: 0, message: "已达到最大尝试次数，停止自动唤醒。" });
    } else if (nextAt >= record.endsAt) {
      put(record, { status: "waiting", nextAttemptAt: record.endsAt, message: "预计恢复时间超出生效时段，到期后停止等待。" });
    } else {
      put(record, { status: "waiting", nextAttemptAt: nextAt, message });
    }
  };
  const save = (input: SessionWakeupInput): SessionWakeup => {
    const parsed = sessionWakeupInputSchema.parse(input);
    if (parsed.endsAt <= now()) throw new Error("请选择尚未结束的生效时段。");
    const existing = parsed.id ? list().find((item) => item.id === parsed.id) : undefined;
    if (parsed.id && !existing) throw new Error("这条会话唤醒登记已被删除，请刷新后重试。");
    if (list().some((item) => item.id !== parsed.id && item.sessionId === parsed.sessionId)) throw new Error("该会话已经登记，请编辑已有记录。");
    const newWindow = !existing || existing.sessionId !== parsed.sessionId || existing.startsAt !== parsed.startsAt || existing.endsAt !== parsed.endsAt;
    const record: SessionWakeup = {
      ...parsed, id: existing?.id || randomUUID(), revision: randomUUID(),
      status: newWindow ? "armed" : existing.status,
      attempts: newWindow ? 0 : existing.attempts,
      nextAttemptAt: newWindow ? 0 : existing.nextAttemptAt,
      lastAttemptAt: newWindow ? 0 : existing.lastAttemptAt,
      message: newWindow ? "等待网关检测到账号池额度不足。" : existing.message
    };
    if (record.status === "checking") Object.assign(record, { status: "waiting", nextAttemptAt: now() + RETRY_DELAY_MS });
    if (record.status === "waking") Object.assign(record, { status: "failed", nextAttemptAt: 0, message: "配置已修改，请确认之前的唤醒结果。" });
    options.repository.put(record);
    options.changed();
    return record;
  };
  const setEnabled = (id: string, enabled: boolean) => {
    const record = list().find((item) => item.id === id);
    if (record) put(record, {
      enabled, revision: randomUUID(),
      ...(record.status === "checking" ? { status: "waiting", nextAttemptAt: now() + RETRY_DELAY_MS } : {}),
      ...(record.status === "waking" ? { status: "failed", nextAttemptAt: 0, message: "唤醒期间启用状态发生变化，请确认会话结果。" } : {})
    });
  };
  const trigger = (sessionId: string): void => {
    const record = list().find((item) => item.sessionId === sessionId);
    if (!record || !eligible(record) || terminalStatuses.has(record.status)) return;
    if (["waiting", "checking", "waking"].includes(record.status)) return;
    if (record.status === "awakened" && now() - record.lastAttemptAt < RESET_GRACE_MS) return;
    schedule(record, "账号池额度不足，等待重置后刷新额度。");
    options.log(`会话 ${record.name || record.sessionId} 已进入额度等待。`);
  };
  const perform = async (): Promise<void> => {
    for (const record of list()) {
      if (record.enabled && now() >= record.endsAt && !terminalStatuses.has(record.status)) {
        put(record, { status: "expired", nextAttemptAt: 0, message: "生效时段已结束，停止自动唤醒。" });
      }
    }
    const due = list().filter((record) => eligible(record) && record.status === "waiting" && record.nextAttemptAt <= now());
    const checking: SessionWakeup[] = [];
    for (const record of due) {
      if (record.attempts >= record.maxAttempts) { schedule(record, ""); continue; }
      checking.push(put(record, { status: "checking", attempts: record.attempts + 1, lastAttemptAt: now(), nextAttemptAt: 0, message: "正在刷新账号池额度。" }));
    }
    if (!checking.length) return;
    let successfulIds = new Set<string>();
    try {
      const results = await options.refreshUsage();
      successfulIds = new Set(results.filter((result) => result.ok && result.kind !== "balance").map((result) => result.id));
    } catch { /* 本轮刷新失败仍消耗一次尝试，按上限重试。 */ }
    for (const attempt of checking) {
      const record = current(attempt);
      if (!record || !eligible(record)) continue;
      if (!hasRefreshedQuota(options.listAccounts(), successfulIds, options.ignoreFiveHourLimit())) {
        schedule(record, "尚未确认可用额度，等待下一次检查。");
        continue;
      }
      const waking = put(record, { status: "waking", message: "额度已恢复，正在唤醒会话。" });
      const canRun = () => { const latest = current(waking); return Boolean(latest && eligible(latest) && latest.status === "waking"); };
      try {
        const status = await options.wake(waking, canRun);
        if (!canRun()) continue;
        const message = status === "skipped" ? "原 Goal 已完成，未重新激活。" : "已唤醒会话。";
        put(waking, { status, nextAttemptAt: 0, message });
        options.log(`会话 ${waking.name || waking.sessionId}：${message}`);
      } catch (error) {
        if (!canRun()) continue;
        const message = error instanceof Error ? error.message : "唤醒失败。";
        schedule(waking, `唤醒失败：${message}`, now() + RETRY_DELAY_MS);
        options.log(`会话 ${waking.name || waking.sessionId} 唤醒失败：${message}`);
      }
    }
  };
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = perform().finally(() => { inFlight = null; });
    return inFlight;
  };
  const start = (): void => {
    if (timer) return;
    stopped = false;
    for (const record of list()) {
      if (record.status === "checking") schedule(record, "上次额度检查中断，已恢复等待。", now() + RESET_GRACE_MS);
      if (record.status === "waking") put(record, { status: "failed", nextAttemptAt: 0, message: "上次唤醒结果未确认，已停止自动重发，请检查会话。" });
    }
    const run = () => { void tick().catch(() => options.log("会话唤醒检查失败，将在下一轮重试。")); };
    timer = setInterval(run, 5000);
    timer.unref();
    run();
  };
  return {
    list, save, setEnabled, trigger, tick, start,
    delete: (id: string) => { options.repository.delete(id); options.changed(); },
    stop: () => { stopped = true; clearInterval(timer); timer = undefined; }
  };
};
