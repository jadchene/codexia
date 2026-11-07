interface RefreshAccount {
  id: string;
  email?: string;
  name?: string;
  enabled?: boolean;
  access_token?: string;
}

interface RefreshResult {
  id: string;
  label: string;
  kind?: "account" | "balance";
  ok: boolean;
  message?: string;
}

interface BalanceRefreshTarget {
  id: string;
  name?: string;
}

interface RefreshCoordinatorOptions {
  listAccounts: () => RefreshAccount[];
  refreshAccount: (id: string) => Promise<unknown>;
  listBalanceUpstreams?: () => BalanceRefreshTarget[];
  refreshBalance?: (id: string) => Promise<unknown>;
  saveSettings: (patch: Record<string, unknown>) => unknown;
  addLog: (entry: Record<string, unknown>) => unknown;
  compactError: (value: unknown) => string;
  now: () => number;
  concurrency?: number;
}

export function createUsageRefreshCoordinator(options: RefreshCoordinatorOptions): {
  refreshAll: (reason?: string) => Promise<RefreshResult[]>;
} {
  let inFlight: Promise<RefreshResult[]> | null = null;

  const refreshAll = (reason = "manual"): Promise<RefreshResult[]> => {
    if (inFlight) return inFlight;
    inFlight = perform(reason).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const perform = async (reason: string): Promise<RefreshResult[]> => {
    const accounts = options.listAccounts().filter((account) => account.enabled && account.access_token);
    const balanceUpstreams = options.listBalanceUpstreams ? options.listBalanceUpstreams() : [];
    const targets: Array<{ kind: "account" | "balance"; id: string; label: string }> = [
      ...accounts.map((account) => ({
        kind: "account" as const,
        id: account.id,
        label: account.email || account.name || account.id
      })),
      ...balanceUpstreams.map((upstream) => ({
        kind: "balance" as const,
        id: upstream.id,
        label: upstream.name || upstream.id
      }))
    ];
    const results = await mapWithConcurrency(targets, options.concurrency || 3, async (target) => {
      try {
        if (target.kind === "account") {
          await options.refreshAccount(target.id);
        } else {
          await options.refreshBalance!(target.id);
        }
        return { id: target.id, label: target.label, kind: target.kind, ok: true };
      } catch (error) {
        return { id: target.id, label: target.label, kind: target.kind, ok: false, message: errorMessage(error) };
      }
    });
    const okCount = results.filter((item) => item.ok).length;
    const accountOk = results.filter((item) => item.kind === "account" && item.ok).length;
    const accountTotal = results.filter((item) => item.kind === "account").length;
    const balanceOk = results.filter((item) => item.kind === "balance" && item.ok).length;
    const balanceTotal = results.filter((item) => item.kind === "balance").length;
    const failed = results.filter((item) => !item.ok);
    const detail = failed.length > 0
      ? `；失败：${failed.map((item) => `${item.label}: ${options.compactError(item.message)}`).join(" | ")}`
      : "";
    const summaryParts = [];
    if (accountTotal > 0) summaryParts.push(`账号额度 ${accountOk}/${accountTotal}`);
    if (balanceTotal > 0) summaryParts.push(`渠道余额 ${balanceOk}/${balanceTotal}`);
    const summary = summaryParts.length > 0 ? summaryParts.join("，") : "无待刷新项";
    options.addLog({
      scope: "usage",
      action: "refresh-all",
      status: failed.length === 0 && results.length > 0 ? "success" : failed.length < results.length ? "partial" : "failed",
      message: `${reason}: ${summary}${detail}`
    });
    if (results.length > 0 && okCount > 0) {
      options.saveSettings({ last_usage_refresh_all_at: Math.floor(options.now() / 1000) });
    }
    return results;
  };

  return { refreshAll };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
