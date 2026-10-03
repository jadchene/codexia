import {
  ApiOutlined,
  DashboardOutlined,
  ReloadOutlined,
  TeamOutlined
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Col, Flex, List, Progress, Row, Space, Statistic, Tooltip, Typography } from "antd";
import type { ReactNode } from "react";
import type { AppLog, TokenSummary } from "../../../shared/contracts/logs";
import { currencyName } from "../../lib/currency";
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
  onToggleGateway?: () => Promise<void>;
  onRefreshAccounts?: () => Promise<void>;
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
  recentLogs = [],
  onToggleGateway,
  onRefreshAccounts
}: OverviewPageProps) => {
  const upstreamQuery = useQuery({
    queryKey: ["upstreams", "overview"],
    queryFn: () => window.codexGateway.listUpstreams()
  });
  const usableAccounts = accounts.filter((account) => isUsableAccount(account, settings)).length;
  const total = tokenSummary?.total || {};
  const apiUpstreams = Array.isArray(upstreamQuery.data)
    ? upstreamQuery.data.filter((upstream) => upstream.kind === "responses_api")
    : [];
  const healthyApiUpstreams = apiUpstreams.filter((upstream) => upstream.enabled && upstream.healthStatus === "healthy").length;
  const unhealthyApiUpstreams = apiUpstreams.filter((upstream) => upstream.enabled && upstream.healthStatus === "unhealthy");
  const modelCount = (upstreamQuery.data ?? []).reduce((total, upstream) => total + upstream.modelCount, 0);
  const errorLogs = recentLogs.filter((log) => log.level === "error" || log.status === "failed").slice(0, 5);

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <div className="v1-page-card">
        <Flex gap={8} wrap className="v1-table-toolbar">
          <Button type="primary" onClick={() => void onToggleGateway?.()}>{gateway.running ? "停止 API 服务" : "启动 API 服务"}</Button>
          <Button icon={<ReloadOutlined />} onClick={() => void onRefreshAccounts?.()}>刷新额度</Button>
        </Flex>
        <Row gutter={[16, 16]}>
          <MetricCard icon={<TeamOutlined />} title="可用订阅账号" value={`${usableAccounts}/${accounts.length}`} />
          <MetricCard icon={<ApiOutlined />} title="可用第三方渠道" value={`${healthyApiUpstreams}/${apiUpstreams.length}`} loading={upstreamQuery.isLoading} />
          <MetricCard icon={<DashboardOutlined />} title="可选模型" value={modelCount} loading={upstreamQuery.isLoading} />
        </Row>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={settings.ignore_five_hour_limit === "true" ? 12 : 8}>
          <ServiceAddressCard gatewayBase={gateway.running ? gatewayBase : "未启动"} mcpGatewayUrl={mcpGateway.url || "未启动"} />
        </Col>
        {settings.ignore_five_hour_limit !== "true" && (
          <Col xs={24} md={12} xl={8}><QuotaCard title="5 小时剩余额度" detail={quotaSummary.primary} capacity={quotaSummary.capacity_percent} /></Col>
        )}
        <Col xs={24} md={12} xl={settings.ignore_five_hour_limit === "true" ? 12 : 8}>
          <QuotaCard title="7 天剩余额度" detail={quotaSummary.secondary} capacity={quotaSummary.capacity_percent} />
        </Col>
      </Row>

      <Card title="今日调用" className="v1-overview-card">
        <Row gutter={[16, 20]}>
          <StatisticColumn title="调用" value={total.calls || 0} />
          <StatisticColumn title="总 Token" value={total.total_tokens || 0} tooltip={<TokenUsageDetails usage={total} />} />
          <StatisticColumn title="缓存命中" value={cacheHitRate(total.input_tokens, total.cached_input_tokens)} precision={1} suffix="%" />
          <StatisticColumn title="平均耗时" value={Number(total.average_duration_ms || 0)} precision={0} suffix="ms" />
          <StatisticColumn title="错误" value={Number(total.errors || 0)} />
          <StatisticColumn title={`估算成本（${currencyName(settings.billing_currency || "USD")}）`} value={Number(total.estimated_cost || 0)} precision={4} />
        </Row>
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
  icon,
  title,
  value,
  loading = false
}: {
  icon: ReactNode;
  title: string;
  value: string | number;
  loading?: boolean;
}) => (
  <Col xs={24} sm={12} xl={8}>
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
        <Typography.Text type="secondary">API 服务</Typography.Text>
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
  const remaining = Math.max(0, Number(detail?.remaining_percent || 0));
  const totalCapacity = Number(capacity ?? 100);
  const progress = Math.round(Math.max(0, Math.min(100, totalCapacity > 0 ? remaining / totalCapacity * 100 : 0)) * 10) / 10;
  return (
    <Card className="v1-overview-card v1-overview-status-card v1-overview-quota-card">
      <Typography.Text type="secondary">{title}</Typography.Text>
      <div className="v1-overview-quota-body">
        <div>
          <Typography.Title level={3}>{remaining.toFixed(1)}%</Typography.Title>
          <Typography.Text type="secondary">重置：{formatTime(detail?.reset_at)}</Typography.Text>
        </div>
        <Progress type="dashboard" percent={progress} size={92} strokeColor={progress < 20 ? "#dc2626" : "#2563eb"} />
      </div>
    </Card>
  );
};

const StatisticColumn = ({
  title,
  value,
  precision,
  suffix,
  tooltip
}: {
  title: string;
  value: number;
  precision?: number;
  suffix?: string;
  tooltip?: ReactNode;
}) => (
  <Col xs={12} lg={8} xl={4}>
    {tooltip ? (
      <Tooltip title={tooltip}>
        <div><Statistic title={title} value={value} {...(precision === undefined ? {} : { precision })} {...(suffix === undefined ? {} : { suffix })} /></div>
      </Tooltip>
    ) : (
      <Statistic title={title} value={value} {...(precision === undefined ? {} : { precision })} {...(suffix === undefined ? {} : { suffix })} />
    )}
  </Col>
);

const TokenUsageDetails = ({ usage }: { usage: TokenSummary["total"] }) => (
  <div className="v1-token-tooltip">
    <div>输入：{formatTokenNumber(usage.input_tokens)}</div>
    <div>缓存输入：{formatTokenNumber(usage.cached_input_tokens)}</div>
    <div>输出：{formatTokenNumber(usage.output_tokens)}</div>
    <div>缓存命中率：{cacheHitRate(usage.input_tokens, usage.cached_input_tokens).toFixed(1)}%</div>
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
