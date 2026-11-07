import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalInstanceDirectory } from "./single-instance.ts";
import { ACCESS_MODES, gatewayStartReminder, type AccessMode, type AccessSelection, type CliBackend } from "./cli.ts";

export const ACCESS_MODE_API_PATH = "/codexia/api/access-mode";
export const controlApiFile = (dataDir: string) => path.join(dataDir, "control-api.json");
export interface ApiDiscoveryOptions { singleInstance?: boolean; globalFile?: string; }
export interface ControlApiMetadata {
  url: string; apiKey: string; instanceId: string; instanceDirectory: string; singleInstance: boolean; pid: number;
}
export interface AccessModeSnapshot {
  current: AccessSelection | null;
  show: string;
  choices: Record<AccessMode, ReturnType<CliBackend["choices"]>>;
  defaults: Record<AccessMode, ReturnType<CliBackend["defaults"]>>;
  gatewayRunning: boolean;
}
interface ApiOptions extends ApiDiscoveryOptions { host: string; port: number; apiKey: string; }
function validSelection(value: unknown): value is AccessSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return typeof s.mode === "string" && Object.hasOwn(ACCESS_MODES, s.mode)
    && typeof s.targetId === "string" && s.targetId.length <= 512
    && typeof s.proxy === "boolean" && typeof s.restart === "boolean"
    && (s.mode !== "gateway" || (!s.proxy && s.targetId === ""));
}

/** General external API; independent of the model gateway and its running state. */
export async function startControlApi(dataDir: string, backend: CliBackend, options: ApiOptions) {
  if (options.apiKey.length < 32 || /[^\x21-\x7e]/.test(options.apiKey)) throw new Error("外部 API 密钥至少需要 32 个可打印 ASCII 字符，且不能包含空格。");
  const instanceId = randomUUID();
  const registryFiles = [controlApiFile(dataDir), ...(options.singleInstance && options.globalFile ? [options.globalFile] : [])];
  let queue = Promise.resolve(); let pending = 0; let stopping = false;
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000 }, async (req, res) => {
    const reply = (status: number, body: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const error = (status: number, code: string, message: string) => reply(status, { ok: false, error: { code, message } });
    req.on("error", () => {}); res.on("error", () => {});
    if (stopping) { error(503, "STOPPING", "Codexia 正在退出。"); req.resume(); return; }
    const provided = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${options.apiKey}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.setHeader("WWW-Authenticate", "Bearer"); error(401, "UNAUTHORIZED", "API 认证失败。"); req.resume(); return;
    }
    if (req.headers["x-codexia-instance"] && req.headers["x-codexia-instance"] !== instanceId) {
      error(409, "INSTANCE_CHANGED", "Codexia 实例已改变，请重新读取配置。"); req.resume(); return;
    }
    if (req.url !== ACCESS_MODE_API_PATH) { error(404, "NOT_FOUND", "接口不存在。"); req.resume(); return; }
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST"); error(405, "METHOD_NOT_ALLOWED", "不支持此请求方法。"); req.resume(); return;
    }
    if (pending >= 16) { error(429, "BUSY", "请求过多，请稍后重试。"); req.resume(); return; }
    pending++;
    let selection: AccessSelection | undefined;
    try {
      if (req.method === "POST") {
        if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
          error(415, "CONTENT_TYPE", "请求正文必须为 application/json。"); req.resume(); return;
        }
        const chunks: Buffer[] = []; let bytes = 0;
        const body = await new Promise<Buffer | null>((resolve, reject) => {
          req.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16384) resolve(null); else chunks.push(chunk); });
          req.once("end", () => resolve(Buffer.concat(chunks)));
          req.once("error", reject); req.once("aborted", () => reject(new Error("请求已中断。")));
        });
        if (!body) { error(413, "BODY_TOO_LARGE", "请求正文不能超过 16 KiB。"); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(body.toString("utf8")); } catch { error(400, "INVALID_JSON", "JSON 格式无效。"); return; }
        if (!validSelection(parsed)) { error(400, "INVALID_SELECTION", "接入参数无效。"); return; }
        selection = parsed;
      }
      const operation = queue.then(async () => {
        if (stopping) { error(503, "STOPPING", "Codexia 正在退出。"); return; }
        if (req.aborted || res.destroyed) return;
        if (selection) {
          await backend.apply(selection);
          const gatewayRunning = backend.gatewayRunning?.() ?? false;
          reply(200, { ok: true, result: { gatewayRunning, warning: gatewayStartReminder(selection, gatewayRunning) } });
        } else {
          const modes = Object.keys(ACCESS_MODES) as AccessMode[];
          const result = { current: backend.current?.() ?? null, show: backend.show(), gatewayRunning: backend.gatewayRunning?.() ?? false,
            choices: Object.fromEntries(modes.map((mode) => [mode, backend.choices(mode)])),
            defaults: Object.fromEntries(modes.map((mode) => [mode, backend.defaults(mode)])) };
          reply(200, { ok: true, result });
        }
      });
      queue = operation.catch(() => {});
      await operation;
    } catch (cause) { error(500, "APPLY_FAILED", cause instanceof Error ? cause.message : "执行失败，请检查配置是否已应用。"); }
    finally { pending--; }
  });
  server.timeout = 120000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host.replace(/^\[|\]$/g, ""), resolve); });
  const address = server.address() as import("node:net").AddressInfo;
  const host = address.address === "0.0.0.0" ? "127.0.0.1" : address.address === "::" ? "::1" : address.address;
  const metadata: ControlApiMetadata = { url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
    apiKey: options.apiKey, instanceId, instanceDirectory: canonicalInstanceDirectory(dataDir), singleInstance: options.singleInstance === true, pid: process.pid };
  const unregister = () => {
    for (const file of registryFiles) {
      try { if (JSON.parse(fs.readFileSync(file, "utf8")).instanceId === instanceId) fs.unlinkSync(file); } catch { /* Already removed. */ }
    }
  };
  try {
    for (const file of registryFiles) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(metadata), { mode: 0o600 }); fs.chmodSync(file, 0o600);
    }
  } catch (cause) { unregister(); server.closeAllConnections(); server.close(); throw cause; }
  return async () => {
    stopping = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    unregister(); await queue; server.closeAllConnections(); await closed;
  };
}
