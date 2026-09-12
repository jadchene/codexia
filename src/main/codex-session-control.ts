import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { SessionWakeup } from "../shared/contracts/session-wakeup.ts";

export const resolveCodexExecutable = (): string => {
  if (process.platform !== "win32") return "codex";
  const matches = execFileSync("where.exe", ["codex"], { encoding: "utf8", windowsHide: true, timeout: 5000 })
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const executable = matches.find((value) => value.endsWith(".exe"));
  if (executable) return executable;
  const shim = matches.find((value) => value.endsWith(".cmd"));
  if (!shim) throw new Error("未找到 Codex CLI，请先安装并确认 codex 命令可用。");
  const relative = [...fs.readFileSync(shim, "utf8").matchAll(/"%dp0%\\([^"\r\n]+\.js)"/gi)].at(-1)?.[1];
  if (!relative) throw new Error("无法识别 Codex CLI 的安装位置，请重新安装 Codex CLI。");
  const entry = path.resolve(path.dirname(shim), relative.replace(/\\/g, path.sep));
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const target = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  let vendor = path.resolve(path.dirname(entry), "..", "vendor");
  try {
    vendor = path.join(path.dirname(createRequire(entry).resolve(`@openai/codex-win32-${arch}/package.json`)), "vendor");
  } catch { /* 兼容将原生程序直接放在 CLI 包内的安装方式。 */ }
  for (const folder of ["bin", "codex"]) {
    const candidate = path.join(vendor, target, folder, "codex.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("未找到 Codex CLI 原生程序，请修复 Codex CLI 安装。");
};

export const connectCodexControl = (executable: string, codexHome: string) => {
  const child: ChildProcessWithoutNullStreams = spawn(executable, ["app-server"], {
    env: { ...process.env, CODEX_HOME: codexHome }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], shell: false
  });
  let sequence = 0;
  let closed = false;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const fail = () => {
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Codex 控制连接已断开。")); }
    pending.clear();
  };
  child.once("error", fail);
  child.once("exit", fail);
  child.stdin.on("error", fail);
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let response: any;
    try { response = JSON.parse(line); } catch { return; }
    const item = pending.get(response.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(response.id);
    if (response.error) item.reject(new Error("Codex 未接受会话操作，请检查会话是否存在及 CLI 版本是否支持。"));
    else item.resolve(response.result);
  });
  const notify = (method: string, params: object) => child.stdin.write(JSON.stringify({ method, params }) + "\n");
  const request = (method: string, params: object): Promise<any> => new Promise((resolve, reject) => {
    if (closed) return reject(new Error("Codex 控制连接不可用。"));
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("等待 Codex 响应超时，请检查会话和 CLI 运行状态。"));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  return {
    request,
    initialize: async () => {
      await request("initialize", { clientInfo: { name: "codexia_session_wakeup", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      notify("initialized", {});
    },
    close: () => {
      lines.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      fail();
    }
  };
};

interface SessionControlOptions {
  codexHome: string;
  executable?: string;
  connect?: typeof connectCodexControl;
  queue?: (executable: string, args: string[], environment: NodeJS.ProcessEnv) => Promise<void>;
}

const queueMessage = (executable: string, args: string[], environment: NodeJS.ProcessEnv): Promise<void> => new Promise((resolve, reject) => {
  execFile(executable, args, { env: environment, windowsHide: true, timeout: 20_000, maxBuffer: 256 * 1024 }, (error) => {
    if (error) reject(new Error("发送唤醒消息失败，请检查会话、Codex CLI 和本机服务。"));
    else resolve();
  });
});

export const wakeCodexSession = async (record: SessionWakeup, canRun: () => boolean, options: SessionControlOptions): Promise<"awakened" | "skipped"> => {
  const executable = options.executable || resolveCodexExecutable();
  const ensureCurrent = () => { if (!canRun()) throw new Error("唤醒登记已停用、修改或到期。"); };
  ensureCurrent();
  if (record.resumeGoal) {
    const client = (options.connect || connectCodexControl)(executable, options.codexHome);
    try {
      await client.initialize();
      const result = await client.request("thread/goal/get", { threadId: record.sessionId });
      if (result.goal?.status === "complete") return "skipped";
      if (result.goal) {
        ensureCurrent();
        await client.request("thread/goal/set", { threadId: record.sessionId, status: "active" });
        return "awakened";
      }
    } finally { client.close(); }
  }
  ensureCurrent();
  await (options.queue || queueMessage)(executable, [
    "queue", "--thread", record.sessionId, "--message", "账号池额度已恢复，请继续之前因额度不足中断的任务；已完成的任务无需重复执行。"
  ], { ...process.env, CODEX_HOME: options.codexHome });
  return "awakened";
};
