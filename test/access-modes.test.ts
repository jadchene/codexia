import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { applyAccountMode, applyApiMode, applyGatewayMode, detectCodexAuthMode, readCodexAccountTokens } from "../src/main/codex-cli-auth.ts";

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
