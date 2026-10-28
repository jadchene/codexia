import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import type { Settings } from "../shared/contracts/settings";

const MCP_GATEWAY_COMMAND = "mcp-gateway-service";

interface McpState {
  running: boolean;
  installed: boolean;
  url: string;
  error: string;
  pid: number;
  command: string;
}
interface SettingsStore { getSettings: () => Settings }
interface Launch { executable: string; prefixArgs: string[] }
interface McpHooks {
  resolveLaunch?: () => Launch;
  spawnProcess?: (executable: string, args: string[], options: Record<string, unknown>) => ChildProcess;
  killProcess?: (child: ChildProcess) => void;
  onStatusChanged?: (state: McpState) => void;
  stopTimeoutMs?: number;
}
export function createMcpGatewayService(store: SettingsStore, hooks: McpHooks = {}) {
  let child: ChildProcess | null = null;
  let state = stoppedState();
  let stopPromise: Promise<McpState> | null = null;
  const expectedStops = new WeakSet<ChildProcess>();

  async function start(): Promise<McpState> {
    if (stopPromise) await stopPromise;
    if (child) return state;
    const settings = store.getSettings();
    let launch: Launch;
    try {
      launch = hooks.resolveLaunch?.() || resolveMcpGatewayLaunch();
    } catch (error) {
      state = {
        ...stoppedState(settings),
        installed: false,
        error: error instanceof Error ? error.message : String(error)
      };
      hooks.onStatusChanged?.(state);
      throw error;
    }
    const args = mcpGatewayArgs(settings);
    const command = buildMcpGatewayCommand(settings);
    const output: string[] = [];
    const spawned = (hooks.spawnProcess || spawn)(launch.executable, [...launch.prefixArgs, ...args], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child = spawned;
    spawned.stdout?.on("data", (chunk: Buffer) => collectOutput(output, chunk));
    spawned.stderr?.on("data", (chunk: Buffer) => collectOutput(output, chunk));
    state = {
      running: true,
      installed: true,
      url: mcpGatewayUrl(settings),
      error: "",
      pid: spawned.pid || 0,
      command
    };
    spawned.once("error", (error: Error) => {
      if (child !== spawned) return;
      child = null;
      state = expectedStops.has(spawned)
        ? stoppedState(settings, true)
        : { ...stoppedState(settings, true), error: error.message };
      hooks.onStatusChanged?.(state);
    });
    spawned.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (child !== spawned) return;
      child = null;
      state = expectedStops.has(spawned)
        ? stoppedState(settings, true)
        : { ...stoppedState(settings, true), error: exitMessage(code, signal, output) };
      hooks.onStatusChanged?.(state);
    });
    return state;
  }

  async function stop(): Promise<McpState> {
    const settings = store.getSettings();
    if (!child) {
      state = stoppedState(settings, canResolveLaunch(hooks.resolveLaunch));
      return state;
    }
    if (stopPromise) return stopPromise;
    const closing = child;
    expectedStops.add(closing);
    stopPromise = new Promise<McpState>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (child === closing) child = null;
        if (!child) state = stoppedState(settings, true);
        resolve(state);
      };
      closing.once("exit", finish);
      closing.once("error", finish);
      (hooks.killProcess || killProcessTree)(closing);
      setTimeout(finish, Number(hooks.stopTimeoutMs || 3000));
    }).finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  function status(): McpState {
    const settings = store.getSettings();
    return child
      ? state
      : {
          ...state,
          running: false,
          installed: canResolveLaunch(hooks.resolveLaunch),
          url: "",
          pid: 0,
          command: buildMcpGatewayCommand(settings)
        };
  }

  return { start, stop, status };
}

function canResolveLaunch(resolveLaunch?: () => Launch): boolean {
  try {
    (resolveLaunch || resolveMcpGatewayLaunch)();
    return true;
  } catch {
    return false;
  }
}

function resolveMcpGatewayLaunch(): Launch {
  if (process.platform !== "win32") {
    return { executable: MCP_GATEWAY_COMMAND, prefixArgs: [] };
  }
  const matches = whereWindows(MCP_GATEWAY_COMMAND);
  const native = matches.find((item) => /\.exe$/i.test(item));
  if (native) return { executable: native, prefixArgs: [] };
  const shim = matches.find((item) => /\.cmd$/i.test(item));
  if (!shim) throw new Error("未找到 mcp-gateway-service 可执行文件。");
  const nodeExecutable = whereWindows("node.exe").find((item) => /node\.exe$/i.test(item));
  if (!nodeExecutable) throw new Error("未找到用于运行 mcp-gateway-service 的 Node.js。");
  return resolveWindowsNpmShim(shim, nodeExecutable);
}

export function resolveWindowsNpmShim(shim: string, nodeExecutable: string): Launch {
  const base = path.dirname(shim);
  const content = fs.readFileSync(shim, "utf8");
  const matches = Array.from(content.matchAll(/"%dp0%\\([^"\r\n]+\.js)"/gi));
  const relativeScript = matches.at(-1)?.[1];
  if (!relativeScript) throw new Error(`无法解析 npm 命令入口：${shim}`);
  const script = path.resolve(base, relativeScript.replace(/\\/g, path.sep));
  const relative = path.relative(base, script);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(script)) {
    throw new Error(`mcp-gateway-service 入口不存在或超出 npm 全局目录：${script}`);
  }
  return { executable: nodeExecutable, prefixArgs: [script] };
}

function whereWindows(command: string): string[] {
  return execFileSync("where.exe", [command], {
    encoding: "utf8",
    windowsHide: true
  }).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function stoppedState(settings: Settings = {}, installed = false): McpState {
  return {
    running: false,
    installed,
    url: "",
    error: "",
    pid: 0,
    command: buildMcpGatewayCommand(settings)
  };
}

export function buildMcpGatewayCommand(settings: Settings = {}): string {
  return [MCP_GATEWAY_COMMAND, ...mcpGatewayArgs(settings).map(quoteArg)].join(" ");
}

function mcpGatewayArgs(settings: Settings = {}): string[] {
  const args: string[] = ["--http"];
  appendOptionalArg(args, "--config", settings.mcp_gateway_config_path);
  appendOptionalArg(args, "--host", settings.mcp_gateway_host);
  appendOptionalArg(args, "--port", cleanMcpGatewayPort(settings.mcp_gateway_port));
  appendOptionalArg(args, "--path", cleanMcpGatewayPath(settings.mcp_gateway_path));
  return args;
}

export function mcpGatewayUrl(settings: Settings = {}): string {
  const host = cleanMcpGatewayText(settings.mcp_gateway_host);
  const port = cleanMcpGatewayPort(settings.mcp_gateway_port);
  if (!host || !port) return "";
  return `http://${host}:${port}${cleanMcpGatewayPath(settings.mcp_gateway_path) || ""}`;
}

function appendOptionalArg(args: string[], name: string, value: unknown): void {
  const text = cleanMcpGatewayText(value);
  if (!text) return;
  args.push(name, text);
}

function cleanMcpGatewayText(value: unknown): string {
  return String(value || "").trim();
}

function cleanMcpGatewayPort(value: unknown): string {
  const text = cleanMcpGatewayText(value);
  if (!text) return "";
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? String(Math.trunc(number)) : "";
}

function cleanMcpGatewayPath(value: unknown): string {
  const text = cleanMcpGatewayText(value);
  if (!text) return "";
  return text.startsWith("/") ? text : `/${text}`;
}

function killProcessTree(processHandle: ChildProcess): void {
  if (!processHandle?.pid) return;
  if (process.platform !== "win32") {
    processHandle.kill();
    return;
  }
  execFile("taskkill.exe", ["/pid", String(processHandle.pid), "/t", "/f"], { windowsHide: true }, () => {});
}

function quoteArg(value: unknown): string {
  const text = String(value);
  return /[\s"]/g.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function collectOutput(output: string[], chunk: unknown): void {
  output.push(String(chunk || "").replace(/\s+/g, " ").trim());
  while (output.join(" ").length > 800 && output.length > 1) output.shift();
}

function exitMessage(code: number | null, signal: NodeJS.Signals | null, output: string[] = []): string {
  const detail = output.filter(Boolean).join(" ").slice(0, 500);
  if (signal) return detail ? `进程已退出：${signal}；${detail}` : `进程已退出：${signal}`;
  if (typeof code === "number" && code !== 0) return detail ? `进程已退出：${code}；${detail}` : `进程已退出：${code}`;
  return "";
}
