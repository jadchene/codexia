import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Flex,
  Form,
  Input,
  InputNumber,
  Menu,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Switch,
  Typography
} from "antd";
import { CopyOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { applyAppearancePreferences, appearanceFromSettings } from "../../app/appearance";
import { CURRENCY_OPTIONS } from "../../lib/currency";

type SettingsRecord = Record<string, string>;

interface SettingsPageProps {
  settings: SettingsRecord;
  paths: { dataDir?: string; dbPath?: string };
  mcpInstalled?: boolean | undefined;
  onSave: (settings: SettingsRecord) => Promise<unknown>;
  onMessage: (message: string) => void;
  onClearTokenLogs: () => Promise<void>;
  onClearAppLogs: () => Promise<void>;
}

type SettingsFormValues = Record<string, unknown> & {
  gateway_connect_timeout_seconds: string | number;
  gateway_stream_idle_timeout_seconds: string | number;
  gateway_unary_timeout_seconds: string | number;
  gateway_websocket_idle_timeout_seconds: string | number;
  gateway_quota_cooldown_seconds: string | number;
  gateway_session_affinity_ttl_hours: string | number;
  gateway_shutdown_grace_seconds: string | number;
  usage_refresh_timeout_seconds: string | number;
  gateway_request_body_limit_mib: string | number;
  gateway_error_body_limit_mib: string | number;
  gateway_compaction_response_limit_mib: string | number;
  gateway_websocket_max_payload_mib: string | number;
  gateway_websocket_buffer_high_water_mib: string | number;
  gateway_websocket_pending_queue_limit_mib: string | number;
  auto_start_gateway_enabled: boolean;
  auto_start_mcp_gateway_enabled: boolean;
  ignore_five_hour_limit_enabled: boolean;
  gateway_websocket_reject_http_only_model_upgrade_enabled: boolean;
};

const SECOND_FIELDS: Record<string, string> = {
  gateway_connect_timeout_seconds: "gateway_connect_timeout_ms",
  gateway_stream_idle_timeout_seconds: "gateway_stream_idle_timeout_ms",
  gateway_unary_timeout_seconds: "gateway_unary_timeout_ms",
  gateway_websocket_idle_timeout_seconds: "gateway_websocket_idle_timeout_ms",
  gateway_quota_cooldown_seconds: "gateway_quota_cooldown_ms",
  gateway_shutdown_grace_seconds: "gateway_shutdown_grace_ms",
  usage_refresh_timeout_seconds: "usage_refresh_timeout_ms"
};

const MIB_FIELDS: Record<string, string> = {
  gateway_request_body_limit_mib: "gateway_request_body_limit_bytes",
  gateway_error_body_limit_mib: "gateway_error_body_limit_bytes",
  gateway_compaction_response_limit_mib: "gateway_compaction_response_limit_bytes",
  gateway_websocket_max_payload_mib: "gateway_websocket_max_payload_bytes",
  gateway_websocket_buffer_high_water_mib: "gateway_websocket_buffer_high_water_bytes",
  gateway_websocket_pending_queue_limit_mib: "gateway_websocket_pending_queue_limit_bytes"
};

export const SettingsPage = ({
  settings,
  paths,
  mcpInstalled,
  onSave,
  onMessage,
  onClearTokenLogs,
  onClearAppLogs
}: SettingsPageProps) => {
  const [form] = Form.useForm<SettingsFormValues>();
  const [activeSection, setActiveSection] = useState("general");
  const [dirty, setDirty] = useState(false);
  const [autoReviewModelOptions, setAutoReviewModelOptions] = useState<Array<{ value: string; label: string }>>([]);

  useEffect(() => {
    form.setFieldsValue(settingsToForm(settings));
    setDirty(false);
  }, [form, settings]);

  useEffect(() => {
    let cancelled = false;
    window.codexGateway?.listGatewayModels?.()
      .then((models) => {
        if (cancelled) return;
        setAutoReviewModelOptions(models.map((item) => ({
          value: item.modelId,
          label: `${item.displayName}（${item.upstreamName}）`
        })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (values: SettingsFormValues): Promise<void> => {
    const next = formToSettings(settings, values);
    try {
      await onSave(next);
      applyAppearancePreferences(appearanceFromSettings(next));
      setDirty(false);
    } catch {
      applyAppearancePreferences(appearanceFromSettings(settings));
    }
  };

  const copyGatewayKey = async (): Promise<void> => {
    const value = String(form.getFieldValue("gateway_api_key") || "");
    if (!value) {
      onMessage("如需复制，请先生成一个新密钥。");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      onMessage("新本地 API Key 已复制；保存后请同步更新客户端配置。");
    } catch (error) {
      onMessage(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const previewAppearance = (_: Partial<SettingsFormValues>, values: SettingsFormValues): void => {
    setDirty(true);
    applyAppearancePreferences(appearanceFromSettings({
      appearance_theme: values.appearance_theme,
      appearance_density: values.appearance_density
    }));
  };

  const discard = (): void => {
    form.setFieldsValue(settingsToForm(settings));
    applyAppearancePreferences(appearanceFromSettings(settings));
    setDirty(false);
  };

  const generalTab = (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <SettingsSection title="应用行为" description="设置应用的启动和关闭方式。">
        <div className="v1-settings-grid v1-settings-grid-2">
          <Form.Item name="startup_launch" label="开机自启">
            <Segmented block options={[
              { label: "关闭", value: "disabled" },
              { label: "自动启动", value: "auto" },
              { label: "延迟启动", value: "delayed" }
            ]} />
          </Form.Item>
          <Form.Item name="close_behavior" label="关闭窗口时">
            <Segmented block options={[
              { label: "退出应用", value: "exit" },
              { label: "最小化到托盘", value: "tray" }
            ]} />
          </Form.Item>
        </div>
      </SettingsSection>
      <SettingsSection title="外观" description="选择界面主题和显示密度。">
        <div className="v1-settings-grid v1-settings-grid-2">
          <Form.Item name="appearance_theme" label="主题">
            <Segmented block options={[
              { label: "跟随系统", value: "system" },
              { label: "浅色", value: "light" },
              { label: "深色", value: "dark" }
            ]} />
          </Form.Item>
          <Form.Item name="appearance_density" label="界面密度">
            <Segmented block options={[
              { label: "舒适", value: "comfortable" },
              { label: "紧凑", value: "compact" }
            ]} />
          </Form.Item>
        </div>
      </SettingsSection>
    </Space>
  );

  const gatewayTab = (
    <SettingsSection title="服务监听" description="设置 API 服务的监听地址和访问密钥。">
        <div className="v1-settings-grid v1-settings-grid-2">
          <Form.Item name="gateway_host" label="监听地址" rules={[{ required: true }]}>
            <Input placeholder="127.0.0.1" />
          </Form.Item>
          <Form.Item name="gateway_port" label="端口" rules={[{ required: true }]}>
            <InputNumber min={1} max={65535} precision={0} style={{ width: "100%" }} />
          </Form.Item>
        </div>
        <Form.Item shouldUpdate noStyle>
          {({ getFieldValue }) => !isLoopbackHost(getFieldValue("gateway_host")) && (
            <Alert
              showIcon
              type="warning"
              title="当前监听地址会向本机外部开放代理能力，请使用随机 API Key 并限制防火墙访问范围。"
            />
          )}
        </Form.Item>
        <Form.Item
          label="更换访问密钥"
          extra={settings.gateway_api_key_configured === "true"
            ? "已设置。留空会保留当前密钥。"
            : "尚未设置，请生成或输入一个新密钥。"}
        >
          <Space.Compact block>
            <Form.Item name="gateway_api_key" noStyle>
              <Input.Password autoComplete="new-password" placeholder="留空保留现有密钥" />
            </Form.Item>
            <Button
              aria-label="重新生成访问密钥"
              icon={<ReloadOutlined />}
              onClick={() => form.setFieldValue("gateway_api_key", generateApiKey())}
            />
            <Button aria-label="复制访问密钥" icon={<CopyOutlined />} onClick={copyGatewayKey} />
          </Space.Compact>
        </Form.Item>
        <Flex align="center" justify="space-between" className="v1-setting-switch-row">
          <div>
            <Typography.Text strong>自动启动 API 服务</Typography.Text>
            <Typography.Text type="secondary" className="v1-block">打开应用时自动启动服务。</Typography.Text>
          </div>
          <Form.Item name="auto_start_gateway_enabled" valuePropName="checked" noStyle><Switch /></Form.Item>
        </Flex>
    </SettingsSection>
  );

  const quotaTab = (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <SettingsSection title="额度刷新">
        <div className="v1-settings-grid v1-settings-grid-2">
          <NumberField name="usage_refresh_interval_secs" label="自动刷新间隔" suffix="秒（0 为关闭）" min={0} max={86400} />
          <NumberField name="usage_refresh_timeout_seconds" label="单次刷新超时" suffix="秒" min={1} max={300} />
        </div>
      </SettingsSection>
      <SettingsSection title="账号调度" description="设置会话账号亲和、账号选择和额度耗尽后的冷却策略。">
        <div className="v1-settings-grid v1-settings-grid-2">
          <NumberField
            name="gateway_session_affinity_ttl_hours"
            label="会话亲和有效期"
            suffix="小时"
            min={1}
            max={8760}
          />
          <NumberField name="gateway_quota_cooldown_seconds" label="账号失败冷却" suffix="秒" min={1} max={3600} />
        </div>
        <Typography.Text type="secondary" className="v1-block">
          同一会话持续使用已绑定账号；每次成功使用后重新计时，过期后按 7 天剩余额度重新选择。
        </Typography.Text>
        <Flex align="center" justify="space-between" className="v1-setting-switch-row">
          <div>
            <Typography.Text strong>忽略 5 小时限制</Typography.Text>
            <Typography.Text type="secondary" className="v1-block">账号选择和额度汇总只依据 7 天窗口。</Typography.Text>
          </div>
          <Form.Item name="ignore_five_hour_limit_enabled" valuePropName="checked" noStyle><Switch /></Form.Item>
        </Flex>
      </SettingsSection>
      <SettingsSection title="额度展示" description="设置 Codex 客户端看到的订阅账号额度。">
        <Form.Item name="codex_quota_headers_mode" label="Codex 额度显示" extra="仅影响订阅账号；第三方渠道始终显示可用。">
          <Segmented options={[
            { label: "隐藏账号额度", value: "block" },
            { label: "显示账号池汇总", value: "rewrite" }
          ]} />
        </Form.Item>
      </SettingsSection>
      <SettingsSection title="自动审查回退" description="账号池无可用额度时，自动审查改用指定的第三方模型。">
        <Form.Item
          name="auto_review_upstream_model"
          label="自动审查模型"
          extra="留空则不启用回退。"
          style={{ maxWidth: 260 }}
        >
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="选择第三方模型"
            options={autoReviewModelOptions}
          />
        </Form.Item>
      </SettingsSection>
    </Space>
  );

  const logsBillingTab = (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <SettingsSection title="日志保留" description="设置调用记录和运行日志的保留时间。">
        <div className="v1-settings-grid v1-settings-grid-2">
          <NumberField name="request_log_retention_days" label="调用记录保留" suffix="天" min={1} max={3650} />
          <NumberField name="app_log_retention_days" label="运行日志保留" suffix="天" min={1} max={3650} />
        </div>
      </SettingsSection>
      <SettingsSection title="计费币种" description="设置费用统计和界面展示使用的币种。">
        <Form.Item name="billing_currency" label="全局币种" style={{ maxWidth: 260 }}>
          <Select options={CURRENCY_OPTIONS} />
        </Form.Item>
      </SettingsSection>
    </Space>
  );

  const mcpTab = (
    <SettingsSection title="MCP 服务" description="设置 MCP 服务的地址和启动方式。">
      {mcpInstalled === false && (
        <Alert
          showIcon
          type="warning"
          title="未检测到 MCP 服务，请先安装 mcp-gateway-service。"
        />
      )}
      <Flex align="center" justify="space-between" className="v1-setting-switch-row">
        <Typography.Text strong>自动启动 MCP 服务</Typography.Text>
        <Form.Item name="auto_start_mcp_gateway_enabled" valuePropName="checked" noStyle><Switch /></Form.Item>
      </Flex>
      <Form.Item name="mcp_gateway_config_path" label="配置文件路径"><Input /></Form.Item>
      <div className="v1-settings-grid v1-settings-grid-3">
        <Form.Item name="mcp_gateway_host" label="主机"><Input /></Form.Item>
        <Form.Item name="mcp_gateway_port" label="端口"><InputNumber min={1} max={65535} precision={0} style={{ width: "100%" }} /></Form.Item>
        <Form.Item name="mcp_gateway_path" label="HTTP 路径"><Input placeholder="/mcp" /></Form.Item>
      </div>
    </SettingsSection>
  );

  const dataTab = (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <SettingsSection title="数据位置">
        <Descriptions bordered column={1} size="small" items={[
          { key: "data", label: "数据目录", children: <Typography.Text copyable className="v1-mono">{paths.dataDir || "-"}</Typography.Text> },
          { key: "sqlite", label: "数据库文件", children: <Typography.Text copyable className="v1-mono">{paths.dbPath || "-"}</Typography.Text> }
        ]} />
      </SettingsSection>
      <Card className="v1-danger-card" title="数据清理" size="small">
        <Flex align="center" justify="space-between" gap={16} wrap>
          <Typography.Text type="secondary">只清理本地记录，不删除账号、模型渠道或应用设置。</Typography.Text>
          <Space>
            <Popconfirm title="清空全部调用分析？" description="此操作不可恢复。" okButtonProps={{ danger: true }} onConfirm={onClearTokenLogs}>
              <Button danger>清空调用分析</Button>
            </Popconfirm>
            <Popconfirm title="清空全部运行日志？" description="此操作不可恢复。" okButtonProps={{ danger: true }} onConfirm={onClearAppLogs}>
              <Button danger>清空运行日志</Button>
            </Popconfirm>
          </Space>
        </Flex>
      </Card>
    </Space>
  );

  const networkTab = (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <Collapse items={[
        {
          key: "timeouts",
          label: "超时与并发",
          children: (
            <>
              <div className="v1-settings-grid v1-settings-grid-3">
                <NumberField name="gateway_connect_timeout_seconds" label="连接超时" suffix="秒" min={1} max={600} />
                <NumberField name="gateway_stream_idle_timeout_seconds" label="SSE 空闲超时" suffix="秒" min={1} max={3600} />
                <NumberField name="gateway_unary_timeout_seconds" label="普通请求总超时" suffix="秒" min={1} max={3600} />
                <NumberField name="gateway_websocket_idle_timeout_seconds" label="WS 响应空闲超时" suffix="秒" min={1} max={3600} />
                <NumberField name="gateway_shutdown_grace_seconds" label="停机宽限" suffix="秒" min={0.1} max={60} />
                <NumberField name="gateway_max_concurrent_requests" label="HTTP 最大并发" min={1} max={10000} />
                <NumberField name="gateway_websocket_max_connections" label="WS 最大连接" min={1} max={10000} />
              </div>
              <Flex align="center" justify="space-between" className="v1-setting-switch-row">
                <div>
                  <Typography.Text strong>WS 握手拒绝 HTTP-only 模型</Typography.Text>
                  <Typography.Text type="secondary" className="v1-block">Codex 配置的当前模型仅支持 HTTP 时，新建 WebSocket 连接直接返回 426，让客户端立即改用 HTTP。</Typography.Text>
                </div>
                <Form.Item name="gateway_websocket_reject_http_only_model_upgrade_enabled" valuePropName="checked" noStyle><Switch /></Form.Item>
              </Flex>
            </>
          )
        },
        {
          key: "limits",
          label: "请求与缓冲上限",
          children: (
            <div className="v1-settings-grid v1-settings-grid-2">
              <NumberField name="gateway_request_body_limit_mib" label="请求体上限" suffix="MiB" min={0.01} max={1024} />
              <NumberField name="gateway_error_body_limit_mib" label="错误响应上限" suffix="MiB" min={0.01} max={64} />
              <NumberField name="gateway_compaction_response_limit_mib" label="压缩适配响应上限" suffix="MiB" min={0.01} max={1024} />
              <NumberField name="gateway_websocket_max_payload_mib" label="WS 单消息上限" suffix="MiB" min={0.01} max={1024} />
              <NumberField name="gateway_websocket_buffer_high_water_mib" label="WS 缓冲高水位" suffix="MiB" min={0.01} max={1024} />
              <NumberField name="gateway_websocket_pending_queue_limit_mib" label="WS 握手队列上限" suffix="MiB" min={0.01} max={1024} />
            </div>
          )
        }
      ]} />
    </Space>
  );

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={settingsToForm(settings)}
      onFinish={save}
      onValuesChange={previewAppearance}
    >
      <Card className="v1-page-card" variant="borderless">
        <div className="v1-settings-layout">
          <Menu
            className="v1-settings-menu"
            mode="inline"
            selectedKeys={[activeSection]}
            onSelect={({ key }) => setActiveSection(key)}
            items={SETTINGS_SECTIONS.map(({ key, label }) => ({ key, label }))}
          />
          <div className="v1-settings-panel">
            {{
              general: generalTab,
              gateway: gatewayTab,
              quota: quotaTab,
              logs: logsBillingTab,
              mcp: mcpTab,
              storage: dataTab,
              network: networkTab
            }[activeSection] ?? generalTab}
          </div>
        </div>
        {dirty && (
          <Flex className="v1-settings-actions" align="center" justify="flex-end" gap={8}>
            <Button onClick={discard}>放弃更改</Button>
            <Button htmlType="submit" type="primary" icon={<SaveOutlined />}>保存设置</Button>
          </Flex>
        )}
      </Card>
    </Form>
  );
};

const SETTINGS_SECTIONS = [
  { key: "general", label: "常规" },
  { key: "gateway", label: "API 服务" },
  { key: "mcp", label: "MCP 服务" },
  { key: "quota", label: "账号与额度" },
  { key: "logs", label: "日志与计费" },
  { key: "storage", label: "存储与维护" },
  { key: "network", label: "高级网络" }
] as const;

const SettingsSection = ({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) => (
  <Card size="small" title={title} extra={description ? <Typography.Text type="secondary">{description}</Typography.Text> : null}>
    {children}
  </Card>
);

const NumberField = ({
  name,
  label,
  suffix,
  min,
  max
}: {
  name: string;
  label: string;
  suffix?: string;
  min?: number;
  max?: number;
}) => (
  <Form.Item name={name} label={label} rules={[{ required: true }]}>
    <InputNumber
      {...(min === undefined ? {} : { min })}
      {...(max === undefined ? {} : { max })}
      {...(Number.isInteger(min) ? { precision: 0 } : {})}
      {...(suffix === undefined ? {} : { suffix })}
      style={{ width: "100%" }}
    />
  </Form.Item>
);

export const settingsToForm = (settings: SettingsRecord): SettingsFormValues => {
  const values = { ...settings } as SettingsFormValues;
  values.gateway_api_key = "";
  values.gateway_session_affinity_ttl_hours = settings.gateway_session_affinity_ttl_hours || "168";
  for (const [formKey, settingKey] of Object.entries(SECOND_FIELDS)) {
    values[formKey] = formatNumber(Number(settings[settingKey] || 0) / 1000);
  }
  for (const [formKey, settingKey] of Object.entries(MIB_FIELDS)) {
    values[formKey] = formatNumber(Number(settings[settingKey] || 0) / (1024 * 1024));
  }
  values.auto_start_gateway_enabled = settings.auto_start_gateway === "true";
  values.auto_start_mcp_gateway_enabled = settings.auto_start_mcp_gateway === "true";
  values.ignore_five_hour_limit_enabled = settings.ignore_five_hour_limit === "true";
  values.gateway_websocket_reject_http_only_model_upgrade_enabled = settings.gateway_websocket_reject_http_only_model_upgrade === "true";
  return values;
};

export const formToSettings = (current: SettingsRecord, values: Partial<SettingsFormValues>): SettingsRecord => {
  const next: SettingsRecord = { ...current };
  for (const [key, value] of Object.entries(values)) {
    if (key in SECOND_FIELDS || key in MIB_FIELDS || key.endsWith("_enabled")) continue;
    if (key === "gateway_api_key" && !String(value || "").trim()) continue;
    next[key] = String(value ?? "").trim();
  }
  for (const [formKey, settingKey] of Object.entries(SECOND_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(values, formKey)) continue;
    const value = Number(values[formKey]);
    if (Number.isFinite(value)) next[settingKey] = String(Math.round(value * 1000));
  }
  for (const [formKey, settingKey] of Object.entries(MIB_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(values, formKey)) continue;
    const value = Number(values[formKey]);
    if (Number.isFinite(value)) next[settingKey] = String(Math.round(value * 1024 * 1024));
  }
  if (Object.prototype.hasOwnProperty.call(values, "auto_start_gateway_enabled")) {
    next.auto_start_gateway = values.auto_start_gateway_enabled ? "true" : "false";
  }
  if (Object.prototype.hasOwnProperty.call(values, "auto_start_mcp_gateway_enabled")) {
    next.auto_start_mcp_gateway = values.auto_start_mcp_gateway_enabled ? "true" : "false";
  }
  if (Object.prototype.hasOwnProperty.call(values, "ignore_five_hour_limit_enabled")) {
    next.ignore_five_hour_limit = values.ignore_five_hour_limit_enabled ? "true" : "false";
  }
  if (Object.prototype.hasOwnProperty.call(values, "gateway_websocket_reject_http_only_model_upgrade_enabled")) {
    next.gateway_websocket_reject_http_only_model_upgrade = values.gateway_websocket_reject_http_only_model_upgrade_enabled ? "true" : "false";
  }
  return next;
};

const formatNumber = (value: number): string => (
  Number.isFinite(value) ? String(Number(value.toFixed(3))) : "0"
);

const isLoopbackHost = (host: unknown): boolean => {
  const value = String(host || "").trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]";
};

const generateApiKey = (): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return `sk-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
};
