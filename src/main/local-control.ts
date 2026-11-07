import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { canonicalInstanceDirectory } from "./single-instance.ts";
import { CONTROL_PROTOCOL_VERSION, type ControlRequest, type ControlResponse } from "../shared/control-protocol.ts";

export interface ControlMetadata {
  endpoint: string;
  token: string;
  instanceDirectory: string;
  appVersion: string;
  pid: number;
}
export interface ControlOptions { appVersion: string; }
export type ControlHandlers = Record<string, (params: unknown) => unknown | Promise<unknown>>;
export const controlFile = (dataDir: string) => path.join(dataDir, "cli-control.json");
export class ControlError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function readControlMetadata(file: string): ControlMetadata | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof v.endpoint === "string" && typeof v.token === "string" && typeof v.instanceDirectory === "string"
      && typeof v.appVersion === "string" && Number.isSafeInteger(v.pid) ? v : null;
  } catch { return null; }
}

/** A method registry keeps new operations separate from the transport. */
export async function startLocalControl(dataDir: string, handlers: ControlHandlers, options: ControlOptions) {
  const instanceDirectory = canonicalInstanceDirectory(dataDir);
  const token = randomBytes(32).toString("hex");
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\codexia-cli-${token.slice(0, 24)}` : path.join(os.tmpdir(), `codexia-cli-${token.slice(0, 24)}.sock`);
  const files = [controlFile(dataDir)];
  let stopping = false; let pending = 0; let queue = Promise.resolve();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    if (stopping) { socket.destroy(); return; }
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {}); socket.setTimeout(90000, () => socket.destroy());
    socket.setEncoding("utf8");
    let input = ""; let bytes = 0; let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      bytes += Buffer.byteLength(chunk); if (bytes > 65536) { socket.destroy(); return; }
      input += chunk; const newline = input.indexOf("\n"); if (newline < 0) return;
      handled = true;
      let id = "";
      const reply = (response: Pick<ControlResponse, "ok" | "result" | "error">) => {
        if (socket.destroyed) return;
        const envelope = { version: CONTROL_PROTOCOL_VERSION, appVersion: options.appVersion, id, ...response };
        const text = JSON.stringify(envelope);
        socket.end((Buffer.byteLength(text) <= 1024 * 1024 ? text : JSON.stringify({ ...envelope, ok: false, result: undefined,
          error: { code: "RESPONSE_TOO_LARGE", message: "命令响应过大。" } })) + "\n");
      };
      const fail = (error: unknown) => reply({ ok: false, error: { code: error instanceof ControlError ? error.code : "EXECUTION_FAILED",
        message: error instanceof Error ? error.message : "执行失败。" } });
      let request: ControlRequest;
      try {
        request = JSON.parse(input.slice(0, newline));
        if (!request || typeof request.id !== "string" || request.id.length > 128 || !request.id) throw new ControlError("INVALID_REQUEST", "请求标识无效。");
        id = request.id;
        if (request.token !== token || request.instanceDirectory !== instanceDirectory) throw new ControlError("UNAUTHORIZED", "命令认证失败。");
        if (request.version !== CONTROL_PROTOCOL_VERSION) throw new ControlError("PROTOCOL_MISMATCH", "进程通信协议版本不一致。");
        if (request.appVersion !== options.appVersion) throw new ControlError("VERSION_MISMATCH", `CLI 与 Codexia 版本不一致（${request.appVersion} / ${options.appVersion}），请使用相同版本。`);
        if (typeof request.method !== "string" || !Object.hasOwn(handlers, request.method)) throw new ControlError("UNKNOWN_METHOD", "未知命令类型。");
        if (stopping) throw new ControlError("STOPPING", "Codexia 正在退出。");
        if (pending >= 16) throw new ControlError("BUSY", "待处理命令过多，请稍后重试。");
      } catch (error) { fail(error); return; }
      pending++;
      queue = queue.then(async () => {
        if (socket.destroyed) return;
        try { reply({ ok: true, result: await handlers[request.method]!(request.params) }); }
        catch (error) { fail(error); }
      }).finally(() => { pending--; });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  const unregister = () => {
    for (const file of files) if (readControlMetadata(file)?.token === token) fs.rmSync(file, { force: true });
  };
  try {
    if (process.platform !== "win32") fs.chmodSync(endpoint, 0o600);
    const metadata: ControlMetadata = { endpoint, token, instanceDirectory, appVersion: options.appVersion, pid: process.pid };
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(metadata), { mode: 0o600 }); fs.chmodSync(file, 0o600);
    }
  } catch (error) { unregister(); server.close(); throw error; }
  return async () => {
    stopping = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    unregister(); await queue;
    for (const socket of sockets) socket.destroy();
    await closed;
  };
}

export async function requestLocalControl<T>(connection: ControlMetadata, appVersion: string, method: string, params?: unknown): Promise<T> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connection.endpoint);
    let connected = false; let complete = false; let input = ""; let bytes = 0;
    const finish = (error?: Error, result?: T) => {
      if (complete) return; complete = true; clearTimeout(deadline); socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const deadline = setTimeout(() => finish(new Error("Codexia 命令超时，请检查配置是否已应用，勿盲目重试。")), method === "access-mode.get" ? 3000 : 90000);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      connected = true;
      socket.write(JSON.stringify({ version: CONTROL_PROTOCOL_VERSION, appVersion, id, method, params, token: connection.token, instanceDirectory: connection.instanceDirectory }) + "\n");
    });
    socket.once("error", () => finish(connected ? new Error("命令连接中断，请检查配置是否已应用。") : new ControlError("UNAVAILABLE", "Codexia 命令服务未运行。")));
    socket.once("end", () => finish(new Error("命令连接提前结束，请检查配置是否已应用。")));
    socket.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk); if (bytes > 1024 * 1024) { finish(new Error("命令响应过大。")); return; }
      input += chunk; const newline = input.indexOf("\n"); if (newline < 0) return;
      try {
        const response: ControlResponse = JSON.parse(input.slice(0, newline));
        if (response.id !== id || response.version !== CONTROL_PROTOCOL_VERSION) throw new Error("命令响应格式或标识无效。");
        if (!response.ok) throw new ControlError(response.error?.code || "EXECUTION_FAILED", response.error?.message || "执行失败。");
        if (response.appVersion !== appVersion) throw new ControlError("VERSION_MISMATCH", "CLI 与 Codexia 版本不一致，请使用相同版本。");
        finish(undefined, response.result as T);
      } catch (error) { finish(error instanceof Error ? error : new Error("命令响应无效。")); }
    });
  });
}
