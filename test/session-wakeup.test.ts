import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSessionWakeupService, hasRefreshedQuota, nextPoolResetAt } from "../src/main/session-wakeup-service.ts";
import { wakeCodexSession } from "../src/main/codex-session-control.ts";
import { notifySessionQuotaExhausted } from "../src/main/gateway/session-wakeup.ts";

const harness = (maxAttempts = 3) => {
  let time = Date.UTC(2030, 0, 1);
  const records = new Map();
  const accounts = [{ id: "a", enabled: true, access_token: "token", quota_5h_used_percent: 100, quota_7d_used_percent: 20, quota_5h_reset_at: time / 1000 + 1800 }];
  const refresh = vi.fn(async () => [{ id: "a", ok: true }]);
  const wake = vi.fn(async () => "awakened" as const);
  const options = {
    repository: { list: () => [...records.values()].map((item) => structuredClone(item)), put: (item) => records.set(item.id, structuredClone(item)), delete: (id) => records.delete(id) },
    listAccounts: () => accounts, ignoreFiveHourLimit: () => false, refreshUsage: refresh, wake,
    changed: vi.fn(), log: vi.fn(), now: () => time
  };
  const service = createSessionWakeupService(options);
  const record = service.save({ sessionId: randomUUID(), name: "夜间任务", enabled: true, resumeGoal: false, startsAt: time, endsAt: time + 8 * 3600_000, maxAttempts });
  return { service, options, accounts, record, refresh, wake, now: () => time, at: (value: number) => { time = value; }, latest: () => service.list().find((item) => item.id === record.id)! };
};

describe("会话唤醒调度", () => {
  it("重复额度失败仅排一个任务，到点刷新后才唤醒，成功不清空次数", async () => {
    const h = harness();
    h.service.trigger(h.record.sessionId);
    const scheduled = h.latest().nextAttemptAt;
    expect(scheduled).toBe(h.now() + 1860_000);
    h.service.trigger(h.record.sessionId);
    expect(h.latest().nextAttemptAt).toBe(scheduled);
    await h.service.tick();
    expect(h.refresh).not.toHaveBeenCalled();
    h.accounts[0]!.quota_5h_used_percent = 10;
    h.at(scheduled);
    await Promise.all([h.service.tick(), h.service.tick()]);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.wake).toHaveBeenCalledTimes(1);
    expect(h.latest()).toMatchObject({ status: "awakened", attempts: 1 });
    h.service.trigger(h.record.sessionId);
    expect(h.latest().status).toBe("awakened");
    h.at(h.now() + 61_000);
    h.service.trigger(h.record.sessionId);
    expect(h.latest()).toMatchObject({ status: "waiting", attempts: 1 });
  });

  it("额度持续不足时达到上限后不再刷新或发消息", async () => {
    const h = harness(2);
    h.service.trigger(h.record.sessionId);
    for (let index = 0; index < 2; index++) {
      h.at(h.latest().nextAttemptAt);
      await h.service.tick();
    }
    expect(h.latest()).toMatchObject({ status: "exhausted", attempts: 2, nextAttemptAt: 0 });
    h.service.trigger(h.record.sessionId);
    await h.service.tick();
    expect(h.refresh).toHaveBeenCalledTimes(2);
    expect(h.wake).not.toHaveBeenCalled();
  });

  it("刷新失败也计次，旧的剩余额度不能触发唤醒", async () => {
    const h = harness(1);
    h.service.trigger(h.record.sessionId);
    h.accounts[0]!.quota_5h_used_percent = 0;
    h.refresh.mockRejectedValue(new Error("网络错误"));
    h.at(h.latest().nextAttemptAt);
    await h.service.tick();
    expect(h.latest().status).toBe("exhausted");
    expect(h.wake).not.toHaveBeenCalled();
  });

  it("唤醒明确失败后按上限重试，次数与额度检查共用", async () => {
    const h = harness(2);
    h.service.trigger(h.record.sessionId);
    h.accounts[0]!.quota_5h_used_percent = 0;
    h.wake.mockRejectedValue(new Error("未找到 Codex"));
    h.at(h.latest().nextAttemptAt);
    await h.service.tick();
    expect(h.latest()).toMatchObject({ status: "waiting", attempts: 1 });
    h.at(h.latest().nextAttemptAt);
    await h.service.tick();
    expect(h.latest().status).toBe("exhausted");
    expect(h.wake).toHaveBeenCalledTimes(2);
  });

  it("未生效、停用、未登记的会话不触发，结束边界也不唤醒", async () => {
    const h = harness();
    h.at(h.record.startsAt - 1);
    h.service.trigger(h.record.sessionId);
    expect(h.latest().status).toBe("armed");
    h.at(h.record.startsAt);
    h.service.setEnabled(h.record.id, false);
    h.service.trigger(h.record.sessionId);
    h.service.trigger(randomUUID());
    expect(h.latest().status).toBe("armed");
    h.service.setEnabled(h.record.id, true);
    h.service.trigger(h.record.sessionId);
    h.at(h.record.endsAt);
    await h.service.tick();
    expect(h.latest().status).toBe("expired");
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it.each(["disable", "delete", "expire", "edit", "stop"])("刷新期间发生 %s 时不再唤醒", async (action) => {
    const h = harness();
    let resolve;
    h.refresh.mockImplementation(() => new Promise((done) => { resolve = done; }));
    h.service.trigger(h.record.sessionId);
    h.at(h.latest().nextAttemptAt);
    const run = h.service.tick();
    h.accounts[0]!.quota_5h_used_percent = 0;
    if (action === "disable") h.service.setEnabled(h.record.id, false);
    if (action === "delete") h.service.delete(h.record.id);
    if (action === "expire") h.at(h.record.endsAt);
    if (action === "edit") h.service.save({ id: h.record.id, sessionId: h.record.sessionId, name: "修改", startsAt: h.record.startsAt, endsAt: h.record.endsAt, maxAttempts: 3, enabled: true, resumeGoal: false });
    if (action === "stop") h.service.stop();
    resolve([{ id: "a", ok: true }]);
    await run;
    expect(h.wake).not.toHaveBeenCalled();
  });

  it("多个到期会话共用一次刷新，分别计数和唤醒", async () => {
    const h = harness();
    const second = h.service.save({ sessionId: randomUUID(), name: "另一个任务", startsAt: h.record.startsAt, endsAt: h.record.endsAt, maxAttempts: 2, enabled: true, resumeGoal: true });
    h.service.trigger(h.record.sessionId);
    h.service.trigger(second.sessionId);
    h.at(h.latest().nextAttemptAt);
    h.accounts[0]!.quota_5h_used_percent = 0;
    await h.service.tick();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.wake).toHaveBeenCalledTimes(2);
  });

  it("重启恢复等待任务，未确认的唤醒不会自动重复投递", async () => {
    const h = harness();
    h.service.trigger(h.record.sessionId);
    h.service.stop();
    const restored = createSessionWakeupService(h.options);
    expect(restored.list()[0]!.nextAttemptAt).toBe(h.latest().nextAttemptAt);
    h.options.repository.put({ ...h.latest(), status: "waking" });
    restored.start();
    expect(restored.list()[0]!.status).toBe("failed");
    restored.stop();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it("忽略 5 小时后只按周额度判断，过期的耗尽快照不当成恢复", () => {
    const h = harness();
    expect(hasRefreshedQuota(h.accounts, new Set(["a"]), false)).toBe(false);
    expect(hasRefreshedQuota(h.accounts, new Set(["a"]), true)).toBe(true);
    expect(nextPoolResetAt(h.accounts, true, h.now())).toBe(h.now() + 300_000);
    h.accounts[0]!.quota_5h_reset_at = h.now() / 1000 - 10;
    expect(hasRefreshedQuota(h.accounts, new Set(["a"]), false)).toBe(false);
    expect(hasRefreshedQuota(h.accounts, new Set(), true)).toBe(false);
  });
});

describe("Codex 唤醒控制", () => {
  it.each(["blocked", "paused", "usageLimited", "budgetLimited", "active"])("恢复 %s Goal 不加载会话、不发送消息", async (status) => {
    const h = harness();
    const request = vi.fn(async (method) => method === "thread/goal/get" ? { goal: { status } } : {});
    const close = vi.fn();
    const queue = vi.fn();
    const result = await wakeCodexSession({ ...h.record, resumeGoal: true }, () => true, {
      codexHome: "test-home", executable: "test-codex", connect: () => ({ request, initialize: async () => {}, close }), queue
    });
    expect(result).toBe("awakened");
    expect(request.mock.calls.map((call) => call[0])).toEqual(["thread/goal/get", "thread/goal/set"]);
    expect(request).toHaveBeenLastCalledWith("thread/goal/set", { threadId: h.record.sessionId, status: "active" });
    expect(queue).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it.each([false, true])("恢复开关为 %s 且没有 Goal 时发送普通消息", async (resumeGoal) => {
    const h = harness();
    const connect = vi.fn(() => ({ request: async () => ({ goal: null }), initialize: async () => {}, close: vi.fn() }));
    const queue = vi.fn(async () => {});
    await wakeCodexSession({ ...h.record, resumeGoal }, () => true, { codexHome: "test-home", executable: "test-codex", connect, queue });
    expect(queue).toHaveBeenCalledOnce();
    expect(queue.mock.calls[0]![1].slice(0, 3)).toEqual(["queue", "--thread", h.record.sessionId]);
    if (!resumeGoal) expect(connect).not.toHaveBeenCalled();
  });
  it("已完成 Goal 不恢复，控制请求之间过期也不恢复", async () => {
    const h = harness();
    const request = vi.fn(async () => ({ goal: { status: "complete" } }));
    const queue = vi.fn();
    const options = { codexHome: "test-home", executable: "test-codex", connect: () => ({ request, initialize: async () => {}, close: vi.fn() }), queue };
    expect(await wakeCodexSession({ ...h.record, resumeGoal: true }, () => true, options)).toBe("skipped");
    expect(request).toHaveBeenCalledOnce();
    expect(queue).not.toHaveBeenCalled();
    let allowed = true;
    request.mockImplementation(async () => { allowed = false; return { goal: { status: "blocked" } }; });
    await expect(wakeCodexSession({ ...h.record, resumeGoal: true }, () => allowed, options)).rejects.toThrow("到期");
    expect(request.mock.calls.every((call) => call[0] === "thread/goal/get")).toBe(true);
  });
});

it("额度耗尽触发排除普通网络故障、停用账号和仍可接管的账号", () => {
  const h = harness();
  const notify = vi.fn();
  const headers = { session_id: h.record.sessionId };
  notifySessionQuotaExhausted(headers, h.accounts, false, notify);
  expect(notify).toHaveBeenCalledWith(h.record.sessionId);
  notify.mockClear();
  notifySessionQuotaExhausted(headers, h.accounts, true, notify);
  notifySessionQuotaExhausted(headers, [], false, notify, true);
  notifySessionQuotaExhausted(headers, [{ ...h.accounts[0], enabled: false }], false, notify, true);
  notifySessionQuotaExhausted(headers, [...h.accounts, { id: "b", enabled: true, access_token: "token", quota_5h_used_percent: 0 }], false, notify, true, ["a"]);
  expect(notify).not.toHaveBeenCalled();
});
