import { contextBridge, ipcRenderer } from "electron";
import type {
  ConsumeResetCreditResult,
  PublicAccount,
  LoginStartResult,
  LoginStatus,
  UsageRefreshResult
} from "../shared/contracts/accounts";
import type { BootstrapData } from "../shared/contracts/bootstrap";
import type { SessionWakeupInput } from "../shared/contracts/session-wakeup";
import type { ScheduledTaskInput } from "../shared/contracts/scheduled-tasks";
import type { IpcChannel, IpcContract } from "../shared/contracts/ipc";
import type { AppLogPage, LogQuery, RequestLogPage, RequestLogModels, TokenSummary } from "../shared/contracts/logs";
import type { ServiceStatus, Settings } from "../shared/contracts/settings";
import type {
  BalanceRefreshResult,
  BundledModelOverride,
  GatewayModelSummary,
  ModelManagementInput,
  ModelManagementItem,
  ModelPricing,
  SaveResponsesApiUpstreamInput,
  UpstreamHealthResult,
  UpstreamInvocationTestResult,
  UpstreamModel,
  UpstreamSummary
} from "../shared/contracts/upstreams";

type DataChangedListener = (types: string[]) => void;
type StatusChangedListener = (status: ServiceStatus) => void;
interface ClearResult { deleted: number }
interface ApplyAuthResult { providerChanged?: boolean; providerRemoved?: boolean }

const invoke = <Channel extends IpcChannel>(
  channel: Channel,
  ...args: IpcContract[Channel]["args"]
): Promise<IpcContract[Channel]["result"]> => ipcRenderer.invoke(channel, ...args);

const onStatusChanged = (channel: string, callback: StatusChangedListener): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, status: unknown): void => callback(status as ServiceStatus);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api = {
  listScheduledTasks: () => invoke("scheduledTasks:list"),
  saveScheduledTask: (input: ScheduledTaskInput) => invoke("scheduledTasks:save", input),
  setScheduledTaskEnabled: (id: string, enabled: boolean) => invoke("scheduledTasks:setEnabled", id, enabled),
  deleteScheduledTask: (id: string) => invoke("scheduledTasks:delete", id),
  listSessionWakeups: () => invoke("sessionWakeups:list"),
  saveSessionWakeup: (input: SessionWakeupInput) => invoke("sessionWakeups:save", input),
  setSessionWakeupEnabled: (id: string, enabled: boolean) => invoke("sessionWakeups:setEnabled", id, enabled),
  deleteSessionWakeup: (id: string) => invoke("sessionWakeups:delete", id),
  bootstrap: (): Promise<BootstrapData> => invoke("app:bootstrap"),
  listSystemFonts: (): Promise<string[]> => invoke("app:listSystemFonts"),
  saveSettings: (patch: Record<string, unknown>): Promise<Settings> => invoke("settings:save", patch),
  setAccountEnabled: (id: string, enabled: boolean): Promise<PublicAccount[]> => invoke("accounts:setEnabled", id, enabled),
  deleteAccount: (id: string): Promise<PublicAccount[]> => invoke("accounts:delete", id),
  listAccounts: (): Promise<PublicAccount[]> => invoke("accounts:list"),
  listUpstreams: (): Promise<UpstreamSummary[]> => invoke("upstreams:list"),
  listUpstreamModels: (upstreamId: string): Promise<UpstreamModel[]> => invoke("upstreams:models", upstreamId),
  listGatewayModels: (): Promise<GatewayModelSummary[]> => invoke("upstreams:gatewayModels"),
  saveUpstream: (input: SaveResponsesApiUpstreamInput): Promise<UpstreamSummary> => invoke("upstreams:save", input),
  deleteUpstream: (upstreamId: string): Promise<{ deleted: boolean; id: string }> => invoke("upstreams:delete", upstreamId),
  refreshUpstreamBalance: (upstreamId: string): Promise<BalanceRefreshResult> => invoke("upstreams:refreshBalance", upstreamId),
  getBundledModelOverride: (): Promise<BundledModelOverride> => invoke("upstreams:bundledOverride"),
  saveBundledModelOverride: (input: BundledModelOverride) => invoke("upstreams:saveBundledOverride", input),
  refreshBuiltinModels: () => invoke("upstreams:refreshBuiltinModels"),
  getModelManagement: (): Promise<ModelManagementItem[]> => invoke("upstreams:modelManagement"),
  saveModelManagement: (models: ModelManagementInput[]) => invoke("upstreams:saveModelManagement", models),
  saveUpstreamModelPricing: (upstreamId: string, pricing: Record<string, ModelPricing>): Promise<UpstreamModel[]> => invoke("upstreams:saveModelPricing", upstreamId, pricing),
  testUpstreamConnection: (upstreamId: string): Promise<UpstreamHealthResult> => invoke("upstreams:testConnection", upstreamId),
  testUpstreamInvocation: (upstreamId: string, modelId: string): Promise<UpstreamInvocationTestResult> => invoke("upstreams:testInvocation", upstreamId, modelId),
  refreshUsage: (id: string): Promise<unknown> => invoke("accounts:refreshUsage", id),
  refreshSubscription: (id: string): Promise<PublicAccount> => invoke("accounts:refreshSubscription", id),
  refreshAllUsage: (): Promise<UsageRefreshResult[]> => invoke("accounts:refreshAllUsage"),
  consumeResetCredit: (id: string, creditId?: string): Promise<ConsumeResetCreditResult> => invoke("accounts:consumeResetCredit", id, creditId),
  importLocalCodexAccount: (): Promise<PublicAccount> => invoke("accounts:importLocalCodex"),
  listTokenLogs: (query: LogQuery): Promise<RequestLogPage> => invoke("tokens:list", query),
  listTokenLogModels: (): Promise<RequestLogModels> => invoke("tokens:models"),
  tokenSummary: (query?: LogQuery): Promise<TokenSummary> => invoke("tokens:summary", query),
  quotaSummary: (): Promise<BootstrapData["quotaSummary"]> => invoke("quota:summary"),
  clearTokenLogs: (): Promise<ClearResult> => invoke("tokens:clear"),
  listAppLogs: (query: LogQuery): Promise<AppLogPage> => invoke("appLogs:list", query),
  clearAppLogs: (): Promise<ClearResult> => invoke("appLogs:clear"),
  startGateway: (): Promise<ServiceStatus> => invoke("gateway:start"),
  stopGateway: (): Promise<ServiceStatus> => invoke("gateway:stop"),
  startMcpGateway: (): Promise<ServiceStatus> => invoke("mcpGateway:start"),
  stopMcpGateway: (): Promise<ServiceStatus> => invoke("mcpGateway:stop"),
  applyGatewayAuth: (): Promise<ApplyAuthResult> => invoke("codexAuth:applyGatewayMode"),
  applyAccountAuth: (accountId: string, useApiProxy: boolean): Promise<ApplyAuthResult> => invoke("codexAuth:applyAccountMode", accountId, useApiProxy),
  startLogin: (): Promise<LoginStartResult> => invoke("auth:startLogin"),
  loginStatus: (loginId: string): Promise<LoginStatus> => invoke("auth:status", loginId),
  cancelLogin: (loginId: string): Promise<{ cancelled: boolean }> => invoke("auth:cancelLogin", loginId),
  onGatewayStatusChanged: (callback: StatusChangedListener) => onStatusChanged("gateway:status-changed", callback),
  onMcpGatewayStatusChanged: (callback: StatusChangedListener) => onStatusChanged("mcpGateway:status-changed", callback),
  onDataChanged: (callback: DataChangedListener) => {
    const listener = (_event: Electron.IpcRendererEvent, types: string[]): void => callback(types);
    ipcRenderer.on("app:data-changed", listener);
    return () => ipcRenderer.removeListener("app:data-changed", listener);
  }
};

contextBridge.exposeInMainWorld("codexGateway", api);

export type CodexGatewayBridge = typeof api;
