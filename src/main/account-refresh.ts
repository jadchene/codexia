import { subscriptionFromTokens } from "./auth.ts";
import { normalizeUsagePayload, normalizeResetCreditsPayload } from "./quota.ts";
import { readCodexOwnedAccountTokens } from "./codex-cli-auth.ts";
import type { createStore } from "./store.ts";

export type AccountRefreshKind = "all" | "usage" | "token";
type Account = ReturnType<ReturnType<typeof createStore>["listAccounts"]>[number];

/** Shared by the desktop and offline CLI; one refresh operation per account at a time. */
export function createAccountRefreshService(options: {
  store: ReturnType<typeof createStore>;
  codexOptions: { codexDir?: string };
  fetch?: typeof fetch;
  onUsageRefreshed?: (account: Account) => void;
}) {
  const { store, codexOptions } = options;
  const fetcher = options.fetch || globalThis.fetch;
  const pending = new Map<string, Promise<unknown>>();
  const accountById = (id: string) => {
    const account = store.listAccounts().find((item) => item.id === id);
    if (!account) throw new Error("账号不存在或已删除。");
    return account;
  };
  const timeout = () => {
    const configured = Number(store.getSettings().usage_refresh_timeout_ms);
    return Number.isFinite(configured) ? Math.max(1000, Math.min(300000, Math.trunc(configured))) : 20000;
  };
  function serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const task = (pending.get(id) || Promise.resolve()).catch(() => {}).then(operation);
    pending.set(id, task);
    void task.finally(() => { if (pending.get(id) === task) pending.delete(id); }).catch(() => {});
    return task;
  }
  function ownedTokens(account: Account) {
    return readCodexOwnedAccountTokens(account as Parameters<typeof readCodexOwnedAccountTokens>[0], store.getSettings(),
      store.listAccounts() as Parameters<typeof readCodexOwnedAccountTokens>[2], codexOptions);
  }
  function syncAccount(account: Account): Account {
    const tokens = ownedTokens(account);
    return tokens ? store.saveAccount({ ...accountById(account.id), ...tokens }) : account;
  }
  async function refreshToken(id: string, subscription: boolean): Promise<Account> {
    const account = accountById(id);
    const owned = ownedTokens(account);
    if (owned) return store.saveAccount({ ...accountById(id), ...owned, ...(subscription ? subscriptionFromTokens(owned) : {}) });
    if (!account.refresh_token) throw new Error("账号缺少 refresh token，请重新登录。");
    const response = await fetcher("https://auth.openai.com/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann", grant_type: "refresh_token", refresh_token: account.refresh_token }),
      signal: AbortSignal.timeout(timeout())
    });
    if (!response.ok) throw new Error(`刷新 token 失败：HTTP ${response.status}`);
    const data = await response.json();
    if (!data || typeof data.access_token !== "string" || !data.access_token) throw new Error("刷新 token 返回的认证信息无效。");
    const tokens = { access_token: data.access_token, refresh_token: data.refresh_token || account.refresh_token,
      id_token: data.id_token || account.id_token, last_refresh: new Date().toISOString() };
    return store.saveAccount({ ...accountById(id), ...tokens, ...(subscription ? subscriptionFromTokens(tokens) : {}) });
  }
  async function requestJson(endpoint: string, account: Account) {
    const response = await fetcher(endpoint, {
      headers: { authorization: `Bearer ${account.access_token}`, "ChatGPT-Account-Id": account.account_id || account.workspace_id || "",
        accept: "application/json", "user-agent": "codex_cli_rs/0.136.0", origin: "https://chatgpt.com", referer: "https://chatgpt.com/" },
      signal: AbortSignal.timeout(timeout())
    });
    if (!response.ok) throw Object.assign(new Error(`额度查询失败：HTTP ${response.status}`), { status: response.status });
    return response.json();
  }
  async function refreshUsage(id: string): Promise<Account> {
    for (let attempt = 0; ; attempt++) {
      const account = syncAccount(accountById(id));
      try {
        const [usage, credits] = await Promise.all([
          requestJson("https://chatgpt.com/backend-api/wham/usage", account),
          requestJson("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", account)
        ]);
        accountById(id); // Do not resurrect an account deleted during the requests.
        store.updateUsage(id, { ...normalizeUsagePayload(usage), ...normalizeResetCreditsPayload(credits) });
        const saved = accountById(id);
        options.onUsageRefreshed?.(saved);
        return saved;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (attempt || ![401, 403].includes(status || 0) || !account.refresh_token) throw error;
        await refreshToken(id, false); // For Codex-owned accounts this only reloads auth.json.
      }
    }
  }
  return {
    syncAccount,
    refreshToken: (id: string, subscription = true) => serial(id, () => refreshToken(id, subscription)),
    refreshUsage: (id: string) => serial(id, () => refreshUsage(id)),
    refresh: (id: string, kind: AccountRefreshKind) => serial(id, async () => {
      if (kind !== "usage") await refreshToken(id, true);
      return kind === "token" ? accountById(id) : refreshUsage(id);
    })
  };
}
