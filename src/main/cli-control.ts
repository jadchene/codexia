import fs from "node:fs";
import http from "node:http";
import { canonicalInstanceDirectory } from "./single-instance.ts";
import type { AccessSelection, CliBackend } from "./cli.ts";
import { ACCESS_MODE_API_PATH, controlApiFile, type AccessModeSnapshot, type ControlApiMetadata, type ApiDiscoveryOptions } from "./control-api.ts";

const unavailable = () => Object.assign(new Error("Codexia 外部 API 尚未就绪。"), { code: "CLI_UNAVAILABLE" });
function readConnection(file: string): ControlApiMetadata | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof v.url === "string" && typeof v.apiKey === "string" && typeof v.instanceId === "string"
      && typeof v.instanceDirectory === "string" && typeof v.singleInstance === "boolean" ? v : null;
  } catch { return null; }
}
async function request<T>(connection: ControlApiMetadata, selection?: AccessSelection): Promise<T> {
  return new Promise((resolve, reject) => {
    let connected = false; let complete = false;
    const finish = (error?: Error, value?: T) => {
      if (complete) return;
      complete = true; clearTimeout(deadline); req.destroy();
      if (error) reject(error); else resolve(value!);
    };
    const body = selection ? JSON.stringify(selection) : undefined;
    const req = http.request(new URL(ACCESS_MODE_API_PATH, connection.url), {
      method: selection ? "POST" : "GET", agent: false,
      headers: { Authorization: `Bearer ${connection.apiKey}`, "X-Codexia-Instance": connection.instanceId,
        ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}) }
    }, (res) => {
      let bytes = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { finish(new Error("API 响应过大。")); return; }
        chunks.push(chunk);
      });
      res.once("error", () => finish(new Error("API 响应中断，请检查配置是否已应用。")));
      res.once("end", () => {
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish(res.statusCode === 200 && response.ok === true ? undefined : new Error(response.error?.message || "API 请求失败。"), response.result);
        } catch { finish(new Error("API 响应无效。")); }
      });
    });
    const deadline = setTimeout(() => finish(new Error("Codexia API 请求超时；请先查看当前模式，勿盲目重复应用。")), selection ? 90000 : 3000);
    req.once("socket", (socket) => socket.once("connect", () => { connected = true; }));
    req.once("error", () => finish(connected ? new Error("API 连接中断，请检查配置是否已应用。") : unavailable()));
    req.end(body);
  });
}

/** Only instance discovery uses a local record; all data exchange uses HTTP. */
export async function connectCliControl(dataDir: string, options: ApiDiscoveryOptions = {}): Promise<CliBackend | null> {
  const candidates: ControlApiMetadata[] = [];
  if (options.singleInstance && options.globalFile) {
    const global = readConnection(options.globalFile);
    if (global?.singleInstance) candidates.push(global);
  }
  const local = readConnection(controlApiFile(dataDir));
  if (local?.instanceDirectory === canonicalInstanceDirectory(dataDir)) candidates.push(local);
  for (const connection of candidates) {
    let snapshot: AccessModeSnapshot;
    try { snapshot = await request<AccessModeSnapshot>(connection); }
    catch (error) { if ((error as { code?: string })?.code === "CLI_UNAVAILABLE") continue; throw error; }
    if (!snapshot?.choices || !snapshot.defaults) throw new Error("Codexia 未返回接入配置。");
    let gatewayRunning = snapshot.gatewayRunning;
    return { current: () => snapshot.current, show: () => snapshot.show, choices: (mode) => snapshot.choices[mode], defaults: (mode) => snapshot.defaults[mode],
      gatewayRunning: () => gatewayRunning,
      apply: async (selection) => { gatewayRunning = (await request<{ gatewayRunning: boolean }>(connection, selection)).gatewayRunning; } };
  }
  return null;
}
