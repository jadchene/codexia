type Dynamic = any;

import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, safeStorage, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserDataDir } from "./paths.ts";
import { codexAccessOptions, createRuntimeProfile } from "./runtime-profile.ts";
import { acquireSingleInstanceChannel, closeSingleInstanceChannel } from "./single-instance.ts";
import { createStore } from "./store.ts";
import { createSecretCodec } from "./secret-codec.ts";
import { editableSettingsPatch, isTrustedRendererUrl, publicAccount, publicSettings } from "./renderer-boundary.ts";
import { createUsageRefreshCoordinator } from "./usage-refresh-coordinator.ts";
import { createGateway, buildAccountPoolQuotaSummary } from "./gateway.ts";
import { createMcpGatewayService } from "./mcp-gateway-service.ts";
import { createUpstreamService } from "./upstreams/upstream-service.ts";
import { createCodexModelCatalogService } from "./codex-model-catalog.ts";
import { createAuthService, accountFromTokens } from "./auth.ts";
import { normalizeUsagePayload, normalizeResetCreditsPayload } from "./quota.ts";
import {
  buildConsumeRequestBody,
  isConsumeSuccess,
  normalizeConsumeResult,
  parseStoredResetCredits,
  pickAvailableResetCredit,
  pickResetCreditById,
  requestResetCreditConsume
} from "./reset-credit.ts";
import { applyGatewayMode, applyAccountMode, detectCodexAuthMode, ensureProviderConfig } from "./codex-cli-auth.ts";
import type { IpcChannel, IpcContract } from "../shared/contracts/ipc.ts";
import { ipcArgumentSchemas } from "../shared/schemas/ipc.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const runtimeProfile = createRuntimeProfile({
  argv: process.argv,
  isPackaged: app.isPackaged,
  projectRoot: path.resolve(__dirname, "..", "..")
});
const activeBrowserDataDir = runtimeProfile.paths?.browserDataDir || browserDataDir();

fs.mkdirSync(activeBrowserDataDir, { recursive: true });
app.setPath("userData", activeBrowserDataDir);
app.setName(runtimeProfile.appName);
app.setAppUserModelId(runtimeProfile.appUserModelId);

const hasSingleInstanceLock = runtimeProfile.useSingleInstance
  ? app.requestSingleInstanceLock()
  : true;
if (!hasSingleInstanceLock) app.quit();

let mainWindow: Dynamic;
let store: Dynamic;
let gateway: Dynamic;
let mcpGateway: Dynamic;
let authService: Dynamic;
let upstreamService: Dynamic;
let modelCatalogService: Dynamic;
let tray: Dynamic;
let creatingTray = false;
let usageRefreshTimer: Dynamic = null;
let usageRefreshCoordinator: Dynamic = null;
let maintenanceTimer: Dynamic = null;
let singleInstanceServer: Dynamic = null;
const usageResetTimers = new Map<Dynamic, Dynamic>();
let shuttingDown = false;
let runtimeReady = false;
let showWindowWhenReady = false;
const STARTUP_DELAY_MS = 10_000;

function handleSecondInstance() {
  if (!runtimeReady) {
    showWindowWhenReady = true;
    return;
  }
  showMainWindow();
}

app.on("second-instance", handleSecondInstance);

const singleInstanceChannel = runtimeProfile.useSingleInstance && hasSingleInstanceLock
  ? acquireSingleInstanceChannel({ onSecondInstance: handleSecondInstance })
  : Promise.resolve({ primary: true, endpoint: null, server: null });

async function createWindow() {
  const bounds = readWindowBounds();
  const windowOptions = {
    width: bounds.width || 1180,
    height: bounds.height || 760,
    minWidth: 980,
    minHeight: 640,
    icon: await loadAppIcon(32),
    title: runtimeProfile.windowTitle,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
  if (bounds.x !== undefined) Object.assign(windowOptions, { x: bounds.x });
  if (bounds.y !== undefined) Object.assign(windowOptions, { y: bounds.y });
  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.webContents.on("will-navigate", (event: Dynamic, url: Dynamic) => {
    if (!trustedRendererUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  Menu.setApplicationMenu(null);
  bindWindowBoundsPersistence(mainWindow);

  if (!app.isPackaged && !runtimeProfile.isolated && process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else if (!app.isPackaged) {
    await mainWindow.loadURL(runtimeProfile.rendererDevOrigin);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "..", "..", "dist", "renderer", "index.html"));
  }
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  const channel = await singleInstanceChannel;
  if (!channel.primary) {
    shuttingDown = true;
    app.quit();
    return;
  }
  singleInstanceServer = channel.server;
  const secretCodec = createSecretCodec(safeStorage);
  const storeOptions = runtimeProfile.paths
    ? { secretCodec, dataDir: runtimeProfile.paths.dataDir, dbPath: runtimeProfile.paths.dbPath }
    : { secretCodec };
  store = createObservableStore(createStore(storeOptions));
  if (runtimeProfile.isolated) {
    const isolatedPaths = runtimeProfile.paths;
    if (!isolatedPaths) throw new Error("隔离开发配置缺少专用运行目录。");
    store.saveSettings(runtimeProfile.settingsOverrides);
    store.addAppLog({
      scope: "v1-dev",
      action: "isolated-profile",
      status: "active",
      message: `隔离开发模式已启用：${isolatedPaths.runtimeRoot}`
    });
  } else {
    if (runtimeProfile.rejectedPackagedFlag) {
      store.addAppLog({
        level: "error",
        scope: "security",
        action: "isolated-profile",
        status: "ignored",
        message: "打包应用忽略了 --isolated-dev 参数。"
      });
    }
  }
  store.runMaintenance();
  scheduleMaintenance();
  upstreamService = createUpstreamService({ db: store.db, secretCodec });
  usageRefreshCoordinator = createUsageRefreshCoordinator({
    listAccounts: () => store.listAccounts(),
    refreshAccount: refreshUsage,
    listBalanceUpstreams: () => upstreamService.list().filter(
      (upstream: Dynamic) => upstream.kind === "responses_api" && upstream.enabled && upstream.balanceQueryType !== "none"
    ),
    refreshBalance: (upstreamId: Dynamic) => upstreamService.refreshBalance(upstreamId),
    saveSettings: (patch: Dynamic) => store.saveSettings(patch),
    addLog: (entry: Dynamic) => store.addAppLog(entry),
    compactError,
    now: () => Date.now(),
    concurrency: 3
  });
  applyStartupLaunchSettings(store.getSettings());
  await waitForStartupDelay();
  if (runtimeProfile.allowLiveCodexAccess || runtimeProfile.paths?.codexDir) syncDetectedCodexAuthMode();
  authService = createAuthService(store, () => gateway.start(), refreshUsage);
  modelCatalogService = createCodexModelCatalogService({ db: store.db, dataDir: store.paths.dataDir });
  try {
    modelCatalogService.refreshBundled(true);
  } catch (error: Dynamic) {
    store.addAppLog({ level: "warn", scope: "models", action: "initial-refresh", status: "failed", message: error.message });
  }
  gateway = createGateway(store, authService, {
    refreshAllUsage,
    ensureUsableAccounts: () => refreshAllUsage("gateway-no-usable-account"),
    refreshAccountToken: refreshGatewayAccountToken,
    upstreamService
  });
  mcpGateway = createMcpGatewayService(store, { onStatusChanged: notifyMcpGatewayStatus });
  registerIpc();
  scheduleUsageRefresh("startup");
  const startedStartupRefreshAll = await checkUsageRefreshOnStartup();
  if (!startedStartupRefreshAll) await checkStaleQuotasOnStartup();
  if (runtimeProfile.allowServiceAutoStart && store.getSettings().auto_start_gateway === "true") {
    gateway.start().then(() => {
      store.addAppLog({ scope: "gateway", action: "auto-start", status: "success", message: "应用启动时自动启动 API 服务" });
      updateTrayMenu();
    }).catch((error: Dynamic) => {
      store.addAppLog({ level: "error", scope: "gateway", action: "auto-start", status: "failed", message: error.message });
    });
  }
  if (runtimeProfile.allowServiceAutoStart && store.getSettings().auto_start_mcp_gateway === "true") {
    mcpGateway.start().then((status: Dynamic) => {
      store.addAppLog({ scope: "mcp", action: "auto-start", status: "success", message: "应用启动时自动启动 MCP 服务" });
      notifyMcpGatewayStatus(status);
    }).catch((error: Dynamic) => {
      store.addAppLog({ level: "error", scope: "mcp", action: "auto-start", status: "failed", message: error.message });
    });
  }
  runtimeReady = true;
  if (isStartupHiddenLaunch() && !showWindowWhenReady) {
    store.addAppLog({
      scope: "app",
      action: "startup-hidden",
      status: "success",
      message: "开机自启时不显示主界面"
    });
    await createTray();
  } else {
    await createWindow();
    syncTrayForSettings();
  }
});

function createObservableStore(baseStore: Dynamic) {
  return {
    ...baseStore,
    saveAccount(account: Dynamic) {
      const result = baseStore.saveAccount(account);
      notifyDataChanged(["accounts"]);
      return result;
    },
    setAccountEnabled(id: Dynamic, enabled: Dynamic) {
      const result = baseStore.setAccountEnabled(id, enabled);
      notifyDataChanged(["accounts"]);
      return result;
    },
    deleteAccount(id: Dynamic) {
      const result = baseStore.deleteAccount(id);
      notifyDataChanged(["accounts"]);
      return result;
    },
    updateUsage(id: Dynamic, usage: Dynamic) {
      const result = baseStore.updateUsage(id, usage);
      notifyDataChanged(["accounts"]);
      return result;
    },
    addTokenLog(entry: Dynamic) {
      const result = baseStore.addTokenLog(entry);
      notifyDataChanged(["tokenLogs", "tokenSummary"]);
      return result;
    },
    clearTokenLogs() {
      const result = baseStore.clearTokenLogs();
      notifyDataChanged(["tokenLogs", "tokenSummary"]);
      return result;
    },
    addAppLog(entry: Dynamic) {
      const result = baseStore.addAppLog(entry);
      notifyDataChanged(["appLogs"]);
      return result;
    },
    clearAppLogs() {
      const result = baseStore.clearAppLogs();
      notifyDataChanged(["appLogs"]);
      return result;
    }
  };
}

async function waitForStartupDelay() {
  if (!process.argv.includes("--startup-delayed")) return;
  store.addAppLog({
    scope: "app",
    action: "startup-delay",
    status: "start",
    message: `开机延迟启动：等待 ${Math.round(STARTUP_DELAY_MS / 1000)} 秒`
  });
  await new Promise((resolve) => setTimeout(resolve, STARTUP_DELAY_MS));
  store.addAppLog({
    scope: "app",
    action: "startup-delay",
    status: "success",
    message: "开机延迟启动等待完成"
  });
}

function isStartupHiddenLaunch() {
  if (runtimeProfile.isolated) return false;
  return process.argv.includes("--startup-hidden") || process.argv.includes("--startup-delayed");
}

function applyStartupLaunchSettings(settings: Dynamic) {
  if (!runtimeProfile.allowStartupIntegration) return;
  const mode = normalizeStartupLaunchMode(settings.startup_launch);
  const openAtLogin = mode !== "disabled";
  const args = mode === "delayed"
    ? ["--startup-hidden", "--startup-delayed"]
    : mode === "auto"
      ? ["--startup-hidden"]
      : [];
  try {
    app.setLoginItemSettings({
      openAtLogin,
      openAsHidden: openAtLogin,
      args
    });
    store?.addAppLog({
      scope: "app",
      action: "startup-launch",
      status: "success",
      message: `已同步开机自启设置：${startupLaunchLabel(mode)}`
    });
  } catch (error: Dynamic) {
    store?.addAppLog({
      level: "error",
      scope: "app",
      action: "startup-launch",
      status: "failed",
      message: `同步开机自启设置失败：${error.message}`
    });
  }
}

function normalizeStartupLaunchMode(value: Dynamic) {
  if (value === "auto" || value === "delayed") return value;
  return "disabled";
}

function startupLaunchLabel(mode: Dynamic) {
  if (mode === "auto") return "自动";
  if (mode === "delayed") return "自动(延迟)";
  return "关闭";
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event: Dynamic) => {
  if (shuttingDown) return;
  event.preventDefault();
  requestAppExit("app-before-quit");
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow();
});

process.once("SIGINT", () => {
  shutdownRuntime("sigint").finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  shutdownRuntime("sigterm").finally(() => process.exit(0));
});

process.once("uncaughtException", (error) => {
  console.error(error);
  shutdownRuntime("uncaught-exception", error).finally(() => process.exit(1));
});

process.once("unhandledRejection", (reason) => {
  console.error(reason);
  shutdownRuntime("unhandled-rejection", reason).finally(() => process.exit(1));
});

function registerIpc() {
  handleIpc("app:bootstrap", () => ({
    app: {
      version: app.getVersion()
    },
    settings: publicSettings(store.getSettings()),
    accounts: publicAccounts(),
    tokenLogs: store.listTokenLogs(),
    tokenSummary: store.tokenSummary(),
    quotaSummary: gatewayQuotaSummary(),
    appLogs: store.listAppLogs(),
    gateway: gateway.status(),
    mcpGateway: mcpGateway.status(),
    paths: store.paths
  }));
  handleIpc("settings:save", (_event, patch) => {
    const editablePatch = editableSettingsPatch(patch);
    if (!editablePatch.gateway_api_key) delete editablePatch.gateway_api_key;
    const settings = store.saveSettings({
      ...editablePatch,
      ...runtimeProfile.settingsOverrides
    });
    applyStartupLaunchSettings(settings);
    scheduleUsageRefresh("settings-save");
    syncTrayForSettings();
    return publicSettings(settings);
  });
  handleIpc("accounts:setEnabled", (_event, id, enabled) => {
    store.setAccountEnabled(id, enabled);
    if (!enabled) clearUsageResetTimer(id, "account-disabled");
    return publicAccounts();
  });
  handleIpc("accounts:delete", (_event, id) => {
    store.deleteAccount(id);
    clearUsageResetTimer(id, "account-deleted");
    return publicAccounts();
  });
  handleIpc("accounts:list", () => publicAccounts());
  handleIpc("upstreams:list", () => upstreamService.list());
  handleIpc("upstreams:models", (_event, upstreamId) => upstreamService.listModels(upstreamId));
  handleIpc("upstreams:gatewayModels", () => upstreamService.listGatewayModelOptions());
  handleIpc("upstreams:save", (_event, input) => {
    const result = upstreamService.save(input);
    modelCatalogService.refresh();
    notifyDataChanged(["upstreams", "upstreamModels"]);
    return result;
  });
  handleIpc("upstreams:delete", (_event, upstreamId) => {
    const result = upstreamService.delete(upstreamId);
    modelCatalogService.refresh();
    notifyDataChanged(["upstreams", "upstreamModels"]);
    return result;
  });
  handleIpc("upstreams:refreshBalance", async (_event, upstreamId) => {
    const result = await upstreamService.refreshBalance(upstreamId);
    notifyDataChanged(["upstreams"]);
    return result;
  });
  handleIpc("upstreams:refreshBuiltinModels", () => {
    const result = modelCatalogService.refreshBundled();
    notifyDataChanged(["upstreams", "upstreamModels"]);
    return result;
  });
  handleIpc("upstreams:saveModelPricing", (_event, upstreamId, pricing) => {
    const result = upstreamService.saveModelPricing(upstreamId, pricing);
    notifyDataChanged(["upstreams", "upstreamModels"]);
    return result;
  });
  handleIpc("upstreams:testConnection", async (_event, upstreamId) => {
    const result = await upstreamService.testConnection(upstreamId);
    notifyDataChanged(["upstreams"]);
    return result;
  });
  handleIpc("upstreams:testInvocation", async (_event, upstreamId, modelId) => {
    const result = await upstreamService.testInvocation(upstreamId, modelId);
    store.addAppLog({
      level: result.ok ? "info" : "warn",
      scope: "upstream",
      action: "invocation-test",
      status: result.ok ? "success" : `http_${result.status}`,
      message: `API 上游调用测试：${result.upstreamId} / ${result.modelId} / ${result.message}`
    });
    notifyDataChanged(["upstreams", "appLogs"]);
    return result;
  });
  handleIpc("tokens:list", (_event, query) => store.listTokenLogs(query));
  handleIpc("tokens:summary", (_event, query) => store.tokenSummary(query));
  handleIpc("quota:summary", () => gatewayQuotaSummary());
  handleIpc("tokens:clear", () => {
    const result = store.clearTokenLogs();
    store.addAppLog({
      scope: "logs",
      action: "clear-token-logs",
      status: "success",
      message: `已清空调用记录：${result.deleted} 条`
    });
    return result;
  });
  handleIpc("appLogs:list", (_event, query) => store.listAppLogs(query));
  handleIpc("appLogs:clear", () => store.clearAppLogs());
  handleIpc("gateway:start", async () => {
    return startGateway("manual");
  });
  handleIpc("gateway:stop", async () => {
    return stopGateway("manual");
  });
  handleIpc("mcpGateway:start", async () => {
    return startMcpGateway("manual");
  });
  handleIpc("mcpGateway:stop", async () => {
    return stopMcpGateway("manual");
  });
  handleIpc("codexAuth:applyGatewayMode", () => {
    const settings = store.getSettings();
    modelCatalogService.refresh();
    const result = applyGatewayMode(settings, gatewayCodexOptions());
    store.saveSettings({ codex_auth_mode: "gateway", codex_selected_account_id: "" });
    store.addAppLog({ scope: "auth", action: "apply-gateway", status: "success", message: "已写入 Codex API 模式认证" });
    return result;
  });
  handleIpc("codexAuth:applyAccountMode", (_event, accountId) => {
    const account = store.listAccounts().find((item: Dynamic) => item.id === accountId);
    if (!account) throw new Error("账号不存在。");
    const result = applyAccountMode(account, codexAccessOptions(runtimeProfile));
    store.saveSettings({ codex_auth_mode: "account", codex_selected_account_id: account.id });
    store.addAppLog({ scope: "auth", action: "apply-account", status: "success", message: `已写入 Codex 账号模式认证：${account.name}` });
    return result;
  });
  handleIpc("auth:startLogin", async () => {
    const result = await authService.startLogin();
    await shell.openExternal(result.authUrl);
    return result;
  });
  handleIpc("auth:status", (_event, loginId) => authService.loginStatus(loginId));
  handleIpc("auth:cancelLogin", (_event, loginId) => authService.cancelLogin(loginId));
  handleIpc("accounts:refreshUsage", async (_event, id) => {
    const result = await refreshUsage(id);
    store.addAppLog({ scope: "usage", action: "refresh-account", status: "success", message: `已刷新账号额度：${result.name}` });
    return publicAccount(result);
  });
  handleIpc("accounts:refreshAllUsage", async () => refreshAllUsage("manual"));
  handleIpc("accounts:consumeResetCredit", async (_event, id, creditId) => {
    const result = await consumeResetCredit(id, creditId);
    notifyDataChanged(["accounts"]);
    return result;
  });
  handleIpc("accounts:importLocalCodex", async () => publicAccount(await importLocalCodexAccount()));
}

function handleIpc<Channel extends IpcChannel>(
  channel: Channel,
  listener: (event: Dynamic, ...args: IpcContract[Channel]["args"]) => Dynamic
) {
  ipcMain.handle(channel, (event: Dynamic, ...rawArgs: Dynamic[]) => {
    if (!trustedRendererUrl(event.senderFrame?.url || "")) {
      throw new Error(`拒绝来自非应用页面的 IPC 调用：${channel}`);
    }
    const schema = ipcArgumentSchemas[channel] as { parse: (value: unknown) => unknown };
    const args = schema.parse(rawArgs) as IpcContract[Channel]["args"];
    return listener(event, ...args);
  });
}

function trustedRendererUrl(value: Dynamic) {
  return isTrustedRendererUrl(value, {
    packaged: app.isPackaged,
    devOrigin: runtimeProfile.rendererDevOrigin,
    indexFile: path.resolve(__dirname, "..", "..", "dist", "renderer", "index.html")
  });
}

function publicAccounts() {
  return store.listAccounts().map(publicAccount);
}

function gatewayQuotaSummary() {
  const settings = store.getSettings();
  return buildAccountPoolQuotaSummary(store.listAccounts(), undefined, {
    ignoreFiveHourLimit: settings.ignore_five_hour_limit === "true"
  });
}

async function startGateway(reason: Dynamic = "manual") {
  const catalog = modelCatalogService.refresh();
  if (store.getSettings().codex_auth_mode === "gateway") {
    ensureProviderConfig(store.getSettings(), gatewayCodexOptions());
  }
  const status = await gateway.start();
  store.addAppLog({
    scope: "gateway",
    action: reason === "tray" ? "tray-start" : "start",
    status: "success",
    message: `${reason === "tray" ? "托盘菜单启动 API 服务" : "API 服务已启动"}；模型目录 ${catalog.totalCount} 个`
  });
  updateTrayMenu();
  notifyGatewayStatus(status);
  return status;
}

function gatewayCodexOptions() {
  return { ...codexAccessOptions(runtimeProfile), modelCatalogPath: modelCatalogService.path };
}

async function stopGateway(reason: Dynamic = "manual") {
  const status = await gateway.stop();
  store.addAppLog({
    scope: "gateway",
    action: reason === "tray" ? "tray-stop" : "stop",
    status: "success",
    message: reason === "tray" ? "托盘菜单停止 API 服务" : "API 服务已停止"
  });
  updateTrayMenu();
  notifyGatewayStatus(status);
  return status;
}

async function startMcpGateway(reason: Dynamic = "manual") {
  const status = await mcpGateway.start();
  store.addAppLog({
    scope: "mcp",
    action: "start",
    status: "success",
    message: reason === "manual" ? "MCP 服务已启动" : `${reason}: MCP 服务已启动`
  });
  notifyMcpGatewayStatus(status);
  return status;
}

async function stopMcpGateway(reason: Dynamic = "manual") {
  const status = await mcpGateway.stop();
  store.addAppLog({
    scope: "mcp",
    action: "stop",
    status: "success",
    message: reason === "manual" ? "MCP 服务已停止" : `${reason}: MCP 服务已停止`
  });
  notifyMcpGatewayStatus(status);
  return status;
}

async function importLocalCodexAccount() {
  const codexOptions = codexAccessOptions(runtimeProfile);
  const file = path.join(codexOptions.codexDir || path.join(os.homedir(), ".codex"), "auth.json");
  if (!fs.existsSync(file)) throw new Error(`未找到 ${file}`);
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error: Dynamic) {
    throw new Error(`auth.json 解析失败：${error.message}`);
  }
  const source = auth.tokens || auth;
  const tokens = {
    id_token: String(source.id_token || ""),
    access_token: String(source.access_token || ""),
    refresh_token: String(source.refresh_token || ""),
    account_id: String(source.account_id || "")
  };
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("auth.json 不是有效的 Codex 账号模式认证，缺少 access_token 或 refresh_token。");
  }
  if (auth.OPENAI_API_KEY && !auth.auth_mode && !auth.tokens) {
    throw new Error("当前 auth.json 是 API 模式，不是 Codex 账号模式。");
  }
  const account: Dynamic = {
    ...accountFromTokens(tokens),
    last_refresh: auth.last_refresh || new Date().toISOString(),
    note: "local codex auth.json"
  };
  if (tokens.account_id && !account.account_id) {
    account.account_id = tokens.account_id;
    account.workspace_id = tokens.account_id;
  }
  const saved = store.saveAccount(account);
  store.addAppLog({
    scope: "auth",
    action: "import-local-codex",
    status: "success",
    message: `已从 ~/.codex/auth.json 导入账号：${saved.name}`
  });
  try {
    const refreshed = await refreshUsage(saved.id);
    store.addAppLog({
      scope: "usage",
      action: "refresh-account",
      status: "success",
      message: `导入本地账号后已刷新额度：${refreshed.name}`
    });
    return refreshed;
  } catch (error: Dynamic) {
    store.addAppLog({
      level: "error",
      scope: "usage",
      action: "refresh-account",
      status: "failed",
      message: `导入本地账号后刷新额度失败：${saved.name}: ${compactError(error.message)}`
    });
    return saved;
  }
}

function notifyGatewayStatus(status: Dynamic = gateway?.status()) {
  if (!status || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("gateway:status-changed", status);
}

function notifyMcpGatewayStatus(status: Dynamic = mcpGateway?.status()) {
  if (!status || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("mcpGateway:status-changed", status);
}

function notifyDataChanged(types: Dynamic) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("app:data-changed", Array.from(new Set(types)));
}

async function createTray() {
  if (tray || creatingTray) return tray;
  creatingTray = true;
  const image = await loadAppIcon();
  if (tray) {
    creatingTray = false;
    return tray;
  }
  tray = new Tray(image);
  tray.setToolTip(runtimeProfile.trayToolTip);
  tray.on("double-click", showMainWindow);
  updateTrayMenu();
  creatingTray = false;
  return tray;
}

async function loadAppIcon(size = 16) {
  const bundledIcon = nativeImage.createFromPath(path.join(__dirname, "..", "..", "assets", "app-icon.png"));
  if (!bundledIcon.isEmpty()) return bundledIcon.resize({ width: size, height: size, quality: "best" });
  try {
    const image = await app.getFileIcon(process.execPath, { size: "normal" });
    if (image && !image.isEmpty()) return image.resize({ width: size, height: size, quality: "best" });
  } catch (error: Dynamic) {
    if (store) {
      store.addAppLog({ scope: "app", action: "tray-icon", status: "failed", message: `读取应用图标失败：${error.message}` });
    }
  }
  return nativeImage.createEmpty();
}

function syncTrayForSettings() {
  if (!store) return;
  if (store.getSettings().close_behavior === "tray") {
    void createTray();
  } else if (tray) {
    tray.destroy();
    tray = null;
  }
}

function updateTrayMenu() {
  if (!tray || !gateway) return;
  const running = gateway.status().running;
  const menu = Menu.buildFromTemplate([
    {
      label: running ? "停止 API 服务" : "启动 API 服务",
      click: () => {
        const task = running ? stopGateway("tray") : startGateway("tray");
        task.catch((error) => {
          store.addAppLog({
            level: "error",
            scope: "gateway",
            action: running ? "tray-stop" : "tray-start",
            status: "failed",
            message: error.message
          });
          updateTrayMenu();
        });
      }
    },
    { label: "退出", click: () => requestAppExit("tray-exit") }
  ]);
  tray.setContextMenu(menu);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow().catch((error) => {
      store?.addAppLog({ level: "error", scope: "app", action: "show-window", status: "failed", message: error.message });
    });
    return;
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function requestAppExit(reason: Dynamic) {
  shutdownRuntime(reason).finally(() => app.exit(0));
}

function syncDetectedCodexAuthMode() {
  const accounts = store.listAccounts();
  const detected = detectCodexAuthMode(store.getSettings(), accounts, codexAccessOptions(runtimeProfile));
  store.saveSettings({
    codex_auth_mode: detected.mode,
    codex_selected_account_id: detected.accountId || ""
  });
  const account = detected.accountId ? accounts.find((item: Dynamic) => item.id === detected.accountId) : null;
  const message = detected.mode === "account"
    ? `启动时识别 Codex 认证模式：账号模式${account ? `（${account.email || account.name}）` : ""}`
    : detected.mode === "gateway"
      ? "启动时识别 Codex 认证模式：API 模式"
      : "启动时识别 Codex 认证模式：未知";
  store.addAppLog({
    scope: "auth",
    action: "detect-startup",
    status: detected.mode,
    message
  });
}

async function shutdownRuntime(reason: Dynamic, error?: Dynamic) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (usageRefreshTimer) {
    clearInterval(usageRefreshTimer);
    usageRefreshTimer = null;
    if (store) {
      store.addAppLog({
        scope: "usage",
        action: "timer-stop",
        status: reason,
        message: `退出时停止账号额度定时刷新任务：${reason}`
      });
    }
  }
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
  clearAllUsageResetTimers(reason);
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (store) {
    store.addAppLog({
      level: error ? "error" : "info",
      scope: "app",
      action: "shutdown",
      status: reason,
      message: error ? `应用退出清理：${reason}；${String(error?.message || error)}` : `应用退出清理：${reason}`
    });
  }
  if (authService?.stop) {
    try {
      await authService.stop();
    } catch (stopError: Dynamic) {
      if (store) {
        store.addAppLog({
          level: "error",
          scope: "auth",
          action: "login-server-stop",
          status: "failed",
          message: `退出时关闭登录回调服务失败：${stopError.message}`
        });
      }
    }
  }
  if (gateway) {
    try {
      const wasRunning = gateway.status().running;
      await gateway.stop();
      if (store && wasRunning) {
        store.addAppLog({
          scope: "gateway",
          action: "stop",
          status: reason,
          message: `退出时停止 API 服务：${reason}`
        });
      }
    } catch (stopError: Dynamic) {
      if (store) {
        store.addAppLog({
          level: "error",
          scope: "gateway",
          action: "stop",
          status: "failed",
          message: `退出时关闭 API 服务失败：${stopError.message}`
        });
      }
    }
  }
  if (mcpGateway) {
    try {
      const wasRunning = mcpGateway.status().running;
      await mcpGateway.stop();
      if (store && wasRunning) {
        store.addAppLog({
          scope: "mcp",
          action: "stop",
          status: reason,
          message: `退出时停止 MCP 服务：${reason}`
        });
      }
    } catch (stopError: Dynamic) {
      if (store) {
        store.addAppLog({
          level: "error",
          scope: "mcp",
          action: "stop",
          status: "failed",
          message: `退出时关闭 MCP 服务失败：${stopError.message}`
        });
      }
    }
  }
  const closingSingleInstanceServer = singleInstanceServer;
  singleInstanceServer = null;
  await closeSingleInstanceChannel(closingSingleInstanceServer);
}

function readWindowBounds() {
  if (!store) return {};
  const settings = store.getSettings();
  return {
    x: numberOrUndefined(settings.window_x),
    y: numberOrUndefined(settings.window_y),
    width: numberOrUndefined(settings.window_width),
    height: numberOrUndefined(settings.window_height)
  };
}

function numberOrUndefined(value: Dynamic) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function bindWindowBoundsPersistence(win: Dynamic) {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    saveMainWindowBounds(win);
  };
  const schedule = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 250);
    saveTimer.unref?.();
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("close", (event: Dynamic) => {
    if (!store || win.isDestroyed()) return;
    flush();
    if (!shuttingDown && store.getSettings().close_behavior === "tray") {
      event.preventDefault();
      void createTray();
      win.hide();
      store.addAppLog({
        scope: "app",
        action: "close-window",
        status: "tray",
        message: "关闭窗口时最小化到托盘"
      });
    }
  });
  win.on("closed", () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
  });
}

function saveMainWindowBounds(win: Dynamic = mainWindow) {
  if (!store || !win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  store.saveSettings({
    window_x: String(bounds.x),
    window_y: String(bounds.y),
    window_width: String(bounds.width),
    window_height: String(bounds.height)
  });
}

function scheduleUsageRefresh(reason: Dynamic = "settings-save") {
  if (usageRefreshTimer) {
    clearInterval(usageRefreshTimer);
    usageRefreshTimer = null;
    store.addAppLog({
      scope: "usage",
      action: "timer-stop",
      status: reason,
      message: `停止账号额度与渠道余额定时刷新任务：${reason}`
    });
  }
  const settings = store.getSettings();
  const intervalSecs = Number(settings.usage_refresh_interval_secs || 900);
  if (!Number.isFinite(intervalSecs) || intervalSecs <= 0) {
    store.addAppLog({
      scope: "usage",
      action: "timer-disabled",
      status: reason,
      message: `账号额度与渠道余额定时刷新任务未启动：间隔为 ${settings.usage_refresh_interval_secs || 0}`
    });
    return;
  }
  const effectiveIntervalSecs = Math.max(60, intervalSecs);
  usageRefreshTimer = setInterval(() => {
    refreshAllUsage("timer").catch((error: Dynamic) => {
      store.addAppLog({
        level: "error",
        scope: "usage",
        action: "timer-refresh",
        status: "failed",
        message: error.message
      });
    });
  }, effectiveIntervalSecs * 1000);
  store.addAppLog({
    scope: "usage",
    action: "timer-start",
    status: reason,
    message: `启动账号额度与渠道余额定时刷新任务：每 ${effectiveIntervalSecs} 秒`
  });
}

function scheduleMaintenance() {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  maintenanceTimer = setInterval(() => {
    try {
      const result = store.runMaintenance();
      if (result.requestLogsDeleted || result.appLogsDeleted || result.loginSessionsDeleted) {
        store.addAppLog({
          scope: "storage",
          action: "retention-cleanup",
          status: "success",
          message: `自动清理：调用记录 ${result.requestLogsDeleted}，运行日志 ${result.appLogsDeleted}，登录会话 ${result.loginSessionsDeleted}`
        });
      }
    } catch (error: Dynamic) {
      store.addAppLog({ level: "error", scope: "storage", action: "retention-cleanup", status: "failed", message: error.message });
    }
  }, 24 * 60 * 60 * 1000);
  maintenanceTimer.unref?.();
}

async function checkUsageRefreshOnStartup() {
  const settings = store.getSettings();
  const intervalSecs = Number(settings.usage_refresh_interval_secs || 900);
  if (!Number.isFinite(intervalSecs) || intervalSecs <= 0) {
    store.addAppLog({
      scope: "usage",
      action: "startup-refresh-check",
      status: "disabled",
      message: `启动时跳过账号额度补刷检查：间隔为 ${settings.usage_refresh_interval_secs || 0}`
    });
    return false;
  }
  const effectiveIntervalSecs = Math.max(60, intervalSecs);
  const now = Math.floor(Date.now() / 1000);
  const lastRefreshAt = Number(store.getLastRefreshAllUsageAt?.() || 0);
  if (lastRefreshAt > 0 && now - lastRefreshAt < effectiveIntervalSecs) {
    store.addAppLog({
      scope: "usage",
      action: "startup-refresh-check",
      status: "fresh",
      message: `启动时账号额度与渠道余额无需补刷：上次刷新全部额度时间 ${formatTime(lastRefreshAt)}`
    });
    return false;
  }
  const elapsed = lastRefreshAt > 0 ? `${now - lastRefreshAt} 秒` : "无记录";
  store.addAppLog({
    scope: "usage",
    action: "startup-refresh-check",
    status: "start",
    message: `启动时检测到刷新全部额度已超过配置间隔，开始自动刷新：上次刷新 ${elapsed}，间隔 ${effectiveIntervalSecs} 秒`
  });
  try {
    await refreshAllUsage("startup-expired");
  } catch (error: Dynamic) {
    store.addAppLog({
      level: "error",
      scope: "usage",
      action: "startup-refresh-check",
      status: "failed",
      message: `启动时自动刷新全部额度失败：${compactError(error.message)}`
    });
  }
  return true;
}

async function checkStaleQuotasOnStartup() {
  const now = Math.floor(Date.now() / 1000);
  const accounts = store.listAccounts().filter((account: Dynamic) => account.enabled && account.access_token);
  const refreshes = [];
  for (const account of accounts) {
    const fiveHourUsed = Number(account.quota_5h_used_percent || 0);
    const sevenDayUsed = Number(account.quota_7d_used_percent || 0);
    const fiveHourResetAt = Number(account.quota_5h_reset_at || 0);
    const sevenDayResetAt = Number(account.quota_7d_reset_at || 0);

    const fiveHourStale = fiveHourUsed >= 100 && fiveHourResetAt > 0 && fiveHourResetAt < now;
    const sevenDayStale = sevenDayUsed >= 100 && sevenDayResetAt > 0 && sevenDayResetAt < now;

    if (fiveHourStale || sevenDayStale) {
      store.addAppLog({
        scope: "usage",
        action: "startup-stale-refresh",
        status: "start",
        message: `启动时检测到账号额度已过重置时间，开始自动刷新：${account.email || account.name || account.id}`
      });
      refreshes.push(refreshUsage(account.id).catch((error) => {
        store.addAppLog({
          level: "error",
          scope: "usage",
          action: "startup-stale-refresh",
          status: "failed",
          message: `启动时自动刷新过期账号额度失败：${account.email || account.name || account.id}: ${compactError(error.message)}`
        });
      }));
    }
  }
  await Promise.all(refreshes);
}

async function refreshUsage(id: Dynamic) {
  let account = store.listAccounts().find((item: Dynamic) => item.id === id);
  if (!account) throw new Error("Account not found.");
  const endpoints = [
    "https://chatgpt.com/backend-api/wham/usage"
    // "https://chatgpt.com/backend-api/codex/usage" currently returns 403 HTML for account tokens.
  ];
  const resetCreditsEndpoint = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const endpoint of endpoints) {
      try {
        const [usagePayload, resetCreditsPayload] = await Promise.all([
          requestJson(endpoint, account),
          requestJson(resetCreditsEndpoint, account)
        ]);
        const usage = {
          ...normalizeUsagePayload(usagePayload),
          ...normalizeResetCreditsPayload(resetCreditsPayload)
        };
        store.updateUsage(id, usage);
        const refreshed = store.listAccounts().find((item: Dynamic) => item.id === id);
        scheduleUsageResetRefresh(refreshed, "usage-refresh");
        return refreshed;
      } catch (error) {
        lastError = error;
      }
    }
    if (!shouldRefreshForUsageError(lastError) || !account.refresh_token) break;
    try {
      const refreshed = await refreshAccessToken(account);
      account = store.saveAccount({ ...account, ...refreshed });
    } catch (refreshError: Dynamic) {
      throw new Error(`刷新 token 失败：${refreshError.message}`);
    }
  }
  throw lastError || new Error("Usage refresh failed.");
}

const pendingResetCreditConsumes = new Set<string>();

async function consumeResetCredit(accountId: Dynamic, creditId: Dynamic = "") {
  if (pendingResetCreditConsumes.has(accountId)) {
    throw new Error("该账号正在使用重置卡，请稍候。");
  }
  pendingResetCreditConsumes.add(accountId);
  try {
    let account = store.listAccounts().find((item: Dynamic) => item.id === accountId);
    if (!account) throw new Error("Account not found.");
    if (!account.access_token) throw new Error("账号缺少访问令牌，请先重新登录。");
    const storedCredits = parseStoredResetCredits(account.reset_credits_json);
    // 用户选定卡：始终以该 credit_id 请求（本地列表过期也不阻断，服务器为准）；
    // 未指定卡：回退为最早过期的可用卡。
    const credit = creditId
      ? pickResetCreditById(storedCredits, creditId) ?? { id: String(creditId).trim() }
      : pickAvailableResetCredit(storedCredits);
    // 幂等键与选卡在重试间保持不变，避免重复消耗。
    const body = buildConsumeRequestBody(credit);
    const endpoint = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
    let lastError: Dynamic = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const payload = await requestResetCreditConsume({
          endpoint,
          account,
          body,
          timeoutMs: usageRefreshTimeoutMs()
        });
        const result = normalizeConsumeResult(payload);
        if (result.status === "error") {
          lastError = new Error(result.message);
          continue;
        }
        const label = account.email || account.name || account.id;
        if (isConsumeSuccess(result.status)) {
          let refreshed: Dynamic = account;
          try {
            refreshed = await refreshUsage(account.id);
          } catch (refreshError: Dynamic) {
            store.addAppLog({
              level: "warn",
              scope: "usage",
              action: "consume-reset-credit",
              status: "refresh-failed",
              message: `重置卡已使用，但额度刷新失败：${label}（${refreshError.message}），请稍后手动刷新`
            });
          }
          store.addAppLog({
            scope: "usage",
            action: "consume-reset-credit",
            status: result.status,
            message: `账号已使用重置卡：${refreshed.email || refreshed.name || refreshed.id}（${result.message}）`
          });
          return { status: result.status, message: result.message, account: publicAccount(refreshed) };
        }
        store.addAppLog({
          scope: "usage",
          action: "consume-reset-credit",
          status: result.status,
          message: `账号使用重置卡未消耗：${label}（${result.message}）`
        });
        return { status: result.status, message: result.message, account: publicAccount(account) };
      } catch (error) {
        lastError = error;
        if (attempt > 0) break;
        if (shouldRefreshForUsageError(error) && account.refresh_token) {
          try {
            const refreshedTokens = await refreshAccessToken(account);
            account = store.saveAccount({ ...account, ...refreshedTokens });
          } catch (refreshError: Dynamic) {
            throw new Error(`刷新 token 失败：${refreshError.message}`);
          }
        }
      }
    }
    throw lastError || new Error("使用重置卡失败。");
  } finally {
    pendingResetCreditConsumes.delete(accountId);
  }
}

function scheduleUsageResetRefresh(account: Dynamic, reason: Dynamic = "usage-refresh") {
  if (!account?.id) return;
  const settings = store.getSettings();
  if (settings.ignore_five_hour_limit === "true") {
    clearUsageResetTimer(account.id, "ignore-five-hour");
    return;
  }
  const label = account.email || account.name || account.id;
  const fiveHourUsed = Number(account.quota_5h_used_percent || 0);
  const sevenDayUsed = Number(account.quota_7d_used_percent || 0);
  const resetAt = Number(account.quota_5h_reset_at || 0);
  if (!(fiveHourUsed >= 100 && sevenDayUsed < 100 && resetAt > 0 && account.enabled)) {
    clearUsageResetTimer(account.id, "quota-available");
    return;
  }
  const existing = usageResetTimers.get(account.id);
  if (existing?.resetAt === resetAt) return;
  if (existing) {
    clearTimeout(existing.timer);
    usageResetTimers.delete(account.id);
    store.addAppLog({
      scope: "usage",
      action: "reset-refresh-reschedule",
      status: reason,
      message: `账号 5 小时额度重置刷新任务已重新计划：${label}，${formatTime(resetAt)} 后 1 分钟`
    });
  }
  const delayMs = Math.max(1000, resetAt * 1000 + 60_000 - Date.now());
  const timer = setTimeout(() => {
    usageResetTimers.delete(account.id);
    store.addAppLog({
      scope: "usage",
      action: "reset-refresh-run",
      status: "start",
      message: `开始执行 5 小时额度重置后账号刷新：${label}`
    });
    refreshUsage(account.id)
      .then((refreshed) => {
        store.addAppLog({
          scope: "usage",
          action: "reset-refresh-run",
          status: "success",
          message: `已执行 5 小时额度重置后账号刷新：${refreshed.email || refreshed.name || refreshed.id}`
        });
      })
      .catch((error) => {
        store.addAppLog({
          level: "error",
          scope: "usage",
          action: "reset-refresh-run",
          status: "failed",
          message: `5 小时额度重置后账号刷新失败：${label}: ${compactError(error.message)}`
        });
      });
  }, delayMs);
  usageResetTimers.set(account.id, { timer, resetAt });
  store.addAppLog({
    scope: "usage",
    action: "reset-refresh-schedule",
    status: reason,
    message: `账号 5 小时额度已用满，已计划在重置时间后 1 分钟自动刷新：${label}，${formatTime(resetAt)}`
  });
}

function clearUsageResetTimer(accountId: Dynamic, reason: Dynamic = "clear") {
  const existing = usageResetTimers.get(accountId);
  if (!existing) return;
  clearTimeout(existing.timer);
  usageResetTimers.delete(accountId);
  if (store) {
    store.addAppLog({
      scope: "usage",
      action: "reset-refresh-stop",
      status: reason,
      message: `停止账号 5 小时额度重置刷新任务：${accountId}，${reason}`
    });
  }
}

function clearAllUsageResetTimers(reason: Dynamic = "shutdown") {
  const count = usageResetTimers.size;
  for (const { timer } of usageResetTimers.values()) clearTimeout(timer);
  usageResetTimers.clear();
  if (store && count > 0) {
    store.addAppLog({
      scope: "usage",
      action: "reset-refresh-stop-all",
      status: reason,
      message: `停止全部账号 5 小时额度重置刷新任务：${count} 个，${reason}`
    });
  }
}

function formatTime(epochSeconds: Dynamic) {
  return new Date(Number(epochSeconds) * 1000).toLocaleString("zh-CN", { hour12: false });
}

function refreshAllUsage(reason: Dynamic = "manual") {
  return usageRefreshCoordinator.refreshAll(reason);
}

function compactError(value: Dynamic) {
  return String(value || "").replace(/\s+/g, " ").slice(0, 360);
}

async function refreshGatewayAccountToken(accountId: Dynamic) {
  const account = store.listAccounts().find((item: Dynamic) => item.id === accountId);
  if (!account) throw new Error("Account not found.");
  if (!account.refresh_token) throw new Error("Account has no refresh token.");
  const refreshed = await refreshAccessToken(account);
  const saved = store.saveAccount({ ...account, ...refreshed });
  store.addAppLog({
    scope: "gateway",
    action: "refresh-token",
    status: "success",
    message: `API 服务请求前刷新账号 token：${saved.email || saved.name || saved.id}`
  });
  return saved;
}

async function requestJson(endpoint: Dynamic, account: Dynamic) {
  const timeoutMs = usageRefreshTimeoutMs();
  const resp = await fetch(endpoint, {
    headers: {
      authorization: `Bearer ${account.access_token}`,
      "ChatGPT-Account-Id": account.account_id || account.workspace_id || "",
      accept: "application/json",
      "user-agent": "codex_cli_rs/0.136.0",
      origin: "https://chatgpt.com",
      referer: "https://chatgpt.com/"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await resp.text();
  if (!resp.ok) {
    const hint = looksLikeHtml(text) ? "HTML response, possible Cloudflare/auth challenge" : text.slice(0, 240);
    const error: Dynamic = new Error(`${resp.status} ${hint}`);
    error.status = resp.status;
    throw error;
  }
  return JSON.parse(text);
}

async function refreshAccessToken(account: Dynamic) {
  const body = new URLSearchParams({
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    grant_type: "refresh_token",
    refresh_token: account.refresh_token
  });
  const resp = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(usageRefreshTimeoutMs())
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${resp.status} ${text.slice(0, 240)}`);
  const data = JSON.parse(text);
  return {
    access_token: data.access_token || account.access_token,
    refresh_token: data.refresh_token || account.refresh_token,
    id_token: data.id_token || account.id_token,
    last_refresh: new Date().toISOString()
  };
}

function usageRefreshTimeoutMs() {
  const configured = Number(store.getSettings().usage_refresh_timeout_ms);
  return Number.isFinite(configured) ? Math.max(1000, Math.min(300000, Math.trunc(configured))) : 20000;
}

function shouldRefreshForUsageError(error: Dynamic) {
  return error?.status === 401 || error?.status === 403 || /^(401|403)\b/.test(String(error?.message || ""));
}

function looksLikeHtml(value: Dynamic) {
  return /^\s*<!doctype html|^\s*<html/i.test(String(value || ""));
}
