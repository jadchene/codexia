import { pickGatewayAccount, type GatewayAccount } from "../selection.ts";
import { readCodexVersion } from "../subscription-models.ts";
import type { UpstreamHealthResult, UpstreamInvocationTestResult } from "../../shared/contracts/upstreams";

/** 账号池测试依赖。@author chenjd @created 2026-11-04 10:00:00 */
interface SubscriptionTestOptions {
  /** 读取已解密账号。 */
  listAccounts: () => GatewayAccount[];
  /** 获取当前额度策略。 */
  ignoreFiveHourLimit: () => boolean;
  /** 刷新过期的账号令牌。 */
  refreshAccount: (id: string) => Promise<GatewayAccount>;
  /** 测试可替换的网络客户端。 */
  fetch?: typeof fetch;
  /** 读取实际 Codex 版本。 */
  getClientVersion?: () => Promise<string>;
}

/** 直接检测订阅接口，不经过本地网关的渠道路由。 */
export const createSubscriptionTests = (options: SubscriptionTestOptions) => {
  const upstreamId = "builtin-chatgpt-subscription-pool";
  const baseUrl = "https://chatgpt.com/backend-api/codex";
  const fetchImpl = options.fetch || globalThis.fetch;
  const request = async (modelId?: string) => {
    let account = pickGatewayAccount(options.listAccounts(), "", [], { ignoreFiveHourLimit: options.ignoreFiveHourLimit() });
    if (!account) throw new Error("账号池没有可用账号，请检查账号启用状态和额度。");
    const version = await (options.getClientVersion || readCodexVersion)();
    const endpoint = modelId ? `${baseUrl}/responses` : `${baseUrl}/models?client_version=${encodeURIComponent(version)}`;
    const signal = AbortSignal.timeout(modelId ? 30_000 : 15_000);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetchImpl(endpoint, {
        method: modelId ? "POST" : "GET", redirect: "error", signal,
        headers: {
          Authorization: `Bearer ${account.access_token}`,
          "ChatGPT-Account-Id": String(account.account_id || account.workspace_id || ""),
          "User-Agent": `codex_cli_rs/${version}`, originator: "codex_cli_rs",
          Accept: modelId ? "text/event-stream" : "application/json", "Content-Type": "application/json"
        },
        ...(modelId ? { body: JSON.stringify({ model: modelId, instructions: "Reply with exactly OK.",
          input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly OK." }] }],
          stream: true, store: false }) } : {})
      });
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        account = await options.refreshAccount(account.id);
        continue;
      }
      return { response, endpoint };
    }
    throw new Error("账号认证失败，请重新登录。");
  };
  return {
    /** 连接延迟统计到响应头，不产生模型调用。 */
    connection: async (): Promise<UpstreamHealthResult> => {
      const started = Date.now();
      let status: UpstreamHealthResult["status"] = "unhealthy";
      let message: string;
      try {
        const { response } = await request();
        await response.body?.cancel();
        status = response.ok ? "healthy" : "unhealthy";
        message = response.ok ? "连接成功" : `连接返回 HTTP ${response.status}`;
      } catch (error) {
        message = error instanceof Error ? error.message : "连接检查失败";
      }
      return { upstreamId, status, checkedAt: Date.now(), latencyMs: Date.now() - started, message };
    },
    /** 调用延迟统计到响应流结束，只有完成事件才视为成功。 */
    invocation: async (modelId: string): Promise<UpstreamInvocationTestResult> => {
      const started = Date.now();
      const { response, endpoint } = await request(modelId);
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (reader) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4 * 1024 * 1024) throw new Error("调用测试响应过大。");
          chunks.push(value);
        }
      } finally {
        await reader?.cancel().catch(() => {});
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let completed: Record<string, any> | undefined;
      let failure = "";
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          const event = JSON.parse(data);
          if (event.type === "response.completed") completed = event.response;
          if (["error", "response.failed", "response.incomplete"].includes(event.type)) failure = "订阅调用返回失败或未完成事件";
        } catch { /* 忽略非 JSON 事件，缺少完成事件时返回失败。 */ }
      }
      const ok = response.ok && Boolean(completed) && !failure;
      const usage = completed?.usage || {};
      return {
        upstreamId, endpoint, modelId, ok, status: response.status, latencyMs: Date.now() - started,
        responseId: completed?.id || null,
        outputPreview: (completed?.output || []).flatMap((item: any) => item.content || []).map((item: any) => item.text || "").join("").slice(0, 500),
        inputTokens: Number(usage.input_tokens || 0), outputTokens: Number(usage.output_tokens || 0), totalTokens: Number(usage.total_tokens || 0),
        message: ok ? "调用测试成功" : failure || (response.ok ? "响应未包含完成事件" : `调用返回 HTTP ${response.status}`)
      };
    }
  };
};
