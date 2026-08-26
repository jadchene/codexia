import { z } from "zod";
import type { IpcChannel } from "../contracts/ipc";
import { saveResponsesApiUpstreamSchema } from "./upstreams";

const id = z.string().trim().min(1).max(256);
const empty = z.tuple([]);
const pricing = z.object({
  inputPerMillion: z.number().finite().nonnegative().max(1_000_000),
  cachedInputPerMillion: z.number().finite().nonnegative().max(1_000_000),
  outputPerMillion: z.number().finite().nonnegative().max(1_000_000)
}).strict();
const bundledModelOverride = z.object({
  enabled: z.boolean(),
  modelCatalogJson: z.string().max(16 * 1024 * 1024)
}).strict();
const modelManagement = z.array(z.object({
  slug: id,
  displayName: z.string().trim().min(1).max(256),
  visible: z.boolean()
}).strict()).max(1000).refine((models) => new Set(models.map((model) => model.slug)).size === models.length);
const logQuery = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(500),
  startAt: z.number().finite(),
  endAt: z.number().finite(),
  accountId: z.string().optional(),
  upstreamId: z.string().optional(),
  clientModel: z.string().optional(),
  upstreamModel: z.string().optional(),
  sessionId: z.string().optional(),
  status: z.string().optional(),
  keyword: z.string().optional(),
  level: z.string().optional(),
  scope: z.string().optional()
}).strict();
export const ipcArgumentSchemas = {
  "app:bootstrap": empty,
  "settings:save": z.tuple([z.record(z.string(), z.unknown())]),
  "accounts:setEnabled": z.tuple([id, z.boolean()]),
  "accounts:delete": z.tuple([id]),
  "accounts:list": empty,
  "upstreams:list": empty,
  "upstreams:models": z.tuple([id]),
  "upstreams:gatewayModels": empty,
  "upstreams:save": z.tuple([saveResponsesApiUpstreamSchema]),
  "upstreams:delete": z.tuple([id]),
  "upstreams:refreshBalance": z.tuple([id]),
  "upstreams:bundledOverride": empty,
  "upstreams:saveBundledOverride": z.tuple([bundledModelOverride]),
  "upstreams:refreshBuiltinModels": empty,
  "upstreams:modelManagement": empty,
  "upstreams:saveModelManagement": z.tuple([modelManagement]),
  "upstreams:saveModelPricing": z.tuple([id, z.record(id, pricing)]),
  "upstreams:testConnection": z.tuple([id]),
  "upstreams:testInvocation": z.tuple([id, id]),
  "tokens:list": z.tuple([logQuery]),
  "tokens:summary": z.tuple([logQuery.optional()]),
  "quota:summary": empty,
  "tokens:clear": empty,
  "appLogs:list": z.tuple([logQuery]),
  "appLogs:clear": empty,
  "gateway:start": empty,
  "gateway:stop": empty,
  "mcpGateway:start": empty,
  "mcpGateway:stop": empty,
  "codexAuth:applyGatewayMode": empty,
  "codexAuth:applyAccountMode": z.tuple([id]),
  "auth:startLogin": empty,
  "auth:status": z.tuple([id]),
  "auth:cancelLogin": z.tuple([id]),
  "accounts:refreshUsage": z.tuple([id]),
  "accounts:refreshAllUsage": empty,
  "accounts:consumeResetCredit": z.tuple([id, id.optional()]),
  "accounts:importLocalCodex": empty
} satisfies Record<IpcChannel, z.ZodType>;
