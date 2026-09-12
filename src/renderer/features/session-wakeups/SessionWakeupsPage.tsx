import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, DatePicker, Flex, Form, Input, InputNumber, Modal, Popconfirm, Space, Switch, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useState } from "react";
import type { SessionWakeup, SessionWakeupStatus } from "../../../shared/contracts/session-wakeup";

const statusLabels: Record<SessionWakeupStatus, string> = {
  armed: "待命", waiting: "等待额度", checking: "刷新额度中", waking: "唤醒中", awakened: "已唤醒",
  expired: "已过期", exhausted: "次数用尽", failed: "需确认", skipped: "目标已完成"
};
const timeText = (value: number) => value ? dayjs(value).format("YYYY-MM-DD HH:mm:ss") : "—";

interface FormValues {
  sessionId: string;
  name: string;
  enabled: boolean;
  resumeGoal: boolean;
  range: [Dayjs, Dayjs];
  maxAttempts: number;
}

export const SessionWakeupsPage = ({ onMessage }: { onMessage: (message: string) => void }) => {
  const api = window.codexGateway;
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["sessionWakeups"], queryFn: () => api.listSessionWakeups(), refetchInterval: 5000 });
  const [form] = Form.useForm<FormValues>();
  const [editing, setEditing] = useState<SessionWakeup | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["sessionWakeups"] });
  const run = async (action: () => Promise<unknown>) => {
    try { await action(); await refresh(); }
    catch (error) { onMessage(error instanceof Error ? error.message : "操作失败，请重试。"); }
  };
  const edit = (record: SessionWakeup | null) => {
    setEditing(record);
    setFormError("");
    form.setFieldsValue(record ? {
      ...record, range: [dayjs(record.startsAt), dayjs(record.endsAt)]
    } : { sessionId: "", name: "", enabled: true, resumeGoal: false, range: [dayjs(), dayjs().add(8, "hour")], maxAttempts: 3 });
    setOpen(true);
  };
  const save = async (values: FormValues) => {
    setSaving(true);
    setFormError("");
    try {
      await api.saveSessionWakeup({
        ...(editing ? { id: editing.id } : {}), name: values.name || "", sessionId: values.sessionId.trim(),
        enabled: values.enabled, resumeGoal: values.resumeGoal, maxAttempts: values.maxAttempts,
        startsAt: values.range[0].valueOf(), endsAt: values.range[1].valueOf()
      });
      await refresh();
      setOpen(false);
      onMessage("会话唤醒已保存。");
    } catch (error) { setFormError(error instanceof Error ? error.message : "保存失败，请重试。"); }
    finally { setSaving(false); }
  };
  const columns: TableColumnsType<SessionWakeup> = [
    { title: "会话", key: "session", width: 300, render: (_, record) => <Space orientation="vertical" size={0}>
      <Typography.Text strong>{record.name || "未命名会话"}</Typography.Text>
      <Typography.Text type="secondary" copyable={{ text: record.sessionId }} className="v1-mono">{record.sessionId}</Typography.Text>
    </Space> },
    { title: "启用", key: "enabled", width: 75, render: (_, record) => <Switch aria-label={`启用 ${record.name || record.sessionId}`} checked={record.enabled} onChange={(enabled) => void run(() => api.setSessionWakeupEnabled(record.id, enabled))} /> },
    { title: "唤醒方式", key: "mode", width: 115, render: (_, record) => record.resumeGoal ? "恢复 Goal" : "继续消息" },
    { title: "生效时段", key: "window", width: 185, render: (_, record) => <Space orientation="vertical" size={0}><span>{timeText(record.startsAt)}</span><span>至 {timeText(record.endsAt)}</span></Space> },
    { title: "状态", key: "status", width: 270, render: (_, record) => <Space orientation="vertical" size={4}>
      <Tag color={record.status === "awakened" ? "success" : record.status === "failed" ? "error" : "default"}>{record.enabled ? statusLabels[record.status] : "已停用"}</Tag>
      <Typography.Text type="secondary">{record.message}</Typography.Text>
    </Space> },
    { title: "尝试次数", key: "attempts", width: 95, render: (_, record) => `${record.attempts} / ${record.maxAttempts}` },
    { title: "下次检查", key: "next", width: 175, render: (_, record) => record.enabled ? timeText(record.nextAttemptAt) : "—" },
    { title: "最近尝试", key: "last", width: 175, render: (_, record) => timeText(record.lastAttemptAt) },
    { title: "操作", key: "actions", width: 125, fixed: "right", render: (_, record) => <Space>
      <Button type="link" size="small" onClick={() => edit(record)}>编辑</Button>
      <Popconfirm title="删除这条会话唤醒登记？" onConfirm={() => run(() => api.deleteSessionWakeup(record.id))}><Button type="link" danger size="small">删除</Button></Popconfirm>
    </Space> }
  ];
  return <Space orientation="vertical" size={16} style={{ width: "100%" }}>
    <Alert showIcon type="info" title="在生效时段内，网关确认账号池额度不足后，等待重置、刷新额度并唤醒登记的会话。请保持 Codexia 和对应的 Codex 会话运行。" />
    {query.isError && <Alert showIcon type="error" title="读取会话唤醒登记失败，请刷新重试。" />}
    <div className="v1-page-card">
      <Flex gap={8} className="v1-table-toolbar">
        <Button type="primary" icon={<PlusOutlined />} onClick={() => edit(null)}>登记会话</Button>
        <Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => void refresh()}>刷新</Button>
      </Flex>
      <Table rowKey="id" columns={columns} dataSource={query.data || []} loading={query.isLoading} scroll={{ x: 1515 }} pagination={{ pageSize: 10 }} locale={{ emptyText: "暂无会话唤醒登记" }} />
    </div>
    <Modal title={editing ? "编辑会话唤醒" : "登记会话唤醒"} open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} okText="保存" cancelText="取消" confirmLoading={saving} destroyOnHidden>
      <Form form={form} layout="vertical" onFinish={(values) => void save(values)}>
        {formError && <Alert type="error" showIcon title={formError} />}
        <Form.Item name="name" label="会话名称"><Input maxLength={100} placeholder="例如：夜间项目开发" /></Form.Item>
        <Form.Item name="sessionId" label="会话 ID" rules={[{ required: true, message: "请输入会话 ID。" }, { pattern: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, message: "请输入会话 UUID。" }]}><Input placeholder="填写 Codex 会话 UUID" /></Form.Item>
        <Form.Item name="range" label="生效时段" rules={[{ required: true, message: "请选择开始和结束时间。" }]}><DatePicker.RangePicker showTime format="YYYY-MM-DD HH:mm:ss" style={{ width: "100%" }} /></Form.Item>
        <Form.Item name="maxAttempts" label="最大尝试次数" extra="每轮额度刷新及后续唤醒计一次；失败也计数，达到上限即停止。成功后不清零，修改生效时段开始新的计数。" rules={[{ required: true }]}><InputNumber min={1} max={100} precision={0} /></Form.Item>
        <Form.Item name="resumeGoal" label="恢复 Goal" valuePropName="checked" extra="开启后恢复原 Goal；已完成的 Goal 不再激活。关闭或没有 Goal 时，仅发送继续消息。"><Switch /></Form.Item>
        <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
      </Form>
    </Modal>
  </Space>;
};
