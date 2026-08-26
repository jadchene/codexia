export const MAX_USAGE_RESET_REFRESH_ATTEMPTS = 3;
export const USAGE_RESET_REFRESH_RETRY_DELAY_MS = 5 * 60_000;

export function usageResetRefreshDelay(resetAt: number, now: number, completedAttempts: number): number | null {
  if (completedAttempts >= MAX_USAGE_RESET_REFRESH_ATTEMPTS) return null;
  if (completedAttempts > 0) return USAGE_RESET_REFRESH_RETRY_DELAY_MS;
  return Math.max(1000, resetAt * 1000 + 60_000 - now);
}
