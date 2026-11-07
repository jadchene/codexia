import { execFile } from "node:child_process";
import { resolveCodexHome } from "./codex-cli-auth.ts";

/** Restart only after the new auth and configuration have been committed. */
export async function restartCodexDaemon(options: Parameters<typeof resolveCodexHome>[0] = {}) {
  const args = ["app-server", "daemon", "restart"];
  try {
    await new Promise<void>((resolve, reject) => execFile(process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "codex",
      process.platform === "win32" ? ["/d", "/s", "/c", "codex app-server daemon restart"] : args,
      { windowsHide: true, timeout: 60_000, env: { ...process.env, CODEX_HOME: resolveCodexHome(options) } },
      (error) => error ? reject(error) : resolve()));
  } catch {
    throw new Error("配置已应用，但 Codex daemon app server 重启失败。请确认 Codex 已安装且支持 codex app-server daemon restart，再手动重试。");
  }
}
