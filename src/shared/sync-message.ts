/** Local directory synchronization envelope. Timestamps are Unix milliseconds. */
export interface SyncMessage<T = unknown> {
  version: 1;
  id: string;
  type: string;
  targetInstanceId: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "applying" | "failed";
  payload: T;
  error?: { code: string; message: string };
}

export const ACCESS_MODE_SYNC_TYPE = "access-mode.apply";
