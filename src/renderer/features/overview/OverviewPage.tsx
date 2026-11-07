import {
  ApiOutlined,
  DashboardOutlined,
  TeamOutlined
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Card, Col, Flex, List, Row, Space, Statistic, Tooltip, Typography } from "antd";
import { quotaRemainingPercent } from "../../../shared/quota-normalization";
import type { ReactNode } from "react";
import type { AppLog, TokenSummary } from "../../../shared/contracts/logs";
import { currencySymbol } from "../../lib/currency";
import { cacheHitRate, formatTokenNumber } from "../../lib/formatters";

type SettingsRecord = Record<string, string>;

interface AccountSummary {
  enabled?: boolean;
  status?: string;
  has_access_token?: boolean;
  quota_5h_used_percent?: number;
  quota_5h_reset_at?: number;
  quota_7d_used_percent?: number;
  quota_7d_reset_at?: number;
}

interface OverviewPageProps {
  accounts: AccountSummary[];
  gateway: { running?: boolean; url?: string; activeHttpRequests?: number; activeWebSockets?: number };
  gatewayBase: string;
  mcpGateway: { running?: boolean; url?: string };
  tokenSummary: TokenSummary;
  quotaSummary: {
    capacity_percent?: number;
    primary?: QuotaDetail;
    secondary?: QuotaDetail;
  };
  settings: SettingsRecord;
  recentLogs?: AppLog[];
}

interface QuotaDetail {
  remaining_percent?: number;
  reset_at?: number;
}

export const OverviewPage = ({
  accounts,
  gateway,
  gatewayBase,
  mcpGateway,
  tokenSummary,
  quotaSummary,
  settings,
  recentLogs = []
}: OverviewPageProps) => {
  const upstreamQuery = useQuery({
    queryKey: ["upstreams", "overview"],
    queryFn: () => window.codexGateway.listUpstreams()
  });
  const modelsQuery = useQuery({
    queryKey: ["upstreams", "overview", "models"],
    queryFn: () => window.codexGateway.getModelManagement()
  });
  const usableAccounts = accounts.filter((account) => isUsableAccount(account, settings)).length;
  const total = tokenSummary?.total || {};
  const apiUpstreams = Array.isArray(upstreamQuery.data)
    ? upstreamQuery.data.filter((upstream) => upstream.kind === "responses_api")
    : [];
  const healthyApiUpstreams = apiUpstreams.filter((upstream) => upstream.enabled && upstream.healthStatus === "healthy").length;
  const unhealthyApiUpstreams = apiUpstreams.filter((upstream) => upstream.enabled && upstream.healthStatus === "unhealthy");
  const modelCount = new Set((modelsQuery.data ?? []).filter((model) => model.visible).map((model) => model.slug)).size;
  const errorLogs = recentLogs.filter((log) => log.level === "error" || log.status === "failed").slice(0, 5);

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <div className="v1-page-card">
        <Row gutter={[16, 16]}>
          <MetricCard span={8} icon={<TeamOutlined />} title="可用订阅账号" value={`${usableAccounts}/${accounts.length}`} />
          <MetricCard span={10} icon={<ApiOutlined />} title="可用第三方渠道" value={`${healthyApiUpstreams}/${apiUpstreams.length}`} loading={upstreamQuery.isLoading} />
          <MetricCard span={6} icon={<DashboardOutlined />} title="可选模型" value={modelsQuery.isError ? "-" : modelCount} loading={modelsQuery.isLoading} />
        </Row>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={settings.ignore_five_hour_limit === "true" ? 16 : 12}>
          <ServiceAddressCard gatewayBase={gateway.running ? gatewayBase : "未启动"} mcpGatewayUrl={mcpGateway.url || "未启动"} />
        </Col>
        {settings.ignore_five_hour_limit !== "true" && (
          <Col xs={24} md={12} xl={6}><QuotaCard title="5 小时剩余额度" detail={quotaSummary.primary} capacity={quotaSummary.capacity_percent} /></Col>
        )}
        <Col xs={24} md={12} xl={settings.ignore_five_hour_limit === "true" ? 8 : 6}>
          <QuotaCard title="7 天剩余额度" detail={quotaSummary.secondary} capacity={quotaSummary.capacity_percent} />
        </Col>
      </Row>

      <Card title="今日调用" className="v1-overview-card v1-statistics-card">
        <div className="v1-overview-statistics">
          <StatisticColumn title="调用" value={total.calls || 0} />
          <StatisticColumn title="总 Token" value={total.total_tokens || 0} tooltip={<TokenUsageDetails usage={total} />} />
          <StatisticColumn title="缓存命中率（%）" value={cacheHitRate(total.input_tokens, total.cached_input_tokens)} precision={1} />
          <StatisticColumn title="平均耗时（s）" value={Math.round(Number(total.average_duration_ms || 0) / 100) / 10} precision={1} />
          <StatisticColumn title="输出速度（tps）" value={total.output_tokens_per_second ?? "-"} precision={1} tooltip="有效记录的总输出 Token ÷ 总请求耗时，包含等待时间。" />
          <StatisticColumn title="错误" value={Number(total.errors || 0)} />
          <StatisticColumn title={`估算成本（${currencySymbol(settings.billing_currency || "USD")}）`} value={Number(total.estimated_cost || 0)} precision={4} />
        </div>
      </Card>

      <Card title="需要关注" className="v1-overview-card">
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          {unhealthyApiUpstreams.map((upstream) => <Alert key={upstream.id} showIcon type="warning" title={`${upstream.name} 健康检查失败`} description={upstream.healthMessage || "请检查地址、认证和网络。"} />)}
          {errorLogs.length === 0 && unhealthyApiUpstreams.length === 0
            ? <Alert showIcon type="success" title="当前运行正常" />
            : <List size="small" dataSource={errorLogs} renderItem={(log) => <List.Item><Typography.Text type="danger">{log.scope || "system"} · {log.message || log.status || "未知错误"}</Typography.Text></List.Item>} />}
        </Space>
      </Card>
    </Space>
  );
};

const MetricCard = ({
  span,
  icon,
  title,
  value,
  loading = false
}: {
  span: number;
  icon: ReactNode;
  title: string;
  value: string | number;
  loading?: boolean;
}) => (
  <Col xs={24} md={span}>
    <Card loading={loading} className="v1-overview-card">
      <Flex align="center" gap={14}>
        <div className="v1-overview-icon">{icon}</div>
        <Statistic title={title} value={value} />
      </Flex>
    </Card>
  </Col>
);

const ServiceAddressCard = ({ gatewayBase, mcpGatewayUrl }: { gatewayBase: string; mcpGatewayUrl: string }) => (
  <Card className="v1-overview-card v1-overview-status-card">
    <Typography.Text type="secondary">服务地址</Typography.Text>
    <div className="v1-overview-addresses">
      <div className="v1-overview-address-row">
        <Typography.Text type="secondary">网关服务</Typography.Text>
        <Typography.Text
          className="v1-overview-address-value v1-mono"
          ellipsis={{ tooltip: gatewayBase }}
          copyable={{ text: gatewayBase }}
        >
          {gatewayBase}
        </Typography.Text>
      </div>
      <div className="v1-overview-address-row">
        <Typography.Text type="secondary">MCP 服务</Typography.Text>
        <Typography.Text
          className="v1-overview-address-value v1-mono"
          ellipsis={{ tooltip: mcpGatewayUrl }}
          copyable={{ text: mcpGatewayUrl }}
        >
          {mcpGatewayUrl}
        </Typography.Text>
      </div>
    </div>
  </Card>
);

const QuotaCard = ({ title, detail, capacity }: { title: string; detail: QuotaDetail | undefined; capacity: number | undefined }) => {
  const remaining = quotaRemainingPercent(Number(detail?.remaining_percent || 0), Number(capacity ?? 100));
  return (
    <Card className="v1-overview-card v1-overview-status-card v1-overview-quota-card">
      <Typography.Text type="secondary">{title}（%）</Typography.Text>
      <div className="v1-overview-quota-body">
        <div>
          <Typography.Title level={3}>{remaining.toFixed(1)}</Typography.Title>
          <Typography.Text type="secondary">重置：{formatTime(detail?.reset_at)}</Typography.Text>
        </div>
      </div>
    </Card>
  );
};

const StatisticColumn = ({
  title,
  value,
  precision,
  tooltip
}: {
  title: string;
  value: number | string;
  precision?: number;
  tooltip?: ReactNode;
}) => (
  <div className="v1-statistic-item">
    {tooltip ? (
      <Tooltip title={tooltip}>
        <div><Statistic title={title} value={value} {...(precision === undefined ? {} : { precision })} /></div>
      </Tooltip>
    ) : (
      <Statistic title={title} value={value} {...(precision === undefined ? {} : { precision })} />
    )}
  </div>
);

const TokenUsageDetails = ({ usage }: { usage: TokenSummary["total"] }) => (
  <div className="v1-token-tooltip">
    <div>输入：{formatTokenNumber(usage.input_tokens)}</div>
    <div>缓存输入：{formatTokenNumber(usage.cached_input_tokens)}</div>
    <div>输出：{formatTokenNumber(usage.output_tokens)}</div>
    <div>缓存命中率（%）：{cacheHitRate(usage.input_tokens, usage.cached_input_tokens).toFixed(1)}</div>
  </div>
);

const isUsableAccount = (account: AccountSummary, settings: SettingsRecord): boolean => {
  if (!account.enabled || account.status === "disabled" || !account.has_access_token) return false;
  const now = Math.floor(Date.now() / 1000);
  const windows: Array<[number | undefined, number | undefined]> = [
    [account.quota_7d_used_percent, account.quota_7d_reset_at]
  ];
  if (settings.ignore_five_hour_limit !== "true") {
    windows.push([account.quota_5h_used_percent, account.quota_5h_reset_at]);
  }
  return !windows.some(([usedValue, resetValue]) => {
    const used = Number(usedValue);
    if (!Number.isFinite(used) || used < 99.9) return false;
    const resetAt = Number(resetValue);
    return !Number.isFinite(resetAt) || resetAt <= 0 || resetAt > now;
  });
};

const formatTime = (value: number | undefined): string => {
  const timestamp = Number(value || 0);
  if (!timestamp) return "暂无";
  return new Date(timestamp * 1000).toLocaleString();
};
