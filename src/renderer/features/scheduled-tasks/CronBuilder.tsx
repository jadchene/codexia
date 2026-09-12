import { Button, InputNumber, Select, Space, TimePicker } from "antd";
import dayjs from "dayjs";
import { useState } from "react";

export const CronBuilder = ({ onApply }: { onApply: (cron: string) => void }) => {
  const [frequency, setFrequency] = useState("daily");
  const [interval, setInterval] = useState(30);
  const [time, setTime] = useState(dayjs().hour(22).minute(0));
  const [weekday, setWeekday] = useState(1);
  const expression = frequency === "minutes" ? `*/${interval} * * * *`
    : frequency === "hourly" ? `${time.minute()} * * * *`
      : `${time.minute()} ${time.hour()} * * ${frequency === "weekly" ? weekday : "*"}`;
  return <Space wrap style={{ marginBottom: 12 }}>
    <Select aria-label="执行频率" value={frequency} onChange={setFrequency} style={{ width: 125 }} options={[
      { label: "每隔几分钟", value: "minutes" }, { label: "每小时", value: "hourly" },
      { label: "每天", value: "daily" }, { label: "每周", value: "weekly" }
    ]} />
    {frequency === "minutes" ? <InputNumber aria-label="间隔分钟" min={1} max={59} precision={0} value={interval} onChange={(value) => setInterval(value || 1)} suffix="分钟" />
      : <TimePicker aria-label="执行时刻" value={time} onChange={(value) => { if (value) setTime(value); }} format={frequency === "hourly" ? "mm" : "HH:mm"} allowClear={false} needConfirm={false} />}
    {frequency === "weekly" && <Select aria-label="执行星期" value={weekday} onChange={setWeekday} style={{ width: 100 }} options={["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map((label, value) => ({ label, value }))} />}
    <Button onClick={() => onApply(expression)}>生成表达式</Button>
    {frequency === "minutes" && <span>每小时内按分钟步长触发</span>}
  </Space>;
};
