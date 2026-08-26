import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { App as AntApp } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexGatewayBridge } from "../../preload";
import type { UpstreamKind, UpstreamSummary } from "../../shared/contracts/upstreams";
import { AppShell } from "../app/layout/AppShell";
import { AccountsPage } from "./accounts/AccountsPage";
import { CodexIntegrationPage } from "./codex-integration/CodexIntegrationPage";
import { OverviewPage } from "./overview/OverviewPage";
import { RequestAnalyticsPage } from "./request-analytics/RequestAnalyticsPage";
import { RuntimeLogsPage } from "./runtime-logs/RuntimeLogsPage";
import { ServicesPage } from "./services/ServicesPage";
import { UpstreamsPage } from "./upstreams/UpstreamsPage";
import { currentLogQuery } from "../lib/log-query";

const emptyRequestPage = { items: [], total: 0, page: 1, pageSize: 10 };
const emptyLogPage = { items: [], total: 0, page: 1, pageSize: 10 };
const emptySummary = { total: {}, byAccount: [] };

describe("Ant Design pages", () => {
  beforeEach(() => {
    localStorage.clear();
    window.codexGateway = createBridge();
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });
  afterEach(() => cleanup());

  it("uses the page definitions for navigation and the current page title", () => {
    render(
      <AppShell
        activePage="upstreams"
        gatewayRunning={false}
        mcpGatewayRunning={false}
        onNavigate={vi.fn()}
        pages={[
          { id: "upstreams", label: "模型渠道", description: "管理模型渠道。" },
          { id: "codexIntegration", label: "接入模式", description: "选择接入方式。" }
        ]}
      >
        <div>页面内容</div>
      </AppShell>
    );
    expect(screen.getAllByText("模型渠道")).toHaveLength(2);
    expect(screen.getByText("管理模型渠道。")).toBeTruthy();
    expect(screen.getByText("接入模式")).toBeTruthy();
    expect(screen.getByText("API 已停止")).toBeTruthy();
    expect(screen.getByText("MCP 已停止")).toBeTruthy();
  });

  it("renders overview model channel metrics", async () => {
    const user = userEvent.setup();
    const onRefreshAccounts = vi.fn().mockResolvedValue(undefined);
    renderWithQueries(<OverviewPage
      accounts={[]}
      gateway={{ running: true, url: "http://localhost:8436", activeHttpRequests: 2, activeWebSockets: 3 }}
      gatewayBase="http://localhost:8436/v1"
      mcpGateway={{ running: true, url: "http://127.0.0.1:3000/mcp" }}
      tokenSummary={{ total: { calls: 12, total_tokens: 1000, input_tokens: 800, cached_input_tokens: 400, average_duration_ms: 250, errors: 2, estimated_cost: 0.12 }, byAccount: [] }}
      quotaSummary={{ capacity_percent: 200, primary: { remaining_percent: 115 }, secondary: { remaining_percent: 150 } }}
      settings={{}}
      onRefreshAccounts={onRefreshAccounts}
    />);
    expect(screen.getByRole("button", { name: /刷新额度/ })).toBeTruthy();
    expect(screen.getByText("API 服务")).toBeTruthy();
    expect(screen.getByText("MCP 服务")).toBeTruthy();
    await waitFor(() => expect(window.codexGateway.listUpstreams).toHaveBeenCalled());
    expect(await screen.findByText("可选模型")).toBeTruthy();
    expect(screen.getByText("缓存命中")).toBeTruthy();
    expect(screen.getByText("平均耗时")).toBeTruthy();
    expect(screen.getByText("估算成本（美元）")).toBeTruthy();
    expect(screen.queryByText("今日调用统计")).toBeNull();
    expect(screen.getByText("115.0%")).toBeTruthy();
    expect(screen.getByText("http://localhost:8436/v1")).toBeTruthy();
    expect(screen.getByText("57.5%")).toBeTruthy();
    expect(screen.getByText("150.0%")).toBeTruthy();
    await user.hover(screen.getByText("1,000"));
    expect(await screen.findByText("输入：800")).toBeTruthy();
    expect(screen.getByText("缓存命中率：50.0%")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /刷新额度/ }));
    expect(onRefreshAccounts).toHaveBeenCalledOnce();
  });

  it("opens account browser login", async () => {
    const user = userEvent.setup();
    const onStartLogin = vi.fn().mockResolvedValue(undefined);
    const onCancelLogin = vi.fn().mockResolvedValue(undefined);
    const props = {
      accounts: [],
      loginPhase: "idle" as const,
      loginError: "",
      refreshingIds: new Set<string>(),
      retryIds: new Set<string>(),
      settings: {},
      onStartLogin,
      onImportLocal: vi.fn().mockResolvedValue(true),
      onCancelLogin,
      onResetLogin: vi.fn(),
      onRefreshUsage: vi.fn(),
      onRefreshAll: vi.fn(),
      onConsumeResetCredit: vi.fn(),
      consumingResetIds: new Set<string>(),
      onSetEnabled: vi.fn(),
      onDelete: vi.fn()
    };
    const view = render(<AccountsPage {...props} />);
    await user.click(screen.getByRole("button", { name: /添加账号/ }));
    const browserLogin = screen.getByRole("button", { name: /浏览器认证/ });
    const localLogin = screen.getByRole("button", { name: /从本机 Codex 读取/ });
    expect(browserLogin.parentElement).toBe(localLogin.parentElement);
    expect(browserLogin.style.width).toBe("160px");
    expect(localLogin.style.width).toBe("160px");
    await user.click(browserLogin);
    expect(onStartLogin).toHaveBeenCalledOnce();
    expect(screen.getByText("添加订阅账号")).toBeTruthy();

    view.rerender(<AccountsPage {...props} loginPhase="waiting" />);
    expect(screen.getByText("等待浏览器授权")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /从本机 Codex 读取/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /取\s*消/ }));
    expect(onCancelLogin).toHaveBeenCalledOnce();
  });

  it("shows the five-hour account summary only when the limit is enforced", () => {
    const props = {
      accounts: [{
        id: "account-1",
        name: "测试账号",
        enabled: true,
        status: "active",
        quota_5h_used_percent: 25,
        quota_7d_used_percent: 40,
        has_access_token: true,
        has_refresh_token: true
      }],
      loginPhase: "idle" as const,
      loginError: "",
      refreshingIds: new Set<string>(),
      retryIds: new Set<string>(),
      onStartLogin: vi.fn(),
      onImportLocal: vi.fn(),
      onCancelLogin: vi.fn(),
      onResetLogin: vi.fn(),
      onRefreshUsage: vi.fn(),
      onRefreshAll: vi.fn(),
      onConsumeResetCredit: vi.fn(),
      consumingResetIds: new Set<string>(),
      onSetEnabled: vi.fn(),
      onDelete: vi.fn()
    };
    const view = render(<AccountsPage {...props} settings={{ ignore_five_hour_limit: "false" }} />);

    expect(screen.getByText("5 小时总剩余额度").closest(".ant-card")?.textContent).toContain("75.0%");
    expect(screen.getByText("7 天总剩余额度").closest(".ant-card")?.textContent).toContain("60.0%");
    expect(document.querySelector(".v1-summary-cards")?.textContent).not.toContain("令牌续期");
    expect(document.querySelectorAll(".v1-summary-cards > .ant-col-md-6")).toHaveLength(3);

    view.rerender(<AccountsPage {...props} settings={{ ignore_five_hour_limit: "true" }} />);
    expect(screen.queryByText("5 小时总剩余额度")).toBeNull();
    expect(screen.getByText("7 天总剩余额度")).toBeTruthy();
    expect(document.querySelectorAll(".v1-summary-cards > .ant-col-md-6")).toHaveLength(2);
  });

  it("shows the subscription expiry in account details", async () => {
    const user = userEvent.setup();
    const subscriptionExpiresAt = 1_800_000_000;
    render(<AccountsPage accounts={[{
      id: "account-1",
      name: "测试账号",
      email: "account@example.com",
      enabled: true,
      status: "active",
      subscription_plan: "plus",
      subscription_expires_at: subscriptionExpiresAt,
      has_access_token: true,
      has_refresh_token: true
    }]} loginPhase="idle" loginError="" refreshingIds={new Set()} retryIds={new Set()} settings={{}}
      onStartLogin={vi.fn()} onImportLocal={vi.fn()} onCancelLogin={vi.fn()} onResetLogin={vi.fn()} onRefreshUsage={vi.fn()}
      onRefreshAll={vi.fn()} onConsumeResetCredit={vi.fn()} consumingResetIds={new Set()}
      onSetEnabled={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getByRole("button", { name: "刷新额度" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "停用账号" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除账号" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "查看详情" }));
    expect(screen.getByText("订阅到期")).toBeTruthy();
    expect(screen.getByText(new Date(subscriptionExpiresAt * 1000).toLocaleString())).toBeTruthy();
  });

  it("requires Codex model JSON when adding an API upstream", async () => {
    const user = userEvent.setup();
    renderWithQueries(<UpstreamsPage />);
    expect(screen.getAllByText("额度").length).toBeGreaterThan(0);
    expect(screen.queryByText("余额 / 额度")).toBeNull();
    await user.click(screen.getByRole("button", { name: /新增渠道/ }));
    expect(screen.getByText("Codex 模型 JSON")).toBeTruthy();
    const modelHint = screen.getByText(/用于读取模型及其支持的能力/).closest(".ant-alert");
    expect(modelHint?.getAttribute("style")).toContain("margin-bottom: 16px");
    expect(await screen.findByText("模型费率（美元 / 百万 Token）")).toBeTruthy();
    const editors = Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea.v1-code-editor"));
    expect(editors[0]?.value).toBe("");
    expect(editors.slice(1).every((editor) => editor.classList.contains("v1-fixed-json-editor"))).toBe(true);
    await user.click(screen.getByRole("combobox", { name: /余额查询方式/ }));
    expect(screen.getByRole("option", { name: "DeepSeek" })).toBeTruthy();
    expect(screen.queryByText("DeepSeek 官方接口")).toBeNull();
    expect(screen.queryByText("模型映射")).toBeNull();
  });

  it("validates model and header JSON before saving an API upstream", async () => {
    const user = userEvent.setup();
    renderWithQueries(<UpstreamsPage />);
    await user.click(screen.getByRole("button", { name: /新增渠道/ }));
    await user.type(screen.getByRole("textbox", { name: "渠道名称" }), "测试渠道");
    await user.type(screen.getByRole("textbox", { name: "API 地址" }), "https://api.example.com/v1");
    const [modelEditor, publicHeaderEditor] = Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea.v1-code-editor"));

    fireEvent.change(modelEditor!, { target: { value: '{"models":[{"slug":"valid"},{}]}' } });
    await user.click(screen.getByRole("button", { name: /保\s*存/ }));
    expect(await screen.findByText("models 中的每一项都必须包含非空 slug")).toBeTruthy();

    fireEvent.change(modelEditor!, { target: { value: '{"models":[{"slug":"valid"}]}' } });
    fireEvent.change(publicHeaderEditor!, { target: { value: "[]" } });
    await user.click(screen.getByRole("button", { name: /保\s*存/ }));
    expect(await screen.findByText("普通请求头不是有效 JSON 对象")).toBeTruthy();
  });

  it("hides the delete action for the built-in account channel", async () => {
    const apiUpstream = createUpstream("api", "第三方渠道", "responses_api");
    apiUpstream.balanceQueryType = "deepseek";
    vi.mocked(window.codexGateway.listUpstreams).mockResolvedValue([
      createUpstream("builtin", "内置账号渠道", "chatgpt_subscription_pool"),
      apiUpstream
    ]);
    renderWithQueries(<UpstreamsPage />);
    expect(await screen.findByText("内置账号渠道")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "配置 Bundled 覆盖" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新内置模型" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新余额" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "更多操作" })).toHaveLength(1);
  });

  it("configures a disabled-by-default bundled model override with validated JSON", async () => {
    const user = userEvent.setup();
    const builtin = createUpstream("builtin", "内置账号渠道", "chatgpt_subscription_pool");
    vi.mocked(window.codexGateway.listUpstreams).mockResolvedValue([builtin]);
    vi.mocked(window.codexGateway.getBundledModelOverride).mockResolvedValue({ enabled: false, modelCatalogJson: "" });
    vi.mocked(window.codexGateway.saveBundledModelOverride).mockImplementation(async (input) => ({
      override: input,
      catalog: {
        path: "D:/data/models.json",
        bundledCachePath: "D:/data/codex-bundled-models.json",
        bundledSource: "override",
        bundledCount: 1,
        externalCount: 0,
        totalCount: 1
      }
    }));
    renderWithQueries(<UpstreamsPage />);

    await user.click(await screen.findByRole("button", { name: "配置 Bundled 覆盖" }));
    const dialog = await screen.findByRole("dialog", { name: "Codex Bundled 覆盖" });
    const enabled = within(dialog).getByRole("switch", { name: "启用覆盖" });
    expect(enabled.getAttribute("aria-checked")).toBe("false");
    await user.click(enabled);
    await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));
    expect(await within(dialog).findByText("模型 JSON 格式不正确")).toBeTruthy();

    const modelCatalogJson = '{"models":[{"slug":"gpt-override"}]}';
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Codex Bundled 模型 JSON" }), {
      target: { value: modelCatalogJson }
    });
    await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(window.codexGateway.saveBundledModelOverride).toHaveBeenCalledWith({
      enabled: true,
      modelCatalogJson
    }));
  });

  it("manages model names, order, and visibility", async () => {
    const user = userEvent.setup();
    vi.mocked(window.codexGateway.getModelManagement).mockResolvedValue([
      { slug: "model-a", sourceDisplayName: "Model A", displayName: "Model A", visible: true, priority: 1 },
      { slug: "model-b", sourceDisplayName: "Model B", displayName: "Model B", visible: true, priority: 2 }
    ]);
    vi.mocked(window.codexGateway.saveModelManagement).mockResolvedValue({
      models: [
        { slug: "model-b", sourceDisplayName: "Model B", displayName: "Model B Custom", visible: true, priority: 1 },
        { slug: "model-a", sourceDisplayName: "Model A", displayName: "Model A", visible: false, priority: 2 }
      ],
      catalog: {
        path: "D:/data/models.json",
        bundledCachePath: "D:/data/codex-bundled-models.json",
        bundledSource: "cache",
        bundledCount: 2,
        externalCount: 0,
        totalCount: 2
      }
    });
    renderWithQueries(<UpstreamsPage />);

    await user.click(await screen.findByRole("button", { name: "模型管理" }));
    const dialog = await screen.findByRole("dialog", { name: "模型管理" });
    await user.click(within(dialog).getByRole("button", { name: "下移 model-a" }));
    const displayName = within(dialog).getByRole("textbox", { name: "model-b 显示名称" });
    await user.clear(displayName);
    await user.type(displayName, "Model B Custom");
    await user.click(within(dialog).getByRole("switch", { name: "显示 model-a" }));
    await user.click(within(dialog).getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(window.codexGateway.saveModelManagement).toHaveBeenCalledWith([
      { slug: "model-b", displayName: "Model B Custom", visible: true },
      { slug: "model-a", displayName: "Model A", visible: false }
    ]));
  });

  it("starts the gateway from service management", async () => {
    const user = userEvent.setup();
    const onToggleGateway = vi.fn().mockResolvedValue(undefined);
    render(<ServicesPage gateway={{ running: false }} mcpGateway={{ running: false }} gatewayBase="http://localhost:8436/v1"
      mcpGatewayUrl="http://127.0.0.1:3000/mcp" mcpGatewayCommand="mcp-gateway-service --http"
      onToggleGateway={onToggleGateway}
      onToggleMcpGateway={vi.fn()} onRestartGateway={vi.fn()} onRestartMcpGateway={vi.fn()} onMessage={vi.fn()} />);
    expect(screen.getByText("API 服务")).toBeTruthy();
    expect(screen.getByText("MCP 服务")).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: /启动/ })[0]!);
    expect(onToggleGateway).toHaveBeenCalledOnce();
  });

  it("queries request analytics", async () => {
    const user = userEvent.setup();
    const onQuery = vi.fn().mockResolvedValue(undefined);
    vi.mocked(window.codexGateway.listUpstreams).mockResolvedValue([
      createUpstream("builtin-chatgpt-subscription-pool", "ChatGPT 订阅账号池", "chatgpt_subscription_pool")
    ]);
    const pageData = {
      ...emptyRequestPage,
      total: 1,
      items: [{
        id: 1,
        created_at: 1,
        session_id: "session-only-in-detail",
        account_id: "account-a",
        account_name: "账号 A",
        account_email: "a@example.com",
        upstream_name: "订阅账号池",
        client_model: "gpt-client",
        upstream_model: "gpt-upstream",
        input_tokens: 1234,
        cached_input_tokens: 234,
        output_tokens: 56,
        estimated_cost: 0.1234
      }]
    };
    const summary = {
      total: { total_tokens: 1524, input_tokens: 1000, cached_input_tokens: 400, output_tokens: 524 },
      byAccount: [
        { account_id: null, upstream_id: "deepseek", upstream_name: "DeepSeek API", total_tokens: 555, input_tokens: 400, cached_input_tokens: 100, output_tokens: 155 },
        { account_id: null, upstream_id: "qwen", upstream_name: "Qwen API", total_tokens: 333, input_tokens: 200, cached_input_tokens: 50, output_tokens: 133 },
        { account_id: "account-a", account_name: "账号 A", upstream_id: "subscription", upstream_name: "订阅账号池", total_tokens: 636, input_tokens: 400, cached_input_tokens: 250, output_tokens: 236 }
      ]
    };
    renderWithQueries(<RequestAnalyticsPage pageData={pageData} summary={summary} accounts={[]} settings={{ billing_currency: "CNY" }} onMessage={vi.fn()} onQuery={onQuery} />);
    expect(screen.getAllByText("估算成本（人民币）").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Token（输入 / 缓存输入 / 输出）").length).toBeGreaterThanOrEqual(1);
    const rowToken = screen.getByText("1,234 / 234 / 56");
    expect(rowToken.getAttribute("title")).toBeNull();
    await user.hover(rowToken);
    expect(await screen.findByText("缓存命中率：19.0%")).toBeTruthy();
    expect(screen.getByText("gpt-client → gpt-upstream").getAttribute("title")).toBeNull();
    expect(screen.queryByText("session-only-in-detail")).toBeNull();
    expect(screen.getByText("DeepSeek API")).toBeTruthy();
    expect(screen.getByText("Qwen API")).toBeTruthy();
    expect(screen.getByText("汇总指标")).toBeTruthy();
    expect(screen.getByText("渠道与账号用量")).toBeTruthy();
    expect(await screen.findAllByText("ChatGPT 订阅账号池")).toHaveLength(2);
    expect(screen.queryByText("订阅账号池")).toBeNull();
    await user.hover(screen.getByText("DeepSeek API"));
    expect(await screen.findByText("输出：155")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "展开 ChatGPT 订阅账号池" }));
    expect(screen.getByText("账号 A")).toBeTruthy();
    expect(screen.getAllByText("ChatGPT 订阅账号池")).toHaveLength(1);
    await user.hover(screen.getByText("账号 A"));
    expect(await screen.findByText("输出：236")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "返回 ChatGPT 订阅账号池：账号 A" }));
    expect(screen.getAllByText("ChatGPT 订阅账号池")).toHaveLength(2);
    await user.hover(screen.getByText("1,524"));
    expect(await screen.findByText("缓存命中率：40.0%")).toBeTruthy();
    const requestRow = screen.getByText("gpt-client → gpt-upstream").closest("tr");
    expect(requestRow).toBeTruthy();
    await user.click(within(requestRow!).getByText("ChatGPT 订阅账号池"));
    expect(await screen.findByText("账号 A · a@example.com")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /查询/ }));
    expect(onQuery).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: /重置/ }));
    expect(onQuery).toHaveBeenCalledTimes(2);
    expect(onQuery.mock.calls[1]?.[0]).not.toHaveProperty("accountId");
  });

  it("keeps request analytics column settings after the page remounts", async () => {
    const user = userEvent.setup();
    const props = {
      pageData: emptyRequestPage,
      summary: emptySummary,
      accounts: [],
      settings: {},
      onMessage: vi.fn(),
      onQuery: vi.fn().mockResolvedValue(undefined)
    };
    const view = renderWithQueries(<RequestAnalyticsPage {...props} />);
    await user.click(screen.getByRole("button", { name: /列设置/ }));
    await user.click(screen.getByRole("checkbox", { name: "路径" }));
    expect(screen.getByRole("columnheader", { name: "路径" })).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem("codexia:request-analytics:visible-columns")).toContain("path"));

    view.unmount();
    renderWithQueries(<RequestAnalyticsPage {...props} />);
    expect(screen.getByRole("columnheader", { name: "路径" })).toBeTruthy();
  });

  it("pauses runtime logs", async () => {
    const user = userEvent.setup();
    const onPausedChange = vi.fn();
    const onQuery = vi.fn().mockResolvedValue(undefined);
    const pageData = {
      ...emptyLogPage,
      total: 2,
      items: [
        { id: 1, created_at: Date.now(), level: "info", scope: "gateway", action: "start", status: "success", message: "API 服务已启动" },
        { id: 2, created_at: Date.now(), level: "info", scope: "gateway-websocket", action: "connect", status: "success", message: "WebSocket 已连接" }
      ]
    };
    render(<RuntimeLogsPage pageData={pageData} paused={false} newLogCount={0} onPausedChange={onPausedChange} onMessage={vi.fn()} onQuery={onQuery} />);
    expect(screen.getByText("api")).toBeTruthy();
    expect(screen.getByText("api-ws")).toBeTruthy();
    expect(screen.queryByText("gateway-websocket")).toBeNull();
    await user.click(screen.getByRole("button", { name: /暂停自动刷新/ }));
    expect(onPausedChange).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole("button", { name: /重置/ }));
    expect(onQuery).toHaveBeenCalledOnce();
    expect(onQuery.mock.calls[0]?.[0]).not.toHaveProperty("keyword");
  });

  it("keeps all active filters when an event-driven refresh rebuilds a log query", () => {
    const query = currentLogQuery({
      items: [],
      total: 0,
      page: 3,
      pageSize: 50,
      startAt: 100,
      endAt: 200,
      query: {
        page: 3,
        pageSize: 50,
        startAt: 100,
        endAt: 200,
        upstreamId: "deepseek",
        clientModel: "deepseek",
        status: "200",
        level: "error",
        keyword: "timeout"
      }
    });
    expect(query).toEqual({
      page: 3,
      pageSize: 50,
      startAt: 100,
      endAt: 200,
      upstreamId: "deepseek",
      clientModel: "deepseek",
      status: "200",
      level: "error",
      keyword: "timeout"
    });
  });

  it("applies Codex API mode", async () => {
    const user = userEvent.setup();
    const onApplyGateway = vi.fn().mockResolvedValue(undefined);
    const onSaveSettings = vi.fn().mockResolvedValue(undefined);
    render(<CodexIntegrationPage settings={{ codex_auth_mode: "" }} accounts={[]} gatewayBase="http://localhost:8436/v1" modelCatalogPath="D:/data/models.json"
      onMessage={vi.fn()} onSaveSettings={onSaveSettings} onApplyGateway={onApplyGateway} onApplyAccount={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /API 模式/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /API 模式/ }));
    expect(screen.getByText(/model_catalog_json = "D:\/data\/models\.json"/)).toBeTruthy();
    expect(screen.getByText(/openai_base_url = "http:\/\/localhost:8436\/v1"/)).toBeTruthy();
    expect(screen.queryByText(/model_provider = "openai"/)).toBeNull();
    await user.click(screen.getByText("自定义 Provider"));
    expect(screen.getByText(/model_provider = "codexia"/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /应用到 Codex/ }));
    expect(onSaveSettings).toHaveBeenCalledWith(expect.objectContaining({ codex_config_use_openai_base_url: "false" }));
    expect(onApplyGateway).toHaveBeenCalledOnce();
  });
});

function renderWithQueries(element: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><AntApp>{element}</AntApp></QueryClientProvider>);
}

function createBridge(): CodexGatewayBridge {
  return {
    listUpstreams: vi.fn().mockResolvedValue([]),
    listUpstreamModels: vi.fn().mockResolvedValue([]),
    getBundledModelOverride: vi.fn().mockResolvedValue({ enabled: false, modelCatalogJson: "" }),
    saveBundledModelOverride: vi.fn(),
    refreshBuiltinModels: vi.fn(),
    getModelManagement: vi.fn().mockResolvedValue([]),
    saveModelManagement: vi.fn(),
    bootstrap: vi.fn().mockResolvedValue({ settings: { billing_currency: "USD" } })
  } as unknown as CodexGatewayBridge;
}

const createUpstream = (id: string, name: string, kind: UpstreamKind): UpstreamSummary => ({
  id,
  name,
  kind,
  enabled: true,
  baseUrl: "http://localhost:8436/v1",
  hasApiKey: kind === "responses_api",
  apiKeyFingerprint: null,
  supportsWebSocket: true,
  compactAdaptEnabled: true,
  publicHeaders: {},
  secretHeaders: [],
  balanceQueryType: "none",
  balance: {
    available: true,
    infos: [],
    summary: null,
    checkedAt: null,
    error: null,
    subscriptionPool: kind === "chatgpt_subscription_pool"
      ? {
        totalAccounts: 1,
        enabledAccounts: 1,
        availableAccounts: 1,
        quotaCapacityPercent: 100,
        fiveHourRemainingPercent: 100,
        sevenDayRemainingPercent: 100,
        resetCredits: 0
      }
      : null
  },
  healthStatus: "unknown",
  healthCheckedAt: null,
  healthLatencyMs: null,
  healthMessage: null,
  modelCount: 1,
  lastSyncedAt: null
});
