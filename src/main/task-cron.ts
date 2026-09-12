import { CronExpressionParser } from "cron-parser";

const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const validateTaskCron = (cron: string): void => {
  if (cron.trim().split(/\s+/).length !== 5) throw new Error("Cron 需要五段：分、时、日、月、周。例如每小时执行：0 * * * *。");
  try {
    CronExpressionParser.parse(cron, { tz: localTimezone(), hashSeed: "codexia" });
  } catch {
    throw new Error("Cron 表达式无效，请检查取值范围和格式。");
  }
};

export const nextTaskRunAt = (cron: string, startsAt: number, endsAt: number, after: number, timezone = localTimezone()): number => {
  if (after >= endsAt) return 0;
  try {
    const next = CronExpressionParser.parse(cron, {
      currentDate: Math.max(after, startsAt - 1), endDate: endsAt - 1, tz: timezone, hashSeed: "codexia"
    }).next().getTime();
    return next >= startsAt && next < endsAt ? next : 0;
  } catch { return 0; }
};
