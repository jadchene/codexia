import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings } from "../shared/contracts/settings";

interface CodexPathOptions {
  codexDir?: string;
  modelCatalogPath?: string;
  environment?: NodeJS.ProcessEnv;
}
interface AccountRecord extends Record<string, unknown> {
  id: string;
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
  workspace_id?: string;
  last_refresh?: string;
  updated_at?: number;
}
interface FileEntry { file: string; content: string }
type AuthModeResult = { mode: "gateway" | "account" | "unknown"; accountId: string };

export function resolveCodexHome(options: CodexPathOptions = {}): string {
  if (options.codexDir) return path.resolve(options.codexDir);
  const configured = String((options.environment || process.env).CODEX_HOME || "").trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}
function authPath(options: CodexPathOptions = {}): string {
  return path.join(resolveCodexHome(options), "auth.json");
}
function configPath(options: CodexPathOptions = {}): string {
  return path.join(resolveCodexHome(options), "config.toml");
}

function managedModelCatalogPath(options: CodexPathOptions = {}): string {
  const configured = options.modelCatalogPath || path.join(resolveCodexHome(options), "models.json");
  return path.win32.isAbsolute(configured) ? configured : path.resolve(configured);
}

const codexModelCache = new Map<string, { mtimeMs: number; size: number; model: string }>();

/**
 * 读取 Codex Home 下 config.toml 的顶层当前模型（不读取 profiles 子表）。
 * 供网关在 WebSocket 握手阶段判断当前模型是否支持 WS，依据文件 mtime/size 做轻量缓存。
 */
export function readCurrentCodexModel(options: CodexPathOptions = {}): string {
  const file = configPath(options);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return "";
  }
  const cached = codexModelCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.model;
  let model = "";
  try {
    const text = readText(file);
    const firstSection = text.search(/(?:^|\n)\s*\[/);
    const header = firstSection === -1 ? text : text.slice(0, firstSection);
    const match = /(?:^|\n)\s*model\s*=\s*("([^"]*)"|'([^']*)')/.exec(header);
    if (match) model = String(match[2] ?? match[3] ?? "").trim();
  } catch {
    model = "";
  }
  codexModelCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, model });
  return model;
}

export function applyGatewayMode(settings: Settings, options: CodexPathOptions = {}) {
  ensureCodexDir(options);
  const apiKey = String(settings.gateway_api_key || "").trim();
  if (!apiKey) throw new Error("本地 API Key 为空，无法写入 Codex 认证。");
  const currentConfig = readText(configPath(options));
  const nextConfig = nextGatewayConfig(currentConfig, settings, options);
  const nextAuth = jsonText({ OPENAI_API_KEY: apiKey });
  writeFilesTransaction([
    { file: authPath(options), content: nextAuth },
    { file: configPath(options), content: nextConfig }
  ], () => {
    if (readJsonSafe(authPath(options))?.OPENAI_API_KEY !== apiKey
      || !hasGatewayProvider(readText(configPath(options)))
      || !hasManagedModelCatalog(readText(configPath(options)))) {
      throw new Error("写入后的 Codex API 模式认证校验失败。");
    }
  });
  return {
    mode: "gateway",
    authPath: authPath(options),
    configPath: configPath(options),
    modelCatalogPath: managedModelCatalogPath(options),
    providerChanged: nextConfig !== currentConfig
  };
}

export function applyAccountMode(account: AccountRecord | null | undefined, options: CodexPathOptions = {}) {
  ensureCodexDir(options);
  if (!account) throw new Error("请选择一个账号。");
  if (!account.access_token || !account.refresh_token) {
    throw new Error("账号 token 不完整，无法写入 Codex 认证。");
  }
  const nextAuth = jsonText({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: account.id_token || "",
      access_token: account.access_token || "",
      refresh_token: account.refresh_token || "",
      account_id: String(account.account_id || account.workspace_id || "")
    },
    last_refresh: String(account.last_refresh || toIso(account.updated_at) || new Date().toISOString())
  });
  const currentConfig = readText(configPath(options));
  const nextConfig = withoutGatewayProvider(currentConfig);
  writeFilesTransaction([
    { file: authPath(options), content: nextAuth },
    { file: configPath(options), content: nextConfig }
  ], () => {
    const auth = readJsonSafe(authPath(options));
    if (auth?.auth_mode !== "chatgpt" || auth?.tokens?.access_token !== account.access_token || hasGatewayProvider(readText(configPath(options)))) {
      throw new Error("写入后的 Codex 账号认证校验失败。");
    }
  });
  return {
    mode: "account",
    accountId: account.id,
    authPath: authPath(options),
    configPath: configPath(options),
    providerRemoved: nextConfig !== currentConfig
  };
}

export function ensureProviderConfig(settings: Settings, options: CodexPathOptions = {}): boolean {
  ensureCodexDir(options);
  const file = configPath(options);
  const current = readText(file);
  const next = nextGatewayConfig(current, settings, options);
  if (next === current) return false;
  writeFilesTransaction([{ file, content: next }], () => {
    if (!hasGatewayProvider(readText(file)) || !hasManagedModelCatalog(readText(file))) {
      throw new Error("Codex Provider 配置校验失败。");
    }
  });
  return true;
}

export function nextGatewayConfig(current: unknown, settings: Settings, options: CodexPathOptions = {}): string {
  const withoutActiveProvider = String(current || "")
    .replace(/^\s*model_provider\s*=.*\r?\n?/m, "")
    .replace(/^\s*model_catalog_json\s*=.*\r?\n?/m, "")
    .replace(/^\s*openai_base_url\s*=.*\r?\n?/m, "");
  return replaceGatewayProviderBlock(withoutActiveProvider, gatewayProviderBlock(settings, options));
}

export function gatewayProviderBlock(settings: Settings, options: CodexPathOptions = {}): string {
  const host = gatewayProviderBaseHost(settings.gateway_host);
  const port = settings.gateway_port || "8436";
  const baseUrl = `http://${host}:${port}/v1`;
  const catalog = `model_catalog_json = ${tomlString(managedModelCatalogPath(options).replaceAll("\\", "/"))}`;
  if (useOpenaiBaseUrl(settings)) {
    return [
      catalog,
      `openai_base_url = "${baseUrl}"`,
      ""
    ].join("\n");
  }
  return [
    'model_provider = "codexia"',
    catalog,
    "",
    "[model_providers.codexia]",
    'name = "OpenAI"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    "supports_websockets = true",
    ""
  ].join("\n");
}

export function gatewayProviderBaseHost(host: unknown): string {
  const value = String(host || "").trim();
  if (!value || value === "0.0.0.0") return "localhost";
  return value;
}

export function replaceGatewayProviderBlock(current: unknown, block: unknown): string {
  let next = String(current || "");
  if (/^\s*model_provider\s*=\s*"(?:codexia|codex_gateway)"\s*$/m.test(next)) {
    next = next.replace(/^\s*model_provider\s*=\s*"(?:codexia|codex_gateway)"\s*\r?\n?/m, "");
  }
  next = next.replace(/^\s*openai_base_url\s*=.*\r?\n?/m, "");
  next = next.replace(/\r?\n?\[model_providers\.(?:codexia|codex_gateway)\]\r?\n(?:[^\[\r\n].*\r?\n?)*/gm, "\n");
  next = next.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  return insertProviderBlockIntoConfig(next, block);
}

export function insertProviderBlockIntoConfig(current: unknown, block: unknown): string {
  const text = String(current || "");
  const normalizedBlock = String(block || "").trimEnd();
  if (!text.trim()) return `${normalizedBlock}\n`;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const insertIndex = lines.findIndex((line) => /^\s*(?:\[[^\[\]\r\n]+\]|\[\[[^\[\]\r\n]+\]\])\s*(?:#.*)?$/.test(line));
  if (insertIndex < 0) {
    return `${text.trimEnd()}${newline}${newline}${normalizedBlock.replace(/\n/g, newline)}${newline}`;
  }
  const before = lines.slice(0, insertIndex).join(newline).trimEnd();
  const after = lines.slice(insertIndex).join(newline);
  const prefix = before ? `${before}${newline}${newline}` : "";
  return `${prefix}${normalizedBlock.replace(/\n/g, newline)}${newline}${newline}${after}`;
}

export function removeGatewayProviderConfig(options: CodexPathOptions = {}): boolean {
  const file = configPath(options);
  if (!fs.existsSync(file)) return false;
  const current = fs.readFileSync(file, "utf8");
  const next = withoutGatewayProvider(current);
  if (next === current) return false;
  writeFilesTransaction([{ file, content: next }], () => {
    if (hasGatewayProvider(readText(file))) throw new Error("移除 Codexia Provider 后校验失败。");
  });
  return true;
}

export function withoutGatewayProvider(current: unknown): string {
  let next = String(current || "");
  if (/^\s*openai_base_url\s*=.*$/m.test(next)) {
    next = next.replace(/^\s*model_provider\s*=\s*"openai"\s*\r?\n?/m, "")
      .replace(/^\s*openai_base_url\s*=.*\r?\n?/m, "");
  }
  next = next
    .replace(/^\s*model_provider\s*=\s*"(?:codexia|codex_gateway)"\s*\r?\n?/m, "")
    .replace(/^\s*model_catalog_json\s*=.*models\.json.*\r?\n?/m, "")
    .replace(/\r?\n?\[model_providers\.(?:codexia|codex_gateway)\]\r?\n(?:[^\[\r\n].*\r?\n?)*/gm, "\n");
  next = next.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  return next;
}

function hasManagedModelCatalog(config: string): boolean {
  return /^\s*model_catalog_json\s*=.*models\.json.*$/m.test(config);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function detectCodexAuthMode(settings: Settings, accounts: AccountRecord[], options: CodexPathOptions = {}): AuthModeResult {
  const auth = readJsonSafe(authPath(options));
  const config = fs.existsSync(configPath(options)) ? fs.readFileSync(configPath(options), "utf8") : "";
  const localKey = String(settings.gateway_api_key || "").trim();
  const authKey = String(auth?.OPENAI_API_KEY || "").trim();
  if (authKey && localKey && authKey === localKey && hasGatewayProvider(config)) {
    return { mode: "gateway", accountId: "" };
  }

  const tokens = auth?.tokens || {};
  const tokenAccountId = String(tokens.account_id || "").trim();
  const refreshToken = String(tokens.refresh_token || "").trim();
  const accessToken = String(tokens.access_token || "").trim();
  if (auth?.auth_mode === "chatgpt" || refreshToken || accessToken || tokenAccountId) {
    const account = accounts.find((item) => {
      return (refreshToken && item.refresh_token === refreshToken)
        || (accessToken && item.access_token === accessToken)
        || (tokenAccountId && (item.account_id === tokenAccountId || item.workspace_id === tokenAccountId));
    });
    if (account) return { mode: "account", accountId: account.id };
  }

  return { mode: "unknown", accountId: "" };
}

export function repairConfigSpacing(options: CodexPathOptions = {}): boolean {
  const file = configPath(options);
  if (!fs.existsSync(file)) return false;
  const current = fs.readFileSync(file, "utf8");
  const next = current.replace(/("gpt-[^"\r\n]+"\s*=\s*"[^"\r\n]+")\s+(model_provider\s*=)/g, "$1\n$2");
  if (next === current) return false;
  writeFilesTransaction([{ file, content: next }]);
  return true;
}

function hasGatewayProvider(config: string): boolean {
  return /^\s*model_provider\s*=\s*"(?:codexia|codex_gateway)"\s*$/m.test(config)
    || /^\s*\[model_providers\.(?:codexia|codex_gateway)\]\s*$/m.test(config)
    || /^\s*openai_base_url\s*=.*$/m.test(config);
}

function useOpenaiBaseUrl(settings: Settings): boolean {
  return String(settings.codex_config_use_openai_base_url || "").trim() !== "false";
}

function readJsonSafe(file: string): any {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function ensureCodexDir(options: CodexPathOptions = {}): void {
  fs.mkdirSync(resolveCodexHome(options), { recursive: true });
}

function readText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeFilesTransaction(entries: FileEntry[], verify: () => void = () => {}): void {
  const transactionId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const staged = entries.map(({ file, content }) => ({
    file,
    target: resolveWriteTarget(file),
    content,
    temp: "",
    backup: "",
    existed: false,
    installed: false
  }));
  const targets = new Set<string>();
  for (const entry of staged) {
    const normalizedTarget = path.normalize(entry.target).toLowerCase();
    if (targets.has(normalizedTarget)) throw new Error(`Codex 文件写入目标重复：${entry.target}`);
    targets.add(normalizedTarget);
    entry.temp = `${entry.target}.tmp-${transactionId}`;
    entry.backup = `${entry.target}.bak-${transactionId}`;
    entry.existed = fs.existsSync(entry.target);
  }
  let committed = false;
  try {
    for (const entry of staged) {
      fs.mkdirSync(path.dirname(entry.target), { recursive: true });
      fs.writeFileSync(entry.temp, entry.content, { encoding: "utf8", mode: 0o600 });
    }
    for (const entry of staged) {
      if (entry.existed) fs.renameSync(entry.target, entry.backup);
      fs.renameSync(entry.temp, entry.target);
      entry.installed = true;
    }
    verify();
    committed = true;
  } catch (error) {
    for (const entry of [...staged].reverse()) {
      if (entry.installed) fs.rmSync(entry.target, { force: true });
      if (entry.existed && fs.existsSync(entry.backup)) fs.renameSync(entry.backup, entry.target);
    }
    throw error;
  } finally {
    for (const entry of staged) fs.rmSync(entry.temp, { force: true });
    if (committed) {
      for (const entry of staged) {
        try {
          fs.rmSync(entry.backup, { force: true });
        } catch {
          // A stale backup is safer than rolling back files that already passed verification.
        }
      }
    }
  }
}

function resolveWriteTarget(file: string): string {
  let current = path.resolve(file);
  const visited = new Set<string>();
  while (true) {
    const normalized = path.normalize(current).toLowerCase();
    if (visited.has(normalized)) throw new Error(`Codex 文件软链接存在循环：${file}`);
    visited.add(normalized);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isSymbolicLink()) return current;
      current = path.resolve(path.dirname(current), fs.readlinkSync(current));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return current;
      throw error;
    }
  }
}

function toIso(value: unknown): string {
  if (!value) return "";
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
