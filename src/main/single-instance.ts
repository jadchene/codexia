import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net, { type Server } from "node:net";
import os from "node:os";
import path from "node:path";

/** 在获取启动锁前只读查询配置；缺失或读取失败时保留单实例限制。 */
export function readSingleInstanceSetting(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) return true;
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("single_instance");
    return row?.value !== "false";
  } catch {
    return true;
  } finally {
    db?.close();
  }
}

interface SingleInstanceOptions {
  userIdentity?: string;
  platform?: NodeJS.Platform;
  tempDir?: string;
  endpoint?: string;
  connectTimeoutMs?: number;
  onSecondInstance?: () => void;
  onError?: (error: Error) => void;
}

interface SingleInstanceChannel {
  primary: boolean;
  endpoint: string;
  server: Server | null;
}

export function singleInstanceEndpoint(options: SingleInstanceOptions = {}): string {
  const identity = String(options.userIdentity || `${os.homedir()}\0${os.userInfo().username}`);
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  if ((options.platform || process.platform) === "win32") return `\\\\.\\pipe\\codex-gateway-${suffix}`;
  return path.join(options.tempDir || os.tmpdir(), `codex-gateway-${suffix}.sock`);
}

export function acquireSingleInstanceChannel(options: SingleInstanceOptions = {}): Promise<SingleInstanceChannel> {
  const endpoint = options.endpoint || singleInstanceEndpoint(options);
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.resume();
    options.onSecondInstance?.();
    socket.end();
  });
  return new Promise<SingleInstanceChannel>((resolve, reject) => {
    const onListenError = (error: NodeJS.ErrnoException): void => {
      if (error.code !== "EADDRINUSE") {
        reject(error);
        return;
      }
      notifyExistingInstance(endpoint, options.connectTimeoutMs).finally(() => {
        resolve({ primary: false, endpoint, server: null });
      });
    };
    server.once("error", onListenError);
    server.listen(endpoint, () => {
      server.off("error", onListenError);
      server.on("error", (error) => options.onError?.(error));
      resolve({ primary: true, endpoint, server });
    });
  });
}

function notifyExistingInstance(endpoint: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(endpoint);
    let settled = false;
    const finish = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!connected && !socket.destroyed) socket.destroy();
      resolve(connected);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => {
      socket.end("show", () => finish(true));
    });
    socket.once("error", () => finish(false));
  });
}

export function closeSingleInstanceChannel(server: Server | null | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
