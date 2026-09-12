export interface SessionWakeupInput {
  id?: string;
  sessionId: string;
  name: string;
  enabled: boolean;
  resumeGoal: boolean;
  startsAt: number;
  endsAt: number;
  maxAttempts: number;
}

export type SessionWakeupStatus = "armed" | "waiting" | "checking" | "waking" | "awakened" | "expired" | "exhausted" | "failed" | "skipped";

export interface SessionWakeup extends SessionWakeupInput {
  id: string;
  revision: string;
  status: SessionWakeupStatus;
  attempts: number;
  nextAttemptAt: number;
  lastAttemptAt: number;
  message: string;
}
