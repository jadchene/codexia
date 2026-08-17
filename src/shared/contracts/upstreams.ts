export type UpstreamKind = "chatgpt_subscription_pool" | "responses_api";
export type UpstreamHealthStatus = "unknown" | "healthy" | "unhealthy";
export type BalanceQueryType = "none" | "deepseek";

export interface ModelPricing {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

export interface SecretHeaderSummary {
  name: string;
  fingerprint: string;
}

export interface BalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface UpstreamBalance {
  available: boolean | null;
  infos: BalanceInfo[];
  summary: string | null;
  checkedAt: number | null;
  error: string | null;
  subscriptionPool: {
    totalAccounts: number;
    enabledAccounts: number;
    availableAccounts: number;
    quotaCapacityPercent: number;
    fiveHourRemainingPercent: number | null;
    sevenDayRemainingPercent: number;
    resetCredits: number;
  } | null;
}

export interface UpstreamSummary {
  id: string;
  name: string;
  kind: UpstreamKind;
  enabled: boolean;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyFingerprint: string | null;
  supportsWebSocket: boolean;
  compactAdaptEnabled: boolean;
  publicHeaders: Record<string, string>;
  secretHeaders: SecretHeaderSummary[];
  balanceQueryType: BalanceQueryType;
  balance: UpstreamBalance;
  healthStatus: UpstreamHealthStatus;
  healthCheckedAt: number | null;
  healthLatencyMs: number | null;
  healthMessage: string | null;
  modelCount: number;
  lastSyncedAt: number | null;
}

export interface SaveResponsesApiUpstreamInput {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
  supportsWebSocket: boolean;
  compactAdaptEnabled: boolean;
  balanceQueryType: BalanceQueryType;
  publicHeaders?: Record<string, string>;
  secretHeaders?: Record<string, string>;
  modelCatalogJson: string;
  modelPricing: Record<string, ModelPricing>;
}

export interface UpstreamModel {
  modelId: string;
  displayName: string;
  available: boolean;
  source: string;
  metadata: Record<string, unknown>;
  pricing: ModelPricing;
  lastSeenAt: number | null;
  lastSyncedAt: number | null;
}

export interface GatewayModelSummary {
  modelId: string;
  displayName: string;
  upstreamId: string;
  upstreamName: string;
}

export interface BundledModelOverride {
  enabled: boolean;
  modelCatalogJson: string;
}

export interface ModelCatalogBuildResult {
  path: string;
  bundledCachePath: string;
  bundledSource: "cli" | "cache" | "override";
  bundledCount: number;
  externalCount: number;
  totalCount: number;
}

export interface SaveBundledModelOverrideResult {
  override: BundledModelOverride;
  catalog: ModelCatalogBuildResult;
}

export interface ModelCatalogSaveResult {
  upstreamId: string;
  count: number;
  savedAt: number;
  models: UpstreamModel[];
}

export interface UpstreamHealthResult {
  upstreamId: string;
  status: Exclude<UpstreamHealthStatus, "unknown">;
  checkedAt: number;
  latencyMs: number;
  message: string;
}

export interface UpstreamInvocationTestResult {
  upstreamId: string;
  endpoint: string;
  modelId: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  responseId: string | null;
  outputPreview: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  message: string;
}

export interface BalanceRefreshResult extends UpstreamBalance {
  upstreamId: string;
}
