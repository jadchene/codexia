import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAccountRefreshService } from "../src/main/account-refresh.ts";
import { applyAccountMode } from "../src/main/codex-cli-auth.ts";
import { createStore } from "../src/main/store.ts";
import { createSecretCodec } from "../src/main/secret-codec.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach((close) => close()); });
function fixture(fetcher: typeof fetch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-account-refresh-"));
  const store = createStore({ dataDir: root, dbPath: path.join(root, "test.sqlite"), secretCodec: createSecretCodec({
    isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString()
  }) });
  cleanup.push(() => { store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const account = store.saveAccount({ name: "one", account_id: "owner-one", enabled: true, access_token: "old-access", refresh_token: "old-refresh" });
  const codexDir = path.join(root, "codex");
  const onUsageRefreshed = vi.fn();
  const service = createAccountRefreshService({ store, codexOptions: { codexDir }, fetch: fetcher, onUsageRefreshed });
  return { store, account, codexDir, service, onUsageRefreshed };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const quota = { rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 25 }, secondary_window: { limit_window_seconds: 604800, used_percent: 40 } } };
const credits = { available_count: 2, credits: [{ id: "card", status: "available", expires_at: 4102444800 }] };

it("refreshes token, quotas and reset counts into SQLite without consuming credits", async () => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).includes("oauth/token")) return json({ access_token: "new-access", refresh_token: "new-refresh" });
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer new-access");
    expect(init!.method).toBeUndefined();
    return json(String(url).endsWith("/usage") ? quota : credits);
  });
  const f = fixture(fetcher);
  const result = await f.service.refresh(f.account.id, "all");
  expect(result).toMatchObject({ access_token: "new-access", refresh_token: "new-refresh", quota_5h_used_percent: 25, quota_7d_used_percent: 40, reset_credits_available_count: 2 });
  expect(f.onUsageRefreshed).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.every(([url]) => !String(url).includes("/consume"))).toBe(true);
});

it("direct account refresh only reads rotated Codex tokens, leaving auth.json untouched", async () => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).not.toContain("oauth/token");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer codex-access");
    return json(String(url).endsWith("/usage") ? quota : credits);
  });
  const f = fixture(fetcher);
  applyAccountMode({ ...f.account, id: f.account.id, access_token: "codex-access", refresh_token: "codex-refresh" }, { codexDir: f.codexDir });
  f.store.saveSettings({ codex_auth_mode: "account", codex_selected_account_id: f.account.id, account_mode_use_api_proxy: "false" });
  const file = path.join(f.codexDir, "auth.json");
  const before = fs.readFileSync(file, "utf8");
  expect(await f.service.refresh(f.account.id, "token")).toMatchObject({ refresh_token: "codex-refresh" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(await f.service.refresh(f.account.id, "all")).toMatchObject({ reset_credits_available_count: 2 });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  fs.writeFileSync(file, "{");
  await expect(f.service.refresh(f.account.id, "all")).rejects.toThrow(/auth.json/);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("usage refresh retries authentication once and persists rotated tokens", async () => {
  let rotated = false;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes("oauth/token")) { rotated = true; return json({ access_token: "rotated", refresh_token: "rotated-refresh" }); }
    return rotated ? json(String(url).endsWith("/usage") ? quota : credits) : json({}, 401);
  });
  const f = fixture(fetcher);
  expect(await f.service.refresh(f.account.id, "usage")).toMatchObject({ access_token: "rotated", reset_credits_available_count: 2 });
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("oauth/token"))).toHaveLength(1);
});

it("401 for a Codex-owned account never redeems the refresh token", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => json({}, 401));
  const f = fixture(fetcher);
  applyAccountMode({ ...f.account, id: f.account.id }, { codexDir: f.codexDir });
  await expect(f.service.refresh(f.account.id, "all")).rejects.toThrow(/401/);
  expect(fetcher.mock.calls.every(([url]) => !String(url).includes("oauth/token"))).toBe(true);
});

it("failed quota query leaves both previous usage and reset counts intact", async () => {
  const f = fixture(vi.fn<typeof fetch>(async (url) => String(url).endsWith("/usage") ? json(quota) : json({}, 500)));
  f.store.updateUsage(f.account.id, { quota_5h_used_percent: 8, reset_credits_available_count: 3 });
  await expect(f.service.refresh(f.account.id, "usage")).rejects.toThrow(/500/);
  expect(f.store.listAccounts()[0]).toMatchObject({ quota_5h_used_percent: 8, reset_credits_available_count: 3 });
});

it("serializes token rotation per account and uses the latest refresh token", async () => {
  const submitted: string[] = [];
  let active = 0; let maximum = 0;
  const f = fixture(vi.fn<typeof fetch>(async (_url, init) => {
    submitted.push((init!.body as URLSearchParams).get("refresh_token")!);
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return json({ access_token: "new-access", refresh_token: "new-refresh" });
  }));
  await Promise.all([f.service.refresh(f.account.id, "token"), f.service.refreshToken(f.account.id)]);
  expect(submitted).toEqual(["old-refresh", "new-refresh"]);
  expect(maximum).toBe(1);
});

it("does not recreate an account deleted while a refresh was in flight", async () => {
  let finish!: (value: Response) => void;
  const started = Promise.withResolvers<void>();
  const f = fixture(vi.fn<typeof fetch>(async () => { started.resolve(); return new Promise((resolve) => { finish = resolve; }); }));
  const result = f.service.refresh(f.account.id, "token");
  await started.promise;
  f.store.deleteAccount(f.account.id);
  finish(json({ access_token: "new-access", refresh_token: "new-refresh" }));
  await expect(result).rejects.toThrow(/删除/);
  expect(f.store.listAccounts()).toHaveLength(0);
});
