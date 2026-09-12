import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ScheduledTask, ScheduledTaskInput } from "../shared/contracts/scheduled-tasks.ts";
import { scheduledTaskInputSchema } from "../shared/schemas/scheduled-tasks.ts";
import { nextTaskRunAt, validateTaskCron } from "./task-cron.ts";

export interface ScheduledTaskResult {
  sessionId: string;
  status: "sent" | "completed";
  result: string;
}

interface TaskOptions {
  repository: { list: () => ScheduledTask[]; put: (record: ScheduledTask) => void; delete: (id: string) => void };
  execute: (record: ScheduledTask, onSession: (sessionId: string) => void) => Promise<ScheduledTaskResult>;
  changed: () => void;
  log: (message: string) => void;
  now?: () => number;
  validateDirectory?: (directory: string) => void;
}

const validateWorkingDirectory = (directory: string): void => {
  if (!path.isAbsolute(directory)) throw new Error("工作目录需要填写完整路径。");
  try {
    if (fs.statSync(directory).isDirectory()) return;
  } catch { /* 将不存在或不可访问的目录统一转换为可读提示。 */ }
  throw new Error("工作目录不存在或无法访问，请检查路径。");
};

export const createScheduledTaskService = (options: TaskOptions) => {
  const now = options.now || Date.now;
  const list = () => options.repository.list();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const running = new Map<string, Promise<void>>();
  const next = (record: Pick<ScheduledTaskInput, "enabled" | "cron" | "startsAt" | "endsAt">, after = now()) => record.enabled
    ? nextTaskRunAt(record.cron, record.startsAt, record.endsAt, after) : 0;
  const put = (record: ScheduledTask, patch: Partial<ScheduledTask>): ScheduledTask => {
    const updated = { ...record, ...patch };
    options.repository.put(updated);
    options.changed();
    return updated;
  };
  const current = (record: ScheduledTask) => list().find((item) => item.id === record.id);
  const save = (input: ScheduledTaskInput): ScheduledTask => {
    const parsed = scheduledTaskInputSchema.parse(input);
    validateTaskCron(parsed.cron);
    if (parsed.endsAt <= now()) throw new Error("请选择尚未结束的生效时段。");
    if (parsed.target === "new") (options.validateDirectory || validateWorkingDirectory)(parsed.workingDirectory);
    const existing = parsed.id ? list().find((item) => item.id === parsed.id) : undefined;
    if (parsed.id && !existing) throw new Error("这条定时任务已被删除，请刷新后重试。");
    const nextRunAt = next(parsed);
    const record: ScheduledTask = {
      ...parsed, sessionId: parsed.target === "existing" ? parsed.sessionId : "",
      workingDirectory: parsed.target === "new" ? parsed.workingDirectory : "",
      id: existing?.id || randomUUID(), revision: randomUUID(), nextRunAt,
      status: existing && running.has(existing.id) ? "running" : nextRunAt ? "scheduled" : "idle", runCount: existing?.runCount || 0,
      lastRunAt: existing?.lastRunAt || 0, lastSessionId: existing?.lastSessionId || "",
      result: existing?.result || ""
    };
    options.repository.put(record);
    options.changed();
    return record;
  };
  const setEnabled = (id: string, enabled: boolean): void => {
    const record = list().find((item) => item.id === id);
    if (!record) return;
    const nextRunAt = next({ ...record, enabled });
    put(record, { enabled, nextRunAt, status: running.has(id) ? "running" : now() >= record.endsAt ? "expired" : nextRunAt ? "scheduled" : "idle" });
  };
  const perform = async (record: ScheduledTask): Promise<void> => {
    try {
      const result = await options.execute(record, (sessionId) => {
        const latest = current(record);
        if (latest) put(latest, { lastSessionId: sessionId });
      });
      const latest = current(record);
      if (latest && !stopped) {
        put(latest, { status: result.status, result: result.result, lastSessionId: result.sessionId, nextRunAt: next(latest) });
        options.log(`定时任务 ${latest.name}：${result.status === "sent" ? "消息已发送" : "执行完成"}。`);
      }
    } catch (error) {
      const latest = current(record);
      if (latest && !stopped) {
        const result = error instanceof Error ? error.message : "执行失败，请检查 Codex 运行状态。";
        put(latest, { status: "failed", result, nextRunAt: next(latest) });
        options.log(`定时任务 ${latest.name}：${result}`);
      }
    }
  };
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    const launched: Promise<void>[] = [];
    for (const record of list()) {
      if (running.has(record.id) || !record.enabled) continue;
      if (now() >= record.endsAt) {
        if (record.status !== "expired") put(record, { status: "expired", nextRunAt: 0 });
        continue;
      }
      if (now() < record.startsAt || !record.nextRunAt || record.nextRunAt > now()) continue;
      // 睡眠恢复、事件循环长时间阻塞或并发繁忙时跳过过期时间点，不集中补发。
      if (now() - record.nextRunAt >= 60_000) {
        put(record, { nextRunAt: next(record) });
        continue;
      }
      if (running.size >= 4) continue;
      const claimed = put(record, {
        status: "running", runCount: record.runCount + 1, lastRunAt: now(), nextRunAt: next(record),
        lastSessionId: record.target === "existing" ? record.sessionId : "", result: "正在执行。"
      });
      const operation = perform(claimed).finally(() => { running.delete(record.id); });
      running.set(record.id, operation);
      launched.push(operation);
    }
    return Promise.all(launched).then(() => {});
  };
  const start = (): void => {
    if (timer) return;
    stopped = false;
    for (const record of list()) {
      const nextRunAt = next(record);
      put(record, {
        nextRunAt, status: now() >= record.endsAt ? "expired" : record.status === "running" ? "interrupted" : record.status,
        ...(record.status === "running" ? { result: "应用退出时上次执行尚未结束，请查看对应会话；本次不补发。" } : {})
      });
    }
    timer = setInterval(() => {
      void tick().catch(() => options.log("定时任务检查失败，请检查数据目录。"));
    }, 1000);
    timer.unref();
  };
  return {
    list, save, setEnabled, tick, start,
    delete: (id: string) => { options.repository.delete(id); options.changed(); },
    stop: () => { stopped = true; clearInterval(timer); timer = undefined; }
  };
};
