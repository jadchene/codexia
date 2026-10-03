import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App as AntApp } from "antd";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { CodexGatewayBridge } from "../preload";
import App from "./App";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it.each(["fiveHour", "normalization", "multiplier"])("refreshes quota and model channel data after %s setting changes", async (field) => {
  const user = userEvent.setup();
  const settings = {
    ignore_five_hour_limit: field === "fiveHour" ? "true" : "false",
    gpt_quota_normalization_enabled: "false",
    gpt_quota_multiplier_pro: "10",
    usage_refresh_interval_secs: "900",
    usage_refresh_timeout_ms: "20000",
    gateway_quota_cooldown_ms: "60000",
    codex_quota_headers_mode: "block"
  };
  const quotaSummary = vi.fn().mockResolvedValue({
    capacity_percent: 200,
    primary: { remaining_percent: 170 },
    secondary: { remaining_percent: 150 }
  });
  window.codexGateway = {
    bootstrap: vi.fn().mockResolvedValue({
      app: { version: "1.0.0" },
      settings,
      accounts: [],
      tokenLogs: { items: [], total: 0, page: 1, pageSize: 10 },
      tokenSummary: { total: {}, byAccount: [] },
      quotaSummary: {
        capacity_percent: 200,
        primary: { remaining_percent: 150 },
        secondary: { remaining_percent: 150 }
      },
      appLogs: { items: [], total: 0, page: 1, pageSize: 10 },
      gateway: { running: true },
      mcpGateway: { running: false },
      paths: { dataDir: "", dbPath: "" }
    }),
    saveSettings: vi.fn().mockImplementation(async (patch) => ({ ...settings, ...patch })),
    quotaSummary,
    listUpstreams: vi.fn().mockResolvedValue([])
  } as unknown as CodexGatewayBridge;

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <QueryClientProvider client={queryClient}>
        <AntApp><App /></AntApp>
      </QueryClientProvider>
    </MemoryRouter>
  );

  await screen.findByText("应用行为", {}, { timeout: 5000 });
  await user.click(screen.getByText("账号与额度"));
  await screen.findByText("忽略 5 小时限制");
  expect(screen.queryByText("重启服务后生效")).toBeNull();
  if (field === "multiplier") {
    const input = screen.getByRole("spinbutton", { name: "Pro 倍率" });
    await user.clear(input);
    await user.type(input, "12.5");
  } else {
    await user.click(screen.getByRole("switch", { name: field === "fiveHour" ? "忽略 5 小时限制" : "按 Plus 基准折算额度" }));
  }
  await user.click(screen.getByRole("button", { name: /保存设置/ }));
  await waitFor(() => expect(quotaSummary).toHaveBeenCalledOnce());
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["upstreams"] });
  expect(screen.getByRole("status").textContent).toContain("配置已保存");
  expect(screen.getByRole("status").textContent).not.toContain("重启");

  await user.click(screen.getByText("运行概览"));
  expect(await screen.findByText("170.0%")).toBeTruthy();
  expect(screen.getByText("150.0%")).toBeTruthy();
});

it("refreshes the visible model channels when background data changes", async () => {
  let dataChanged: ((types: string[]) => void) | undefined;
  const listUpstreams = vi.fn().mockResolvedValue([]);
  window.codexGateway = {
    bootstrap: vi.fn().mockResolvedValue({
      app: { version: "1.0.0" },
      settings: { billing_currency: "USD" },
      accounts: [],
      tokenLogs: { items: [], total: 0, page: 1, pageSize: 10 },
      tokenSummary: { total: {}, byAccount: [] },
      quotaSummary: { primary: {}, secondary: {} },
      appLogs: { items: [], total: 0, page: 1, pageSize: 10 },
      gateway: { running: false },
      mcpGateway: { running: false },
      paths: { dataDir: "", dbPath: "" }
    }),
    listUpstreams,
    onDataChanged: vi.fn((callback) => {
      dataChanged = callback;
      return () => undefined;
    })
  } as unknown as CodexGatewayBridge;

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <MemoryRouter initialEntries={["/upstreams"]}>
      <QueryClientProvider client={queryClient}>
        <AntApp><App /></AntApp>
      </QueryClientProvider>
    </MemoryRouter>
  );

  await screen.findByText("新增渠道");
  await waitFor(() => expect(listUpstreams).toHaveBeenCalledOnce());
  dataChanged?.(["upstreams"]);
  await waitFor(() => expect(listUpstreams).toHaveBeenCalledTimes(2));
});
