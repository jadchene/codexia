import { CheckCircleOutlined, KeyOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Flex, Radio, Segmented, Select, Space, Switch, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { PublicAccount } from "../../../shared/contracts/accounts";
import type { Settings } from "../../../shared/contracts/settings";
import { isUsableAccount } from "../../lib/formatters";

type AuthMode = "gateway" | "account" | "";
type GatewayConfigMode = "base_url" | "provider";

interface CodexIntegrationPageProps {
  settings: Settings;
  accounts: PublicAccount[];
  gatewayBase: string;
  modelCatalogPath: string;
  onMessage: (message: string) => void;
  onSaveSettings: (settings: Settings) => Promise<unknown>;
  onApplyGateway: () => Promise<void>;
  onApplyAccount: (accountId: string, useApiProxy: boolean) => Promise<void>;
}

export const CodexIntegrationPage = ({
  settings,
  accounts,
  gatewayBase,
  modelCatalogPath,
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
  const usableAccounts = useMemo(() => accounts.filter((account) => isUsableAccount(account, settings)), [accounts, settings]);
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const alreadyApplied = mode === "gateway"
    ? settings.codex_auth_mode === "gateway"
    : mode === "account" && settings.codex_auth_mode === "account" && settings.codex_selected_account_id === accountId;
  const gatewayConfigChanged = gatewayConfigMode !== gatewayConfigModeFromSettings(settings);
  const apiProxyChanged = useApiProxy !== (settings.account_mode_use_api_proxy === "true");
  const previewSettings = {
    ...settings,
    codex_config_use_openai_base_url: gatewayConfigMode === "base_url" ? "true" : "false"
  };
  const applyButtonText = mode === "gateway"
    ? alreadyApplied && !gatewayConfigChanged ? "重新应用到 Codex" : "应用到 Codex"
    : alreadyApplied && !apiProxyChanged ? "已应用" : alreadyApplied ? "重新应用到 Codex" : "应用到 Codex";

  useEffect(() => {
    setMode(normalizeAuthMode(settings.codex_auth_mode));
    setAccountId(settings.codex_auth_mode === "account" ? settings.codex_selected_account_id || "" : "");
    setGatewayConfigMode(gatewayConfigModeFromSettings(settings));
    setUseApiProxy(settings.account_mode_use_api_proxy === "true");
  }, [settings]);

  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      if (mode === "gateway") {
        if (gatewayConfigChanged) await onSaveSettings(previewSettings);
        await onApplyGateway();
      }
      else if (mode === "account") await onApplyAccount(accountId, useApiProxy);
    } catch (error) {
      onMessage(`写入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="v1-page-card" variant="borderless">
      <Flex className="v1-page-actions" justify="flex-end" gap={16} wrap>
        {settings.codex_auth_mode && <Tag color="success" icon={<CheckCircleOutlined />}>当前：{settings.codex_auth_mode === "gateway" ? "API 模式" : "账号模式"}</Tag>}
      </Flex>

      <Radio.Group value={mode} onChange={(event) => setMode(event.target.value as AuthMode)} className="v1-auth-mode-group">
        <Radio.Button value="gateway">
          <Space><SafetyCertificateOutlined /><span>API 模式</span></Space>
        </Radio.Button>
        <Radio.Button value="account">
          <Space><KeyOutlined /><span>账号模式</span></Space>
        </Radio.Button>
      </Radio.Group>

      {!mode && <Alert showIcon type="info" title="请选择 Codex 的接入方式。" />}

      {mode === "gateway" && (
        <Space orientation="vertical" size={16} style={{ width: "100%" }}>
          <Alert
            showIcon
            type="success"
            title="推荐模式"
            description="Codex 将使用已配置的订阅账号和模型渠道，并根据所选模型发送请求。"
          />
          <Card size="small" title="配置写入方式">
            <Space orientation="vertical" size={8} style={{ width: "100%" }}>
              <Typography.Text type="secondary">决定应用 API 模式时写入 config.toml 的连接配置。</Typography.Text>
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
            description="账号模式不会经过本地服务。需要使用模型渠道时，请重新应用 API 模式。"
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
              <Typography.Text strong>通过 API 服务代理</Typography.Text>
              <Switch size="small" aria-label="通过 API 服务代理" checked={useApiProxy} onChange={setUseApiProxy} />
            </Flex>
            <Typography.Text type="secondary">通过现有 API 服务透明转发，仅记录请求日志</Typography.Text>
          </Space>
        </Space>
      )}

      <Flex justify="flex-end" className="v1-auth-actions">
        <Button
          type="primary"
          loading={busy}
          disabled={!mode || (mode === "account" && ((alreadyApplied && !apiProxyChanged) || !accountId || !isUsableAccount(selectedAccount, settings)))}
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
  value === "gateway" || value === "account" ? value : ""
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
