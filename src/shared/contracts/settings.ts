export type Settings = Record<string, string>;

export interface RuntimePaths {
  dataDir: string;
  dbPath: string;
}

export interface ServiceStatus {
  running: boolean;
  installed?: boolean;
  url?: string;
  command?: string;
  error?: string;
  activeHttpRequests?: number;
  activeWebSockets?: number;
}

export interface IpGuardStatus {
  enabled: boolean;
  allowedIp: string;
  currentIp: string;
  checkedAt: number | null;
  error: string;
  matched: boolean;
}
