import {
  CheckCircleOutlined,
  DeleteOutlined,
  EyeOutlined,
  ImportOutlined,
  LoginOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  ReloadOutlined
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography
} from "antd";
import type { TableColumnsType } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { ConsumeResetCreditResult, PublicAccount, ResetCredit } from "../../../shared/contracts/accounts";
import type { Settings } from "../../../shared/contracts/settings";
import { formatTime, parseResetCredits, resetCreditStatusLabel } from "../../lib/formatters";

interface AccountsPageProps {
  accounts: PublicAccount[];
  loginPhase: "idle" | "starting" | "waiting" | "success" | "failed";
  loginError: string;
  refreshingIds: Set<string>;
  retryIds: Set<string>;
  settings: Settings;
  onStartLogin: () => Promise<void>;
  onImportLocal: () => Promise<boolean>;
  onCancelLogin: () => Promise<void>;
  onResetLogin: () => void;
  onRefreshUsage: (account: PublicAccount) => Promise<void>;
  onRefreshAll: () => Promise<void>;
  onConsumeResetCredit: (account: PublicAccount, creditId?: string) => Promise<ConsumeResetCreditResult | void>;
  consumingResetIds: Set<string>;
  onSetEnabled: (account: PublicAccount, enabled: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export const AccountsPage = ({
  accounts,
  loginPhase,
  loginError,
  refreshingIds,
  retryIds,
  settings,
  onStartLogin,
  onImportLocal,
  onCancelLogin,
  onResetLogin,
  onRefreshUsage,
  onRefreshAll,
  onConsumeResetCredit,
  consumingResetIds,
  onSetEnabled,
  onDelete
}: AccountsPageProps) => {
  const [addOpen, setAddOpen] = useState(false);
  const [importingLocal, setImportingLocal] = useState(false);
  const [detailAccount, setDetailAccount] = useState<PublicAccount | null>(null);
  const resetCredits = useMemo(() => parseResetCredits(detailAccount), [detailAccount]);
  const enabledAccounts = accounts.filter((account) => account.enabled && account.status !== "disabled");
  const totalFiveHourRemaining = enabledAccounts.reduce(
    (total, account) => total + Math.max(0, 100 - Number(account.quota_5h_used_percent || 0)),
    0
  );
  const totalSevenDayRemaining = enabledAccounts.reduce(
    (total, account) => total + Math.max(0, 100 - Number(account.quota_7d_used_percent || 0)),
    0
  );

  const loginBusy = loginPhase === "starting" || loginPhase === "waiting";

  useEffect(() => {
    if (loginPhase !== "success") return;
    setAddOpen(false);
    onResetLogin();
  }, [loginPhase, onResetLogin]);

  const openAddModal = (): void => {
    if (!loginBusy) onResetLogin();
    setAddOpen(true);
  };

  const closeAddModal = async (): Promise<void> => {
    if (loginBusy) await onCancelLogin();
    setAddOpen(false);
  };

  const importLocalAccount = async (): Promise<void> => {
    setImportingLocal(true);
    try {
      if (await onImportLocal()) setAddOpen(false);
    } finally {
      setImportingLocal(false);
    }
  };

  const columns: TableColumnsType<PublicAccount> = [
    {
      title: "账号",
      key: "account",
      width: 240,
      render: (_, account) => (
        <div>
          <Typography.Text strong ellipsis={{ tooltip: account.name || "未命名账号" }}>{account.name || "未命名账号"}</Typography.Text>
          <Typography.Text ellipsis={{ tooltip: account.email || account.id }} type="secondary" className="v1-block">{account.email || account.id}</Typography.Text>
        </div>
      )
    },
    {
      title: "状态",
      key: "status",
      width: 100,
      render: (_, account) => (
        <Tag color={account.enabled && account.status !== "disabled" ? "success" : "default"}>
          {account.enabled ? "启用" : "停用"}
        </Tag>
      )
    },
    ...(settings.ignore_five_hour_limit === "true"
      ? []
      : [quotaColumn("5 小时额度", "quota_5h_used_percent", "quota_5h_reset_at")]),
    quotaColumn("7 天额度", "quota_7d_used_percent", "quota_7d_reset_at"),
    {
      title: "令牌续期",
      dataIndex: "last_refresh",
      width: 160,
      render: (value) => value ? new Date(value).toLocaleString() : "暂无"
    },
    {
      title: "套餐",
      dataIndex: "subscription_plan",
      width: 110,
      render: (value: string | undefined) => value || "未知"
    },
    {
      title: "重置次数",
      key: "resetCredits",
      width: 150,
      render: (_, account) => (
        <Button type="link" size="small" onClick={() => setDetailAccount(account)}>
          {Math.max(0, Number(account.reset_credits_available_count || 0))} 次
          {account.reset_credits_next_expires_at ? ` · ${formatTime(account.reset_credits_next_expires_at)}` : ""}
        </Button>
      )
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 176,
      render: (_, account) => (
        <Space size={4}>
          <Tooltip title={retryIds.has(account.id) ? "重试刷新" : "刷新额度"}>
            <Button
              aria-label={retryIds.has(account.id) ? "重试刷新" : "刷新额度"}
              icon={<ReloadOutlined />}
              loading={refreshingIds.has(account.id)}
              disabled={refreshingIds.has(account.id)}
              onClick={() => onRefreshUsage(account)}
            />
          </Tooltip>
          <Tooltip title={account.enabled ? "停用账号" : "启用账号"}>
            <Button
              aria-label={account.enabled ? "停用账号" : "启用账号"}
              icon={account.enabled ? <PauseCircleOutlined /> : <CheckCircleOutlined />}
              onClick={() => onSetEnabled(account, !account.enabled)}
            />
          </Tooltip>
          <Tooltip title="查看详情">
            <Button aria-label="查看详情" icon={<EyeOutlined />} onClick={() => setDetailAccount(account)} />
          </Tooltip>
          <Popconfirm
            title="删除这个账号？"
            description="删除后需要重新完成浏览器授权。"
            okButtonProps={{ danger: true }}
            onConfirm={() => onDelete(account.id)}
          >
            <Button aria-label="删除账号" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <Card className="v1-page-card v1-page-fill" variant="borderless">
      <Flex className="v1-page-actions" justify="flex-end" gap={16} wrap>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={onRefreshAll}>刷新全部</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAddModal}>
            {loginBusy ? "等待授权" : "添加账号"}
          </Button>
        </Space>
      </Flex>

      <Row gutter={[12, 12]} className="v1-summary-cards">
        <Col xs={24} md={6}>
          <Card size="small"><Statistic title="可用账号" value={enabledAccounts.length} suffix={`/ ${accounts.length}`} /></Card>
        </Col>
        {settings.ignore_five_hour_limit !== "true" && (
          <Col xs={24} md={6}>
            <Card size="small"><Statistic title="5 小时总剩余额度" value={totalFiveHourRemaining} precision={1} suffix="%" /></Card>
          </Col>
        )}
        <Col xs={24} md={6}>
          <Card size="small"><Statistic title="7 天总剩余额度" value={totalSevenDayRemaining} precision={1} suffix="%" /></Card>
        </Col>
      </Row>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={accounts}
        pagination={false}
        scroll={{ x: "max-content" }}
        tableLayout="fixed"
        locale={{ emptyText: <Empty description="还没有账号，请先完成 ChatGPT/Codex 授权。" /> }}
      />

      <Modal title="添加订阅账号" open={addOpen} footer={null} onCancel={() => void closeAddModal()}>
        {loginBusy ? (
          <Flex vertical align="center" gap={12} className="v1-account-login-waiting">
            <Spin size="large" />
            <Typography.Text strong>{loginPhase === "starting" ? "正在打开浏览器" : "等待浏览器授权"}</Typography.Text>
            <Typography.Text type="secondary">请在浏览器中完成登录，授权成功后账号会自动保存。</Typography.Text>
            <Button onClick={() => void onCancelLogin()}>取消</Button>
          </Flex>
        ) : (
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            {loginPhase === "failed" && <Alert showIcon type="error" title="浏览器认证失败" description={loginError || "请重试"} />}
            <Flex justify="center" gap={12}>
              <Button type="primary" icon={<LoginOutlined />} style={{ width: 160 }} onClick={() => void onStartLogin()}>
                浏览器认证
              </Button>
              <Button icon={<ImportOutlined />} loading={importingLocal} style={{ width: 160 }} onClick={() => void importLocalAccount()}>
                从本机 Codex 读取
              </Button>
            </Flex>
            <Typography.Text type="secondary">登录新账号可以使用浏览器认证，也可以读取本机 Codex 当前登录的账号。</Typography.Text>
          </Space>
        )}
      </Modal>

      <Drawer
        title={detailAccount ? `${detailAccount.name} · 账号详情` : "账号详情"}
        open={Boolean(detailAccount)}
        size={720}
        onClose={() => setDetailAccount(null)}
      >
        {detailAccount && <Descriptions bordered column={1} size="small" items={[
          { key: "identity", label: "账号", children: detailAccount.email || detailAccount.id },
          { key: "plan", label: "套餐", children: detailAccount.subscription_plan || "未知" },
          { key: "subscriptionExpiry", label: "订阅到期", children: formatTime(detailAccount.subscription_expires_at, "未知") },
          { key: "state", label: "状态", children: detailAccount.enabled ? "启用" : "停用" },
          { key: "refresh", label: "令牌续期", children: detailAccount.last_refresh ? new Date(detailAccount.last_refresh).toLocaleString() : "暂无" },
          {
            key: "token",
            label: "登录状态",
            children: !detailAccount.has_access_token
              ? "需要重新登录"
              : detailAccount.has_refresh_token ? "正常，可自动续期" : "已登录，过期后需重新登录"
          }
        ]} />}
        <Typography.Title level={5} style={{ marginTop: 20 }}>重置次数</Typography.Title>
        <Typography.Paragraph type="secondary">当前可用 {resetCredits.availableCount} 次。</Typography.Paragraph>
        <Table<ResetCredit>
          rowKey={(credit, index) => `${credit.title || "credit"}-${credit.granted_at || 0}-${index}`}
          pagination={false}
          dataSource={resetCredits.credits}
          columns={[
            { title: "状态", dataIndex: "status", width: 90, render: (value) => <Tag>{resetCreditStatusLabel(value)}</Tag> },
            { title: "重置类型", dataIndex: "title", width: 150, ellipsis: true, render: (value) => value || "-" },
            { title: "有效期开始", dataIndex: "granted_at", width: 160, render: (value) => formatTime(value) },
            { title: "有效期结束", dataIndex: "expires_at", width: 160, render: (value) => formatTime(value) },
            {
              title: "操作",
              key: "actions",
              width: 90,
              render: (_, credit) => {
                const busy = Boolean(detailAccount && consumingResetIds.has(detailAccount.id));
                const disabled = busy || String(credit.status || "").toLowerCase() !== "available";
                return (
                  <Popconfirm
                    title="使用这张重置卡？"
                    description="将消耗一次重置机会，并以服务器返回的数据为准刷新额度。"
                    okText="使用"
                    okButtonProps={{ danger: true }}
                    disabled={disabled}
                    onConfirm={async () => {
                      if (!detailAccount) return;
                      const result = await onConsumeResetCredit(detailAccount, credit.id);
                      if (result?.account) setDetailAccount(result.account);
                    }}
                  >
                    <Button size="small" type="link" loading={busy} disabled={disabled}>
                      使用
                    </Button>
                  </Popconfirm>
                );
              }
            }
          ]}
          scroll={{ x: 660 }}
          tableLayout="fixed"
          locale={{ emptyText: <Empty description="暂无重置次数数据，请先刷新账号额度。" /> }}
        />
      </Drawer>
    </Card>
  );
};

const quotaColumn = (
  title: string,
  usedField: "quota_5h_used_percent" | "quota_7d_used_percent",
  resetField: "quota_5h_reset_at" | "quota_7d_reset_at"
): TableColumnsType<PublicAccount>[number] => ({
  title,
  key: usedField,
  width: 190,
  render: (_, account) => {
    const used = Math.max(0, Math.min(100, Number(account[usedField] || 0)));
    const remaining = Math.max(0, 100 - used);
    return (
      <div>
        <Progress percent={remaining} size="small" {...(remaining < 20 ? { strokeColor: "#dc2626" } : {})} />
        <Typography.Text type="secondary" className="v1-block">重置：{formatTime(account[resetField])}</Typography.Text>
      </div>
    );
  }
});
