import { CopyOutlined, ReloadOutlined, SearchOutlined, SettingOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Card,
  Checkbox,
  DatePicker,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Flex,
  Input,
  Pagination,
  Select,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography
} from "antd";
import type { TableColumnsType } from "antd";
import type { CSSProperties, ReactElement } from "react";
import { useEffect, useState } from "react";
import type { PublicAccount } from "../../../shared/contracts/accounts";
import type { RequestLog, RequestLogPage, TokenAccountSummary, TokenSummary, TokenTotals } from "../../../shared/contracts/logs";
import type { Settings } from "../../../shared/contracts/settings";
import { currencyName } from "../../lib/currency";
import {
  cacheHitRate,
  formatTime,
  formatTokenNumber
} from "../../lib/formatters";
import { isTodayRange, todayLogFilters, toLogQuery, withTodayRange, type LogFilterValues } from "../../lib/log-query";
import { useDayRollover } from "../../lib/use-day-rollover";

interface RequestAnalyticsPageProps {
  pageData: RequestLogPage;
  summary: TokenSummary;
  accounts: PublicAccount[];
  settings: Settings;
  onMessage: (message: string) => void;
  onQuery: (query: ReturnType<typeof toLogQuery>, followsToday?: boolean) => Promise<void>;
}

const ANALYTICS_COLUMN_OPTIONS = [
  { label: "时间", value: "time" },
  { label: "目标", value: "target" },
  { label: "模型", value: "model" },
  { label: "路径", value: "path" },
  { label: "状态", value: "status" },
  { label: "耗时", value: "duration" },
  { label: "输出速度", value: "outputSpeed" },
  { label: "Token", value: "tokens" },
  { label: "估算", value: "cost" }
] as const;
const DEFAULT_ANALYTICS_COLUMN_KEYS = ANALYTICS_COLUMN_OPTIONS
  .filter((item) => item.value !== "path")
  .map((item) => item.value);
const LEGACY_ANALYTICS_COLUMN_STORAGE_KEY = "codexia:request-analytics:visible-columns";
const ANALYTICS_COLUMN_STORAGE_KEY = `${LEGACY_ANALYTICS_COLUMN_STORAGE_KEY}:v2`;

export const RequestAnalyticsPage = ({
  pageData,
  summary,
  accounts,
  settings,
  onMessage,
  onQuery
}: RequestAnalyticsPageProps) => {
  const [filters, setFilters] = useState<LogFilterValues>(todayLogFilters);
  const [followsToday, setFollowsToday] = useState(true);
  const [selectedLog, setSelectedLog] = useState<RequestLog | null>(null);
  const [accountPoolExpanded, setAccountPoolExpanded] = useState(false);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<string[]>(loadVisibleColumnKeys);
  const upstreamQuery = useQuery({
    queryKey: ["upstreams", "analytics"],
    queryFn: () => window.codexGateway.listUpstreams()
  });

  useEffect(() => {
    localStorage.setItem(ANALYTICS_COLUMN_STORAGE_KEY, JSON.stringify(visibleColumnKeys));
  }, [visibleColumnKeys]);

  useDayRollover(() => {
    if (followsToday) setFilters((current) => withTodayRange(current));
  });

  const runQuery = async (page = 1, pageSize = pageData.pageSize, nextFilters = filters, nextFollowsToday = followsToday): Promise<void> => {
    setFilters(nextFilters);
    setFollowsToday(nextFollowsToday);
    setAccountPoolExpanded(false);
    await onQuery(toLogQuery(nextFilters, page, pageSize), nextFollowsToday);
  };

  const resetFilters = async (): Promise<void> => {
    await runQuery(1, pageData.pageSize, todayLogFilters(), true);
  };

  const updateRange = (range: LogFilterValues["range"]): void => {
    setFilters((current) => ({ ...current, range }));
    setFollowsToday(isTodayRange(range));
  };

  const copyValue = async (value: unknown): Promise<void> => {
    const text = String(value || "").trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onMessage("复制成功");
    } catch (error) {
      onMessage(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const currency = settings.billing_currency || "USD";
  const currencyLabel = currencyName(currency);
  const accountUsage = summary.byAccount.filter((item) => Boolean(item.account_id));
  const upstreamUsage = summary.byAccount.filter((item) => !item.account_id);
  const accountPoolUsage = sumTokenUsage(accountUsage);
  const accountPoolName = upstreamQuery.data?.find((item) => item.kind === "chatgpt_subscription_pool")?.name
    || accountUsage.find((item) => item.upstream_name)?.upstream_name
    || "ChatGPT 订阅账号池";
  const breakdownTotal = upstreamUsage.reduce((total, item) => total + Number(item.total_tokens || 0), Number(accountPoolUsage.total_tokens || 0));
  const allColumns: TableColumnsType<RequestLog> = [
    { key: "time", title: "时间", dataIndex: "created_at", width: 180, className: "v1-nowrap", render: (value) => formatTime(value) },
    {
      title: "渠道",
      key: "target",
      width: 200,
      render: (_, log) => {
        const targetName = log.account_id
          ? accountPoolName
          : log.upstream_name || log.account_name || log.upstream_id || "未识别渠道";
        return <Typography.Text strong ellipsis={{ tooltip: targetName }}>{targetName}</Typography.Text>;
      }
    },
    {
      title: "模型",
      key: "model",
      width: 170,
      render: (_, log) => {
        const route = log.upstream_model && log.upstream_model !== log.client_model
          ? `${log.client_model || "-"} → ${log.upstream_model}`
          : log.client_model || log.upstream_model || "-";
        return <Typography.Text ellipsis className="v1-mono v1-nowrap">{route}</Typography.Text>;
      }
    },
    { key: "path", title: "路径", dataIndex: "request_path", width: 140, ellipsis: true, render: (value) => value || "-" },
    {
      title: "状态",
      key: "status",
      dataIndex: "status",
      width: 76,
      render: (value) => <Tag color={Number(value) >= 200 && Number(value) < 300 ? "success" : "error"}>{value || "-"}</Tag>
    },
    { key: "duration", title: "耗时", dataIndex: "duration_ms", width: 110, render: (value) => value ? `${formatTokenNumber(value)} ms` : "-" },
    {
      key: "outputSpeed",
      title: <Tooltip title="输出 Token ÷ 请求总耗时，包含等待时间。">输出速度</Tooltip>,
      width: 150,
      align: "center",
      className: "v1-nowrap",
      render: (_, log) => formatOutputSpeed(log)
    },
    {
      title: "Token（输入 / 缓存输入 / 输出）",
      key: "tokens",
      width: 260,
      render: (_, log) => (
        <TokenUsageTooltip usage={{
          input_tokens: Number(log.input_tokens || 0),
          cached_input_tokens: Number(log.cached_input_tokens || 0),
          output_tokens: Number(log.output_tokens || 0),
          total_tokens: Number(log.total_tokens || 0)
        }}>
          <Typography.Text className="v1-nowrap">
            {formatTokenNumber(log.input_tokens)} / {formatTokenNumber(log.cached_input_tokens)} / {formatTokenNumber(log.output_tokens)}
          </Typography.Text>
        </TokenUsageTooltip>
      )
    },
    {
      title: `估算成本（${currencyLabel}）`,
      key: "cost",
      width: 145,
      render: (_, log) => log.estimated_cost !== null && log.estimated_cost !== undefined
        ? Number(log.estimated_cost).toFixed(4)
        : "-"
    }
  ];
  const columns = allColumns.filter((column) => visibleColumnKeys.includes(String(column.key)));

  return (
    <section className="v1-page-card v1-page-fill v1-analytics-page">
        <Flex className="v1-page-actions" justify="flex-end" gap={16} wrap>
          <Dropdown
            trigger={["click"]}
            popupRender={() => (
              <Card size="small" title="显示列" style={{ width: 220 }}>
                <Checkbox.Group
                  options={[...ANALYTICS_COLUMN_OPTIONS]}
                  value={visibleColumnKeys}
                  onChange={(values) => setVisibleColumnKeys(values.map(String))}
                />
              </Card>
            )}
          >
            <Button icon={<SettingOutlined />}>列设置</Button>
          </Dropdown>
        </Flex>

        <Flex className="v1-table-toolbar" gap={8} wrap align="flex-end">
          <div>
            <Typography.Text type="secondary" className="v1-filter-label">日期范围</Typography.Text>
            <DatePicker.RangePicker
              allowClear={false}
              value={filters.range}
              onChange={(range) => range?.[0] && range[1] && updateRange([range[0], range[1]])}
            />
          </div>
          <div>
            <Typography.Text type="secondary" className="v1-filter-label">账号</Typography.Text>
            <Select
              allowClear
              value={filters.accountId || undefined}
              placeholder="全部账号"
              style={{ width: 200 }}
              options={accounts.map((account) => ({ value: account.id, label: account.name || account.email || account.id }))}
              onChange={(value) => setFilters((current) => ({ ...current, accountId: value || "" }))}
            />
          </div>
          <div>
            <Typography.Text type="secondary" className="v1-filter-label">渠道</Typography.Text>
            <Select
              allowClear
              value={filters.upstreamId || undefined}
              placeholder="全部渠道"
              style={{ width: 190 }}
              options={(upstreamQuery.data || []).map((upstream) => ({ value: upstream.id, label: upstream.name }))}
              onChange={(value) => setFilters((current) => ({ ...current, upstreamId: value || "" }))}
            />
          </div>
          <div>
            <Typography.Text type="secondary" className="v1-filter-label">Codex 模型</Typography.Text>
            <Input value={filters.clientModel} placeholder="模糊匹配" style={{ width: 170 }} onChange={(event) => setFilters((current) => ({ ...current, clientModel: event.target.value }))} />
          </div>
          <div>
            <Typography.Text type="secondary" className="v1-filter-label">渠道模型</Typography.Text>
            <Input value={filters.upstreamModel} placeholder="模糊匹配" style={{ width: 170 }} onChange={(event) => setFilters((current) => ({ ...current, upstreamModel: event.target.value }))} />
          </div>
          <div>
            <Typography.Text type="secondary" className="v1-filter-label">状态</Typography.Text>
            <Select
              allowClear
              value={filters.status || undefined}
              placeholder="全部状态"
              style={{ width: 140 }}
              options={["200", "400", "401", "403", "422", "426", "429", "500", "502", "503"].map((value) => ({ value, label: value }))}
              onChange={(value) => setFilters((current) => ({ ...current, status: value || "" }))}
            />
          </div>
          <Button type="primary" icon={<SearchOutlined />} onClick={() => runQuery(1)}>查询</Button>
          <Button icon={<ReloadOutlined />} onClick={resetFilters}>重置</Button>
        </Flex>

        <Typography.Title level={5} className="v1-analytics-section-title">汇总指标</Typography.Title>
        <div className="v1-analytics-summary">
          <div className="v1-analytics-metric"><Statistic title="调用" value={summary.total.calls || 0} /></div>
          <TokenUsageTooltip usage={summary.total}>
            <div className="v1-analytics-metric"><Statistic title="总 Token" value={summary.total.total_tokens || 0} /></div>
          </TokenUsageTooltip>
          <div className="v1-analytics-metric"><Statistic title="缓存命中" value={cacheHitRate(summary.total.input_tokens, summary.total.cached_input_tokens)} precision={1} suffix="%" /></div>
          <div className="v1-analytics-metric"><Statistic title="平均耗时" value={summary.total.average_duration_ms || 0} precision={0} suffix="ms" /></div>
          <div className={Number(summary.total.errors || 0) > 0 ? "v1-analytics-metric error" : "v1-analytics-metric"}><Statistic title="错误" value={summary.total.errors || 0} /></div>
          <div className="v1-analytics-metric"><Statistic title={`估算成本（${currencyLabel}）`} value={summary.total.estimated_cost || 0} precision={4} /></div>
        </div>

        {breakdownTotal > 0 && (
          <div className="v1-usage-section">
            <Typography.Title level={5} className="v1-analytics-section-title">渠道与账号用量</Typography.Title>
            <div className="v1-usage-viewport">
              <div className="v1-usage-track">
                {upstreamUsage.map((item) => (
                  <TokenUsageTooltip usage={item} key={`upstream:${item.upstream_id || item.upstream_name || "unknown"}`}>
                    <div className="v1-usage-segment" style={usageShareStyle(item.total_tokens, breakdownTotal)}>
                      <UsageSegmentContent
                        name={item.upstream_name || item.upstream_id || "未识别渠道"}
                        tokens={item.total_tokens}
                        percent={usagePercent(item.total_tokens, breakdownTotal)}
                      />
                    </div>
                  </TokenUsageTooltip>
                ))}
                {accountUsage.length > 0 && (
                  <div className="v1-usage-pool" style={usageShareStyle(accountPoolUsage.total_tokens, breakdownTotal)}>
                    {!accountPoolExpanded ? (
                      <TokenUsageTooltip usage={accountPoolUsage}>
                        <button className="v1-usage-pool-summary" aria-label={`展开 ${accountPoolName}`} onClick={() => setAccountPoolExpanded(true)}>
                          <UsageSegmentContent
                            name={accountPoolName}
                            tokens={accountPoolUsage.total_tokens}
                            percent={usagePercent(accountPoolUsage.total_tokens, breakdownTotal)}
                          />
                        </button>
                      </TokenUsageTooltip>
                    ) : (
                      <div className="v1-usage-accounts">
                        {accountUsage.map((item) => (
                          <TokenUsageTooltip usage={item} key={`account:${item.account_id || item.account_name || "unknown"}`}>
                            <button
                              className="v1-usage-account"
                              style={usageShareStyle(item.total_tokens, Number(accountPoolUsage.total_tokens || 0))}
                              aria-label={`返回 ${accountPoolName}：${item.account_name || item.account_id || "未识别账号"}`}
                              onClick={() => setAccountPoolExpanded(false)}
                            >
                              <UsageSegmentContent
                                name={item.account_name || item.account_id || "未识别账号"}
                                tokens={item.total_tokens}
                                percent={usagePercent(item.total_tokens, Number(accountPoolUsage.total_tokens || 0))}
                              />
                            </button>
                          </TokenUsageTooltip>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <Typography.Title level={5} className="v1-analytics-table-title">调用明细</Typography.Title>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={pageData.items}
          pagination={false}
          scroll={{ x: "max-content" }}
          tableLayout="fixed"
          sticky
          onRow={(log) => ({ onClick: () => setSelectedLog(log) })}
          locale={{ emptyText: <Empty description="当前筛选范围内没有调用记录。" /> }}
        />
        <Flex justify="flex-end" className="v1-pagination">
          <Pagination
            current={pageData.page}
            pageSize={pageData.pageSize}
            total={pageData.total}
            showSizeChanger
            pageSizeOptions={[10, 20, 50, 100, 200]}
            showTotal={(total) => `共 ${total} 条`}
            onChange={(page, pageSize) => runQuery(page, pageSize)}
          />
        </Flex>
      <Drawer title="调用详情" open={Boolean(selectedLog)} size={680} extra={selectedLog && <Button icon={<CopyOutlined />} onClick={() => copyValue(JSON.stringify(selectedLog, null, 2))}>复制 JSON</Button>} onClose={() => setSelectedLog(null)}>
        {selectedLog && <Descriptions bordered column={1} size="small" items={requestLogDetails(selectedLog, accountPoolName)} />}
      </Drawer>

    </section>
  );
};

const TokenUsageTooltip = ({
  usage,
  children
}: {
  usage: TokenSummary["total"];
  children: ReactElement;
}) => (
  <Tooltip
    title={(
      <div className="v1-token-tooltip">
        <div>输入：{formatTokenNumber(usage.input_tokens)}</div>
        <div>缓存输入：{formatTokenNumber(usage.cached_input_tokens)}</div>
        <div>输出：{formatTokenNumber(usage.output_tokens)}</div>
        <div>缓存命中率：{cacheHitRate(usage.input_tokens, usage.cached_input_tokens).toFixed(1)}%</div>
      </div>
    )}
  >
    {children}
  </Tooltip>
);

const UsageSegmentContent = ({
  name,
  tokens,
  percent
}: {
  name: string;
  tokens: number | undefined;
  percent: number;
}) => (
  <>
    <span className="v1-usage-name">{name}</span>
    <span className="v1-usage-data">
      <span>{formatTokenNumber(tokens)} Token</span>
      <span className="v1-usage-percent">{percent.toFixed(1)}%</span>
    </span>
  </>
);

const usagePercent = (value: number | undefined, total: number): number => (
  total > 0 ? Number(value || 0) / total * 100 : 0
);

const usageShareStyle = (value: number | undefined, total: number): CSSProperties => ({
  "--v1-usage-share": `${usagePercent(value, total)}%`
} as CSSProperties);

const sumTokenUsage = (items: TokenAccountSummary[]): TokenTotals => {
  const fields: Array<keyof TokenTotals> = [
    "calls",
    "errors",
    "estimated_cost",
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens"
  ];
  return Object.fromEntries(fields.map((field) => [
    field,
    items.reduce((total, item) => total + Number(item[field] || 0), 0)
  ])) as TokenTotals;
};

const requestLogDetails = (log: RequestLog, accountPoolName: string) => {
  const account = [log.account_name, log.account_email]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(" · ") || log.account_id || "-";
  return Object.entries({
    时间: formatTime(log.created_at),
    渠道: log.account_id ? accountPoolName : log.upstream_name || log.upstream_id || log.account_name || "-",
    渠道类型: log.upstream_kind || "-",
    ...(log.account_id ? { 订阅账号: account } : {}),
    客户端模型: log.client_model || "-",
    渠道模型: log.upstream_model || "-",
    会话: log.session_id || "-",
    客户端路径: log.request_path || "-",
    渠道路径: log.upstream_path || "-",
    状态: log.status || "-",
    耗时: log.duration_ms ? `${log.duration_ms} ms` : "-",
    输入Token: log.input_tokens || 0,
    缓存输入: log.cached_input_tokens || 0,
    输出Token: log.output_tokens || 0,
    总Token: log.total_tokens || 0,
    消息: log.message || "-"
  }).map(([key, value]) => ({ key, label: key, children: String(value) }));
};

const formatOutputSpeed = (log: RequestLog): string => {
  const status = Number(log.status);
  const duration = Number(log.duration_ms);
  const output = Number(log.output_tokens);
  if (!(status >= 200 && status < 300)
    || !Number.isFinite(duration) || duration <= 0
    || !Number.isFinite(output) || output <= 0
    || log.message?.startsWith("WebSocket prewarm")) return "—";
  const speed = output / duration * 1000;
  return Number.isFinite(speed) ? speed.toFixed(1) : "—";
};

const loadVisibleColumnKeys = (): string[] => {
  try {
    const current = localStorage.getItem(ANALYTICS_COLUMN_STORAGE_KEY);
    const stored = JSON.parse(current ?? localStorage.getItem(LEGACY_ANALYTICS_COLUMN_STORAGE_KEY) ?? "null");
    if (!Array.isArray(stored)) return [...DEFAULT_ANALYTICS_COLUMN_KEYS];
    const validKeys = new Set(ANALYTICS_COLUMN_OPTIONS.map((item) => item.value));
    const keys = stored.filter((value): value is string => typeof value === "string" && validKeys.has(value as typeof ANALYTICS_COLUMN_OPTIONS[number]["value"]));
    if (current === null && !keys.includes("outputSpeed")) keys.push("outputSpeed");
    return keys;
  } catch {
    return [...DEFAULT_ANALYTICS_COLUMN_KEYS];
  }
};
