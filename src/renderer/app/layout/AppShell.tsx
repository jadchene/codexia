import {
  ApiOutlined,
  BarChartOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  FileSearchOutlined,
  KeyOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  TeamOutlined
} from "@ant-design/icons";
import { Button, Flex, Layout, Menu, Space, Tag, Typography } from "antd";
import type { MenuProps } from "antd";
import type { PropsWithChildren, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import appIconUrl from "../../../../assets/app-icon.png";

const { Header, Content, Sider } = Layout;

interface PageDefinition {
  id: string;
  label: string;
  description?: string;
}

interface AppShellProps extends PropsWithChildren {
  activePage: string;
  appVersion?: string;
  gatewayRunning: boolean;
  initiallyCollapsed?: boolean;
  mcpGatewayRunning: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onNavigate: (page: string) => void;
  pages: PageDefinition[];
}

const navigationIcons: Record<string, ReactNode> = {
  overview: <DashboardOutlined />,
  accounts: <TeamOutlined />,
  upstreams: <ApiOutlined />,
  services: <CloudServerOutlined />,
  analytics: <BarChartOutlined />,
  runtimeLogs: <FileSearchOutlined />,
  codexIntegration: <KeyOutlined />,
  settings: <SettingOutlined />
};

export const AppShell = ({
  activePage,
  appVersion = "",
  children,
  gatewayRunning,
  initiallyCollapsed = false,
  mcpGatewayRunning,
  onCollapsedChange,
  onNavigate,
  pages
}: AppShellProps) => {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const navigationItems = useMemo<NonNullable<MenuProps["items"]>>(
    () => pages.map((page) => ({ key: page.id, icon: navigationIcons[page.id], label: page.label })),
    [pages]
  );
  const title = useMemo(
    () => pages.find((page) => page.id === activePage)?.label ?? "Codexia",
    [activePage, pages]
  );
  const description = useMemo(
    () => pages.find((page) => page.id === activePage)?.description ?? "",
    [activePage, pages]
  );

  useEffect(() => setCollapsed(initiallyCollapsed), [initiallyCollapsed]);

  const toggleCollapsed = (): void => {
    setCollapsed((value) => {
      const next = !value;
      onCollapsedChange?.(next);
      return next;
    });
  };

  return (
    <Layout className="v1-shell">
      <Sider className="v1-sider" collapsed={collapsed} collapsedWidth={72} width={232} trigger={null}>
        <div className="v1-brand">
          <img className="v1-brand-mark" src={appIconUrl} alt="" />
          {!collapsed && (
            <div>
              <Typography.Text strong>Codexia</Typography.Text>
              <Typography.Text type="secondary" className="v1-brand-subtitle">
                {appVersion ? `v${appVersion}` : ""}
              </Typography.Text>
            </div>
          )}
        </div>
        <Menu
          className="v1-navigation"
          items={navigationItems}
          mode="inline"
          selectedKeys={[activePage]}
          onClick={({ key }) => onNavigate(key)}
        />
      </Sider>
      <Layout className="v1-main-layout">
        <Header className="v1-header">
          <Flex align="center" justify="space-between" gap={16}>
            <Space size={12}>
              <Button
                aria-label={collapsed ? "展开导航" : "折叠导航"}
                icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                type="text"
                onClick={toggleCollapsed}
              />
              <div className="v1-header-heading">
                <Typography.Title level={3}>{title}</Typography.Title>
                {description && <Typography.Text type="secondary" className="v1-header-subtitle">{description}</Typography.Text>}
              </div>
            </Space>
            <Space wrap>
              <Tag color={gatewayRunning ? "success" : "default"}>API {gatewayRunning ? "运行中" : "已停止"}</Tag>
              <Tag color={mcpGatewayRunning ? "success" : "default"}>MCP {mcpGatewayRunning ? "运行中" : "已停止"}</Tag>
            </Space>
          </Flex>
        </Header>
        <Content className="v1-content">{children}</Content>
      </Layout>
    </Layout>
  );
};
