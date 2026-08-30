import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import {
  APPEARANCE_CHANGED_EVENT,
  applyAppearancePreferences,
  appearanceFontStack,
  appearanceFromSettings,
  loadAppearancePreferences
} from "../../app/appearance";
import { formToSettings, SettingsPage, settingsToForm } from "./SettingsPage";

describe("settings appearance and display units", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it("persists normalized theme and density while notifying the provider", () => {
    const listener = vi.fn();
    window.addEventListener(APPEARANCE_CHANGED_EVENT, listener);
    applyAppearancePreferences({ theme: "dark", density: "compact", fontFamily: "Inter" });

    expect(loadAppearancePreferences()).toEqual({ theme: "dark", density: "compact", fontFamily: "Inter" });
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(APPEARANCE_CHANGED_EVENT, listener);
  });

  it("normalizes unsupported stored appearance values", () => {
    expect(appearanceFromSettings({ appearance_theme: "unknown", appearance_density: "wide" }))
      .toEqual({ theme: "system", density: "comfortable", fontFamily: "system" });
  });

  it("quotes a selected system font safely and keeps platform fallbacks", () => {
    expect(appearanceFontStack("Example Sans")).toBe('"Example Sans", system-ui, sans-serif');
    expect(appearanceFontStack('Example "UI"')).toBe('"Example \\"UI\\"", system-ui, sans-serif');
  });

  it("round-trips user-facing seconds and MiB to persisted integer values", () => {
    const settings = {
      gateway_connect_timeout_ms: "30000",
      gateway_stream_idle_timeout_ms: "120000",
      gateway_unary_timeout_ms: "90000",
      gateway_websocket_idle_timeout_ms: "180000",
      gateway_quota_cooldown_ms: "60000",
      gateway_session_affinity_ttl_hours: "168",
      gateway_shutdown_grace_ms: "5000",
      usage_refresh_timeout_ms: "15000",
      gateway_request_body_limit_bytes: String(16 * 1024 * 1024),
      gateway_compaction_response_limit_bytes: String(32 * 1024 * 1024),
      gateway_websocket_pending_queue_limit_bytes: String(4 * 1024 * 1024),
      auto_start_gateway: "false",
      auto_start_mcp_gateway: "true",
      ignore_five_hour_limit: "false",
      appearance_theme: "system",
      appearance_density: "comfortable"
    };
    const form = settingsToForm(settings);
    expect(form.gateway_connect_timeout_seconds).toBe("30");
    expect(form.gateway_stream_idle_timeout_seconds).toBe("120");
    expect(form.gateway_unary_timeout_seconds).toBe("90");
    expect(form.gateway_websocket_idle_timeout_seconds).toBe("180");
    expect(form.gateway_quota_cooldown_seconds).toBe("60");
    expect(form.gateway_shutdown_grace_seconds).toBe("5");
    expect(form.usage_refresh_timeout_seconds).toBe("15");
    expect(form.gateway_request_body_limit_mib).toBe("16");
    expect(form.gateway_compaction_response_limit_mib).toBe("32");
    expect(form.gateway_websocket_pending_queue_limit_mib).toBe("4");

    const saved = formToSettings(settings, {
      ...form,
      gateway_connect_timeout_seconds: 45,
      gateway_stream_idle_timeout_seconds: 121,
      gateway_unary_timeout_seconds: 91,
      gateway_websocket_idle_timeout_seconds: 181,
      gateway_quota_cooldown_seconds: 61,
      gateway_session_affinity_ttl_hours: 72,
      gateway_shutdown_grace_seconds: 5.5,
      usage_refresh_timeout_seconds: 16,
      gateway_request_body_limit_mib: 8,
      gateway_compaction_response_limit_mib: 24,
      gateway_websocket_pending_queue_limit_mib: 6,
      auto_start_gateway_enabled: true
    });
    expect(saved.gateway_connect_timeout_ms).toBe("45000");
    expect(saved.gateway_stream_idle_timeout_ms).toBe("121000");
    expect(saved.gateway_unary_timeout_ms).toBe("91000");
    expect(saved.gateway_websocket_idle_timeout_ms).toBe("181000");
    expect(saved.gateway_quota_cooldown_ms).toBe("61000");
    expect(saved.gateway_session_affinity_ttl_hours).toBe("72");
    expect(saved.gateway_shutdown_grace_ms).toBe("5500");
    expect(saved.usage_refresh_timeout_ms).toBe("16000");
    expect(saved.gateway_request_body_limit_bytes).toBe(String(8 * 1024 * 1024));
    expect(saved.gateway_compaction_response_limit_bytes).toBe(String(24 * 1024 * 1024));
    expect(saved.gateway_websocket_pending_queue_limit_bytes).toBe(String(6 * 1024 * 1024));
    expect(saved.auto_start_gateway).toBe("true");
  });

  it("treats the gateway key as write-only", () => {
    const settings = {
      gateway_api_key_configured: "true",
      gateway_api_key_fingerprint: "abc123def456",
      auto_start_gateway: "false",
      auto_start_mcp_gateway: "false",
      ignore_five_hour_limit: "false"
    };
    const form = settingsToForm(settings);
    expect(form.gateway_api_key).toBe("");
    expect(formToSettings(settings, form).gateway_api_key).toBeUndefined();
    expect(formToSettings(settings, { ...form, gateway_api_key: "replacement" }).gateway_api_key).toBe("replacement");
  });

  it("round-trips the WebSocket HTTP-only model upgrade rejection toggle", () => {
    const settings = {
      gateway_websocket_reject_http_only_model_upgrade: "true",
      auto_start_gateway: "false",
      auto_start_mcp_gateway: "false",
      ignore_five_hour_limit: "false"
    };
    const form = settingsToForm(settings);
    expect(form.gateway_websocket_reject_http_only_model_upgrade_enabled).toBe(true);
    const saved = formToSettings(settings, {
      ...form,
      gateway_websocket_reject_http_only_model_upgrade_enabled: false
    });
    expect(saved.gateway_websocket_reject_http_only_model_upgrade).toBe("false");
  });

  it("preserves unmounted setting sections instead of converting missing fields to zero", () => {
    const current = {
      gateway_connect_timeout_ms: "30000",
      gateway_stream_idle_timeout_ms: "120000",
      gateway_request_body_limit_bytes: String(16 * 1024 * 1024),
      auto_start_gateway: "true",
      auto_start_mcp_gateway: "true",
      ignore_five_hour_limit: "true",
      gateway_host: "127.0.0.1"
    };
    const saved = formToSettings(current, { gateway_host: "localhost" });
    expect(saved.gateway_host).toBe("localhost");
    expect(saved.gateway_connect_timeout_ms).toBe("30000");
    expect(saved.gateway_stream_idle_timeout_ms).toBe("120000");
    expect(saved.gateway_request_body_limit_bytes).toBe(String(16 * 1024 * 1024));
    expect(saved.auto_start_gateway).toBe("true");
    expect(saved.auto_start_mcp_gateway).toBe("true");
    expect(saved.ignore_five_hour_limit).toBe("true");
  });

  it("renders categorized settings instead of a single configuration pile", async () => {
    const user = userEvent.setup();
    render(createElement(SettingsPage, {
        settings: {
          appearance_theme: "system",
          appearance_density: "comfortable",
          gateway_connect_timeout_ms: "30000",
          gateway_request_body_limit_bytes: String(16 * 1024 * 1024),
          auto_start_gateway: "false",
          auto_start_mcp_gateway: "false",
          ignore_five_hour_limit: "false"
        },
        paths: { dataDir: "D:/data", dbPath: "D:/data/gateway.sqlite" },
        onSave: vi.fn(),
        onMessage: vi.fn(),
        onClearTokenLogs: vi.fn(),
        onClearAppLogs: vi.fn()
      }));

    expect(screen.getByRole("menuitem", { name: "常规" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "API 服务" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "MCP 服务" })).toBeTruthy();
    expect(screen.getByText("应用行为")).toBeTruthy();
    expect(screen.getByText("外观")).toBeTruthy();
    expect(screen.getByText("延迟启动")).toBeTruthy();
    expect(screen.getByText("最小化到托盘")).toBeTruthy();
    expect(screen.queryByText("忽略 5 小时限制")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存设置" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "账号与额度" }));
    expect(screen.getByText("忽略 5 小时限制")).toBeTruthy();
    expect(screen.getByText("账号调度")).toBeTruthy();
    expect(screen.getByText("会话亲和有效期")).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "高级网络" }));
    expect(screen.getByText("超时与并发")).toBeTruthy();
    expect(screen.getAllByRole("menuitem")).toHaveLength(7);
    await user.click(screen.getByRole("menuitem", { name: "日志与计费" }));
    expect(screen.getByText("设置费用统计和界面展示使用的币种。")).toBeTruthy();
    await user.click(screen.getByRole("combobox", { name: "全局币种" }));
    expect(screen.getByText("美元（USD）")).toBeTruthy();
    expect(screen.getByText("人民币（CNY）")).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "常规" }));
    await user.click(screen.getByText("深色"));
    expect(screen.getByRole("button", { name: /保存设置/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "放弃更改" }));
    expect(screen.queryByRole("button", { name: /保存设置/ })).toBeNull();
  });

  it("shows a concise notice when the MCP service is not installed", async () => {
    const user = userEvent.setup();
    render(createElement(SettingsPage, {
      settings: {
        auto_start_gateway: "false",
        auto_start_mcp_gateway: "false",
        ignore_five_hour_limit: "false"
      },
      paths: {},
      mcpInstalled: false,
      onSave: vi.fn(),
      onMessage: vi.fn(),
      onClearTokenLogs: vi.fn(),
      onClearAppLogs: vi.fn()
    }));

    await user.click(screen.getByRole("menuitem", { name: "MCP 服务" }));
    expect(screen.getByText("未检测到 MCP 服务，请先安装 mcp-gateway-service。")).toBeTruthy();
  });
});
