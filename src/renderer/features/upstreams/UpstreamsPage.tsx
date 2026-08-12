import {
  DeleteOutlined,
  EditOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Drawer,
  Dropdown,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  Tooltip,
  message
} from "antd";
import type { MenuProps, TableColumnsType } from "antd";
import { useMemo, useState } from "react";
import type {
  ModelPricing,
  SaveResponsesApiUpstreamInput,
  UpstreamModel,
  UpstreamSummary
} from "../../../shared/contracts/upstreams";
import { currencyName } from "../../lib/currency";

interface FormValues {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
  supportsWebSocket: boolean;
  compactAdaptEnabled: boolean;
  balanceQueryType: "none" | "deepseek";
  modelCatalogJson: string;
  modelPricing: Record<string, ModelPricing>;
  publicHeadersJson: string;
  secretHeadersJson: string;
}

const EMPTY_CATALOG = "";
export const UpstreamsPage = () => {
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const [pricingForm] = Form.useForm<{ pricing: Record<string, ModelPricing> }>();
  const [editing, setEditing] = useState<UpstreamSummary | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modelUpstream, setModelUpstream] = useState<UpstreamSummary | null>(null);
  const [invocationUpstream, setInvocationUpstream] = useState<UpstreamSummary | null>(null);
  const [invocationModel, setInvocationModel] = useState("");
  const [pricingUpstream, setPricingUpstream] = useState<UpstreamSummary | null>(null);
  const [pricingModels, setPricingModels] = useState<UpstreamModel[]>([]);
  const watchedCatalog = Form.useWatch("modelCatalogJson", form) || EMPTY_CATALOG;

  const upstreamsQuery = useQuery({ queryKey: ["upstreams"], queryFn: () => window.codexGateway.listUpstreams() });
  const settingsQuery = useQuery({ queryKey: ["bootstrap", "billing-currency"], queryFn: () => window.codexGateway.bootstrap() });
  const modelsQuery = useQuery({
    queryKey: ["upstreams", modelUpstream?.id, "models"],
    queryFn: () => window.codexGateway.listUpstreamModels(modelUpstream!.id),
    enabled: Boolean(modelUpstream)
  });
  const invocationModelsQuery = useQuery({
    queryKey: ["upstreams", invocationUpstream?.id, "invocation-models"],
    queryFn: () => window.codexGateway.listUpstreamModels(invocationUpstream!.id),
    enabled: Boolean(invocationUpstream)
  });
  const currency = settingsQuery.data?.settings.billing_currency || "USD";
  const catalogModels = useMemo(() => modelEntries(watchedCatalog), [watchedCatalog]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["upstreams"] });
  };
  const saveMutation = useMutation({
    mutationFn: (input: SaveResponsesApiUpstreamInput) => window.codexGateway.saveUpstream(input),
    onMutate: () => { message.loading({ key: "save-upstream", content: "正在保存模型渠道...", duration: 0 }); },
    onSuccess: async () => {
      await invalidate();
      setDrawerOpen(false);
      message.success({ key: "save-upstream", content: "模型渠道已保存" });
    },
    onError: (error) => message.error({ key: "save-upstream", content: `保存失败：${readableError(error)}`, duration: 8 })
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => window.codexGateway.deleteUpstream(id),
    onSuccess: async () => { await invalidate(); message.success("模型渠道已删除"); }
  });
  const balanceMutation = useMutation({
    mutationFn: (id: string) => window.codexGateway.refreshUpstreamBalance(id),
    onSuccess: async () => { await invalidate(); message.success("余额已刷新"); }
  });
  const bundledMutation = useMutation({
    mutationFn: () => window.codexGateway.refreshBuiltinModels(),
    onMutate: () => { message.loading({ key: "refresh-bundled-models", content: "正在刷新 Codex 内置模型...", duration: 0 }); },
    onSuccess: async (result) => {
      await invalidate();
      message.success({ key: "refresh-bundled-models", content: `已刷新 ${result.bundledCount} 个内置模型` });
    },
    onError: (error) => message.error({ key: "refresh-bundled-models", content: `刷新失败：${readableError(error)}`, duration: 8 })
  });
  const healthMutation = useMutation({
    mutationFn: (id: string) => window.codexGateway.testUpstreamConnection(id),
    onSuccess: async (result) => { await invalidate(); message.success(result.message); }
  });
  const pricingMutation = useMutation({
    mutationFn: ({ id, pricing }: { id: string; pricing: Record<string, ModelPricing> }) => window.codexGateway.saveUpstreamModelPricing(id, pricing),
    onSuccess: async () => { await invalidate(); setPricingUpstream(null); message.success("模型费率已保存"); }
  });
  const invocationMutation = useMutation({
    mutationFn: ({ id, model }: { id: string; model: string }) => window.codexGateway.testUpstreamInvocation(id, model),
    onSuccess: (result) => message[result.ok ? "success" : "warning"](result.message)
  });

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({
      name: "", baseUrl: "", apiKey: "", enabled: true, supportsWebSocket: false,
      compactAdaptEnabled: true, balanceQueryType: "none", modelCatalogJson: EMPTY_CATALOG, modelPricing: {},
      publicHeadersJson: "{}", secretHeadersJson: "{}"
    });
    setDrawerOpen(true);
  };

  const openEdit = async (upstream: UpstreamSummary) => {
    const models = await window.codexGateway.listUpstreamModels(upstream.id);
    setEditing(upstream);
    form.setFieldsValue({
      id: upstream.id,
      name: upstream.name,
      baseUrl: upstream.baseUrl,
      apiKey: "",
      enabled: upstream.enabled,
      supportsWebSocket: upstream.supportsWebSocket,
      compactAdaptEnabled: upstream.compactAdaptEnabled,
      balanceQueryType: upstream.balanceQueryType,
      modelCatalogJson: JSON.stringify({
        models: models.filter((model) => model.available).map((model) => ({
          ...model.metadata,
          slug: String(model.metadata.slug || model.modelId),
          display_name: String(model.metadata.display_name || model.displayName || model.modelId),
          prefer_websockets: upstream.supportsWebSocket,
          supports_websockets: upstream.supportsWebSocket
        }))
      }, null, 2),
      modelPricing: Object.fromEntries(models.map((model) => [model.modelId, model.pricing])),
      publicHeadersJson: JSON.stringify(upstream.publicHeaders, null, 2),
      secretHeadersJson: "{}"
    });
    setDrawerOpen(true);
  };

  const openPricing = async (upstream: UpstreamSummary) => {
    const models = await window.codexGateway.listUpstreamModels(upstream.id);
    setPricingModels(models.filter((model) => model.available));
    pricingForm.setFieldsValue({ pricing: Object.fromEntries(models.map((model) => [model.modelId, model.pricing])) });
    setPricingUpstream(upstream);
  };

  const save = async (values: FormValues) => {
    let publicHeaders: Record<string, string>;
    let secretHeaders: Record<string, string>;
    try {
      publicHeaders = parseObject(values.publicHeadersJson, "普通请求头");
      secretHeaders = editing && !String(values.secretHeadersJson || "").trim()
        ? {}
        : parseObject(values.secretHeadersJson, "加密请求头");
    } catch (error) {
      message.error(readableError(error));
      return;
    }
    const input: SaveResponsesApiUpstreamInput = {
      ...(editing ? { id: editing.id } : {}),
      name: values.name,
      baseUrl: values.baseUrl,
      ...(values.apiKey ? { apiKey: values.apiKey } : {}),
      enabled: values.enabled,
      supportsWebSocket: values.supportsWebSocket,
      compactAdaptEnabled: values.compactAdaptEnabled,
      balanceQueryType: values.balanceQueryType,
      modelCatalogJson: values.modelCatalogJson,
      modelPricing: Object.fromEntries(catalogModels.map((model) => [model.slug, normalizePrice(values.modelPricing?.[model.slug])])),
      publicHeaders,
      ...(editing ? (Object.keys(secretHeaders).length > 0 ? { secretHeaders } : {}) : { secretHeaders })
    };
    await saveMutation.mutateAsync(input).catch(() => undefined);
  };

  const moreItems = (): NonNullable<MenuProps["items"]> => [
    { key: "health", label: "连接检查" },
    { key: "invoke", label: "调用测试" }
  ];

  const onMore = (upstream: UpstreamSummary, key: string) => {
    if (key === "health") healthMutation.mutate(upstream.id);
    if (key === "invoke") { setInvocationUpstream(upstream); setInvocationModel(""); }
  };

  const columns: TableColumnsType<UpstreamSummary> = [
    {
      title: "渠道", key: "identity", width: 240,
      render: (_, upstream) => <Space orientation="vertical" size={2}>
        <Space><Typography.Text strong>{upstream.name}</Typography.Text>{upstream.kind === "chatgpt_subscription_pool" && <Tag color="blue">内置</Tag>}</Space>
        <Typography.Text className="v1-mono" type="secondary" ellipsis={{ tooltip: upstream.baseUrl }}>{upstream.baseUrl}</Typography.Text>
      </Space>
    },
    {
      title: "模型", dataIndex: "modelCount", width: 100,
      render: (count, upstream) => <Button type="link" onClick={() => setModelUpstream(upstream)}>{count} 个</Button>
    },
    {
      title: "传输", key: "transport", width: 120,
      render: (_, upstream) => <Space size={4}><Tag>HTTP</Tag>{upstream.supportsWebSocket && <Tag className="v1-ws-tag">WS</Tag>}</Space>
    },
    {
      title: "额度", key: "balance", width: 310,
      render: (_, upstream) => <BalanceCell upstream={upstream} />
    },
    {
      title: "状态", key: "status", width: 175,
      render: (_, upstream) => <Space orientation="vertical" size={2}>
        <Tag color={upstream.enabled ? "success" : "default"}>{upstream.enabled ? "启用" : "停用"}</Tag>
        {upstream.kind === "responses_api" && <Typography.Text type="secondary">{healthText(upstream)}</Typography.Text>}
      </Space>
    },
    {
      title: "操作", key: "actions", fixed: "right", width: 176,
      render: (_, upstream) => <Space size={4}>
        <Tooltip title={upstream.kind === "chatgpt_subscription_pool" ? "编辑模型费率" : "编辑上游"}>
          <Button aria-label="编辑" icon={<EditOutlined />} onClick={() => void (upstream.kind === "chatgpt_subscription_pool" ? openPricing(upstream) : openEdit(upstream))} />
        </Tooltip>
        {upstream.kind === "chatgpt_subscription_pool" && (
          <Tooltip title="刷新内置模型">
            <Button aria-label="刷新内置模型" loading={bundledMutation.isPending} icon={<ReloadOutlined />} onClick={() => bundledMutation.mutate()} />
          </Tooltip>
        )}
        {upstream.kind === "responses_api" && upstream.balanceQueryType !== "none" && (
          <Tooltip title="刷新余额">
            <Button aria-label="刷新余额" loading={balanceMutation.isPending} icon={<ReloadOutlined />} onClick={() => balanceMutation.mutate(upstream.id)} />
          </Tooltip>
        )}
        {upstream.kind === "responses_api" && (
          <Popconfirm title={`删除“${upstream.name}”？`} onConfirm={() => deleteMutation.mutate(upstream.id)}>
            <Button danger icon={<DeleteOutlined />} aria-label="删除" />
          </Popconfirm>
        )}
        {upstream.kind === "responses_api" && (
          <Dropdown menu={{ items: moreItems(), onClick: ({ key }) => onMore(upstream, key) }} trigger={["click"]}>
            <Button icon={<MoreOutlined />} aria-label="更多操作" />
          </Dropdown>
        )}
      </Space>
    }
  ];

  return <section className="v1-page-card v1-page-fill v1-upstreams-page">
    <Flex className="v1-page-actions" justify="flex-end" gap={16} wrap>
      <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增渠道</Button>
    </Flex>
    <Table
      rowKey="id" columns={columns} dataSource={upstreamsQuery.data ?? []} loading={upstreamsQuery.isLoading}
      pagination={false} scroll={{ x: 1120 }} sticky={{ offsetHeader: 0 }}
    />

    <Drawer
      title={editing ? "编辑模型渠道" : "新增模型渠道"}
      width={760} open={drawerOpen} onClose={() => setDrawerOpen(false)}
      extra={<Button type="primary" loading={saveMutation.isPending} onClick={() => form.submit()}>保存</Button>}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={save}
        onFinishFailed={({ errorFields }) => {
          message.error(errorFields[0]?.errors[0] || "请检查表单中的必填项和模型 JSON");
          if (errorFields[0]?.name) form.scrollToField(errorFields[0].name, { behavior: "smooth", block: "center" });
        }}
        requiredMark="optional"
      >
        <Typography.Title level={5}>连接信息</Typography.Title>
        <Flex gap={12} wrap>
          <Form.Item name="name" label="渠道名称" rules={[{ required: true }]} style={{ flex: "1 1 260px" }}><Input maxLength={80} /></Form.Item>
          <Form.Item name="baseUrl" label="API 地址" rules={[{ required: true }, { type: "url" }]} style={{ flex: "2 1 360px" }}><Input placeholder="https://api.example.com/v1" /></Form.Item>
        </Flex>
        <Flex gap={12} wrap>
          <Form.Item name="apiKey" label={editing ? "API Key（留空保持原值）" : "API Key"} style={{ flex: "1 1 320px" }}><Input.Password /></Form.Item>
          <Form.Item name="balanceQueryType" label="余额查询方式" style={{ width: 220 }}>
            <Select options={[{ value: "none", label: "不查询" }, { value: "deepseek", label: "DeepSeek" }]} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="supportsWebSocket" label="支持 WS" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item
            name="compactAdaptEnabled"
            label="适配远程压缩"
            valuePropName="checked"
            tooltip="解决第三方模型可能不支持远程压缩的问题。"
          >
            <Switch />
          </Form.Item>
        </Flex>

        <Typography.Title level={5}>Codex 模型 JSON</Typography.Title>
        <Alert showIcon type="info" title="粘贴渠道提供的 Codex models.json，用于读取模型及其支持的能力。" style={{ marginBottom: 16 }} />
        <Form.Item name="modelCatalogJson" rules={[{ required: true }, { validator: validateCatalog }]}>
          <Input.TextArea className="v1-code-editor" autoSize={{ minRows: 12, maxRows: 24 }} spellCheck={false} />
        </Form.Item>

        <Typography.Title level={5}>模型费率（{currencyName(currency)} / 百万 Token）</Typography.Title>
        {catalogModels.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="模型 JSON 中尚无有效模型" /> : (
          <Space orientation="vertical" size={8} style={{ width: "100%" }}>
            {catalogModels.map((model) => <div className="v1-model-price-row" key={model.slug}>
              <Typography.Text strong className="v1-mono">{model.slug}</Typography.Text>
              <Form.Item name={["modelPricing", model.slug, "inputPerMillion"]} label="输入" initialValue={0}><InputNumber min={0} precision={4} step={0.0001} /></Form.Item>
              <Form.Item name={["modelPricing", model.slug, "cachedInputPerMillion"]} label="缓存输入" initialValue={0}><InputNumber min={0} precision={4} step={0.0001} /></Form.Item>
              <Form.Item name={["modelPricing", model.slug, "outputPerMillion"]} label="输出" initialValue={0}><InputNumber min={0} precision={4} step={0.0001} /></Form.Item>
            </div>)}
          </Space>
        )}

        <Typography.Title level={5}>高级请求头</Typography.Title>
        <Flex gap={12} wrap>
          <Form.Item
            name="publicHeadersJson"
            label="普通请求头 JSON"
            rules={[{ validator: (_, value) => validateObjectJson(value, "普通请求头") }]}
            style={{ flex: 1 }}
          >
            <Input.TextArea className="v1-code-editor v1-fixed-json-editor" spellCheck={false} />
          </Form.Item>
          <Form.Item
            name="secretHeadersJson"
            label={editing ? "加密请求头 JSON（留空保持原值）" : "加密请求头 JSON"}
            rules={[{ validator: (_, value) => validateObjectJson(value, "加密请求头", Boolean(editing)) }]}
            style={{ flex: 1 }}
          >
            <Input.TextArea className="v1-code-editor v1-fixed-json-editor" spellCheck={false} />
          </Form.Item>
        </Flex>
      </Form>
    </Drawer>

    <Drawer title={`${modelUpstream?.name || ""} · 模型目录`} width="min(1000px, 100vw)" open={Boolean(modelUpstream)} onClose={() => setModelUpstream(null)}>
      <Table rowKey="modelId" pagination={false} dataSource={modelsQuery.data ?? []} loading={modelsQuery.isLoading} columns={modelColumns(currency)} scroll={{ x: 920 }} />
    </Drawer>

    <Modal
      title={`${invocationUpstream?.name || ""} · 调用测试`} open={Boolean(invocationUpstream)}
      okText="开始测试" confirmLoading={invocationMutation.isPending}
      okButtonProps={{ disabled: !invocationModel }} onCancel={() => setInvocationUpstream(null)}
      onOk={() => invocationUpstream && invocationMutation.mutate({ id: invocationUpstream.id, model: invocationModel })}
    >
      <Select style={{ width: "100%" }} placeholder="选择模型" value={invocationModel || null} onChange={setInvocationModel}
        options={(invocationModelsQuery.data ?? []).filter((model) => model.available).map((model) => ({ value: model.modelId, label: model.displayName }))} />
    </Modal>

    <Modal
      title={`${pricingUpstream?.name || ""} · 模型费率`} width={760} open={Boolean(pricingUpstream)}
      okText="保存费率" confirmLoading={pricingMutation.isPending}
      onCancel={() => setPricingUpstream(null)} onOk={() => pricingForm.submit()}
    >
      <Typography.Paragraph type="secondary">币种：{currencyName(currency)}；单价按每百万 Token 计算。</Typography.Paragraph>
      <Form form={pricingForm} onFinish={(values) => pricingUpstream && pricingMutation.mutate({ id: pricingUpstream.id, pricing: values.pricing })}>
        <Space orientation="vertical" size={8} style={{ width: "100%" }}>
          {pricingModels.map((model) => <div className="v1-model-price-row" key={model.modelId}>
            <Typography.Text strong className="v1-mono">{model.modelId}</Typography.Text>
            <Form.Item name={["pricing", model.modelId, "inputPerMillion"]} label="输入"><InputNumber min={0} precision={4} step={0.0001} /></Form.Item>
            <Form.Item name={["pricing", model.modelId, "cachedInputPerMillion"]} label="缓存输入"><InputNumber min={0} precision={4} step={0.0001} /></Form.Item>
            <Form.Item name={["pricing", model.modelId, "outputPerMillion"]} label="输出"><InputNumber min={0} precision={4} step={0.0001} /></Form.Item>
          </div>)}
        </Space>
      </Form>
    </Modal>
  </section>;
};

const BalanceCell = ({ upstream }: { upstream: UpstreamSummary }) => {
  if (upstream.balance.subscriptionPool) {
    const pool = upstream.balance.subscriptionPool;
    const capacity = Math.max(1, pool.quotaCapacityPercent);
    return <Space orientation="vertical" size={4} className="v1-pool-balance">
      {pool.fiveHourRemainingPercent !== null && <PoolQuota label="5 小时" total={pool.fiveHourRemainingPercent} capacity={capacity} />}
      <PoolQuota label="7 天" total={pool.sevenDayRemainingPercent} capacity={capacity} />
    </Space>;
  }
  if (upstream.balance.summary) return <Typography.Text>{upstream.balance.summary}</Typography.Text>;
  if (upstream.balance.error) return <Typography.Text type="danger" ellipsis={{ tooltip: upstream.balance.error }}>{upstream.balance.error}</Typography.Text>;
  if (upstream.balance.infos.length === 0) return <Typography.Text type="secondary">{upstream.balanceQueryType === "none" ? "未配置" : "未查询"}</Typography.Text>;
  return <Space orientation="vertical" size={0}>{upstream.balance.infos.map((info) => <Typography.Text key={info.currency}>{currencyName(info.currency)} {info.totalBalance}</Typography.Text>)}</Space>;
};

const PoolQuota = ({ label, total, capacity }: { label: string; total: number; capacity: number }) => (
  <div className="v1-pool-quota">
    <Flex justify="space-between" gap={8}><Typography.Text type="secondary">{label}总剩余</Typography.Text><Typography.Text>{total.toFixed(1)}%</Typography.Text></Flex>
    <Progress percent={Math.max(0, Math.min(100, total / capacity * 100))} size="small" showInfo={false} />
  </div>
);

const modelColumns = (currency: string): TableColumnsType<UpstreamModel> => [
  { title: "模型 ID", dataIndex: "modelId", width: 190, ellipsis: true, render: (value) => <Typography.Text className="v1-mono" copyable>{value}</Typography.Text> },
  { title: "显示名称", dataIndex: "displayName", width: 180, ellipsis: true },
  { title: "推理程度", width: 310, render: (_, model) => <Typography.Text className="v1-nowrap">{reasoningLevels(model.metadata).join(" / ") || "-"}</Typography.Text> },
  { title: `费率（${currencyName(currency)}）`, width: 240, render: (_, model) => `${model.pricing.inputPerMillion.toFixed(4)} / ${model.pricing.cachedInputPerMillion.toFixed(4)} / ${model.pricing.outputPerMillion.toFixed(4)}` }
];

function modelEntries(raw: string): Array<{ slug: string; metadata: Record<string, unknown> }> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.models)) return [];
    return parsed.models.filter((model: unknown) => model && typeof model === "object" && !Array.isArray(model) && String((model as Record<string, unknown>).slug || "").trim())
      .map((model: Record<string, unknown>) => ({ slug: String(model.slug).trim(), metadata: model }));
  } catch { return []; }
}

function validateCatalog(_: unknown, value: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value || ""));
  } catch {
    return Promise.reject(new Error("模型 JSON 格式不正确"));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Promise.reject(new Error("模型 JSON 必须是对象"));
  }
  const models = (parsed as Record<string, unknown>).models;
  if (!Array.isArray(models) || models.length === 0) {
    return Promise.reject(new Error("模型 JSON 必须包含非空 models 数组"));
  }
  if (models.some((model) => !model || typeof model !== "object" || Array.isArray(model))) {
    return Promise.reject(new Error("models 中的每一项都必须是对象"));
  }
  const slugs = models.map((model) => (model as Record<string, unknown>).slug);
  if (slugs.some((slug) => typeof slug !== "string" || !slug.trim())) {
    return Promise.reject(new Error("models 中的每一项都必须包含非空 slug"));
  }
  const normalizedSlugs = slugs.map((slug) => String(slug).trim());
  if (new Set(normalizedSlugs).size !== normalizedSlugs.length) {
    return Promise.reject(new Error("模型 slug 不能重复"));
  }
  return Promise.resolve();
}

const validateObjectJson = (raw: unknown, label: string, allowEmpty = false): Promise<void> => {
  const text = String(raw || "").trim();
  if (!text && allowEmpty) return Promise.resolve();
  if (!text) return Promise.reject(new Error(`${label}必须是 JSON 对象`));
  try {
    parseObject(text, label);
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
};

function parseObject(raw: string, label: string): Record<string, string> {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
  } catch { throw new Error(`${label}不是有效 JSON 对象`); }
}

function normalizePrice(value?: Partial<ModelPricing>): ModelPricing {
  return {
    inputPerMillion: money(value?.inputPerMillion),
    cachedInputPerMillion: money(value?.cachedInputPerMillion),
    outputPerMillion: money(value?.outputPerMillion)
  };
}

const money = (value: unknown) => Math.round(Math.max(0, Number(value || 0)) * 10_000) / 10_000;
const readableError = (error: unknown) => String(error instanceof Error ? error.message : error || "未知错误")
  .replace(/^Error invoking remote method '[^']+':\s*/i, "")
  .replace(/^Error:\s*/i, "");
const reasoningLevels = (metadata: Record<string, unknown>) => Array.isArray(metadata.supported_reasoning_levels)
  ? metadata.supported_reasoning_levels.map((level) => typeof level === "object" && level ? String((level as Record<string, unknown>).effort || "") : "").filter(Boolean)
  : [];
const healthText = (upstream: UpstreamSummary) => upstream.healthStatus === "healthy"
  ? `健康 · ${upstream.healthLatencyMs ?? 0} ms`
  : upstream.healthStatus === "unhealthy" ? "连接异常" : "未检查";
