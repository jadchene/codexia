import { z } from "zod";

export const scheduledTaskInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, "请输入任务名称。").max(100),
  target: z.enum(["existing", "new"]),
  sessionId: z.string().trim().max(256),
  workingDirectory: z.string().trim().max(2048),
  message: z.string().max(16_000).refine((value) => value.trim().length > 0, "请输入消息内容。"),
  cron: z.string().trim().min(1).max(160),
  startsAt: z.number().int().nonnegative(),
  endsAt: z.number().int().positive().max(8_640_000_000_000_000),
  enabled: z.boolean()
}).strict()
  .refine((value) => value.endsAt > value.startsAt, { message: "结束时间必须晚于开始时间。" })
  .refine((value) => value.target !== "existing" || z.string().uuid().safeParse(value.sessionId).success, { message: "请输入有效的会话 UUID。" })
  .refine((value) => value.target !== "new" || value.workingDirectory.length > 0, { message: "新会话需要指定工作目录。" });
