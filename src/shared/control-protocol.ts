/** Extensible local IPC envelope. Protocol and application versions are independent. */
export const CONTROL_PROTOCOL_VERSION = 1;
export interface ControlRequest {
  version: number;
  appVersion: string;
  id: string;
  method: string;
  params?: unknown;
  token: string;
  instanceDirectory: string;
}
export interface ControlResponse {
  version: number;
  appVersion: string;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}
