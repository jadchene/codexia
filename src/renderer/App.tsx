import React, { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "./app/layout/AppShell";
import { applyAppearancePreferences, appearanceFromSettings } from "./app/appearance";
import type { ConsumeResetCreditResult, PublicAccount } from "../shared/contracts/accounts";
import type { BootstrapData } from "../shared/contracts/bootstrap";
import type { AppLogPage, LogQuery, RequestLogPage, TokenSummary } from "../shared/contracts/logs";
import type { RuntimePaths, ServiceStatus, Settings } from "../shared/contracts/settings";
import { currentLogQuery, moveLogQueryToToday } from "./lib/log-query";
import { useDayRollover } from "./lib/use-day-rollover";

const UpstreamsPage = React.lazy(() => import("./features/upstreams/UpstreamsPage").then((module) => ({ default: module.UpstreamsPage })));
const SettingsPage = React.lazy(() => import("./features/settings/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const ServicesPage = React.lazy(() => import("./features/services/ServicesPage").then((module) => ({ default: module.ServicesPage })));
const OverviewPage = React.lazy(() => import("./features/overview/OverviewPage").then((module) => ({ default: module.OverviewPage })));
const AccountsPage = React.lazy(() => import("./features/accounts/AccountsPage").then((module) => ({ default: module.AccountsPage })));
const CodexIntegrationPage = React.lazy(() => import("./features/codex-integration/CodexIntegrationPage").then((module) => ({ default: module.CodexIntegrationPage })));
const RequestAnalyticsPage = React.lazy(() => import("./features/request-analytics/RequestAnalyticsPage").then((module) => ({ default: module.RequestAnalyticsPage })));
const RuntimeLogsPage = React.lazy(() => import("./features/runtime-logs/RuntimeLogsPage").then((module) => ({ default: module.RuntimeLogsPage })));

const pages = [
  { id: "overview", label: "运行概览", description: "快速查看服务状态、可用额度和调用概况。" },
  { id: "accounts", label: "订阅账号", description: "添加和管理用于 Codex 的 ChatGPT 订阅账号。" },
  { id: "upstreams", label: "模型渠道", description: "管理订阅账号池和第三方模型，并设置连接方式与模型费率。" },
  { id: "services", label: "服务管理", description: "启动、停止或重启本地 API 与 MCP 服务。" },
  { id: "codexIntegration", label: "接入模式", description: "选择 Codex 使用本地 API 服务，或直接使用一个订阅账号。" },
  { id: "analytics", label: "调用分析", description: "按渠道、模型和账号查看调用量、Token、耗时与费用。" },
  { id: "runtimeLogs", label: "运行日志", description: "查看服务运行记录和错误信息。" },
  { id: "settings", label: "设置中心", description: "调整应用、API 服务、MCP 服务、额度、日志和外观设置。" }
];

type BrowserLoginPhase = "idle" | "starting" | "waiting" | "success" | "failed";

function App() {
  const api = window.codexGateway;
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const page = location.pathname.replace(/^\//, "") || "overview";
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<Settings>({});
  const [accounts, setAccounts] = useState<PublicAccount[]>([]);
  const [tokenLogs, setTokenLogs] = useState<RequestLogPage>({ items: [], total: 0, page: 1, pageSize: 10 });
  const [tokenSummary, setTokenSummary] = useState<TokenSummary>({ total: {}, byAccount: [] });
  const [dashboardSummary, setDashboardSummary] = useState<TokenSummary>({ total: {}, byAccount: [] });
  const [quotaSummary, setQuotaSummary] = useState<BootstrapData["quotaSummary"]>({ primary: {}, secondary: {} });
  const [appLogs, setAppLogs] = useState<AppLogPage>({ items: [], total: 0, page: 1, pageSize: 10 });
  const [gateway, setGateway] = useState<ServiceStatus>({ running: false, url: "" });
  const [mcpGateway, setMcpGateway] = useState<ServiceStatus>({ running: false, url: "", command: "" });
  const [paths, setPaths] = useState<RuntimePaths>({ dataDir: "", dbPath: "" });
  const [appVersion, setAppVersion] = useState("");
  const [message, setMessage] = useState("");
  const [loginId, setLoginId] = useState("");
  const [loginPhase, setLoginPhase] = useState<BrowserLoginPhase>("idle");
  const [loginError, setLoginError] = useState("");
  const [refreshingIds, setRefreshingIds] = useState(() => new Set<string>());
  const [retryIds, setRetryIds] = useState(() => new Set<string>());
  const [consumingResetIds, setConsumingResetIds] = useState(() => new Set<string>());
  const tokenLogsRef = useRef(tokenLogs);
  const appLogsRef = useRef(appLogs);
  const tokenLogQueryRef = useRef<LogQuery | null>(null);
  const appLogQueryRef = useRef<LogQuery | null>(null);
  const tokenLogFollowsTodayRef = useRef(true);
  const appLogFollowsTodayRef = useRef(true);
  const appLogsPausedRef = useRef(false);
  const [appLogsPaused, setAppLogsPaused] = useState(false);
  const [pendingAppLogBatches, setPendingAppLogBatches] = useState(0);
  const loginAttemptRef = useRef(0);

  const refreshDailyData = async (): Promise<void> => {
    try {
      const tasks: Promise<void>[] = [
        api.tokenSummary().then(setDashboardSummary)
      ];
      if (tokenLogFollowsTodayRef.current) {
        const query = moveLogQueryToToday(
          tokenLogQueryRef.current || currentLogQuery(tokenLogsRef.current),
          tokenLogsRef.current.pageSize || 10
        );
        tokenLogQueryRef.current = query;
        tasks.push(Promise.all([api.listTokenLogs(query), api.tokenSummary(query)]).then(([logs, summary]) => {
          setTokenLogs(logs);
          setTokenSummary(summary);
        }));
      }
      if (appLogFollowsTodayRef.current) {
        const query = moveLogQueryToToday(
          appLogQueryRef.current || currentLogQuery(appLogsRef.current),
          appLogsRef.current.pageSize || 10
        );
        appLogQueryRef.current = query;
        tasks.push(api.listAppLogs(query).then(setAppLogs));
      }
      await Promise.all(tasks);
    } catch (error) {
      setMessage(`跨日刷新失败：${errorMessage(error)}`);
    }
  };

  async function reload() {
    const data = await api.bootstrap();
    setAppVersion(data.app?.version || "");
    setSettings(data.settings);
    setAccounts(data.accounts);
    setTokenLogs(data.tokenLogs);
    tokenLogQueryRef.current = currentLogQuery(data.tokenLogs);
    setTokenSummary(data.tokenSummary || { total: {}, byAccount: [] });
    setDashboardSummary(data.tokenSummary || { total: {}, byAccount: [] });
    setQuotaSummary(data.quotaSummary || { primary: {}, secondary: {} });
    setAppLogs(data.appLogs);
    appLogQueryRef.current = currentLogQuery(data.appLogs);
    setGateway(data.gateway);
    setMcpGateway(data.mcpGateway || { running: false, url: "", command: "" });
    setPaths(data.paths);
    applyAppearancePreferences(appearanceFromSettings(data.settings));
    setReady(true);
  }

  useEffect(() => {
    reload().catch((error) => setMessage(error.message));
  }, []);

  useEffect(() => {
    tokenLogsRef.current = tokenLogs;
  }, [tokenLogs]);

  useEffect(() => {
    appLogsRef.current = appLogs;
  }, [appLogs]);

  useDayRollover(() => {
    void refreshDailyData();
  });

  useEffect(() => {
    if (!api.onGatewayStatusChanged) return undefined;
    return api.onGatewayStatusChanged((status) => {
      setGateway(status);
    });
  }, []);

  useEffect(() => {
    if (!api.onMcpGatewayStatusChanged) return undefined;
    return api.onMcpGatewayStatusChanged((status) => {
      setMcpGateway(status);
    });
  }, []);

  useEffect(() => {
    if (!api.onDataChanged) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Set<string>();
    const unsubscribe = api.onDataChanged((types) => {
      for (const type of types || []) pending.add(type);
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const next = new Set(pending);
        pending.clear();
        try {
          if (next.has("accounts")) {
            setAccounts(await api.listAccounts());
            setQuotaSummary(await api.quotaSummary());
          }
          if (next.has("tokenLogs") || next.has("tokenSummary")) {
            const current = tokenLogsRef.current || {};
            const query = tokenLogQueryRef.current || currentLogQuery(current);
            setTokenLogs(await api.listTokenLogs(query));
            setTokenSummary(await api.tokenSummary(query));
            setDashboardSummary(await api.tokenSummary());
          }
          if (next.has("appLogs")) {
            if (appLogsPausedRef.current) {
              setPendingAppLogBatches((count) => count + 1);
            } else {
              const current = appLogsRef.current || {};
              setAppLogs(await api.listAppLogs(appLogQueryRef.current || currentLogQuery(current)));
            }
          }
          if (next.has("upstreams") || next.has("upstreamModels")) {
            await queryClient.invalidateQueries({ queryKey: ["upstreams"] });
          }
          if (next.has("settings")) {
            const data = await api.bootstrap();
            setSettings(data.settings);
          }
          if (next.has("apiDebugLoggingExpired")) {
            setMessage("API 调试日志已达到 10 分钟上限，已自动关闭并清空");
          }
        } catch (error) {
          setMessage(`自动刷新失败：${errorMessage(error)}`);
        }
      }, 150);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(() => setMessage(""), 2000);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!loginId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const status = await api.loginStatus(loginId);
        if (cancelled) return;
        if (status.status === "success") {
          setLoginId("");
          setLoginPhase("success");
          setLoginError("");
          await reload();
          setMessage("登录成功，账号已保存");
          return;
        }
        if (status.status === "failed" || status.status === "cancelled" || status.status === "unknown") {
          setLoginId("");
          if (status.status === "cancelled") {
            setLoginPhase("idle");
            setLoginError("");
          } else {
            const error = status.error || (status.status === "unknown" ? "授权会话已失效" : "未知错误");
            setLoginPhase("failed");
            setLoginError(error);
            setMessage(`登录失败：${error}`);
          }
          return;
        }
        timer = setTimeout(poll, 1800);
      } catch (error) {
        if (!cancelled) {
          setMessage(`查询登录状态失败：${errorMessage(error)}`);
          timer = setTimeout(poll, 3000);
        }
      }
    };
    timer = setTimeout(poll, 300);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [loginId]);

  const gatewayBase = `${gateway.url || `http://${settings.gateway_host || "localhost"}:${settings.gateway_port || "8436"}`}/v1`;
  const mcpGatewayUrl = mcpGateway.url || mcpGatewayBaseUrl(settings);

  async function saveSettings(next: Settings): Promise<Settings> {
    try {
      const quotaModeChanged = next.ignore_five_hour_limit !== settings.ignore_five_hour_limit;
      const restartRequired = (gateway.running || mcpGateway.running) && Object.entries(next).some(
        ([key, value]) => value !== settings[key]
          && !key.startsWith("appearance_")
          && key !== "navigation_collapsed"
          && key !== "debug_api_logging"
      );
      const restartReminder = restartRequired ? "，请重启相关服务使配置生效" : "";
      const saved = await api.saveSettings(next);
      setSettings(saved);
      applyAppearancePreferences(appearanceFromSettings(saved));
      if (quotaModeChanged) {
        try {
          setQuotaSummary(await api.quotaSummary());
        } catch (error) {
          setMessage(`配置已保存${restartReminder}；额度汇总刷新失败：${errorMessage(error)}`);
          return saved;
        }
      }
      setMessage(`配置已保存${restartReminder}`);
      return saved;
    } catch (error) {
      setMessage(`保存配置失败：${errorMessage(error)}`);
      throw error;
    }
  }

  async function startLogin() {
    const attempt = ++loginAttemptRef.current;
    setLoginPhase("starting");
    setLoginError("");
    try {
      const result = await api.startLogin();
      if (attempt !== loginAttemptRef.current) {
        await api.cancelLogin(result.loginId);
        return;
      }
      setLoginId(result.loginId);
      setLoginPhase("waiting");
      setMessage("已打开浏览器登录页面，完成授权后会自动保存账号");
    } catch (error) {
      if (attempt !== loginAttemptRef.current) return;
      const detail = errorMessage(error);
      setLoginPhase("failed");
      setLoginError(detail);
      setMessage(`启动登录失败：${detail}`);
    }
  }

  async function cancelLogin() {
    loginAttemptRef.current += 1;
    const currentLoginId = loginId;
    setLoginId("");
    setLoginPhase("idle");
    setLoginError("");
    if (!currentLoginId) return;
    try {
      await api.cancelLogin(currentLoginId);
    } catch (error) {
      setMessage(`取消授权失败：${errorMessage(error)}`);
    }
  }

  async function importLocalCodexAccount(): Promise<boolean> {
    try {
      const account = await api.importLocalCodexAccount();
      await reload();
      setMessage(`已导入账号：${account.name}`);
      return true;
    } catch (error) {
      setMessage(`本地读取失败：${errorMessage(error)}`);
      return false;
    }
  }

  async function refreshUsage(account: PublicAccount): Promise<void> {
    setRefreshingIds((prev) => new Set(prev).add(account.id));
    try {
      await api.refreshUsage(account.id);
      setRetryIds((prev) => {
        const next = new Set(prev);
        next.delete(account.id);
        return next;
      });
      await reload();
      setMessage(`${account.name} 额度已刷新`);
    } catch (error) {
      setRetryIds((prev) => new Set(prev).add(account.id));
      setMessage(`刷新失败：${errorMessage(error)}`);
    } finally {
      setRefreshingIds((prev) => {
        const next = new Set(prev);
        next.delete(account.id);
        return next;
      });
    }
  }

  async function consumeResetCredit(account: PublicAccount, creditId?: string): Promise<ConsumeResetCreditResult | void> {
    setConsumingResetIds((prev) => new Set(prev).add(account.id));
    try {
      const result = await api.consumeResetCredit(account.id, creditId);
      await reload();
      setMessage(`${account.name}：${result.message}`);
      return result;
    } catch (error) {
      setMessage(`使用重置卡失败：${errorMessage(error)}`);
    } finally {
      setConsumingResetIds((prev) => {
        const next = new Set(prev);
        next.delete(account.id);
        return next;
      });
    }
  }

  async function refreshAllUsage() {
    setMessage("正在刷新所有账号额度...");
    try {
      const results = await api.refreshAllUsage();
      await reload();
      const okCount = results.filter((item) => item.ok).length;
      const failCount = results.length - okCount;
      if (results.length === 0) {
        setMessage("没有可刷新的启用账号");
      } else if (failCount === 0) {
        setMessage("所有账号额度刷新完成");
      } else if (okCount === 0) {
        setMessage(`刷新全部失败：${failCount}/${results.length} 个账号失败`);
      } else {
        setMessage(`部分账号刷新成功：${okCount}/${results.length}，失败 ${failCount} 个`);
      }
    } catch (error) {
      setMessage(`刷新全部失败：${errorMessage(error)}`);
    }
  }

  async function toggleGateway() {
    try {
      const next = gateway.running ? await api.stopGateway() : await api.startGateway();
      setGateway(next);
      setMessage(next.running ? "API 服务已启动" : "API 服务已停止");
    } catch (error) {
      setMessage(`API 服务操作失败：${errorMessage(error)}`);
    }
  }

  async function toggleMcpGateway() {
    try {
      const next = mcpGateway.running ? await api.stopMcpGateway() : await api.startMcpGateway();
      setMcpGateway(next);
      setMessage(next.running ? "MCP 服务已启动" : "MCP 服务已停止");
    } catch (error) {
      setMessage(`MCP 服务操作失败：${errorMessage(error)}`);
    }
  }

  async function restartGateway() {
    try {
      await api.stopGateway();
      const next = await api.startGateway();
      setGateway(next);
      setMessage("API 服务已重启");
    } catch (error) {
      setMessage(`API 服务重启失败：${errorMessage(error)}`);
    }
  }

  async function restartMcpGateway() {
    try {
      await api.stopMcpGateway();
      const next = await api.startMcpGateway();
      setMcpGateway(next);
      setMessage("MCP 服务已重启");
    } catch (error) {
      setMessage(`MCP 服务重启失败：${errorMessage(error)}`);
    }
  }

  async function setAccountEnabled(account: PublicAccount, enabled: boolean): Promise<void> {
    try {
      await api.setAccountEnabled(account.id, enabled);
      await reload();
      setMessage(`${account.name} 已${enabled ? "启用" : "停用"}`);
    } catch (error) {
      setMessage(`${enabled ? "启用" : "停用"}账号失败：${errorMessage(error)}`);
    }
  }

  async function clearTokenLogs() {
    try {
      const result = await api.clearTokenLogs();
      const current = tokenLogsRef.current || {};
      const query = { ...(tokenLogQueryRef.current || currentLogQuery(current)), page: 1 };
      setTokenLogs(await api.listTokenLogs(query));
      setTokenSummary(await api.tokenSummary(query));
      setDashboardSummary(await api.tokenSummary());
      setMessage(`已清空调用分析：${result.deleted || 0} 条`);
    } catch (error) {
      setMessage(`清空调用分析失败：${errorMessage(error)}`);
    }
  }

  async function clearAppLogs() {
    try {
      const result = await api.clearAppLogs();
      const current = appLogsRef.current || {};
      setAppLogs(await api.listAppLogs({ ...(appLogQueryRef.current || currentLogQuery(current)), page: 1 }));
      setMessage(`已清空运行日志：${result.deleted || 0} 条`);
    } catch (error) {
      setMessage(`清空运行日志失败：${errorMessage(error)}`);
    }
  }

  if (!ready) return <div className="boot">正在载入本地数据...</div>;

  return (
    <AppShell
      activePage={page}
      appVersion={appVersion}
      gatewayRunning={gateway.running}
      initiallyCollapsed={settings.navigation_collapsed === "true"}
      mcpGatewayRunning={mcpGateway.running}
      onCollapsedChange={(collapsed) => {
        api.saveSettings({ navigation_collapsed: collapsed ? "true" : "false" })
          .then((saved) => setSettings(saved))
          .catch((error) => setMessage(`保存导航状态失败：${errorMessage(error)}`));
      }}
      onNavigate={(nextPage) => navigate(`/${nextPage}`)}
      pages={pages}
    >
      <section className="v1-app-content">
        {message && <div className="toast" role="status">{message}</div>}
        <React.Suspense fallback={<div className="boot">正在载入页面...</div>}>
        {page === "overview" && <OverviewPage
          accounts={accounts}
          gateway={gateway}
          gatewayBase={gatewayBase}
          mcpGateway={mcpGateway}
          tokenSummary={dashboardSummary}
          quotaSummary={quotaSummary}
          settings={settings}
          recentLogs={appLogs.items}
          onToggleGateway={toggleGateway}
          onRefreshAccounts={refreshAllUsage}
        />}
        {page === "accounts" && (
          <AccountsPage
            accounts={accounts}
            loginPhase={loginPhase}
            loginError={loginError}
            settings={settings}
            onStartLogin={startLogin}
            onImportLocal={importLocalCodexAccount}
            onCancelLogin={cancelLogin}
            onResetLogin={() => {
              if (loginId) return;
              setLoginPhase("idle");
              setLoginError("");
            }}
            onRefreshUsage={refreshUsage}
            onRefreshAll={refreshAllUsage}
            onConsumeResetCredit={consumeResetCredit}
            consumingResetIds={consumingResetIds}
            onSetEnabled={setAccountEnabled}
            refreshingIds={refreshingIds}
            retryIds={retryIds}
            onDelete={async (id) => {
              try {
                await api.deleteAccount(id);
                await reload();
                setMessage("账号已删除");
              } catch (error) {
                setMessage(`删除账号失败：${errorMessage(error)}`);
              }
            }}
          />
        )}
        {page === "codexIntegration" && (
          <CodexIntegrationPage
            settings={settings}
            accounts={accounts}
            gatewayBase={gatewayBase}
            modelCatalogPath={`${paths.dataDir.replace(/[\\/]+$/, "")}/models.json`}
            onMessage={setMessage}
            onSaveSettings={saveSettings}
            onApplyGateway={async () => {
              const result = await api.applyGatewayAuth();
              await reload();
              setMessage(result.providerChanged ? "已应用 API 模式" : "已更新 API 模式");
            }}
            onApplyAccount={async (accountId) => {
              const result = await api.applyAccountAuth(accountId);
              await reload();
              setMessage(result.providerRemoved ? "已应用账号模式" : "已更新账号模式");
            }}
          />
        )}
        {page === "services" && (
          <ServicesPage
            gateway={gateway}
            mcpGateway={mcpGateway}
            gatewayBase={gatewayBase}
            mcpGatewayUrl={mcpGatewayUrl}
            mcpGatewayCommand={mcpGateway.command || mcpGatewayCommand(settings)}
            onToggleGateway={toggleGateway}
            onToggleMcpGateway={toggleMcpGateway}
            onRestartGateway={restartGateway}
            onRestartMcpGateway={restartMcpGateway}
            onMessage={setMessage}
          />
        )}
        {page === "settings" && (
          <SettingsPage
            settings={settings}
            paths={paths}
            mcpInstalled={mcpGateway.installed}
            onSave={saveSettings}
            onMessage={setMessage}
            onClearTokenLogs={clearTokenLogs}
            onClearAppLogs={clearAppLogs}
          />
        )}
        {page === "analytics" && (
          <RequestAnalyticsPage
            pageData={tokenLogs}
            summary={tokenSummary}
            accounts={accounts}
            settings={settings}
            onMessage={setMessage}
            onQuery={async (query, followsToday = false) => {
              try {
                const result = await api.listTokenLogs(query);
                tokenLogQueryRef.current = query;
                tokenLogFollowsTodayRef.current = followsToday;
                setTokenLogs(result);
                setTokenSummary(await api.tokenSummary(query));
              } catch (error) {
                setMessage(`查询调用记录失败：${errorMessage(error)}`);
              }
            }}
          />
        )}
        {page === "runtimeLogs" && (
          <RuntimeLogsPage
            pageData={appLogs}
            paused={appLogsPaused}
            newLogCount={pendingAppLogBatches}
            onPausedChange={(paused) => {
              appLogsPausedRef.current = paused;
              setAppLogsPaused(paused);
              if (!paused) {
                setPendingAppLogBatches(0);
                void api.listAppLogs(appLogQueryRef.current || currentLogQuery(appLogsRef.current || {}))
                  .then(setAppLogs)
                  .catch((error) => setMessage(`恢复日志刷新失败：${errorMessage(error)}`));
              }
            }}
            onMessage={setMessage}
            onQuery={async (query, followsToday = false) => {
              try {
                const result = await api.listAppLogs(query);
                appLogQueryRef.current = query;
                appLogFollowsTodayRef.current = followsToday;
                setAppLogs(result);
              } catch (error) {
                setMessage(`查询运行日志失败：${errorMessage(error)}`);
              }
            }}
          />
        )}
        {page === "upstreams" && <UpstreamsPage />}
        </React.Suspense>
      </section>
    </AppShell>
  );
}

function mcpGatewayBaseUrl(settings: Settings = {}): string {
  const host = cleanMcpGatewayText(settings.mcp_gateway_host);
  const port = cleanMcpGatewayPort(settings.mcp_gateway_port);
  if (!host || !port) return "";
  return `http://${host}:${port}${cleanMcpGatewayPath(settings.mcp_gateway_path)}`;
}

function mcpGatewayCommand(settings: Settings = {}): string {
  const args = ["mcp-gateway-service", "--http"];
  appendOptionalMcpArg(args, "--config", settings.mcp_gateway_config_path);
  appendOptionalMcpArg(args, "--host", settings.mcp_gateway_host);
  appendOptionalMcpArg(args, "--port", cleanMcpGatewayPort(settings.mcp_gateway_port));
  appendOptionalMcpArg(args, "--path", cleanMcpGatewayPath(settings.mcp_gateway_path));
  return args.map(quoteCommandArg).join(" ");
}

function appendOptionalMcpArg(args: string[], name: string, value: unknown): void {
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

function quoteCommandArg(value: unknown): string {
  const text = String(value);
  return /[\s"]/g.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export default App;
