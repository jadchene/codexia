import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalInstanceDirectory } from "./single-instance.ts";
import { ACCESS_MODE_SYNC_TYPE, type SyncMessage } from "../shared/sync-message.ts";
import { ACCESS_MODES, type AccessMode, type AccessSelection, type CliBackend } from "./cli.ts";

interface Snapshot {
  show: string;
  choices: Record<AccessMode, ReturnType<CliBackend["choices"]>>;
  defaults: Record<AccessMode, ReturnType<CliBackend["defaults"]>>;
}
interface SyncMetadata {
  pid: number;
  instanceId: string;
  instanceDirectory: string;
  singleInstance: boolean;
  snapshot: Snapshot;
}
export interface CliDiscoveryOptions { singleInstance?: boolean; globalFile?: string; }
const syncDirectory = (dataDir: string) => path.join(dataDir, "sync");
const instanceFile = (dataDir: string) => path.join(syncDirectory(dataDir), "instance.json");
const requestFile = (dataDir: string) => path.join(syncDirectory(dataDir), "request.json");

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}
function writeJson(file: string, value: unknown, exclusive = false) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    // Publish complete JSON; never overwrite another CLI's pending selection.
    if (exclusive) fs.linkSync(temporary, file);
    else fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function validSelection(s: AccessSelection | undefined): boolean {
  return Boolean(s && typeof s.mode === "string" && Object.hasOwn(ACCESS_MODES, s.mode)
    && typeof s.targetId === "string" && s.targetId.length <= 512
    && typeof s.proxy === "boolean" && typeof s.restart === "boolean"
    && (s.mode !== "gateway" || (!s.proxy && s.targetId === "")));
}

/** Watch one local directory; no socket, listening port or credential exchange. */
export async function startCliControl(dataDir: string, backend: CliBackend, options: CliDiscoveryOptions = {}) {
  const directory = syncDirectory(dataDir);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const instanceDirectory = canonicalInstanceDirectory(dataDir);
  const instanceId = randomUUID();
  const registryFiles = [instanceFile(dataDir), ...(options.singleInstance && options.globalFile ? [options.globalFile] : [])];
  for (const file of registryFiles) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let lastSnapshot = "";
  const refresh = () => {
    if (stopping) return;
    const modes = Object.keys(ACCESS_MODES) as AccessMode[];
    const snapshot = { show: backend.show(),
      choices: Object.fromEntries(modes.map((mode) => [mode, backend.choices(mode)])),
      defaults: Object.fromEntries(modes.map((mode) => [mode, backend.defaults(mode)])) };
    const metadata = { pid: process.pid, instanceId, instanceDirectory, singleInstance: options.singleInstance === true, snapshot };
    const encoded = JSON.stringify(metadata);
    if (encoded === lastSnapshot) return;
    for (const file of registryFiles) writeJson(file, metadata);
    lastSnapshot = encoded;
  };
  let stopping = false;
  let active: Promise<void> | undefined;
  const file = requestFile(dataDir);
  const processPending = async () => {
    const request = readJson<SyncMessage<AccessSelection>>(file);
    if (!request || request.status !== "pending") return;
    try {
      if (request.targetInstanceId !== instanceId || !Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now()) throw new Error("同步请求已过期或所属实例已改变，请重新切换。");
      if (request.version !== 1) throw new Error("不支持此同步消息版本。");
      if (request.type !== ACCESS_MODE_SYNC_TYPE) throw new Error("不支持此同步消息类型。");
      if (!validSelection(request.payload)) throw new Error("接入参数无效。");
      writeJson(file, { ...request, status: "applying" });
      await backend.apply(request.payload);
      refresh();
      fs.unlinkSync(file);
    } catch (error) {
      writeJson(file, { ...request, status: "failed", error: { code: "SYNC_FAILED", message: error instanceof Error ? error.message : "同步失败。" } });
    }
  };
  const scan = () => {
    if (stopping || active) return;
    active = processPending().catch((error) => console.warn("接入模式目录同步失败", error)).finally(() => { active = undefined; });
  };
  // A crashed owner must not replay a half-applied selection on the next launch.
  const previous = readJson<SyncMessage<AccessSelection>>(file);
  if (previous) writeJson(file, { ...previous, status: "failed", error: { code: "INSTANCE_CHANGED", message: "Codexia 已重启，上次同步状态未确认，请查看当前配置后重试。" } });
  refresh();
  const watcher = fs.watch(directory, (_event, name) => { if (!name || name.toString() === "request.json") scan(); });
  // Recover missed/coalesced filesystem events with one small local read per second.
  const fallback = setInterval(scan, 1000); fallback.unref();
  watcher.on("error", (error) => console.warn("接入模式目录监听异常，将继续定期检查", error));
  scan();
  const close = async () => {
    stopping = true; watcher.close(); clearInterval(fallback);
    for (const registry of registryFiles) {
      if (readJson<SyncMetadata>(registry)?.instanceId === instanceId) fs.rmSync(registry, { force: true });
    }
    await active;
  };
  return Object.assign(close, { refresh });
}

export async function connectCliControl(dataDir: string, options: CliDiscoveryOptions = {}): Promise<CliBackend | null> {
  const candidates: SyncMetadata[] = [];
  if (options.singleInstance && options.globalFile) {
    const global = readJson<SyncMetadata>(options.globalFile);
    if (global?.singleInstance) candidates.push(global);
  }
  const local = readJson<SyncMetadata>(instanceFile(dataDir));
  if (local?.instanceDirectory === canonicalInstanceDirectory(dataDir)) candidates.push(local);
  for (const connection of candidates) {
    if (!alive(connection.pid) || typeof connection.instanceDirectory !== "string" || typeof connection.instanceId !== "string") continue;
    // Recheck the owner file: copied directories and stale global registrations cannot redirect an apply.
    if (readJson<SyncMetadata>(instanceFile(connection.instanceDirectory))?.instanceId !== connection.instanceId) continue;
    const snapshot = connection.snapshot;
    if (!snapshot?.choices || !snapshot.defaults || typeof snapshot.show !== "string") continue;
    return { show: () => snapshot.show, choices: (mode) => snapshot.choices[mode], defaults: (mode) => snapshot.defaults[mode],
      apply: async (selection) => {
        if (!alive(connection.pid) || readJson<SyncMetadata>(instanceFile(connection.instanceDirectory))?.instanceId !== connection.instanceId) throw new Error("Codexia 实例已退出或改变，请重新切换。");
        const file = requestFile(connection.instanceDirectory);
        const old = readJson<SyncMessage<AccessSelection>>(file);
        if (old?.status === "failed") fs.rmSync(file, { force: true });
        const request: SyncMessage<AccessSelection> = { version: 1, id: randomUUID(), type: ACCESS_MODE_SYNC_TYPE,
          targetInstanceId: connection.instanceId, createdAt: Date.now(), expiresAt: Date.now() + 90000, status: "pending", payload: selection };
        try { writeJson(file, request, true); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("已有接入模式同步正在进行，请稍后重试。"); throw error; }
        while (Date.now() < request.expiresAt) {
          const current = readJson<SyncMessage<AccessSelection>>(file);
          if (!current && !fs.existsSync(file)) return;
          if (current?.id !== request.id) throw new Error("同步文件已改变，请检查当前配置。");
          if (current.status === "failed") {
            fs.rmSync(file, { force: true });
            throw new Error(current.error?.message || "接入模式同步失败。");
          }
          if (!alive(connection.pid) || readJson<SyncMetadata>(instanceFile(connection.instanceDirectory))?.instanceId !== connection.instanceId) throw new Error("Codexia 已退出，请检查配置是否已应用。");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("接入模式同步超时，请检查配置是否已应用，勿盲目重复执行。");
      } };
  }
  return null;
}
