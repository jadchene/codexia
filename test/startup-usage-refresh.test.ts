import assert from "node:assert/strict";
import { test } from "vitest";
import { startStartupUsageRefresh } from "../src/main/startup-usage-refresh.ts";

test("startup usage refresh returns immediately while the refresh continues in background", async () => {
  let releaseRefresh: (() => void) | undefined;
  const refreshPending = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let staleChecked = false;

  const result = startStartupUsageRefresh({
    async checkRefreshAll() {
      await refreshPending;
      return true;
    },
    async checkStaleQuotas() {
      staleChecked = true;
    },
    onError(error) {
      assert.fail(error);
    }
  });

  assert.equal(result, undefined);
  assert.equal(staleChecked, false);
  releaseRefresh?.();
  await refreshPending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(staleChecked, false);
});

test("startup usage refresh checks stale quotas only when a full refresh was not started", async () => {
  let staleChecked = false;
  const completed = new Promise<void>((resolve) => {
    startStartupUsageRefresh({
      async checkRefreshAll() {
        return false;
      },
      async checkStaleQuotas() {
        staleChecked = true;
        resolve();
      },
      onError(error) {
        assert.fail(error);
      }
    });
  });

  await completed;
  assert.equal(staleChecked, true);
});
