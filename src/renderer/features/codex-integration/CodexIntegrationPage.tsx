import { ApiOutlined, CheckCircleOutlined, CloudOutlined, KeyOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Flex, Segmented, Select, Space, Switch, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { PublicAccount } from "../../../shared/contracts/accounts";
import type { UpstreamSummary } from "../../../shared/contracts/upstreams";
import type { Settings } from "../../../shared/contracts/settings";
import { accountModeGatewayBaseUrl } from "../../../shared/account-mode-config";
import { isUsableAccount } from "../../lib/formatters";

type AuthMode = "gateway" | "account" | "openai" | "third_party" | "";
const modeLabels: Record<string, string> = { gateway: "网关模式", account: "账号模式", openai: "OpenAI API 模式", third_party: "第三方 API 模式" };

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
  const [useApiProxy, setUseApiProxy] = useState(settings.account_mode_use_api_proxy === "true");
  const [busy, setBusy] = useState(false);
  const [apiChannel, setApiChannel] = useState<Record<string, string>>({ openai: settings.openai_selected_upstream_id || "", third_party: settings.third_party_selected_upstream_id || "" });
  const [apiProxy, setApiProxy] = useState<Record<string, boolean>>({ openai: settings.openai_use_api_proxy === "true", third_party: settings.third_party_use_api_proxy === "true" });
  const [autoRestart, setAutoRestart] = useState<Record<string, boolean>>(() => Object.fromEntries(Object.keys(modeLabels).map((key) => [key, settings[`${key}_auto_restart_app_server`] === "true"])));
  const [modelCatalog, setModelCatalog] = useState<Record<string, boolean>>(() => Object.fromEntries(Object.keys(modeLabels).map((key) => [key, settings[`${key}_use_model_catalog`] !== "false"])));
  const forcedProxy = mode === "gateway" || mode === "third_party";
  const proxyEnabled = forcedProxy || (mode === "account" ? useApiProxy : Boolean(apiProxy[mode]));
  const catalogEnabled = mode === "third_party" || Boolean(modelCatalog[mode]);
  const catalogPath = mode === "account" ? accountModelCatalogPath : mode === "gateway" ? modelCatalogPath : modelCatalogPath.replace(/[^/\\]+$/, "api-models.json");
  const apiMode = mode === "openai" || mode === "third_party";
  const channels = upstreams.filter((channel) => channel.kind === "responses_api" && (channel.provider === "openai") === (mode === "openai"));
  const channel = channels.find((item) => item.id === apiChannel[mode]);
  const usableAccounts = useMemo(() => accounts.filter((account) => isUsableAccount(account, settings)), [accounts, settings]);
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const alreadyApplied = mode === "gateway"
    ? settings.codex_auth_mode === "gateway"
    : mode === "account" && settings.codex_auth_mode === "account" && settings.codex_selected_account_id === accountId;
  const applyButtonText = alreadyApplied ? "重新应用到 Codex" : "应用到 Codex";

  useEffect(() => {
    setMode(normalizeAuthMode(settings.codex_auth_mode));
    setAccountId(settings.codex_auth_mode === "account" ? settings.codex_selected_account_id || "" : "");
    setUseApiProxy(settings.account_mode_use_api_proxy === "true");
    setApiChannel({ openai: settings.openai_selected_upstream_id || "", third_party: settings.third_party_selected_upstream_id || "" });
    setApiProxy({ openai: settings.openai_use_api_proxy === "true", third_party: settings.third_party_use_api_proxy === "true" });
    setAutoRestart(Object.fromEntries(Object.keys(modeLabels).map((key) => [key, settings[`${key}_auto_restart_app_server`] === "true"])));
    setModelCatalog(Object.fromEntries(Object.keys(modeLabels).map((key) => [key, settings[`${key}_use_model_catalog`] !== "false"])));
  }, [settings]);

  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      const nextSettings: Settings = { ...settings, [`${mode}_auto_restart_app_server`]: String(Boolean(autoRestart[mode])),
        ...(mode !== "third_party" ? { [`${mode}_use_model_catalog`]: String(catalogEnabled) } : {}) };
      if (nextSettings[`${mode}_auto_restart_app_server`] !== (settings[`${mode}_auto_restart_app_server`] || "false")
        || (mode !== "third_party" && nextSettings[`${mode}_use_model_catalog`] !== (settings[`${mode}_use_model_catalog`] || "true"))) await onSaveSettings(nextSettings);
      if (mode === "gateway") {
        await onApplyGateway();
      }
      else if (mode === "account") await onApplyAccount(accountId, useApiProxy);
      else if (apiMode && onApplyApi) await onApplyApi(mode, apiChannel[mode] || "", proxyEnabled);
    } catch (error) {
      onMessage(`应用结果：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="v1-page-card v1-access-page" variant="borderless">
      <Flex className="v1-page-actions" justify="flex-end" gap={16} wrap>
        {settings.codex_auth_mode && <Tag color="success" icon={<CheckCircleOutlined />}>当前：{modeLabels[settings.codex_auth_mode] || "未知"}</Tag>}
      </Flex>

      <Segmented
        block
        value={mode}
        disabled={busy}
        onChange={(value) => setMode(value as AuthMode)}
        className="v1-auth-mode-group"
        options={[
          { label: "网关模式", value: "gateway", icon: <SafetyCertificateOutlined /> },
          { label: "账号模式", value: "account", icon: <KeyOutlined /> },
          { label: modeLabels.openai, value: "openai", icon: <CloudOutlined aria-hidden="true" /> },
          { label: modeLabels.third_party, value: "third_party", icon: <ApiOutlined aria-hidden="true" /> }
        ]}
      />

      <div className="v1-access-content">
      {!mode && <Alert showIcon type="info" title="请选择 Codex 的接入方式。" />}

      {mode === "gateway" && (
        <Space orientation="vertical" size={16} style={{ width: "100%" }}>
          <Alert
            showIcon
            type="info"
            title="通过网关统一使用账号和渠道"
            description="Codex 连接本地网关，由网关根据所选模型分配请求，并记录调用和用量。使用前请在服务管理中启动网关。"
          />

        </Space>
      )}

      {mode === "account" && (
        <Space orientation="vertical" size={16} style={{ width: "100%" }}>
          <Alert
            showIcon
            type="info"
            title="使用一个 ChatGPT 订阅账号"
            description="Codex 使用所选账号的订阅额度，模型列表沿用账号池设置。默认直连，开启网关代理可在 Codexia 中查看调用记录。"
          />
          <Select
            showSearch
            className="v1-account-select"
            aria-label="订阅账号"
            style={{ width: "100%" }}
            disabled={busy}
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
        </Space>
      )}

      {apiMode && <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          showIcon
          type="info"
          title={mode === "openai" ? "使用 OpenAI API 调用模型" : "使用第三方 API 调用模型"}
          description={mode === "openai"
            ? "选择一个 OpenAI 渠道，使用其 API Key 和模型目录，费用由 OpenAI 计收。默认直连，开启网关代理可在 Codexia 中查看调用记录。"
            : "通过本地网关连接所选第三方渠道，仅显示和使用该渠道的模型，费用由该渠道计收。请保持 Codexia 和网关服务运行。"}
        />
        <Select style={{ width: "100%" }} disabled={busy} aria-label="模型渠道" placeholder="选择模型渠道" value={apiChannel[mode] || null}
          options={channels.map((item) => ({ value: item.id, label: item.name, disabled: !item.hasApiKey }))}
          onChange={(value) => setApiChannel((current) => ({ ...current, [mode]: value }))} />
        {!channels.length && <Typography.Text type="secondary">请先在模型渠道中添加对应类型的 API 渠道。</Typography.Text>}
      </Space>}
      {mode && <Card size="small" title="连接选项" className="v1-access-options">
        <div className="v1-access-option">
          <div>
            <Typography.Text strong>通过网关服务代理</Typography.Text>
            <Typography.Paragraph type="secondary">
              {mode === "gateway" ? "网关模式通过本地网关分配请求，此选项始终开启。" : mode === "third_party" ? "第三方 API 必须通过网关连接所选渠道，此选项始终开启。" : "通过现有网关服务透明转发，仅记录请求日志"}
            </Typography.Paragraph>
          </div>
          <Switch aria-label="通过网关服务代理" disabled={busy || forcedProxy}
            checked={proxyEnabled}
            onChange={(value) => mode === "account" ? setUseApiProxy(value) : setApiProxy((current) => ({ ...current, [mode]: value }))} />
        </div>
        <div className="v1-access-option">
          <div>
            <Typography.Text strong>使用模型目录</Typography.Text>
            <Typography.Paragraph type="secondary">{mode === "third_party" ? "仅使用所选渠道的可用模型，此选项始终开启。" : "写入当前模式的 model_catalog_json；关闭后清除此配置，使用 Codex 默认模型目录。"}</Typography.Paragraph>
          </div>
          <Switch aria-label="使用模型目录" disabled={busy || mode === "third_party"} checked={catalogEnabled}
            onChange={(value) => setModelCatalog((current) => ({ ...current, [mode]: value }))} />
        </div>
        <div className="v1-access-option">
          <div>
            <Typography.Text strong>自动重启 Codex 服务</Typography.Text>
            <Typography.Paragraph type="secondary">应用配置后自动重启 Codex 后台服务；关闭时需手动重启。</Typography.Paragraph>
          </div>
          <Switch aria-label="自动重启 Codex 服务" disabled={busy} checked={Boolean(autoRestart[mode])}
            onChange={(value) => setAutoRestart((current) => ({ ...current, [mode]: value }))} />
        </div>
      </Card>}
      {mode && (
          <div className="v1-auth-preview-grid">
            {(mode === "gateway" || apiMode) && <CodePreview title="auth.json" value={JSON.stringify({ OPENAI_API_KEY: mode === "gateway" ? maskedGatewayKey(settings) : channel?.hasApiKey ? "••••••••（所选渠道的 API Key）" : "未选择已配置密钥的渠道" }, null, 2)} />}
            <CodePreview title="config.toml" value={[
              '# 清理旧的 model_provider、codexia / codex_gateway 配置',
              ...(catalogEnabled ? [`model_catalog_json = ${JSON.stringify(catalogPath.replaceAll("\\", "/"))}`] : ['# 清除 model_catalog_json']),
              ...(proxyEnabled ? [`openai_base_url = ${JSON.stringify(gatewayBase || accountModeGatewayBaseUrl(settings))}`] : ['# 清除 openai_base_url，恢复直连']),
              ...(apiMode && channel ? [`# codexia_channel = ${JSON.stringify(channel.id)}`] : [])
            ].join("\n")} />
          </div>
      )}
      </div>
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

const maskedGatewayKey = (settings: Settings): string => settings.gateway_api_key_configured === "true"
  ? "••••••••（已配置）"
  : "未配置";
