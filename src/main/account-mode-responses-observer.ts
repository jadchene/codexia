import type { IncomingMessage } from "node:http";
import type { RawData } from "ws";
import type { Settings } from "../shared/contracts/settings";
import type { ModelPricing } from "../shared/contracts/upstreams";
import { extractTokenUsage, emptyUsage, type TokenUsage } from "./gateway/usage-parser.ts";
import { buildResponsesRequestLog } from "./responses-request-log.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

interface ResponsesObserverStore {
  addTokenLog: (entry: Record<string, unknown>) => unknown;
}

interface ResponsesObserverOptions {
  store: ResponsesObserverStore;
  accountId: string;
  request: IncomingMessage;
  requestPath: string;
  upstreamPath: string;
  settings: Settings;
  getModelPricing?: ((modelId: string) => ModelPricing | null | undefined) | undefined;
  onIdleTimeout: () => void;
}

interface CurrentRequest {
  startedAt: number;
  prewarm: boolean;
  clientModel: string;
  upstreamModel: string;
  usage: TokenUsage;
}

type JsonEvent = Record<string, any>;

/**
 * 旁路观察账号模式 Responses WebSocket，不包含额度和路由副作用。
 */
export const createAccountModeResponsesObserver = (options: ResponsesObserverOptions) => {
  let currentRequest: CurrentRequest | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const armIdleTimer = (): void => {
    clearIdleTimer();
    idleTimer = setTimeout(options.onIdleTimeout, positiveInteger(options.settings.gateway_websocket_idle_timeout_ms, DEFAULT_IDLE_TIMEOUT_MS));
  };

  const finish = (status: number, message: string | null): void => {
    if (!currentRequest) return;
    clearIdleTimer();
    options.store.addTokenLog(buildResponsesRequestLog({
      account: options.accountId ? { id: options.accountId } : null,
      target: null,
      method: "WS",
      requestPath: options.requestPath,
      upstreamPath: options.upstreamPath,
      headers: options.request.headers,
      status,
      durationMs: Date.now() - currentRequest.startedAt,
      usage: currentRequest.usage,
      settings: options.settings,
      clientModel: currentRequest.clientModel,
      upstreamModel: currentRequest.upstreamModel,
      modelPricing: options.getModelPricing?.(currentRequest.upstreamModel || currentRequest.clientModel),
      message: currentRequest.prewarm
        ? ["WebSocket prewarm", message].filter(Boolean).join(": ")
        : message
    }));
    currentRequest = null;
  };

  return {
    onDownstreamMessage(data: RawData, isBinary: boolean): void {
      if (isBinary) return;
      const event = parseJson(data);
      if (event?.type !== "response.create") return;
      const model = modelFromEvent(event);
      currentRequest = {
        startedAt: Date.now(),
        prewarm: event.generate === false,
        clientModel: model,
        upstreamModel: model,
        usage: emptyUsage()
      };
      armIdleTimer();
    },
    onUpstreamMessage(data: RawData, isBinary: boolean): void {
      if (!currentRequest) return;
      armIdleTimer();
      if (isBinary) return;
      const event = parseJson(data);
      if (!event) return;
      const model = modelFromEvent(event);
      if (model) {
        currentRequest.clientModel ||= model;
        currentRequest.upstreamModel ||= model;
      }
      const usage = extractTokenUsage(data);
      if (hasUsage(usage)) currentRequest.usage = usage;
      if (event.type === "response.completed") finish(200, null);
      else if (event.type === "error" || event.type === "response.failed") finish(errorStatus(event), errorMessage(event));
    },
    onClose(code: number, reason: Buffer): void {
      if (!currentRequest) return;
      const message = `WebSocket closed before response completion (${code}${reason.length ? `: ${reason.toString()}` : ""})`;
      finish(code === 1000 ? 499 : 502, message);
    },
    dispose: clearIdleTimer
  };
};

const parseJson = (data: RawData): JsonEvent | null => {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  } catch {
    return null;
  }
};

const modelFromEvent = (event: JsonEvent): string => {
  const response = event.response && typeof event.response === "object" ? event.response : {};
  return String(event.model || response.model || "").trim();
};

const hasUsage = (usage: TokenUsage): boolean => Object.values(usage).some((value) => value > 0);

const errorStatus = (event: JsonEvent): number => {
  const value = Number(event.status || event.status_code || event.error?.status || event.error?.status_code);
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500;
};

const errorMessage = (event: JsonEvent): string => String(
  event.error?.message || event.message || event.error?.code || event.code || "WebSocket response failed."
).slice(0, 1000);

const positiveInteger = (value: unknown, fallback: number): number => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
};
