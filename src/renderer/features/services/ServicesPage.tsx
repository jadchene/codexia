import { PlayCircleOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import { Alert, Badge, Button, Card, Descriptions, Space, Typography } from "antd";
import { useState } from "react";
import type { ReactNode } from "react";

interface ServiceStatus {
  running: boolean;
  command?: string;
  error?: string;
}

interface ServicesPageProps {
  gateway: ServiceStatus;
  mcpGateway: ServiceStatus;
  gatewayBase: string;
  mcpGatewayUrl: string;
  mcpGatewayCommand: string;
  onToggleGateway: () => Promise<void>;
  onToggleMcpGateway: () => Promise<void>;
  onRestartGateway: () => Promise<void>;
  onRestartMcpGateway: () => Promise<void>;
}

export const ServicesPage = ({
  gateway,
  mcpGateway,
  gatewayBase,
  mcpGatewayUrl,
  mcpGatewayCommand,
  onToggleGateway,
  onToggleMcpGateway,
  onRestartGateway,
  onRestartMcpGateway
}: ServicesPageProps) => {
  const [busyService, setBusyService] = useState<"gateway" | "mcp" | null>(null);

  const toggle = async (service: "gateway" | "mcp"): Promise<void> => {
    setBusyService(service);
    try {
      if (service === "gateway") await onToggleGateway();
      else await onToggleMcpGateway();
    } finally {
      setBusyService(null);
    }
  };

  const restart = async (service: "gateway" | "mcp"): Promise<void> => {
    setBusyService(service);
    try {
      if (service === "gateway") await onRestartGateway();
      else await onRestartMcpGateway();
    } finally {
      setBusyService(null);
    }
  };

  return (
    <div className="v1-page-card">
      <div className="v1-service-grid">
        <ServiceCard
          title="API 服务"
          running={gateway.running}
          loading={busyService === "gateway"}
          onToggle={() => toggle("gateway")}
          onRestart={() => restart("gateway")}
        >
          <Descriptions column={1} size="small" items={[
            { key: "base", label: "服务地址", children: <ServiceValue value={gatewayBase} /> }
          ]} />
          {gateway.error && <Alert showIcon type="error" title="最近错误" description={gateway.error} />}
        </ServiceCard>
        <ServiceCard
          title="MCP 服务"
          running={mcpGateway.running}
          loading={busyService === "mcp"}
          onToggle={() => toggle("mcp")}
          onRestart={() => restart("mcp")}
        >
          <Descriptions column={1} size="small" items={[
            { key: "url", label: "服务地址", children: <ServiceValue value={mcpGatewayUrl} /> },
            { key: "command", label: "启动命令", children: <ServiceValue value={mcpGateway.command || mcpGatewayCommand} /> }
          ]} />
          {mcpGateway.error && <Alert showIcon type="error" title="最近错误" description={mcpGateway.error} />}
        </ServiceCard>
      </div>
    </div>
  );
};

const ServiceCard = ({
  title,
  running,
  loading,
  onToggle,
  onRestart,
  children
}: {
  title: string;
  running: boolean;
  loading: boolean;
  onToggle: () => void;
  onRestart: () => void;
  children: ReactNode;
}) => (
  <Card
    title={(
      <Space><Typography.Text strong>{title}</Typography.Text><Badge status={running ? "success" : "default"} text={running ? "运行中" : "已停止"} /></Space>
    )}
    extra={(
      <Space>
      {running && <Button loading={loading} icon={<ReloadOutlined />} onClick={onRestart}>重启</Button>}
      <Button
        danger={running}
        loading={loading}
        type={running ? "default" : "primary"}
        icon={running ? <StopOutlined /> : <PlayCircleOutlined />}
        onClick={onToggle}
      >
        {running ? "停止" : "启动"}
      </Button>
      </Space>
    )}
  >
    {children}
  </Card>
);

const ServiceValue = ({ value }: { value: string }) => (
  <Typography.Text className="v1-mono">{value || "-"}</Typography.Text>
);
