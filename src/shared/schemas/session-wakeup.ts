import { z } from "zod";

export const sessionWakeupInputSchema = z.object({
  id: z.string().uuid().optional(),
  sessionId: z.string().trim().uuid({ message: "请输入有效的会话 UUID。" }),
  name: z.string().trim().max(100),
  enabled: z.boolean(),
  resumeGoal: z.boolean(),
  startsAt: z.number().int().nonnegative(),
  endsAt: z.number().int().positive().max(8_640_000_000_000_000),
  maxAttempts: z.number().int().min(1).max(100)
}).strict().refine((value) => value.endsAt > value.startsAt, { message: "结束时间必须晚于开始时间。" });
