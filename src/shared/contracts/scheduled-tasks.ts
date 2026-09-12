export interface ScheduledTaskInput {
  id?: string;
  name: string;
  target: "existing" | "new";
  sessionId: string;
  workingDirectory: string;
  message: string;
  cron: string;
  startsAt: number;
  endsAt: number;
  enabled: boolean;
}

export type ScheduledTaskStatus = "scheduled" | "running" | "sent" | "completed" | "failed" | "expired" | "idle" | "interrupted";

export interface ScheduledTask extends ScheduledTaskInput {
  id: string;
  revision: string;
  status: ScheduledTaskStatus;
  nextRunAt: number;
  lastRunAt: number;
  lastSessionId: string;
  runCount: number;
  result: string;
}
