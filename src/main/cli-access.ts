import path from "node:path";
import { applyAccountMode, applyApiMode, applyGatewayMode, detectCodexAuthMode, readCodexAccountTokens, writeFilesTransaction } from "./codex-cli-auth.ts";
import { restartCodexDaemon } from "./codex-daemon.ts";
import { accountModeGatewayBaseUrl } from "../shared/account-mode-config.ts";
import type { createStore } from "./store.ts";
import type { createUpstreamService } from "./upstreams/upstream-service.ts";
import type { createCodexModelCatalogService } from "./codex-model-catalog.ts";
import { ACCESS_MODES, type AccessMode, type CliBackend } from "./cli.ts";

export function createCliAccess(options: {
  store: ReturnType<typeof createStore>;
  upstreams: ReturnType<typeof createUpstreamService>;
  catalog: ReturnType<typeof createCodexModelCatalogService>;
  codexOptions: { codexDir?: string };
  restart?: typeof restartCodexDaemon;
  ensureGateway?: () => Promise<unknown>;
  onApplied?: () => void;
}): CliBackend {
  const { store, upstreams, catalog, codexOptions } = options;
  const proxyKey = (mode: AccessMode) => mode === "account" ? "account_mode_use_api_proxy" : `${mode}_use_api_proxy`;
  const defaults = (mode: AccessMode) => {
    const settings = store.getSettings();
    return {
      targetId: String(mode === "account" ? settings.codex_selected_account_id || "" : settings[`${mode}_selected_upstream_id`] || ""),
      proxy: settings[proxyKey(mode)] === "true",
      restart: settings[`${mode}_auto_restart_app_server`] === "true"
    };
  };
  const choices: CliBackend["choices"] = (mode) => mode === "gateway" ? [] : mode === "account"
    ? store.listAccounts().filter((a) => a.enabled && a.status !== "disabled" && a.access_token && a.refresh_token).map((a) => ({ id: String(a.id), label: String(a.name || a.email || a.id) }))
    : upstreams.list().filter((u) => u.enabled && u.kind === "responses_api" && (u.provider === "openai") === (mode === "openai"))
      .map((u) => ({ id: u.id, label: u.name }));
  return {
    defaults, choices,
    show: () => {
      const settings = store.getSettings();
      const detected = detectCodexAuthMode(settings, store.listAccounts() as Parameters<typeof detectCodexAuthMode>[1], codexOptions);
      const mode = settings.codex_auth_mode as AccessMode;
      const lines = [`Codexia 配置模式：${ACCESS_MODES[mode] || "未设置"}`, `Codex 认证识别：${ACCESS_MODES[detected.mode as AccessMode] || "未知/未配置"}`];
      if (Object.hasOwn(ACCESS_MODES, mode)) {
        const selected = defaults(mode);
        if (mode !== "gateway") {
          const targetId = mode === "account" ? settings.codex_selected_account_id : settings.codex_selected_upstream_id;
          const target = choices(mode).find((item) => item.id === targetId);
          lines.push(`当前${mode === "account" ? "账号" : "渠道"}：${target?.label || "未选择或不可用"}${targetId ? ` [${targetId}]` : ""}`,
            `网关代理：${selected.proxy ? "启用" : "关闭"}`);
        }
        lines.push(`自动重启 app-server：${selected.restart ? "启用" : "关闭"}`);
      }
      for (const m of ["account", "openai", "third_party"] as const) {
        lines.push(`\n${ACCESS_MODES[m]}可选项：`, ...choices(m).map((item) => `  ${item.id}  ${item.label}`));
      }
      return lines.join("\n");
    },
    apply: async ({ mode, targetId, proxy, restart }) => {
      if (mode !== "gateway" && !choices(mode).some((item) => item.id === targetId)) throw new Error("所选账号/渠道不可用。");
      if (mode === "gateway" || proxy) await options.ensureGateway?.();
      const settings = store.getSettings();
      // Detect the actual auth owner, so direct Codex refreshes and external account switches are respected.
      const accounts = store.listAccounts();
      const detected = detectCodexAuthMode(settings, accounts as Parameters<typeof detectCodexAuthMode>[1], codexOptions);
      if (detected.mode === "account" && detected.accountId) {
        const owned = accounts.find((a) => a.id === detected.accountId);
        if (owned) store.saveAccount({ ...owned, ...readCodexAccountTokens(owned as Parameters<typeof readCodexAccountTokens>[0], codexOptions) });
      }
      if (mode === "account") {
        catalog.refresh();
        const account = store.listAccounts().find((a) => a.id === targetId);
        applyAccountMode(account as Parameters<typeof applyAccountMode>[0], { ...codexOptions, modelCatalogPath: catalog.accountPath,
          ...(proxy ? { accountModeBaseUrl: accountModeGatewayBaseUrl(settings) } : {}) });
      } else if (mode === "gateway") {
        catalog.refresh();
        applyGatewayMode(settings, { ...codexOptions, modelCatalogPath: catalog.path });
      } else {
        const channel = upstreams.getRuntime(targetId);
        if (!channel?.apiKey) throw new Error("渠道没有可用 API Key。");
        const models = upstreams.listModels(targetId).filter((model) => model.available);
        if (!models.length) throw new Error("渠道没有可用模型，请先在桌面应用中配置模型目录。");
        const catalogPath = path.join(store.paths.dataDir, "api-models.json");
        writeFilesTransaction([{ file: catalogPath, content: JSON.stringify({ models: models.map((model) => ({
          ...model.metadata, slug: model.modelId, display_name: model.displayName,
          prefer_websockets: channel.supportsWebSocket, supports_websockets: channel.supportsWebSocket
        })) }, null, 2) }]);
        applyApiMode(channel, { ...codexOptions, modelCatalogPath: catalogPath,
          ...(proxy ? { accountModeBaseUrl: accountModeGatewayBaseUrl(settings) } : {}) });
      }
      store.saveSettings({ codex_auth_mode: mode, codex_selected_account_id: mode === "account" ? targetId : "",
        codex_selected_upstream_id: ["openai", "third_party"].includes(mode) ? targetId : "",
        ...(mode !== "gateway" ? { [proxyKey(mode)]: String(proxy) } : {}),
        ...(["openai", "third_party"].includes(mode) ? { [`${mode}_selected_upstream_id`]: targetId } : {}),
        [`${mode}_auto_restart_app_server`]: String(restart) });
      store.addAppLog({ scope: "cli", action: "apply-access-mode", status: "success", message: `已应用${ACCESS_MODES[mode]}` });
      options.onApplied?.();
      if (restart) await (options.restart || restartCodexDaemon)(codexOptions);
    }
  };
}
