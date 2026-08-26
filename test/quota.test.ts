import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeUsagePayload, normalizeResetCreditsPayload, percentFromLimit, timestampFrom } from "../src/main/quota.ts";
import { buildExternalQuotaHeaders, buildExternalQuotaSnapshot } from "../src/main/gateway/quota.ts";

test("percentFromLimit handles common limit shapes", () => {
  assert.equal(percentFromLimit({ used: 25, limit: 100 }), 25);
  assert.equal(percentFromLimit({ current: 3, total: 4 }), 75);
});

test("timestampFrom accepts seconds, milliseconds, and ISO strings", () => {
  assert.equal(timestampFrom(1_700_000_000), 1_700_000_000);
  assert.equal(timestampFrom(1_700_000_000_000), 1_700_000_000);
  assert.equal(timestampFrom("2026-05-03T00:00:00.000Z"), 1_777_766_400);
  assert.equal(timestampFrom("2026-07-27 08:05:59 CST"), 1_785_110_759);
});

test("normalizeUsagePayload extracts 5h and 7d quota windows", () => {
  const usage = normalizeUsagePayload({
    usage: {
      "5h": { used: 1, limit: 4, reset_at: 100 },
      "7d": { used: 2, limit: 4, reset_at: 200 }
    }
  });
  assert.equal(usage.quota_5h_used_percent, 25);
  assert.equal(usage.quota_7d_used_percent, 50);
  assert.equal(usage.quota_5h_reset_at, 100);
  assert.equal(usage.quota_7d_reset_at, 200);
});

test("normalizeUsagePayload does not exhaust 7d quota for rate_limit limit_reached", () => {
  const usage = normalizeUsagePayload({
    usage: {
      rate_limit: {
        limit_reached: true,
        primary_window: { limit_window_seconds: 18000, used: 4, limit: 4, reset_at: 100 },
        secondary_window: { limit_window_seconds: 604800, used: 1, limit: 4, reset_at: 200 }
      }
    }
  });
  assert.equal(usage.quota_5h_used_percent, 100);
  assert.equal(usage.quota_7d_used_percent, 25);
});

test("normalizeUsagePayload rounds both quota windows at 99 percent", () => {
  const usage = normalizeUsagePayload({
    usage: {
      "5h": { used_percent: 99 },
      "7d": { used_percent: 99.5 }
    }
  });
  assert.equal(usage.quota_5h_used_percent, 100);
  assert.equal(usage.quota_7d_used_percent, 100);
});

test("normalizeUsagePayload uses the 7d quota when the 5h window is absent", () => {
  const usage = normalizeUsagePayload({
    user_id: "user",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 12,
        limit_window_seconds: 604800,
        reset_after_seconds: 600000,
        reset_at: 200
      },
      secondary_window: null
    }
  });
  assert.equal(usage.quota_5h_used_percent, 12);
  assert.equal(usage.quota_5h_reset_at, 200);
  assert.equal(usage.quota_7d_used_percent, 12);
  assert.equal(usage.quota_7d_reset_at, 200);
});

test("normalizeUsagePayload ignores empty quota windows instead of writing zero", () => {
  const usage = normalizeUsagePayload({
    user_id: "user",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 0,
        limit_window_seconds: 0,
        reset_after_seconds: 0,
        reset_at: 1780474988
      },
      secondary_window: null
    }
  });
  assert.equal("quota_5h_used_percent" in usage, false);
  assert.equal("quota_5h_reset_at" in usage, false);
  assert.equal("quota_7d_used_percent" in usage, false);
  assert.equal("quota_7d_reset_at" in usage, false);
});

test("external API channels report both quota windows as fully available", () => {
  const headers = buildExternalQuotaHeaders();
  const snapshot = buildExternalQuotaSnapshot();
  assert.equal(headers["x-codex-primary-used-percent"], "0");
  assert.equal(headers["x-codex-secondary-used-percent"], "0");
  assert.equal(snapshot.primary.used_percent, 0);
  assert.equal(snapshot.secondary.used_percent, 0);
});

test("normalizeResetCreditsPayload extracts available reset credits", () => {
  const credits = normalizeResetCreditsPayload({
    status_code: 200,
    available_count: 1,
    credits: [
      {
        id: "credit-1",
        status: "available",
        title: "Full reset (Weekly + 5 hr)",
        granted_at: "2026-06-27 08:05:59 CST",
        expires_at: "2099-07-27 08:05:59 CST"
      },
      {
        status: "expired",
        title: "Old reset",
        granted_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2026-02-01T00:00:00.000Z"
      }
    ]
  });
  assert.equal(credits.reset_credits_available_count, 1);
  assert.equal(credits.reset_credits_next_expires_at, 4_088_793_959);
  const parsed = JSON.parse(credits.reset_credits_json);
  assert.equal(parsed.available_count, 1);
  assert.equal(parsed.credits[0].id, "credit-1");
  assert.equal(parsed.credits[0].status, "available");
  assert.equal(parsed.credits[0].title, "Full reset (Weekly + 5 hr)");
  assert.equal(parsed.credits[0].granted_at, 1_782_518_759);
  assert.equal(parsed.credits[0].expires_at, 4_088_793_959);
});

test("normalizeResetCreditsPayload clears nearest expiry when no credit is available", () => {
  const credits = normalizeResetCreditsPayload({
    available_count: 0,
    credits: [
      {
        status: "expired",
        title: "Old reset",
        granted_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2026-02-01T00:00:00.000Z"
      }
    ]
  });
  assert.equal(credits.reset_credits_available_count, 0);
  assert.equal(credits.reset_credits_next_expires_at, 0);
});
