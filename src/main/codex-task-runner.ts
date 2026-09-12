import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ScheduledTask } from "../shared/contracts/scheduled-tasks.ts";
import type { ScheduledTaskResult } from "./scheduled-task-service.ts";
import { resolveCodexExecutable } from "./codex-session-control.ts";

interface RunnerOptions {
  codexHome: () => string;
  executable?: () => string;
  spawnProcess?: (executable: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcessWithoutNullStreams;
}

export const createCodexTaskRunner = (options: RunnerOptions) => {
  const children = new Set<ChildProcessWithoutNullStreams>();
  let stopped = false;
  const execute = (record: ScheduledTask, onSession: (sessionId: string) => void): Promise<ScheduledTaskResult> => {
    if (stopped) return Promise.reject(new Error("定时任务服务已停止。"));
    const executable = (options.executable || resolveCodexExecutable)();
    const existing = record.target === "existing";
    const args = existing
      ? ["queue", "--thread", record.sessionId, "--message", record.message]
      : ["exec", "--json", "--color", "never", "--skip-git-repo-check", "--cd", record.workingDirectory, "--approve-for-me", "-"];
    const child = (options.spawnProcess || spawn)(executable, args, {
      ...(existing ? {} : { cwd: record.workingDirectory }),
      env: { ...process.env, CODEX_HOME: options.codexHome() },
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"], shell: false
    }) as ChildProcessWithoutNullStreams;
    children.add(child);
    return new Promise((resolve, reject) => {
      let sessionId = existing ? record.sessionId : "";
      let output = "";
      let failed = false;
      let completed = false;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const lines = createInterface({ input: child.stdout });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        lines.close();
        children.delete(child);
        if (error) reject(error);
        else resolve({ sessionId, status: existing ? "sent" : "completed", result: existing ? "普通消息已发送。" : output || "新会话执行完成。" });
      };
      child.once("error", () => finish(new Error("无法启动 Codex CLI，请检查安装和运行权限。")));
      child.stdin.on("error", () => {
        failed = true;
        if (child.exitCode === null && child.signalCode === null) child.kill();
      });
      child.stderr.resume();
      lines.on("line", (line) => {
        if (existing || settled) return;
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started" && typeof event.thread_id === "string") {
            sessionId = event.thread_id;
            onSession(sessionId);
          }
          if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") output = event.item.text.slice(0, 4000);
          if (event.type === "turn.failed") failed = true;
          if (event.type === "turn.completed") completed = true;
        } catch { /* 忽略非协议行，避免运行日志影响消息执行。 */ }
      });
      child.once("close", (code) => {
        if (code !== 0 || failed) finish(new Error(existing ? "发送消息失败，请检查会话和 Codex 运行状态。" : "新会话未完成，请查看对应会话的执行结果。"));
        else if (!existing && (!sessionId || !completed)) finish(new Error("Codex 未返回完整的会话执行结果，请检查 CLI 版本和运行状态。"));
        else finish();
      });
      if (existing) {
        timeout = setTimeout(() => {
          child.kill();
          finish(new Error("消息发送超时，本时间点不再自动重发，请确认会话是否已收到。"));
        }, 20_000);
        child.stdin.end();
      } else {
        // 提示词通过标准输入传递，保留换行且不作为命令执行。
        child.stdin.end(record.message, "utf8");
      }
    });
  };
  const stop = async (): Promise<void> => {
    stopped = true;
    await Promise.all([...children].map((child) => new Promise<void>((resolve) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
      if (process.platform === "win32") {
        execFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 5000 }, () => resolve());
      } else {
        child.kill();
        resolve();
      }
    })));
  };
  return { execute, stop };
};
