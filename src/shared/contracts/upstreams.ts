export type UpstreamKind = "chatgpt_subscription_pool" | "responses_api";
type UpstreamHealthStatus = "unknown" | "healthy" | "unhealthy";
export type BalanceQueryType = "none" | "deepseek";

export interface ModelPricing {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

interface SecretHeaderSummary {
  name: string;
  fingerprint: string;
}

interface BalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

interface UpstreamBalance {
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
  /** API 渠道类型；旧配置默认为自定义渠道。 */
  provider?: "custom" | "openai";
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
  /** 官方渠道自动填充连接信息并复用内置目录。 */
  provider?: "custom" | "openai";
  id?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  supportsWebSocket?: boolean;
  compactAdaptEnabled?: boolean;
  balanceQueryType?: BalanceQueryType;
  publicHeaders?: Record<string, string>;
  secretHeaders?: Record<string, string>;
  modelCatalogJson?: string;
  modelPricing?: Record<string, ModelPricing>;
}

export interface UpstreamModel {
  modelId: string;
  displayName: string;
  available: boolean;
  source: string;
  metadata: Record<string, unknown>;
  pricing: ModelPricing;
  /** 未配置时不能把缺少的费率当作免费。 */
  pricingConfigured?: boolean;
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
  bundledSource: "cli" | "cache" | "override" | "remote" | "remote-cache";
  /** 远程获取失败后使用本地目录的原因。 */
  refreshWarning?: string;
  bundledCount: number;
  externalCount: number;
  totalCount: number;
}

export interface ModelManagementInput {
  slug: string;
  displayName: string;
  visible: boolean;
}

export interface ModelManagementItem extends ModelManagementInput {
  sourceDisplayName: string;
  priority: number;
}

export interface SaveModelManagementResult {
  models: ModelManagementItem[];
  catalog: ModelCatalogBuildResult;
}

export interface SaveBundledModelOverrideResult {
  override: BundledModelOverride;
  catalog: ModelCatalogBuildResult;
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
