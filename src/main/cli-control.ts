import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { canonicalInstanceDirectory } from "./single-instance.ts";
import { ACCESS_MODES, type AccessMode, type AccessSelection, type CliBackend } from "./cli.ts";

interface Snapshot {
  show: string;
  choices: Record<AccessMode, ReturnType<CliBackend["choices"]>>;
  defaults: Record<AccessMode, ReturnType<CliBackend["defaults"]>>;
}
interface ControlMetadata {
  endpoint: string;
  token: string;
  instanceDirectory: string;
  singleInstance: boolean;
}
export interface CliDiscoveryOptions {
  singleInstance?: boolean;
  globalFile?: string;
}
const controlFile = (dataDir: string) => path.join(dataDir, "cli-control.json");
const unavailable = () => Object.assign(new Error("Codexia 命令服务尚未就绪。"), { code: "CLI_UNAVAILABLE" });
export const isCliUnavailable = (error: unknown): boolean => (error as { code?: string })?.code === "CLI_UNAVAILABLE";

/** Local authenticated control channel; no account tokens or API keys cross this channel. */
export async function startCliControl(dataDir: string, backend: CliBackend, options: CliDiscoveryOptions = {}) {
  const instanceDirectory = canonicalInstanceDirectory(dataDir);
  const singleInstance = options.singleInstance === true;
  const registryFiles = [controlFile(dataDir), ...(singleInstance && options.globalFile ? [options.globalFile] : [])];
  const token = randomBytes(32).toString("hex");
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\codexia-cli-${token.slice(0, 24)}` : path.join(os.tmpdir(), `codexia-cli-${token.slice(0, 24)}.sock`);
  let queue = Promise.resolve();
  let stopping = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    if (stopping) { socket.destroy(); return; }
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {}); socket.setTimeout(90_000, () => socket.destroy());
    let bytes = 0; let input = ""; let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (stopping) { socket.destroy(); return; }
      if (handled) return;
      bytes += Buffer.byteLength(chunk); if (bytes > 65536) { socket.destroy(); return; }
      input += chunk; const newline = input.indexOf("\n"); if (newline < 0) return;
      handled = true;
      queue = queue.then(async () => {
        try {
          const request = JSON.parse(input.slice(0, newline));
          if (request.token !== token || request.instanceDirectory !== instanceDirectory || (request.scope === "global" && !singleInstance)) throw new Error("命令认证失败。");
          if (request.action === "snapshot") {
            const modes = Object.keys(ACCESS_MODES) as AccessMode[];
            socket.end(`${JSON.stringify({ ok: true, result: { show: backend.show(),
              choices: Object.fromEntries(modes.map((mode) => [mode, backend.choices(mode)])),
              defaults: Object.fromEntries(modes.map((mode) => [mode, backend.defaults(mode)])) } })}\n`);
          } else if (request.action === "apply") {
            const s = request.selection;
            if (!s || !Object.hasOwn(ACCESS_MODES, s.mode) || typeof s.targetId !== "string" || s.targetId.length > 512
              || typeof s.proxy !== "boolean" || typeof s.restart !== "boolean" || (s.mode === "gateway" && (s.proxy || s.targetId))) throw new Error("接入参数无效。");
            await backend.apply(s);
            socket.end(`${JSON.stringify({ ok: true })}\n`);
          } else throw new Error("未知命令。 ");
        } catch (error) { socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "执行失败。" })}\n`); }
      }).catch(() => { socket.destroy(); });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  try {
    if (process.platform !== "win32") fs.chmodSync(endpoint, 0o600);
    for (const file of registryFiles) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ endpoint, token, pid: process.pid, instanceDirectory, singleInstance }), { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    }
  } catch (error) { server.close(); throw error; }
  return async () => {
    stopping = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const file of registryFiles) {
      try { if (JSON.parse(fs.readFileSync(file, "utf8")).token === token) fs.unlinkSync(file); } catch { /* Already removed. */ }
    }
    await queue;
    for (const socket of sockets) socket.destroy();
    await closed;
  };
}

function readConnection(file: string): ControlMetadata | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof value.endpoint === "string" && typeof value.token === "string" && typeof value.instanceDirectory === "string"
      && typeof value.singleInstance === "boolean" ? value : null;
  } catch { return null; }
}

async function request(connection: ControlMetadata, scope: "global" | "local", action: string, selection?: AccessSelection): Promise<Snapshot | undefined> {
  const instanceDirectory = connection.instanceDirectory;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connection.endpoint);
    let connected = false; let input = ""; let complete = false; let bytes = 0;
    const finish = (error?: Error, value?: Snapshot) => {
      if (complete) return; complete = true; socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(action === "snapshot" ? 3000 : 90_000, () => finish(new Error("Codexia 命令超时；请先查看当前模式，勿盲目重复应用。")));
    socket.once("connect", () => { connected = true; socket.write(`${JSON.stringify({ token: connection.token, instanceDirectory, scope, action, selection })}\n`); });
    socket.once("error", () => finish(connected ? new Error("命令连接中断，请检查配置是否已应用。") : unavailable()));
    socket.once("end", () => { if (!complete) finish(new Error("命令连接提前结束，请检查配置是否已应用。")); });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk); if (bytes > 1024 * 1024) { finish(new Error("命令响应过大。")); return; }
      input += chunk; if (!input.includes("\n")) return;
      try { const response = JSON.parse(input.slice(0, input.indexOf("\n"))); finish(response.ok ? undefined : new Error(response.error || "命令执行失败。"), response.result); }
      catch { finish(new Error("命令响应无效。")); }
    });
  });
}

export async function connectCliControl(dataDir: string, options: CliDiscoveryOptions = {}): Promise<CliBackend | null> {
  const candidates: Array<{ connection: ControlMetadata; scope: "global" | "local" }> = [];
  if (options.singleInstance && options.globalFile) {
    const global = readConnection(options.globalFile);
    if (global?.singleInstance) candidates.push({ connection: global, scope: "global" });
  }
  const local = readConnection(controlFile(dataDir));
  if (local?.instanceDirectory === canonicalInstanceDirectory(dataDir)) candidates.push({ connection: local, scope: "local" });
  for (const { connection, scope } of candidates) {
    let snapshot: Snapshot | undefined;
    try { snapshot = await request(connection, scope, "snapshot"); }
    catch (error) { if (isCliUnavailable(error)) continue; throw error; }
    if (!snapshot) throw new Error("Codexia 未返回接入配置。");
    // Pin the selected instance for the whole command; a restart must not silently redirect an apply.
    return { show: () => snapshot!.show, choices: (mode) => snapshot!.choices[mode], defaults: (mode) => snapshot!.defaults[mode],
      apply: async (selection) => { await request(connection, scope, "apply", selection); } };
  }
  return null;
}
