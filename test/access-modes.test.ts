import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, expect, test, vi } from "vitest";
import { applyAccountMode, applyApiMode, applyGatewayMode, detectCodexAuthMode, readCodexAccountTokens, readCodexOwnedAccountTokens } from "../src/main/codex-cli-auth.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-access-"));
  dirs.push(codexDir);
  return { codexDir, mode: "openai" as "openai" | "third_party", modelCatalogPath: path.join(codexDir, "api-models.json") };
}
const channel = { id: "channel-a", baseUrl: "https://api.example.com/custom/v1", apiKey: "channel-key", supportsWebSocket: false, requestHeaders: { "x-project": 'project "one"' } };
const account = { id: "account-a", account_id: "workspace-a", access_token: "old-access", refresh_token: "old-refresh" };

const variants = ["gateway-base", "gateway-legacy", "account-direct", "account-proxy", "openai-direct", "openai-proxy", "third_party-proxy"];
const preservedConfig = [
  '# 用户配置必须保留',
  'model = "gpt-test"',
  'model_provider = "user-provider"',
  'model_catalog_json = "D:/catalog/custom.json"',
  'developer_instructions = """',
  '[model_providers.codexia]',
  'model_provider = "文字内容，不是配置"',
  '"""',
  '[profiles.work]',
  'model_provider = "user-provider"',
  'model_catalog_json = "D:/profile/custom.json"',
  'openai_base_url = "https://profile.example/v1"',
  '[model_providers.user-provider]',
  'name = "User"',
  'base_url = "https://user.example/v1"',
  '[mcp_servers.local]',
  'command = "node"',
  'args = [',
  '  "server.js",',
  ']',
  ''
].join("\n");

/** 在隔离目录应用模式，覆盖直连、代理和旧网关设置的兼容清理。 */
const applyVariant = (variant: string, options: ReturnType<typeof fixture>) => {
  const base = variant.endsWith("proxy") ? { accountModeBaseUrl: "http://localhost:8436/v1" } : {};
  if (variant.startsWith("gateway")) return applyGatewayMode({ gateway_api_key: "gateway-key", codex_config_use_openai_base_url: String(variant === "gateway-base") }, options);
  if (variant.startsWith("account")) return applyAccountMode(account, { ...options, ...base });
  return applyApiMode(channel, { ...options, ...base, mode: variant.startsWith("openai") ? "openai" : "third_party" });
};

test.each(["gateway", "account", "openai"])("%s can disable and re-enable its model catalog independently of proxying", (mode) => {
  const options = fixture();
  const file = path.join(options.codexDir, "config.toml");
  for (const enabled of [true, false, true]) {
    const next = { ...options, useModelCatalog: enabled, accountModeBaseUrl: "http://localhost:8436/v1" };
    if (mode === "gateway") applyGatewayMode({ gateway_api_key: "key" }, next);
    else if (mode === "account") applyAccountMode(account, next);
    else applyApiMode(channel, { ...next, mode: "openai" });
    const config = parse(fs.readFileSync(file, "utf8"));
    expect(config.model_catalog_json).toBe(enabled ? options.modelCatalogPath.replaceAll("\\", "/") : undefined);
    expect(config.openai_base_url).toBe("http://localhost:8436/v1");
  }
});

test("third-party mode requires proxying and cannot disable the selected catalog", () => {
  const options = { ...fixture(), mode: "third_party" as const, useModelCatalog: false };
  expect(() => applyApiMode(channel, options)).toThrow(/必须通过网关/);
  applyApiMode(channel, { ...options, accountModeBaseUrl: "http://localhost:8436/v1" });
  const config = parse(fs.readFileSync(path.join(options.codexDir, "config.toml"), "utf8"));
  expect(config.model_catalog_json).toBe(options.modelCatalogPath.replaceAll("\\", "/"));
  expect(config.model_provider).toBeUndefined();
});

test.each(variants.flatMap((from) => variants.map((to) => [from, to])))("switch %s -> %s keeps only the target connection and preserves user tables", (from, to) => {
  const options = fixture();
  const file = path.join(options.codexDir, "config.toml");
  fs.writeFileSync(file, preservedConfig);
  applyVariant(from!, options);
  applyVariant(to!, options);
  const written = fs.readFileSync(file, "utf8");
  const config = parse(written);
  const original = parse(preservedConfig);
  expect(config.profiles).toEqual(original.profiles);
  expect(config.mcp_servers).toEqual(original.mcp_servers);
  expect(config.developer_instructions).toEqual(original.developer_instructions);
  expect(config.model).toBe(original.model);
  expect(written).toContain('# 用户配置必须保留');
  expect(config.model_catalog_json).toBe(options.modelCatalogPath.replaceAll("\\", "/"));
  const providers = config.model_providers as Record<string, unknown>;
  expect(providers["user-provider"]).toEqual((original.model_providers as Record<string, unknown>)["user-provider"]);
  expect(config.model_provider).toBeUndefined();
  expect(providers.codexia).toBeUndefined();
  expect(config.openai_base_url).toBe(to === "account-direct" || to === "openai-direct" ? undefined : "http://localhost:8436/v1");
  const auth = JSON.parse(fs.readFileSync(path.join(options.codexDir, "auth.json"), "utf8"));
  if (to!.startsWith("account")) expect(auth).toMatchObject({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: account.access_token } });
  else expect(auth).toEqual({ OPENAI_API_KEY: to!.startsWith("gateway") ? "gateway-key" : channel.apiKey });
  applyVariant(to!, options);
  expect(parse(fs.readFileSync(file, "utf8"))).toEqual(config);
});

test.each(["\n", "\r\n"])("account mode removes quoted legacy provider tables and nested headers (%j)", (newline) => {
  const options = fixture();
  const file = path.join(options.codexDir, "config.toml");
  fs.writeFileSync(file, [
    "model_provider = 'codex_gateway' # legacy",
    "'model_catalog_json' = 'D:/old/catalog.json'",
    "[model_providers.'codex_gateway'] # legacy",
    'name = "Old"',
    '',
    'base_url = "https://old.example/v1"',
    '[model_providers."codex_gateway".http_headers]',
    'secret = "old-secret"',
    '[features]',
    'fast_mode = true'
  ].join(newline));
  applyAccountMode(account, options);
  const result = fs.readFileSync(file, "utf8");
  expect(result).not.toContain("old-secret");
  expect(result).not.toContain("codex_gateway");
  expect(parse(result).features).toEqual({ fast_mode: true });
});

test("invalid TOML leaves authentication, config and catalog untouched", () => {
  const options = fixture();
  applyApiMode(channel, { ...options, modelCatalogContent: '{"models":[]}' });
  const configFile = path.join(options.codexDir, "config.toml");
  fs.writeFileSync(configFile, 'model = "unterminated');
  const files = [configFile, path.join(options.codexDir, "auth.json"), options.modelCatalogPath];
  const before = files.map((file) => fs.readFileSync(file, "utf8"));
  expect(() => applyAccountMode(account, options)).toThrow();
  expect(files.map((file) => fs.readFileSync(file, "utf8"))).toEqual(before);
  expect(detectCodexAuthMode({ gateway_api_key: channel.apiKey }, [], options).mode).toBe("unknown");
});

test("an active profile cannot silently override the selected connection mode", () => {
  const options = fixture();
  const file = path.join(options.codexDir, "config.toml");
  const original = 'profile = "work"\n[profiles.work]\nmodel_provider = "other"\n';
  fs.writeFileSync(file, original);
  expect(() => applyApiMode(channel, { ...options, mode: "openai" })).toThrow(/profile/);
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  expect(fs.existsSync(path.join(options.codexDir, "auth.json"))).toBe(false);
});

test.each(["openai", "third_party"] as const)("%s API mode writes only selected credentials and survives restart detection", (mode) => {
  const options = { ...fixture(), mode, ...(mode === "third_party" ? { accountModeBaseUrl: "http://localhost:8436/v1" } : {}) };
  fs.writeFileSync(path.join(options.codexDir, "config.toml"), 'model = "gpt-test"\n[features]\nfast_mode = true\n');
  applyApiMode(channel, options);
  const auth = JSON.parse(fs.readFileSync(path.join(options.codexDir, "auth.json"), "utf8"));
  expect(auth).toEqual({ OPENAI_API_KEY: "channel-key" });
  const config = fs.readFileSync(path.join(options.codexDir, "config.toml"), "utf8");
  expect(parse(config).model_provider).toBeUndefined();
  expect(parse(config).model_providers).toBeUndefined();
  expect(parse(config).openai_base_url).toBe(mode === "third_party" ? "http://localhost:8436/v1" : undefined);
  expect(config).not.toContain("x-project");
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
