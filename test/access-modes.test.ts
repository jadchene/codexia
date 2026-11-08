import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { applyAccountMode, applyApiMode, applyGatewayMode, detectCodexAuthMode, readCodexAccountTokens, readCodexOwnedAccountTokens } from "../src/main/codex-cli-auth.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-access-"));
  dirs.push(codexDir);
  return { codexDir, modelCatalogPath: path.join(codexDir, "api-models.json") };
}
const channel = { id: "channel-a", baseUrl: "https://api.example.com/custom/v1", apiKey: "channel-key", supportsWebSocket: false, requestHeaders: { "x-project": 'project "one"' } };
const account = { id: "account-a", account_id: "workspace-a", access_token: "old-access", refresh_token: "old-refresh" };

test.each(["openai", "third_party"])("%s API mode writes only selected credentials and survives restart detection", (mode) => {
  const options = fixture();
  fs.writeFileSync(path.join(options.codexDir, "config.toml"), 'model = "gpt-test"\n[features]\nfast_mode = true\n');
  applyApiMode(channel, options);
  const auth = JSON.parse(fs.readFileSync(path.join(options.codexDir, "auth.json"), "utf8"));
  expect(auth).toEqual({ OPENAI_API_KEY: "channel-key" });
  const config = fs.readFileSync(path.join(options.codexDir, "config.toml"), "utf8");
  expect(config).toContain('base_url = "https://api.example.com/custom/v1"');
  expect(config).toContain('requires_openai_auth = true');
  expect(config).toContain('supports_websockets = false');
  expect(config).toContain('"x-project" = "project \\"one\\""');
  expect(config).toContain('[features]\nfast_mode = true');
  expect(detectCodexAuthMode({ codex_auth_mode: mode, codex_selected_upstream_id: channel.id }, [], options).mode).toBe(mode);
  applyApiMode(channel, { ...options, accountModeBaseUrl: "http://localhost:8436/v1" });
  expect(fs.readFileSync(path.join(options.codexDir, "config.toml"), "utf8")).toContain('base_url = "http://localhost:8436/v1"');
  applyAccountMode(account, options);
  const accountConfig = fs.readFileSync(path.join(options.codexDir, "config.toml"), "utf8");
  expect(accountConfig).not.toContain("codexia_channel");
  expect(accountConfig).not.toContain("x-project");
  applyApiMode(channel, options);
  applyGatewayMode({ gateway_api_key: "gateway-key" }, options);
  expect(fs.readFileSync(path.join(options.codexDir, "config.toml"), "utf8")).not.toContain("codexia_channel");
});

test("active account reads rotated tokens from auth.json and rejects another identity or corrupt auth", () => {
  const options = fixture();
  applyAccountMode(account, options);
  const authFile = path.join(options.codexDir, "auth.json");
  const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
  auth.tokens.access_token = "codex-rotated-access";
  auth.tokens.refresh_token = "codex-rotated-refresh";
  fs.writeFileSync(authFile, JSON.stringify(auth));
  expect(readCodexAccountTokens(account, options)).toMatchObject({ access_token: "codex-rotated-access", refresh_token: "codex-rotated-refresh" });
  expect(() => readCodexAccountTokens({ ...account, account_id: "another-account" }, options)).toThrow(/已切换账号/);
  fs.writeFileSync(authFile, "{");
  expect(() => readCodexAccountTokens(account, options)).toThrow(/auth.json/);
});

test("Codex auth owns the externally selected account even when saved settings select another mode or account", () => {
  const options = fixture();
  const other = { id: "account-b", account_id: "workspace-b", access_token: "stored-b", refresh_token: "refresh-b" };
  applyAccountMode({ ...other, access_token: "rotated-b", refresh_token: "rotated-refresh-b" }, options);
  for (const settings of [{ codex_auth_mode: "account", codex_selected_account_id: account.id }, { codex_auth_mode: "gateway" }]) {
    expect(readCodexOwnedAccountTokens(other, settings, [account, other], options)).toMatchObject({ access_token: "rotated-b", refresh_token: "rotated-refresh-b" });
    expect(readCodexOwnedAccountTokens(account, settings, [account, other], options)).toBeNull();
  }
  fs.writeFileSync(path.join(options.codexDir, "auth.json"), "{");
  expect(() => readCodexOwnedAccountTokens(account, { codex_auth_mode: "account", codex_selected_account_id: account.id }, [account, other], options)).toThrow(/auth.json/);
});

test.each([[" ", "localhost"], ["::", "localhost"], ["[::]", "localhost"], ["::1", "[::1]"], ["2001:db8::1", "[2001:db8::1]"]])("gateway mode writes a reachable IPv6 address for %s", (host, expected) => {
  const options = fixture();
  applyGatewayMode({ gateway_api_key: "key", gateway_host: host, gateway_port: "8436" }, options);
  expect(fs.readFileSync(path.join(options.codexDir, "config.toml"), "utf8")).toContain(`http://${expected}:8436/v1`);
});


test.each([false, true])("API catalog, auth and config roll back together after a write failure (existing=%s)", (existing) => {
  const options = fixture();
  const authFile = path.join(options.codexDir, "auth.json");
  const configFile = path.join(options.codexDir, "config.toml");
  if (existing) {
    applyApiMode(channel, { ...options, modelCatalogContent: '{"models":[{"slug":"old"}]}' });
  }
  const files = [options.modelCatalogPath, authFile, configFile];
  const before = files.map((file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  const rename = fs.renameSync.bind(fs);
  const mocked = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
    if (String(source).startsWith(`${configFile}.tmp-`)) throw new Error("simulated config installation failure");
    rename(source, target);
  });
  try {
    expect(() => applyApiMode({ ...channel, apiKey: "replacement-key" }, { ...options, modelCatalogContent: '{"models":[{"slug":"new"}]}' })).toThrow(/simulated/);
    files.forEach((file, index) => {
      expect(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null).toBe(before[index]);
    });
    expect(fs.readdirSync(options.codexDir).filter((name) => /\.(tmp|bak)-/.test(name))).toEqual([]);
  } finally { mocked.mockRestore(); }
});

test("shared-workspace accounts prefer exact credentials and never guess after both tokens rotate", () => {
  const options = fixture();
  const second = { ...account, id: "second", access_token: "second-access", refresh_token: "second-refresh" };
  const accounts = [account, second];
  applyAccountMode(second, options);
  const settings = { codex_auth_mode: "account", codex_selected_account_id: account.id };
  expect(detectCodexAuthMode(settings, accounts, options)).toEqual({ mode: "account", accountId: "second" });
  expect(readCodexOwnedAccountTokens(account, settings, accounts, options)).toBeNull();
  expect(readCodexOwnedAccountTokens(second, settings, accounts, options)).toMatchObject({ access_token: "second-access" });
  applyAccountMode({ ...second, access_token: "rotated", refresh_token: "rotated-refresh" }, options);
  expect(detectCodexAuthMode(settings, accounts, options).mode).toBe("unknown");
  for (const candidate of accounts) {
    expect(() => readCodexOwnedAccountTokens(candidate, settings, accounts, options)).toThrow(/无法确认/);
    expect(() => readCodexOwnedAccountTokens(candidate, { codex_auth_mode: "gateway" }, accounts, options)).toThrow(/无法确认/);
  }
});
