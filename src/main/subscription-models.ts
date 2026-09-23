import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseCatalog } from "./codex-model-catalog.ts";

/** 模型目录请求所需的账号信息。@author chenjd @created 2026-09-23 10:00:00 */
export interface ModelAccount {
  /** 本地账号标识。 */
  id: string;
  /** 是否启用。 */
  enabled?: boolean;
  /** 账号状态。 */
  status?: string;
  /** 订阅类型。 */
  subscription_plan?: string;
  /** 同订阅等级的账号优先级，数值越小越优先。 */
  priority?: number;
  /** 官方访问令牌。 */
  access_token?: string;
  /** 官方账号标识。 */
  account_id?: string;
  /** 工作区标识。 */
  workspace_id?: string;
}

/** 远程目录获取依赖。@author chenjd @created 2026-09-23 10:00:00 */
interface SubscriptionModelsOptions {
  /** 每次刷新时读取当前账号池。 */
  listAccounts: () => ModelAccount[];
  /** 鉴权过期后刷新并保存账号令牌。 */
  refreshAccount: (id: string) => Promise<ModelAccount>;
  /** 可替换的 HTTP 客户端。 */
  fetch?: typeof fetch;
  /** 当前 Codex CLI 版本读取器。 */
  getClientVersion?: () => Promise<string>;
}

const PLAN_WEIGHTS: Record<string, number> = { pro: 5, prolite: 4, plus: 3, go: 2, free: 1 };

/** 按订阅等级选择目录账号，不受推理额度或当前会话账号影响。 */
export function orderModelAccounts(accounts: ModelAccount[]): ModelAccount[] {
  return accounts.filter((account) => account.enabled && account.status !== "disabled" && account.access_token)
    .sort((left, right) => {
      const weight = (account: ModelAccount) => PLAN_WEIGHTS[String(account.subscription_plan || "").toLowerCase()] || 0;
      return weight(right) - weight(left) || (left.priority ?? 100) - (right.priority ?? 100);
    });
}

/** 从最高订阅等级的账号拉取目录，鉴权重试后仍失败则依次换号。 */
export function createSubscriptionModelFetcher(options: SubscriptionModelsOptions): () => Promise<string> {
  const fetchImpl = options.fetch || globalThis.fetch;
  return async () => {
    const accounts = orderModelAccounts(options.listAccounts());
    if (accounts.length === 0) throw new Error("没有可用于获取模型目录的已启用 GPT 账号。");
    const version = await (options.getClientVersion || readCodexVersion)();
    const url = `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`;
    for (const original of accounts) {
      try {
        let account = original;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await fetchImpl(url, {
            headers: {
              authorization: `Bearer ${account.access_token}`,
              "ChatGPT-Account-Id": account.account_id || account.workspace_id || "",
              "user-agent": `codex_cli_rs/${version}`,
              accept: "application/json"
            },
            redirect: "error",
            signal: AbortSignal.timeout(15000)
          });
          if (response.status === 401 && attempt === 0) {
            await response.body?.cancel();
            account = await options.refreshAccount(account.id);
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`模型接口 HTTP ${response.status}`);
          }
          const raw = await response.text();
          if (raw.length > 16 * 1024 * 1024) throw new Error("远程模型目录过大。");
          const catalog = parseCatalog(raw, "远程模型目录");
          if (catalog.models.length === 0) throw new Error("远程模型目录为空。");
          return JSON.stringify(catalog);
        }
      } catch {
        // 不记录响应正文或令牌；单个账号失败后继续尝试低等级账号。
      }
    }
    throw new Error("GPT 账号池远程模型获取失败，请检查网络或账号登录状态。");
  };
}

/** 获取客户端真实版本，用于官方模型目录的版本协商。 */
async function readCodexVersion(): Promise<string> {
  const run = promisify(execFile);
  const { stdout } = process.platform === "win32"
    ? await run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "codex --version"], { windowsHide: true, timeout: 10000 })
    : await run("codex", ["--version"], { timeout: 10000 });
  const version = stdout.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0];
  if (!version) throw new Error("无法读取 Codex CLI 版本。");
  return version;
}
