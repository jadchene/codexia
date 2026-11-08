import { CheckCircleOutlined, KeyOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Flex, Segmented, Select, Space, Switch, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { PublicAccount } from "../../../shared/contracts/accounts";
import type { UpstreamSummary } from "../../../shared/contracts/upstreams";
import type { Settings } from "../../../shared/contracts/settings";
import { accountModeGatewayBaseUrl } from "../../../shared/account-mode-config";
import { isUsableAccount } from "../../lib/formatters";

type AuthMode = "gateway" | "account" | "openai" | "third_party" | "";
const modeLabels: Record<string, string> = { gateway: "网关模式", account: "账号模式", openai: "OpenAI 官方 API 模式", third_party: "第三方 API 模式" };
type GatewayConfigMode = "base_url" | "provider";

interface CodexIntegrationPageProps {
  settings: Settings;
  accounts: PublicAccount[];
  upstreams?: UpstreamSummary[];
  onApplyApi?: (mode: "openai" | "third_party", upstreamId: string, useApiProxy: boolean) => Promise<void>;
  gatewayBase: string;
  modelCatalogPath: string;
  /** 账号模式使用的订阅模型目录路径。 */
  accountModelCatalogPath: string;
  onMessage: (message: string) => void;
  onSaveSettings: (settings: Settings) => Promise<unknown>;
  onApplyGateway: () => Promise<void>;
  onApplyAccount: (accountId: string, useApiProxy: boolean) => Promise<void>;
}

export const CodexIntegrationPage = ({
  settings,
  accounts,
  upstreams = [],
  onApplyApi,
  gatewayBase,
  modelCatalogPath,
  accountModelCatalogPath,
  onMessage,
  onSaveSettings,
  onApplyGateway,
  onApplyAccount
}: CodexIntegrationPageProps) => {
  const [mode, setMode] = useState<AuthMode>(normalizeAuthMode(settings.codex_auth_mode));
  const [accountId, setAccountId] = useState(settings.codex_auth_mode === "account" ? settings.codex_selected_account_id || "" : "");
  const [gatewayConfigMode, setGatewayConfigMode] = useState<GatewayConfigMode>(gatewayConfigModeFromSettings(settings));
  const [useApiProxy, setUseApiProxy] = useState(settings.account_mode_use_api_proxy === "true");
  const [busy, setBusy] = useState(false);
  const [apiChannel, setApiChannel] = useState<Record<string, string>>({ openai: settings.openai_selected_upstream_id || "", third_party: settings.third_party_selected_upstream_id || "" });
  const [apiProxy, setApiProxy] = useState<Record<string, boolean>>({ openai: settings.openai_use_api_proxy === "true", third_party: settings.third_party_use_api_proxy === "true" });
  const [autoRestart, setAutoRestart] = useState<Record<string, boolean>>(() => Object.fromEntries(Object.keys(modeLabels).map((key) => [key, settings[`${key}_auto_restart_app_server`] === "true"])));
  const apiMode = mode === "openai" || mode === "third_party";
  const channels = upstreams.filter((channel) => channel.kind === "responses_api" && (channel.provider === "openai") === (mode === "openai"));
  const channel = channels.find((item) => item.id === apiChannel[mode]);
  const usableAccounts = useMemo(() => accounts.filter((account) => isUsableAccount(account, settings)), [accounts, settings]);
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const alreadyApplied = mode === "gateway"
    ? settings.codex_auth_mode === "gateway"
    : mode === "account" && settings.codex_auth_mode === "account" && settings.codex_selected_account_id === accountId;
  const gatewayConfigChanged = gatewayConfigMode !== gatewayConfigModeFromSettings(settings);
  const previewSettings = {
    ...settings,
    codex_config_use_openai_base_url: gatewayConfigMode === "base_url" ? "true" : "false"
  };
  const applyButtonText = mode === "gateway"
    ? alreadyApplied && !gatewayConfigChanged ? "重新应用到 Codex" : "应用到 Codex"
    : alreadyApplied ? "重新应用到 Codex" : "应用到 Codex";

  useEffect(() => {
    setMode(normalizeAuthMode(settings.codex_auth_mode));
    setAccountId(settings.codex_auth_mode === "account" ? settings.codex_selected_account_id || "" : "");
    setGatewayConfigMode(gatewayConfigModeFromSettings(settings));
    setUseApiProxy(settings.account_mode_use_api_proxy === "true");
  }, [settings]);

  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      const nextSettings: Settings = { ...settings, [`${mode}_auto_restart_app_server`]: String(Boolean(autoRestart[mode])),
        ...(mode === "gateway" ? { codex_config_use_openai_base_url: previewSettings.codex_config_use_openai_base_url } : {}) };
      if (nextSettings[`${mode}_auto_restart_app_server`] !== (settings[`${mode}_auto_restart_app_server`] || "false") || (mode === "gateway" && gatewayConfigChanged)) await onSaveSettings(nextSettings);
      if (mode === "gateway") {
        await onApplyGateway();
      }
      else if (mode === "account") await onApplyAccount(accountId, useApiProxy);
      else if (apiMode && onApplyApi) await onApplyApi(mode, apiChannel[mode] || "", Boolean(apiProxy[mode]));
    } catch (error) {
      onMessage(`应用结果：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="v1-page-card" variant="borderless">
      <Flex className="v1-page-actions" justify="flex-end" gap={16} wrap>
        {settings.codex_auth_mode && <Tag color="success" icon={<CheckCircleOutlined />}>当前：{modeLabels[settings.codex_auth_mode] || "未知"}</Tag>}
      </Flex>

      <Segmented
        block
        value={mode}
        onChange={(value) => setMode(value as AuthMode)}
        className="v1-auth-mode-group"
        options={[
          { label: "网关模式", value: "gateway", icon: <SafetyCertificateOutlined /> },
          { label: "账号模式", value: "account", icon: <KeyOutlined /> },
          { label: modeLabels.openai, value: "openai" },
          { label: modeLabels.third_party, value: "third_party" }
        ]}
      />

      {!mode && <Alert showIcon type="info" title="请选择 Codex 的接入方式。" />}

      {mode === "gateway" && (
        <Space orientation="vertical" size={16} style={{ width: "100%" }}>
          <Alert
            showIcon
            type="success"
            title="网关模式"
            description="Codex 将使用已配置的订阅账号和模型渠道，并根据所选模型发送请求。"
          />
          <Card size="small" title="配置写入方式">
            <Space orientation="vertical" size={8} style={{ width: "100%" }}>
              <Typography.Text type="secondary">决定应用网关模式时写入 config.toml 的连接配置。</Typography.Text>
              <Segmented
                block
                value={gatewayConfigMode}
                onChange={(value) => setGatewayConfigMode(value as GatewayConfigMode)}
                options={[
                  { label: "Base URL（推荐）", value: "base_url" },
                  { label: "自定义 Provider", value: "provider" }
                ]}
              />
            </Space>
          </Card>
          <div className="v1-auth-preview-grid">
            <CodePreview title="auth.json" value={JSON.stringify({ OPENAI_API_KEY: maskedGatewayKey(settings) }, null, 2)} />
            <CodePreview title="config.toml" value={providerToml(previewSettings, gatewayBase, modelCatalogPath)} />
          </div>
        </Space>
      )}

      {mode === "account" && (
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <Alert
            showIcon
            type="warning"
            title="Codex 将直接使用所选账号"
            description="关闭代理时直接访问官方服务；开启后通过本地网关服务透明转发。模型列表沿用账号池的覆盖、名称和显示设置，不包含 API 渠道模型。"
          />
          <Select
            showSearch
            value={accountId || null}
            placeholder="选择一个可用订阅账号"
            optionFilterProp="label"
            options={accounts.map((account) => ({
              value: account.id,
              label: account.name || "未命名账号",
              disabled: !isUsableAccount(account, settings)
            }))}
            onChange={setAccountId}
          />
          {accounts.length > 0 && usableAccounts.length === 0 && <Alert showIcon type="error" title="当前没有可用账号，请先刷新额度或重新登录。" />}
          <Space orientation="vertical" size={2}>
            <Flex align="center" gap={10}>
              <Typography.Text strong>通过网关服务代理</Typography.Text>
              <Switch aria-label="通过网关服务代理" checked={useApiProxy} onChange={setUseApiProxy} />
            </Flex>
            <Typography.Text type="secondary">通过现有网关服务透明转发，仅记录请求日志</Typography.Text>
          </Space>
          {useApiProxy && <CodePreview title="config.toml" value={providerToml(
            { ...settings, codex_config_use_openai_base_url: "true" },
            accountModeGatewayBaseUrl(settings),
            accountModelCatalogPath
          )} />}
        </Space>
      )}

      {apiMode && <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Alert showIcon type="info" title="仅使用所选模型渠道" description="直接使用该渠道的 API Key 和模型目录；开启代理后固定转发至该渠道，不使用账号池、路由回退或参数改写。" />
        <Select aria-label="模型渠道" placeholder="选择模型渠道" value={apiChannel[mode] || null}
          options={channels.map((item) => ({ value: item.id, label: item.name, disabled: !item.hasApiKey }))}
          onChange={(value) => setApiChannel((current) => ({ ...current, [mode]: value }))} />
        {!channels.length && <Typography.Text type="secondary">请先在模型渠道中添加对应类型的 API 渠道。</Typography.Text>}
        <Flex align="center" gap={10}>
          <Typography.Text strong>通过网关服务代理</Typography.Text>
          <Switch aria-label="通过网关服务代理" checked={Boolean(apiProxy[mode])} onChange={(value) => setApiProxy((current) => ({ ...current, [mode]: value }))} />
        </Flex>
        <Typography.Text type="secondary">透明转发，仅记录请求日志；渠道开关仅影响网关模式。</Typography.Text>
      </Space>}
      {mode && <Flex align="center" gap={10} style={{ marginTop: 16 }}>
        <Typography.Text strong>自动重启 appserver</Typography.Text>
        <Switch aria-label="自动重启 appserver" checked={Boolean(autoRestart[mode])} onChange={(value) => setAutoRestart((current) => ({ ...current, [mode]: value }))} />
        <Typography.Text type="secondary">应用到 Codex 后重启 daemon app server</Typography.Text>
      </Flex>}
      <Flex justify="flex-end" className="v1-auth-actions">
        <Button
          type="primary"
          loading={busy}
          disabled={!mode || (apiMode && (!channel?.hasApiKey || !onApplyApi)) || (mode === "account" && (!accountId || !isUsableAccount(selectedAccount, settings)))}
          onClick={apply}
        >
          {applyButtonText}
        </Button>
      </Flex>
    </Card>
  );
};

const CodePreview = ({ title, value }: { title: string; value: string }) => (
  <Card size="small" title={title}>
    <Typography.Paragraph copyable={{ text: value }} className="v1-code-preview">
      <pre>{value}</pre>
    </Typography.Paragraph>
  </Card>
);

const normalizeAuthMode = (value: unknown): AuthMode => (
  value === "gateway" || value === "account" || value === "openai" || value === "third_party" ? value : ""
);

const gatewayConfigModeFromSettings = (settings: Settings): GatewayConfigMode => (
  settings.codex_config_use_openai_base_url === "false" ? "provider" : "base_url"
);

const maskedGatewayKey = (settings: Settings): string => settings.gateway_api_key_configured === "true"
  ? "••••••••（已配置）"
  : "未配置";

const providerToml = (settings: Settings, gatewayBase: string, modelCatalogPath: string): string => {
  const baseUrl = gatewayBase || `http://${gatewayProviderHost(settings.gateway_host)}:${settings.gateway_port || "8436"}/v1`;
  const catalog = `model_catalog_json = "${modelCatalogPath.replaceAll("\\", "/")}"`;
  if (settings.codex_config_use_openai_base_url !== "false") {
    return [
      catalog,
      `openai_base_url = "${baseUrl}"`
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
    "supports_websockets = true"
  ].join("\n");
};

const gatewayProviderHost = (host: unknown): string => {
  const value = String(host || "").trim();
  return !value || value === "0.0.0.0" ? "localhost" : value;
};
