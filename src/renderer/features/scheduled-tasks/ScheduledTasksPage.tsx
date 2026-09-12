import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, DatePicker, Flex, Form, Input, Modal, Popconfirm, Radio, Space, Switch, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useState } from "react";
import type { ScheduledTask, ScheduledTaskStatus } from "../../../shared/contracts/scheduled-tasks";
import { CronBuilder } from "./CronBuilder";

const statusLabels: Record<ScheduledTaskStatus, string> = {
  scheduled: "等待执行", running: "执行中", sent: "消息已发送", completed: "执行完成", failed: "执行失败",
  expired: "已过期", idle: "无后续时间点", interrupted: "上次执行中断"
};
const timeText = (value: number) => value ? dayjs(value).format("YYYY-MM-DD HH:mm:ss") : "—";

interface TaskForm {
  name: string;
  target: "existing" | "new";
  sessionId: string;
  workingDirectory: string;
  message: string;
  cron: string;
  range: [Dayjs, Dayjs];
  enabled: boolean;
}

export const ScheduledTasksPage = ({ onMessage }: { onMessage: (message: string) => void }) => {
  const api = window.codexGateway;
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["scheduledTasks"], queryFn: () => api.listScheduledTasks(), refetchInterval: 5000 });
  const [form] = Form.useForm<TaskForm>();
  const target = Form.useWatch("target", form) || "existing";
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["scheduledTasks"] });
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await refresh();
    } catch (failure) { onMessage(failure instanceof Error ? failure.message : "操作失败，请重试。"); }
  };
  const edit = (record: ScheduledTask | null) => {
    setEditing(record);
    setError("");
    form.setFieldsValue(record ? { ...record, range: [dayjs(record.startsAt), dayjs(record.endsAt)] } : {
      name: "", target: "existing", sessionId: "", workingDirectory: "", message: "", cron: "0 22 * * *",
      range: [dayjs(), dayjs().add(1, "day")], enabled: true
    });
    setOpen(true);
  };
  const save = async (values: TaskForm) => {
    setSaving(true);
    setError("");
    try {
      await api.saveScheduledTask({
        ...(editing ? { id: editing.id } : {}), name: values.name.trim(), target: values.target,
        sessionId: values.target === "existing" ? values.sessionId.trim() : "",
        workingDirectory: values.target === "new" ? values.workingDirectory.trim() : "",
        message: values.message, cron: values.cron.trim(), enabled: values.enabled,
        startsAt: values.range[0].valueOf(), endsAt: values.range[1].valueOf()
      });
      await refresh();
      setOpen(false);
      onMessage("定时任务已保存。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败，请重试。"); }
    finally { setSaving(false); }
  };
  const columns: TableColumnsType<ScheduledTask> = [
    { title: "任务名称", dataIndex: "name", key: "name", width: 150 },
    { title: "启用", key: "enabled", width: 75, render: (_, record) => <Switch aria-label={`启用 ${record.name}`} checked={record.enabled} onChange={(enabled) => void run(() => api.setScheduledTaskEnabled(record.id, enabled))} /> },
    { title: "目标会话", key: "target", width: 300, render: (_, record) => <Space orientation="vertical" size={0}>
      <Typography.Text>{record.target === "existing" ? "已有会话" : "每次新建会话"}</Typography.Text>
      {record.target === "new" && <Typography.Text type="secondary" ellipsis={{ tooltip: record.workingDirectory }} style={{ maxWidth: 270 }}>{record.workingDirectory}</Typography.Text>}
      {(record.target === "existing" ? record.sessionId : record.lastSessionId) && <Typography.Text type="secondary" copyable className="v1-mono">{record.target === "existing" ? record.sessionId : record.lastSessionId}</Typography.Text>}
    </Space> },
    { title: "Cron", dataIndex: "cron", key: "cron", width: 140 },
    { title: "消息内容", dataIndex: "message", key: "message", width: 220, ellipsis: true },
    { title: "生效时段", key: "window", width: 190, render: (_, record) => <Space orientation="vertical" size={0}><span>{timeText(record.startsAt)}</span><span>至 {timeText(record.endsAt)}</span></Space> },
    { title: "状态", key: "status", width: 130, render: (_, record) => <Tag color={record.status === "failed" ? "error" : ["sent", "completed"].includes(record.status) ? "success" : "default"}>{record.enabled ? statusLabels[record.status] : "已停用"}</Tag> },
    { title: "下次执行", key: "next", width: 180, render: (_, record) => timeText(record.nextRunAt) },
    { title: "最近执行", key: "last", width: 180, render: (_, record) => timeText(record.lastRunAt) },
    { title: "执行次数", dataIndex: "runCount", key: "count", width: 90 },
    { title: "最近结果", dataIndex: "result", key: "result", width: 230, ellipsis: true },
    { title: "操作", key: "actions", width: 125, fixed: "right", render: (_, record) => <Space>
      <Button type="link" size="small" onClick={() => edit(record)}>编辑</Button>
      <Popconfirm title="删除这条定时任务？" description="已开始的执行会继续，后续时间点不再触发。" onConfirm={() => run(() => api.deleteScheduledTask(record.id))}><Button type="link" danger size="small">删除</Button></Popconfirm>
    </Space> }
  ];
  return <Space orientation="vertical" size={16} style={{ width: "100%" }}>
    <Alert type="info" showIcon title="按本机时区定时发送普通消息。请保持 Codexia 运行；停用只取消后续触发，已开始的执行会继续。" />
    {query.isError && <Alert type="error" showIcon title="读取定时任务失败，请刷新重试。" />}
    <div className="v1-page-card">
      <Flex gap={8} className="v1-table-toolbar">
        <Button type="primary" icon={<PlusOutlined />} onClick={() => edit(null)}>新建任务</Button>
        <Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => void refresh()}>刷新</Button>
      </Flex>
      <Table rowKey="id" columns={columns} dataSource={query.data || []} loading={query.isLoading} scroll={{ x: 2110 }} pagination={{ pageSize: 10 }} locale={{ emptyText: "暂无定时任务" }} />
    </div>
    <Modal title={editing ? "编辑定时任务" : "新建定时任务"} open={open} width={640} okText="保存" cancelText="取消" confirmLoading={saving} onOk={() => form.submit()} onCancel={() => setOpen(false)} destroyOnHidden styles={{ body: { maxHeight: "65vh", overflowY: "auto" } }}>
      <Form form={form} layout="vertical" onFinish={(values) => void save(values)}>
        {error && <Alert type="error" showIcon title={error} />}
        <Form.Item name="name" label="任务名称" rules={[{ required: true, whitespace: true, message: "请输入任务名称。" }]}><Input maxLength={100} /></Form.Item>
        <Form.Item name="target" label="执行目标"><Radio.Group options={[{ label: "已有会话", value: "existing" }, { label: "每次新建会话", value: "new" }]} /></Form.Item>
        {target === "existing" ? <Form.Item name="sessionId" label="会话 ID" rules={[{ required: true, message: "请输入会话 ID。" }, { pattern: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, message: "请输入有效的会话 UUID。" }]}><Input placeholder="填写 Codex 会话 UUID" /></Form.Item>
          : <Form.Item name="workingDirectory" label="工作目录" extra="每次在此目录启动独立会话。" rules={[{ required: true, whitespace: true, message: "请填写完整的工作目录。" }]}><Input placeholder="例如 E:\Personal\my-project" /></Form.Item>}
        <CronBuilder key={editing?.id || "new"} onApply={(cron) => form.setFieldValue("cron", cron)} />
        <Form.Item name="cron" label="Cron 表达式" extra="可用上方工具生成，也可手动填写。五段：分 时 日 月 周，按本机时区执行。" rules={[{ required: true, message: "请输入 Cron 表达式。" }]}><Input placeholder="0 22 * * *" /></Form.Item>
        <Form.Item name="range" label="生效时段" rules={[{ required: true, message: "请选择开始和结束时间。" }]}><DatePicker.RangePicker showTime format="YYYY-MM-DD HH:mm:ss" style={{ width: "100%" }} /></Form.Item>
        <Form.Item name="message" label="消息内容" rules={[{ required: true, whitespace: true, message: "请输入消息内容。" }]}><Input.TextArea rows={4} maxLength={16_000} showCount placeholder="填写到点后发送给 Agent 的任务指令" /></Form.Item>
        <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
      </Form>
    </Modal>
  </Space>;
};
