import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createScheduledTaskService } from "../src/main/scheduled-task-service.ts";
import { createCodexTaskRunner } from "../src/main/codex-task-runner.ts";
import { nextTaskRunAt, validateTaskCron } from "../src/main/task-cron.ts";
import { scheduledTaskInputSchema } from "../src/shared/schemas/scheduled-tasks.ts";

const harness = (patch = {}) => {
  let clock = Date.UTC(2030, 0, 1, 0, 0, 10);
  const records = new Map();
  const input = {
    name: "夜间定时任务", target: "existing" as const, sessionId: randomUUID(), workingDirectory: "",
    message: "继续处理任务\n并报告结果。", cron: "* * * * *", startsAt: clock, endsAt: clock + 86400_000, enabled: true, ...patch
  };
  const execute = vi.fn(async (record, onSession) => {
    const sessionId = record.target === "new" ? randomUUID() : record.sessionId;
    onSession(sessionId);
    return { sessionId, status: record.target === "new" ? "completed" : "sent", result: "完成" };
  });
  const options = {
    repository: { list: () => [...records.values()].map((value) => structuredClone(value)), put: (value) => records.set(value.id, structuredClone(value)), delete: (id) => records.delete(id) },
    execute, changed: vi.fn(), log: vi.fn(), now: () => clock, validateDirectory: vi.fn()
  };
  const service = createScheduledTaskService(options);
  const record = service.save(input);
  return { service, options, input, record, execute, at: (value: number) => { clock = value; }, now: () => clock, latest: () => service.list().find((item) => item.id === record.id)! };
};

describe("Cron 时间计算", () => {
  it("支持步长、每周和跨月，按本地时区且不包含结束边界", () => {
    const starts = Date.parse("2030-01-01T00:00:00+08:00");
    const ends = Date.parse("2030-02-02T00:00:00+08:00");
    expect(nextTaskRunAt("*/15 * * * *", starts, ends, starts - 1, "Asia/Shanghai")).toBe(starts);
    expect(nextTaskRunAt("*/15 * * * *", starts, ends, starts, "Asia/Shanghai")).toBe(starts + 900_000);
    expect(nextTaskRunAt("0 22 * * *", starts, ends, starts, "Asia/Shanghai")).toBe(Date.parse("2030-01-01T22:00:00+08:00"));
    expect(nextTaskRunAt("0 9 * * MON", starts, ends, starts, "Asia/Shanghai")).toBe(Date.parse("2030-01-07T09:00:00+08:00"));
    expect(nextTaskRunAt("0 0 1 * *", starts, ends, starts, "Asia/Shanghai")).toBe(Date.parse("2030-02-01T00:00:00+08:00"));
    expect(nextTaskRunAt("0 22 * * *", starts, starts + 3600_000, starts, "Asia/Shanghai")).toBe(0);
    expect(nextTaskRunAt("* * * * *", starts, starts + 60_000, starts, "Asia/Shanghai")).toBe(0);
  });
  it("拒绝错误 Cron 和非五段表达式", () => {
    expect(() => validateTaskCron("0 * * * *")).not.toThrow();
    expect(() => validateTaskCron("0 0 * * * *")).toThrow("五段");
    expect(() => validateTaskCron("90 * * * *")).toThrow("无效");
    expect(() => validateTaskCron("@hourly")).toThrow("五段");
  });
});

describe("持久化定时任务", () => {
  it("每个 Cron 时间点仅发一次普通消息并保留原文", async () => {
    const h = harness();
    await h.service.tick();
    expect(h.execute).not.toHaveBeenCalled();
    h.at(h.latest().nextRunAt);
    await Promise.all([h.service.tick(), h.service.tick()]);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0]![0].message).toBe(h.input.message);
    expect(h.latest()).toMatchObject({ status: "sent", runCount: 1, lastSessionId: h.input.sessionId });
    h.at(h.latest().nextRunAt);
    await h.service.tick();
    expect(h.execute).toHaveBeenCalledTimes(2);
  });
  it("每次新建不同会话，工作目录和历史会话 ID 不污染下一次配置", async () => {
    const h = harness({ target: "new", sessionId: "", workingDirectory: process.cwd() });
    h.at(h.latest().nextRunAt);
    await h.service.tick();
    const first = h.latest().lastSessionId;
    expect(h.latest().sessionId).toBe("");
    h.at(h.latest().nextRunAt);
    await h.service.tick();
    expect(h.latest().lastSessionId).not.toBe(first);
    expect(h.latest()).toMatchObject({ target: "new", workingDirectory: process.cwd(), status: "completed" });
  });
  it("编辑立即重算 Cron，停用后不执行，重新启用从未来时间点恢复", async () => {
    const h = harness();
    const oldDue = h.latest().nextRunAt;
    h.service.save({ ...h.input, id: h.record.id, cron: "*/10 * * * *" });
    expect(h.latest().nextRunAt).toBeGreaterThan(oldDue);
    h.at(oldDue);
    await h.service.tick();
    expect(h.execute).not.toHaveBeenCalled();
    h.service.setEnabled(h.record.id, false);
    h.at(h.now() + 3600_000);
    await h.service.tick();
    expect(h.execute).not.toHaveBeenCalled();
    h.service.setEnabled(h.record.id, true);
    expect(h.latest().nextRunAt).toBeGreaterThan(h.now());
  });
  it("生效前、结束边界和删除后均不发送", async () => {
    const startsAt = Date.UTC(2030, 0, 1, 1);
    const h = harness({ startsAt, endsAt: startsAt + 60_000 });
    expect(h.latest().nextRunAt).toBe(startsAt);
    await h.service.tick();
    expect(h.execute).not.toHaveBeenCalled();
    h.at(startsAt + 60_000);
    await h.service.tick();
    expect(h.latest().status).toBe("expired");
    expect(h.execute).not.toHaveBeenCalled();
    h.service.delete(h.record.id);
    expect(h.service.list()).toEqual([]);
  });
  it("长任务不重叠，期间停用不撤销已启动的执行", async () => {
    const h = harness();
    let finish;
    h.execute.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    h.at(h.latest().nextRunAt);
    const pending = h.service.tick();
    h.at(h.now() + 180_000);
    await h.service.tick();
    expect(h.execute).toHaveBeenCalledOnce();
    h.service.setEnabled(h.record.id, false);
    finish({ sessionId: h.input.sessionId, status: "sent", result: "完成" });
    await pending;
    expect(h.latest()).toMatchObject({ enabled: false, nextRunAt: 0, status: "sent" });
  });
  it("执行期间修改任务时保留新配置，下一轮使用新消息", async () => {
    const h = harness();
    let finish;
    h.execute.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    h.at(h.latest().nextRunAt);
    const pending = h.service.tick();
    h.service.save({ ...h.input, id: h.record.id, message: "新消息", cron: "*/10 * * * *" });
    finish({ sessionId: h.input.sessionId, status: "sent", result: "旧任务完成" });
    await pending;
    expect(h.latest()).toMatchObject({ message: "新消息", cron: "*/10 * * * *" });
    h.at(h.latest().nextRunAt);
    await h.service.tick();
    expect(h.execute.mock.calls[1]![0].message).toBe("新消息");
  });
  it("失败不在同一个时间点重发，下一次 Cron 正常执行", async () => {
    const h = harness();
    h.execute.mockRejectedValueOnce(new Error("发送失败"));
    h.at(h.latest().nextRunAt);
    await h.service.tick();
    await h.service.tick();
    expect(h.latest()).toMatchObject({ status: "failed", runCount: 1 });
    expect(h.execute).toHaveBeenCalledOnce();
    h.at(h.latest().nextRunAt);
    await h.service.tick();
    expect(h.latest().status).toBe("sent");
  });
  it("电脑睡眠或重启后不补发错过的消息，未确认的上次运行也不重发", async () => {
    const h = harness();
    h.at(h.latest().nextRunAt + 120_000);
    await h.service.tick();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.latest().nextRunAt).toBeGreaterThan(h.now());
    h.options.repository.put({ ...h.latest(), status: "running", lastRunAt: h.now(), runCount: 1 });
    const restored = createScheduledTaskService(h.options);
    restored.start();
    expect(h.latest()).toMatchObject({ status: "interrupted", runCount: 1 });
    expect(h.latest().nextRunAt).toBeGreaterThan(h.now());
    restored.stop();
  });
  it("时钟驱动自动触发，停止服务后不再触发", async () => {
    vi.useFakeTimers();
    const h = harness();
    try {
      h.service.start();
      h.at(h.latest().nextRunAt);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.execute).toHaveBeenCalledOnce();
      h.service.stop();
      h.at(h.latest().nextRunAt);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.execute).toHaveBeenCalledOnce();
    } finally { h.service.stop(); vi.useRealTimers(); }
  });
  it("校验消息、已有会话 ID、新会话工作目录和时间范围", () => {
    const h = harness();
    expect(scheduledTaskInputSchema.safeParse({ ...h.input, message: " " }).success).toBe(false);
    expect(scheduledTaskInputSchema.safeParse({ ...h.input, sessionId: "bad" }).success).toBe(false);
    expect(scheduledTaskInputSchema.safeParse({ ...h.input, target: "new", sessionId: "" }).success).toBe(false);
    expect(() => h.service.save({ ...h.input, endsAt: h.now() })).toThrow();
    expect(() => h.service.save({ ...h.input, cron: "bad" })).toThrow("五段");
  });
});

describe("Codex 定时执行进程", () => {
  it.each(["existing", "new"])("%s 模式通过真实子进程传递普通消息并记录结果", async (target) => {
    const h = harness({ target, workingDirectory: target === "new" ? process.cwd() : "" });
    const captured = [];
    const script = `
      const args = JSON.parse(process.argv[1]);
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      if (args[0] === 'exec') {
        console.log(JSON.stringify({type:'thread.started',thread_id:'new-session-id'}));
        console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({args,input,home:process.env.CODEX_HOME})}}));
        console.log(JSON.stringify({type:'turn.completed'}));
      }
    `;
    const runner = createCodexTaskRunner({
      executable: () => "test-codex", codexHome: () => "test-codex-home",
      spawnProcess: (_command, args, options) => {
        captured.push({ args, options });
        return spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(args)], options);
      }
    });
    const session = vi.fn();
    try {
      const result = await runner.execute(h.record, session);
      expect(captured[0].options.shell).toBe(false);
      expect(captured[0].options.windowsHide).toBe(true);
      if (target === "existing") {
        expect(captured[0].args).toEqual(["queue", "--thread", h.input.sessionId, "--message", h.input.message]);
        expect(result.status).toBe("sent");
      } else {
        const output = JSON.parse(result.result);
        expect(output.input).toBe(h.input.message);
        expect(output.home).toBe("test-codex-home");
        expect(output.args).toContain("--approve-for-me");
        expect(result).toMatchObject({ sessionId: "new-session-id", status: "completed" });
        expect(session).toHaveBeenCalledWith("new-session-id");
      }
    } finally { await runner.stop(); }
  });
  it("进程失败和缺失执行完成事件不冒充成功", async () => {
    const h = harness({ target: "new", workingDirectory: process.cwd(), sessionId: "" });
    for (const script of ["process.exit(1)", "process.exit(0)"]) {
      const runner = createCodexTaskRunner({ executable: () => "test", codexHome: () => "test", spawnProcess: (_cmd, _args, options) => spawn(process.execPath, ["-e", script], options) });
      try { await expect(runner.execute(h.record, vi.fn())).rejects.toThrow(); }
      finally { await runner.stop(); }
    }
  });
});
