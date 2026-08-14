export interface GatewayAccount {
  id: string;
  enabled?: boolean;
  status?: string;
  access_token?: string;
  priority?: number;
  quota_5h_used_percent?: number;
  quota_5h_reset_at?: number;
  quota_7d_used_percent?: number;
  quota_7d_reset_at?: number;
  [key: string]: unknown;
}
interface SelectionOptions {
  ignoreFiveHourLimit?: boolean;
  preferSevenDayQuota?: boolean;
  nowMs?: number;
  activeRequests?: Map<string, number>;
  cooldowns?: Map<string, number>;
}
interface IndexedAccount { account: GatewayAccount; index: number }

export function usableAccount(account: GatewayAccount | null | undefined, nowSeconds = Math.floor(Date.now() / 1000), options: SelectionOptions = {}): boolean {
  return Boolean(account
    && account.enabled
    && account.status !== "disabled"
    && account.access_token
    && !quotaWindowExhausted(account, nowSeconds, options));
}

export function quotaWindowExhausted(account: GatewayAccount, nowSeconds = Math.floor(Date.now() / 1000), options: SelectionOptions = {}): boolean {
  const windows: Array<[unknown, unknown]> = [[account.quota_7d_used_percent, account.quota_7d_reset_at]];
  if (!options.ignoreFiveHourLimit) {
    windows.unshift([account.quota_5h_used_percent, account.quota_5h_reset_at]);
  }
  return windows.some(([usedValue, resetValue]) => {
    const used = Number(usedValue);
    if (!Number.isFinite(used) || used < 99.9) return false;
    const resetAt = Number(resetValue);
    return !Number.isFinite(resetAt) || resetAt <= 0 || resetAt > nowSeconds;
  });
}

export function usageScore(account: GatewayAccount, options: SelectionOptions = {}): number {
  const windows = [account.quota_7d_used_percent];
  if (!options.ignoreFiveHourLimit) windows.push(account.quota_5h_used_percent);
  const values = windows
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) return 0;
  return Math.max(...values);
}

let lastSelectedAccountId = "";

export function pickGatewayAccount(accounts: GatewayAccount[], currentAccountId = "", excludeIds: string[] = [], options: SelectionOptions = {}): GatewayAccount | null {
  const excluded = new Set(excludeIds);
  const ignoreFiveHourLimit = options.ignoreFiveHourLimit === true;
  const candidates = accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => usableAccount(account, undefined, { ignoreFiveHourLimit }))
    .filter(({ account }) => !excluded.has(account.id));
  if (candidates.length === 0) return null;

  if (options.preferSevenDayQuota) {
    const picked = sortAccountsBySevenDayQuota(candidates, { ignoreFiveHourLimit }).at(0)?.account || null;
    if (picked) lastSelectedAccountId = picked.id;
    return picked;
  }

  const current = candidates.find(({ account }) => account.id === currentAccountId)?.account;
  if (current) {
    lastSelectedAccountId = current.id;
    return current;
  }

  const ordered = sortAccounts(candidates).map(({ account }) => account);
  const picked = pickNextAccount(ordered);
  if (picked) lastSelectedAccountId = picked.id;
  return picked;
}

export function pickBalancedGatewayAccount(accounts: GatewayAccount[], excludeIds: string[] = [], options: SelectionOptions = {}): GatewayAccount | null {
  const excluded = new Set(excludeIds);
  const nowMs = Number(options.nowMs || Date.now());
  const nowSeconds = Math.floor(nowMs / 1000);
  const activeRequests = options.activeRequests || new Map();
  const cooldowns = options.cooldowns || new Map();
  const ignoreFiveHourLimit = options.ignoreFiveHourLimit === true;
  const candidates = accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => usableAccount(account, nowSeconds, { ignoreFiveHourLimit }))
    .filter(({ account }) => !excluded.has(account.id))
    .filter(({ account }) => Number(cooldowns.get(account.id) || 0) <= nowMs)
    .sort((left, right) => {
      const weeklyDiff = usedPercent(left.account.quota_7d_used_percent) - usedPercent(right.account.quota_7d_used_percent);
      if (weeklyDiff !== 0) return weeklyDiff;
      const activeDiff = Number(activeRequests.get(left.account.id) || 0) - Number(activeRequests.get(right.account.id) || 0);
      if (activeDiff !== 0) return activeDiff;
      const priorityDiff = Number(left.account.priority || 100) - Number(right.account.priority || 100);
      if (priorityDiff !== 0) return priorityDiff;
      return left.index - right.index;
    });
  return candidates.at(0)?.account || null;
}

function sortAccounts(accounts: IndexedAccount[]): IndexedAccount[] {
  return accounts
    .sort((left, right) => {
      const priorityDiff = Number(left.account.priority || 100) - Number(right.account.priority || 100);
      if (priorityDiff !== 0) return priorityDiff;
      return left.index - right.index;
    });
}

function sortAccountsBySevenDayQuota(accounts: IndexedAccount[], options: SelectionOptions = {}): IndexedAccount[] {
  return accounts
    .sort((left, right) => {
      const weeklyDiff = usedPercent(left.account.quota_7d_used_percent) - usedPercent(right.account.quota_7d_used_percent);
      if (weeklyDiff !== 0) return weeklyDiff;
      if (!options.ignoreFiveHourLimit) {
        const fiveHourDiff = usedPercent(left.account.quota_5h_used_percent) - usedPercent(right.account.quota_5h_used_percent);
        if (fiveHourDiff !== 0) return fiveHourDiff;
      }
      const priorityDiff = Number(left.account.priority || 100) - Number(right.account.priority || 100);
      if (priorityDiff !== 0) return priorityDiff;
      return left.index - right.index;
    });
}

function pickNextAccount(accounts: GatewayAccount[]): GatewayAccount | null {
  if (accounts.length === 0) return null;
  const lastIndex = accounts.findIndex((account) => account.id === lastSelectedAccountId);
  return accounts[(lastIndex + 1) % accounts.length] ?? null;
}

function usedPercent(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
}

export function resetSelectionState(): void {
  lastSelectedAccountId = "";
}
