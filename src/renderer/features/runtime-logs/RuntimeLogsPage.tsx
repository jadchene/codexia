import { CopyOutlined, PauseOutlined, PlayCircleOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Card, DatePicker, Descriptions, Drawer, Empty, Flex, Input, Pagination, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { useState } from "react";
import type { AppLog, AppLogPage } from "../../../shared/contracts/logs";
import { logActionLabels, logDictionaryLabel, logDictionaryOptions, logLevelLabels, logScopeLabels, logStatusLabels } from "../../lib/runtime-log-labels";
import { formatTime } from "../../lib/formatters";
import { isTodayRange, todayLogFilters, toLogQuery, withTodayRange, type LogFilterValues } from "../../lib/log-query";
import { useDayRollover } from "../../lib/use-day-rollover";

interface RuntimeLogsPageProps {
  pageData: AppLogPage;
  paused: boolean;
  newLogCount: number;
  onPausedChange: (paused: boolean) => void;
  onMessage: (message: string) => void;
  onQuery: (query: ReturnType<typeof toLogQuery>, followsToday?: boolean) => Promise<void>;
}

export const RuntimeLogsPage = ({ pageData, paused, newLogCount, onPausedChange, onMessage, onQuery }: RuntimeLogsPageProps) => {
  const [filters, setFilters] = useState<LogFilterValues>(todayLogFilters);
  const [followsToday, setFollowsToday] = useState(true);
  const [selectedLog, setSelectedLog] = useState<AppLog | null>(null);

  useDayRollover(() => {
    if (followsToday) setFilters((current) => withTodayRange(current));
  });

  const runQuery = async (page = 1, pageSize = pageData.pageSize, nextFilters = filters, nextFollowsToday = followsToday): Promise<void> => {
    setFilters(nextFilters);
    setFollowsToday(nextFollowsToday);
    await onQuery(toLogQuery(nextFilters, page, pageSize), nextFollowsToday);
  };

  const resetFilters = async (): Promise<void> => {
    await runQuery(1, pageData.pageSize, todayLogFilters(), true);
  };

  const updateRange = (range: LogFilterValues["range"]): void => {
    setFilters((current) => ({ ...current, range }));
    setFollowsToday(isTodayRange(range));
  };

  const copyJson = async (log: AppLog): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(log, null, 2));
      onMessage("日志 JSON 已复制");
    } catch (error) {
      onMessage(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const columns: TableColumnsType<AppLog> = [
    { title: "时间", dataIndex: "created_at", width: 180, className: "v1-nowrap", render: (value) => formatTime(value) },
    {
      title: "级别",
      dataIndex: "level",
      width: 76,
      render: (value: string) => <Tag color={levelColor(value)}>{logDictionaryLabel(logLevelLabels, value, "级别")}</Tag>
    },
    { title: "模块", dataIndex: "scope", width: 110, ellipsis: true, render: (value) => logDictionaryLabel(logScopeLabels, value, "模块") },
    { title: "动作", dataIndex: "action", width: 150, ellipsis: true, render: (value) => logDictionaryLabel(logActionLabels, value, "动作") },
    { title: "状态", dataIndex: "status", width: 130, ellipsis: true, render: (value) => value ? <Tag>{logDictionaryLabel(logStatusLabels, value, "状态")}</Tag> : "-" },
    { title: "消息", dataIndex: "message", width: 560, ellipsis: true, render: (value) => value || "-" }
  ];

  return (
    <Card className="v1-page-card v1-page-fill" variant="borderless">
      <Flex className="v1-page-actions" justify="flex-end" gap={16} wrap>
        <Space>
          {paused && newLogCount > 0 && <Tag color="processing">有新日志，恢复刷新后查看</Tag>}
          <Button icon={paused ? <PlayCircleOutlined /> : <PauseOutlined />} onClick={() => onPausedChange(!paused)}>
            {paused ? "恢复自动刷新" : "暂停自动刷新"}
          </Button>
        </Space>
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
          <Typography.Text type="secondary" className="v1-filter-label">级别</Typography.Text>
          <Select
            allowClear
            value={filters.level || undefined}
            placeholder="全部级别"
            style={{ width: 150 }}
            options={logDictionaryOptions(logLevelLabels, pageData.filterOptions?.levels ?? [], "级别")}
            onChange={(value) => setFilters((current) => ({ ...current, level: value || "" }))}
          />
        </div>
        <div>
          <Typography.Text type="secondary" className="v1-filter-label">模块</Typography.Text>
          <Select allowClear value={filters.scope || undefined} placeholder="全部模块" style={{ width: 180 }} options={logDictionaryOptions(logScopeLabels, pageData.filterOptions?.scopes ?? [], "模块")} onChange={(value) => setFilters((current) => ({ ...current, scope: value || "" }))} />
        </div>
        <div>
          <Typography.Text type="secondary" className="v1-filter-label">状态</Typography.Text>
          <Select allowClear value={filters.status || undefined} placeholder="全部状态" style={{ width: 180 }} options={logDictionaryOptions(logStatusLabels, pageData.filterOptions?.statuses ?? [], "状态")} onChange={(value) => setFilters((current) => ({ ...current, status: value || "" }))} />
        </div>
        <div>
          <Typography.Text type="secondary" className="v1-filter-label">关键词</Typography.Text>
          <Input value={filters.keyword} placeholder="消息、动作或模块" style={{ width: 220 }} onChange={(event) => setFilters((current) => ({ ...current, keyword: event.target.value }))} />
        </div>
        <Button type="primary" icon={<SearchOutlined />} onClick={() => runQuery(1)}>查询</Button>
        <Button icon={<ReloadOutlined />} onClick={resetFilters}>重置</Button>
      </Flex>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={pageData.items}
        pagination={false}
        scroll={{ x: "max-content" }}
        tableLayout="fixed"
        sticky
        onRow={(log) => ({ onClick: () => setSelectedLog(log) })}
        locale={{ emptyText: <Empty description="当前筛选范围内没有运行日志。" /> }}
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

      <Drawer
        title="日志详情"
        open={Boolean(selectedLog)}
        size={680}
        extra={selectedLog && <Button icon={<CopyOutlined />} onClick={() => copyJson(selectedLog)}>复制 JSON</Button>}
        onClose={() => setSelectedLog(null)}
      >
        {selectedLog && (
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <Descriptions bordered column={1} size="small" items={[
              { key: "time", label: "时间", children: formatTime(selectedLog.created_at) },
              { key: "level", label: "级别", children: <Tag color={levelColor(selectedLog.level)}>{logDictionaryLabel(logLevelLabels, selectedLog.level, "级别")}</Tag> },
              { key: "scope", label: "模块", children: logDictionaryLabel(logScopeLabels, selectedLog.scope, "模块") },
              { key: "action", label: "动作", children: logDictionaryLabel(logActionLabels, selectedLog.action, "动作") },
              { key: "status", label: "状态", children: logDictionaryLabel(logStatusLabels, selectedLog.status, "状态") }
            ]} />
            <Typography.Paragraph copyable={{ text: selectedLog.message || "" }} className="v1-log-message">{selectedLog.message || "-"}</Typography.Paragraph>
          </Space>
        )}
      </Drawer>
    </Card>
  );
};

const levelColor = (level: unknown): string => {
  const value = String(level || "").toLowerCase();
  if (value === "error") return "error";
  if (value === "warn" || value === "warning") return "warning";
  if (value === "debug") return "default";
  return "processing";
};
