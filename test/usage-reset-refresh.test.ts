import assert from "node:assert/strict";
import { test } from "vitest";
import {
  MAX_USAGE_RESET_REFRESH_ATTEMPTS,
  USAGE_RESET_REFRESH_RETRY_DELAY_MS,
  usageResetRefreshDelay
} from "../src/main/usage-reset-refresh.ts";

test("usageResetRefreshDelay schedules the first refresh after the reset window", () => {
  assert.equal(usageResetRefreshDelay(200, 100_000, 0), 160_000);
  assert.equal(usageResetRefreshDelay(100, 200_000, 0), 1000);
});

test("usageResetRefreshDelay limits retries and keeps them five minutes apart", () => {
  assert.equal(usageResetRefreshDelay(100, 200_000, 1), USAGE_RESET_REFRESH_RETRY_DELAY_MS);
  assert.equal(usageResetRefreshDelay(100, 200_000, 2), USAGE_RESET_REFRESH_RETRY_DELAY_MS);
  assert.equal(usageResetRefreshDelay(100, 200_000, MAX_USAGE_RESET_REFRESH_ATTEMPTS), null);
});
