import { z } from "zod";
import { isSensitiveHeaderName, usesInsecureRemoteTransport } from "../security/upstream";

const httpUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "只支持 HTTP 或 HTTPS 地址");

const headerMap = z.record(z.string().trim().min(1).max(128), z.string().max(4096));
const publicHeaderMap = headerMap.superRefine((headers, context) => {
  for (const name of Object.keys(headers)) {
    if (isSensitiveHeaderName(name)) {
      context.addIssue({
        code: "custom",
        message: `请求头 ${name} 可能包含凭据，请改放到加密请求头。`
      });
    }
  }
});
const modelPricing = z.object({
  inputPerMillion: z.number().finite().nonnegative().max(1_000_000),
  cachedInputPerMillion: z.number().finite().nonnegative().max(1_000_000),
  outputPerMillion: z.number().finite().nonnegative().max(1_000_000)
}).strict();

export const saveResponsesApiUpstreamSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(80),
  baseUrl: httpUrl,
  apiKey: z.string().trim().min(1).optional(),
  enabled: z.boolean(),
  supportsWebSocket: z.boolean(),
  compactAdaptEnabled: z.boolean().optional(),
  balanceQueryType: z.enum(["none", "deepseek"]),
  publicHeaders: publicHeaderMap.optional(),
  secretHeaders: headerMap.optional(),
  modelCatalogJson: z.string().trim().min(2).max(4 * 1024 * 1024),
  modelPricing: z.record(z.string().trim().min(1).max(200), modelPricing)
}).strict().superRefine((input, context) => {
  const hasCredentials = Boolean(input.apiKey || (input.secretHeaders && Object.keys(input.secretHeaders).length > 0));
  if (hasCredentials && usesInsecureRemoteTransport(input.baseUrl)) {
    context.addIssue({
      code: "custom",
      path: ["baseUrl"],
      message: "携带 API Key 或机密请求头的远程上游必须使用 HTTPS；HTTP 仅允许回环地址。"
    });
  }
});

export type SaveResponsesApiUpstream = z.infer<typeof saveResponsesApiUpstreamSchema>;
