import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { createSecretCodec, PREFIX } from "../src/main/secret-codec.ts";
import { createStore } from "../src/main/store.ts";
import { editableSettingsPatch, isTrustedRendererUrl, publicAccount, publicSettings } from "../src/main/renderer-boundary.ts";
import { applyGatewayMode, gatewayProviderBlock, nextGatewayConfig, withoutGatewayProvider, writeFilesTransaction } from "../src/main/codex-cli-auth.ts";
import { createMcpGatewayService, resolveWindowsNpmShim } from "../src/main/mcp-gateway-service.ts";
import { isStrongGatewayApiKey } from "../src/main/gateway.ts";
import { createUsageRefreshCoordinator } from "../src/main/usage-refresh-coordinator.ts";
import { acquireSingleInstanceChannel, closeSingleInstanceChannel, singleInstanceEndpoint } from "../src/main/single-instance.ts";

test("bundled model override is disabled by default", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-bundled-override-default-"));
  const store = createStore({ secretCodec: testSecretCodec(), dataDir: directory, dbPath: path.join(directory, "test.sqlite") });
  try {
    assert.equal(store.getSettings().codex_bundled_override_enabled, "false");
    assert.equal(store.getSettings().codex_bundled_override_json, "");
  } finally {
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("safe storage codec encrypts account and PKCE secrets at rest and migrates plaintext rows", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-store-"));
  const database = path.join(directory, "test.sqlite");
  const codec = testSecretCodec();
  let store;
  try {
    store = createStore({ secretCodec: codec, dataDir: directory, dbPath: database });
    const saved = store.saveAccount({ name: "Account", access_token: "access", refresh_token: "refresh", id_token: "identity" });
    store.saveLoginSession({ id: "login", code_verifier: "verifier", redirect_uri: "http://localhost", status: "pending" });
    const rawAccount = store.db.prepare("SELECT access_token, refresh_token, id_token FROM accounts WHERE id = ?").get(saved.id);
    const rawLogin = store.db.prepare("SELECT code_verifier FROM login_sessions WHERE id = ?").get("login");
    assert.ok(Object.values(rawAccount).every((value) => value.startsWith(PREFIX)));
    assert.ok(rawLogin.code_verifier.startsWith(PREFIX));
    assert.equal(store.listAccounts()[0].access_token, "access");
    assert.equal(store.getLoginSession("login").code_verifier, "verifier");

    store.db.prepare("UPDATE accounts SET access_token = 'legacy-plain' WHERE id = ?").run(saved.id);
    store.db.prepare("UPDATE login_sessions SET code_verifier = 'legacy-verifier' WHERE id = 'login'").run();
    store.db.close();
    store = createStore({ secretCodec: codec, dataDir: directory, dbPath: database });
    assert.equal(store.listAccounts()[0].access_token, "legacy-plain");
    assert.ok(store.db.prepare("SELECT access_token FROM accounts WHERE id = ?").get(saved.id).access_token.startsWith(PREFIX));
    assert.equal(store.getLoginSession("login").code_verifier, "legacy-verifier");
  } finally {
    store?.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("store retention removes expired logs and OAuth sessions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-retention-"));
  const database = path.join(directory, "test.sqlite");
  const store = createStore({ secretCodec: testSecretCodec(), dataDir: directory, dbPath: database });
  try {
    store.addTokenLog({ method: "POST", request_path: "/v1/responses" });
    store.addAppLog({ message: "old" });
    store.saveLoginSession({ id: "old-login", code_verifier: "secret", redirect_uri: "http://localhost", status: "pending" });
    store.db.exec("UPDATE request_logs SET created_at = 1; UPDATE app_logs SET created_at = 1; UPDATE login_sessions SET updated_at = 1");
    const result = store.runMaintenance();
    assert.deepEqual(result, { requestLogsDeleted: 1, appLogsDeleted: 1, loginSessionsDeleted: 1 });
  } finally {
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("app log queries filter level, scope, status, and keyword without renderer-side filtering", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-log-filter-"));
  const database = path.join(directory, "test.sqlite");
  const store = createStore({ secretCodec: testSecretCodec(), dataDir: directory, dbPath: database });
  try {
    store.addAppLog({ level: "error", scope: "gateway-http", action: "proxy", status: "failed", message: "gateway failure request-42" });
    store.addAppLog({ level: "info", scope: "gateway-http", message: "gateway ready" });
    store.addAppLog({ level: "error", scope: "mcp", message: "mcp failure" });
    const result = store.listAppLogs({
      page: 1,
      pageSize: 20,
      startAt: 0,
      endAt: Math.floor(Date.now() / 1000) + 10,
      level: "error",
      scope: "gateway",
      status: "fail",
      keyword: "request-42"
    });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].message, "gateway failure request-42");
    assert.deepEqual(result.query, {
      page: 1,
      pageSize: 20,
      startAt: 0,
      endAt: result.query.endAt,
      status: "fail",
      keyword: "request-42",
      level: "error",
      scope: "gateway"
    });
  } finally {
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("request log filters expose the actual channel and model", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-request-filter-"));
  const database = path.join(directory, "test.sqlite");
  const store = createStore({ secretCodec: testSecretCodec(), dataDir: directory, dbPath: database });
  try {
    store.addTokenLog({
      session_id: "session-1",
      upstream_id: "api-a",
      upstream_name: "API A",
      client_model: "gpt-client",
      upstream_model: "provider-model",
      status: 200
    });
    store.addTokenLog({ session_id: "session-2", upstream_id: "api-b", client_model: "other", upstream_model: "other", status: 429 });
    const endAt = Math.floor(Date.now() / 1000) + 10;
    const result = store.listTokenLogs({
      page: 1,
      pageSize: 20,
      startAt: 0,
      endAt,
      upstreamId: "api-a",
      clientModel: "gpt",
      upstreamModel: "provider",
      status: "200",
      sessionId: "session-1"
    });
    assert.equal(result.total, 1);
    const summary = store.tokenSummary({
      page: 1,
      pageSize: 20,
      startAt: 0,
      endAt,
      upstreamId: "api-a"
    });
    assert.equal(summary.total.calls, 1);
    assert.equal(summary.total.errors, 0);
    assert.equal(result.items[0].upstream_name, "API A");
    assert.equal(result.items[0].client_model, "gpt-client");
    assert.equal(result.items[0].upstream_model, "provider-model");
    assert.equal(result.query.upstreamId, "api-a");
    assert.equal(result.query.clientModel, "gpt");
    assert.equal(result.query.upstreamModel, "provider");
    assert.equal(result.query.sessionId, "session-1");
    assert.equal(result.query.status, "200");

    const channelSummary = store.tokenSummary({ page: 1, pageSize: 20, startAt: 0, endAt });
    assert.deepEqual(channelSummary.byAccount.map((item) => ({
      upstreamId: item.upstream_id,
      upstreamName: item.upstream_name,
      calls: item.calls
    })), [
      { upstreamId: "api-a", upstreamName: "API A", calls: 1 },
      { upstreamId: "api-b", upstreamName: "api-b", calls: 1 }
    ]);
  } finally {
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("store repairs a legacy refresh timestamp that points to a failed refresh", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-refresh-time-"));
  const database = path.join(directory, "test.sqlite");
  let store = createStore({ secretCodec: testSecretCodec(), dataDir: directory, dbPath: database });
  try {
    store.db.prepare(`
      INSERT INTO app_logs (level, scope, action, status, message, created_at)
      VALUES ('info', 'usage', 'refresh-all', 'success', 'ok', 100),
             ('info', 'usage', 'refresh-all', 'failed', 'failed', 200)
    `).run();
    store.saveSettings({ last_usage_refresh_all_at: 200 });
    store.db.close();
    store = createStore({ secretCodec: testSecretCodec(), dataDir: directory, dbPath: database });
    assert.equal(store.getSettings().last_usage_refresh_all_at, "100");
    assert.equal(store.getLastRefreshAllUsageAt(), 100);
  } finally {
    store?.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("single-instance channel coordinates copies without changing Electron user data", async (context) => {
  const endpoint = singleInstanceEndpoint({ userIdentity: `test-${process.pid}-${Date.now()}` });
  let notified;
  const notification = new Promise((resolve) => {
    notified = resolve;
  });
  let primary;
  try {
    primary = await acquireSingleInstanceChannel({ endpoint, onSecondInstance: notified });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    context.skip("Unix domain sockets are blocked in this sandbox");
    return;
  }
  try {
    const secondary = await acquireSingleInstanceChannel({ endpoint });
    assert.equal(primary.primary, true);
    assert.equal(secondary.primary, false);
    await Promise.race([
      notification,
      new Promise((_, reject) => setTimeout(() => reject(new Error("single-instance notification timeout")), 1000))
    ]);
  } finally {
    await closeSingleInstanceChannel(primary.server);
  }
});

test("renderer boundary strips secrets, validates settings, and rejects foreign pages", () => {
  const resetCreditsJson = JSON.stringify({ available_count: 1, credits: [{ status: "available" }] });
  const account = publicAccount({
    id: "a",
    access_token: "access",
    refresh_token: "refresh",
    id_token: "id",
    raw_usage_json: "{}",
    reset_credits_json: resetCreditsJson
  });
  assert.deepEqual(account, {
    id: "a",
    reset_credits_json: resetCreditsJson,
    has_access_token: true,
    has_refresh_token: true
  });
  const patch = editableSettingsPatch({ gateway_port: "8436", gateway_host: "localhost", last_usage_refresh_all_at: "999" });
  assert.deepEqual(patch, { gateway_port: "8436", gateway_host: "localhost" });
  assert.deepEqual(editableSettingsPatch({
    appearance_theme: "dark",
    appearance_density: "compact",
    navigation_collapsed: "true"
  }), {
    appearance_theme: "dark",
    appearance_density: "compact",
    navigation_collapsed: "true"
  });
  const safeSettings = publicSettings({
    gateway_port: "8436",
    gateway_api_key: "top-secret-key",
    codex_bundled_override_enabled: "true",
    codex_bundled_override_json: "{\"models\":[]}"
  });
  assert.equal(safeSettings.gateway_api_key, undefined);
  assert.equal(safeSettings.codex_bundled_override_enabled, undefined);
  assert.equal(safeSettings.codex_bundled_override_json, undefined);
  assert.equal(safeSettings.gateway_api_key_configured, "true");
  assert.match(safeSettings.gateway_api_key_fingerprint, /^[a-f0-9]{12}$/);
  assert.throws(() => editableSettingsPatch({ appearance_theme: "midnight" }), /取值无效/);
  assert.deepEqual(editableSettingsPatch({ codex_config_use_openai_base_url: "false" }), { codex_config_use_openai_base_url: "false" });
  assert.throws(() => editableSettingsPatch({ codex_config_use_openai_base_url: "maybe" }), /取值无效/);
  assert.deepEqual(editableSettingsPatch({ auto_review_upstream_model: "deepseek-model" }), {
    auto_review_upstream_model: "deepseek-model"
  });
  assert.throws(() => editableSettingsPatch({ gateway_port: "70000" }), /超出范围/);
  assert.throws(() => editableSettingsPatch({ upstream_base_url: "file:///secret" }), /HTTP/);
  assert.deepEqual(editableSettingsPatch({
    gateway_connect_timeout_ms: "45000",
    gateway_stream_idle_timeout_ms: "121000",
    gateway_unary_timeout_ms: "91000",
    gateway_websocket_idle_timeout_ms: "181000",
    gateway_quota_cooldown_ms: "61000",
    gateway_session_affinity_ttl_hours: "168",
    gateway_shutdown_grace_ms: "5500",
    usage_refresh_timeout_ms: "16000"
  }), {
    gateway_connect_timeout_ms: "45000",
    gateway_stream_idle_timeout_ms: "121000",
    gateway_unary_timeout_ms: "91000",
    gateway_websocket_idle_timeout_ms: "181000",
    gateway_quota_cooldown_ms: "61000",
    gateway_session_affinity_ttl_hours: "168",
    gateway_shutdown_grace_ms: "5500",
    usage_refresh_timeout_ms: "16000"
  });
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:8435/#/", { packaged: false, devOrigin: "http://127.0.0.1:8435" }), true);
  assert.equal(isTrustedRendererUrl("https://example.com", { packaged: false, devOrigin: "http://127.0.0.1:8435" }), false);
  const indexFile = path.resolve("dist/renderer/index.html");
  assert.equal(isTrustedRendererUrl(pathToFileURL(indexFile).href, { packaged: true, indexFile }), true);
});

test("gateway provider config replaces another active provider while preserving its block", () => {
  const current = ['model_provider = "custom"', "", "[model_providers.custom]", 'name = "Custom"', ""].join("\n");
  const next = nextGatewayConfig(current, { gateway_host: "localhost", gateway_port: "8436" });
  assert.match(next, /^openai_base_url = "http:\/\/localhost:8436\/v1"/m);
  assert.doesNotMatch(next, /^model_provider\s*=/m);
  assert.match(next, /\[model_providers\.custom\]/);
  assert.doesNotMatch(next, /codex_gateway/);

  const custom = nextGatewayConfig(current, {
    gateway_host: "localhost",
    gateway_port: "8436",
    codex_config_use_openai_base_url: "false"
  });
  assert.match(custom, /^model_provider = "codexia"/m);
  assert.match(custom, /\[model_providers\.custom\]/);
  assert.match(custom, /\[model_providers\.codexia\]/);
});

test("switching gateway config to custom provider clears openai_base_url residue", () => {
  const current = gatewayProviderBlock({ gateway_host: "localhost", gateway_port: "8436" });
  const next = nextGatewayConfig(current, {
    gateway_host: "localhost",
    gateway_port: "8436",
    codex_config_use_openai_base_url: "false"
  });
  assert.doesNotMatch(next, /openai_base_url/);
  assert.match(next, /^model_provider = "codexia"/m);
  assert.match(next, /\[model_providers\.codexia\]/);
  assert.match(next, /model_catalog_json/);
});

test("switching gateway config to openai_base_url clears custom provider residue", () => {
  const current = gatewayProviderBlock({
    gateway_host: "localhost",
    gateway_port: "8436",
    codex_config_use_openai_base_url: "false"
  });
  const next = nextGatewayConfig(current, { gateway_host: "localhost", gateway_port: "8436" });
  assert.doesNotMatch(next, /codexia|codex_gateway/);
  assert.doesNotMatch(next, /^model_provider\s*=/m);
  assert.match(next, /openai_base_url = "http:\/\/localhost:8436\/v1"/);
  assert.match(next, /model_catalog_json/);
});

test("withoutGatewayProvider clears simplified openai_base_url config without provider line", () => {
  const current = [
    'model = "gpt-5.4"',
    'model_catalog_json = "C:/Users/test/.codex/models.json"',
    'openai_base_url = "http://localhost:8436/v1"',
    "",
    "[notice.model_migrations]",
    '"gpt-5.3-codex" = "gpt-5.4"',
    ""
  ].join("\n");
  const next = withoutGatewayProvider(current);
  assert.doesNotMatch(next, /openai_base_url/);
  assert.doesNotMatch(next, /model_catalog_json/);
  assert.match(next, /^model = "gpt-5\.4"/m);
  assert.match(next, /\[notice\.model_migrations\]/);
});

test("withoutGatewayProvider clears custom provider config", () => {
  const current = [
    'model = "gpt-5.4"',
    'model_provider = "codexia"',
    'model_catalog_json = "C:/Users/test/.codex/models.json"',
    "",
    "[model_providers.codexia]",
    'name = "OpenAI"',
    'base_url = "http://localhost:8436/v1"',
    "",
    "[notice.model_migrations]",
    '"gpt-5.3-codex" = "gpt-5.4"',
    ""
  ].join("\n");
  const next = withoutGatewayProvider(current);
  assert.doesNotMatch(next, /codexia/);
  assert.doesNotMatch(next, /model_catalog_json/);
  assert.match(next, /^model = "gpt-5\.4"/m);
  assert.match(next, /\[notice\.model_migrations\]/);
});

test("withoutGatewayProvider removes the simplified openai_base_url config with its provider line", () => {
  const current = [
    'model = "gpt-5.4"',
    'model_provider = "openai"',
    'model_catalog_json = "C:/Users/test/.codex/models.json"',
    'openai_base_url = "http://localhost:8436/v1"',
    "",
    "[notice.model_migrations]",
    '"gpt-5.3-codex" = "gpt-5.4"',
    ""
  ].join("\n");
  const next = withoutGatewayProvider(current);
  assert.doesNotMatch(next, /model_provider = "openai"/);
  assert.doesNotMatch(next, /openai_base_url/);
  assert.match(next, /^model = "gpt-5\.4"/m);
  assert.match(next, /\[notice\.model_migrations\]/);
});

test("applying gateway mode configures the generated total model catalog", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-catalog-"));
  try {
    fs.writeFileSync(path.join(directory, "config.toml"), [
      'model = "gpt-selected"',
      'model_catalog_json = "C:/Users/test/.codex/codex-gateway-models.json"',
      ""
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(directory, "codex-gateway-models.json"), '{"models":[]}', "utf8");
    const catalogPath = path.join(directory, "models.json");
    fs.writeFileSync(catalogPath, '{"models":[]}', "utf8");
    const result = applyGatewayMode({
      gateway_api_key: "local-test-key",
      gateway_host: "localhost",
      gateway_port: "8436"
    }, { codexDir: directory, modelCatalogPath: catalogPath });
    const config = fs.readFileSync(path.join(directory, "config.toml"), "utf8");
    assert.match(config, /model_catalog_json/);
    assert.match(config, /openai_base_url = "http:\/\/localhost:8436\/v1"/);
    assert.doesNotMatch(config, /model_provider/);
    assert.equal(result.modelCatalogPath, catalogPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("multi-file Codex writes roll back all files when verification fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-auth-"));
  const auth = path.join(directory, "auth.json");
  const config = path.join(directory, "config.toml");
  fs.writeFileSync(auth, "old-auth", "utf8");
  fs.writeFileSync(config, "old-config", "utf8");
  try {
    assert.throws(() => writeFilesTransaction([
      { file: auth, content: "new-auth" },
      { file: config, content: "new-config" }
    ], () => {
      throw new Error("verify failed");
    }), /verify failed/);
    assert.equal(fs.readFileSync(auth, "utf8"), "old-auth");
    assert.equal(fs.readFileSync(config, "utf8"), "old-config");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("applying gateway mode preserves symbolic links and writes their targets", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-auth-links-"));
  const codexDirectory = path.join(directory, "codex");
  const targetDirectory = path.join(directory, "targets");
  const authTarget = path.join(targetDirectory, "auth.json");
  const configTarget = path.join(targetDirectory, "config.toml");
  const authLink = path.join(codexDirectory, "auth.json");
  const configLink = path.join(codexDirectory, "config.toml");
  fs.mkdirSync(codexDirectory, { recursive: true });
  fs.mkdirSync(targetDirectory, { recursive: true });
  fs.writeFileSync(authTarget, "{}\n", "utf8");
  fs.writeFileSync(configTarget, 'model = "gpt-selected"\n', "utf8");
  fs.symlinkSync(authTarget, authLink, "file");
  fs.symlinkSync(configTarget, configLink, "file");
  try {
    applyGatewayMode({
      gateway_api_key: "local-test-key",
      gateway_host: "localhost",
      gateway_port: "8436"
    }, { codexDir: codexDirectory, modelCatalogPath: path.join(directory, "models.json") });

    assert.equal(fs.lstatSync(authLink).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(configLink).isSymbolicLink(), true);
    assert.equal(JSON.parse(fs.readFileSync(authTarget, "utf8")).OPENAI_API_KEY, "local-test-key");
    assert.match(fs.readFileSync(configTarget, "utf8"), /^openai_base_url = "http:\/\/localhost:8436\/v1"/m);
    assert.doesNotMatch(fs.readFileSync(configTarget, "utf8"), /model_provider/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("transaction rollback preserves symbolic links and restores their targets", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-auth-link-rollback-"));
  const target = path.join(directory, "target.json");
  const link = path.join(directory, "auth.json");
  fs.writeFileSync(target, "old-auth", "utf8");
  fs.symlinkSync(target, link, "file");
  try {
    assert.throws(() => writeFilesTransaction([{ file: link, content: "new-auth" }], () => {
      throw new Error("verify failed");
    }), /verify failed/);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(target, "utf8"), "old-auth");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP process late exit cannot clear a restarted process", async () => {
  const children = [];
  const service = createMcpGatewayService({ getSettings: () => ({}) }, {
    resolveLaunch: () => ({ executable: "node", prefixArgs: ["cli.js"] }),
    spawnProcess: () => {
      const child = new EventEmitter();
      child.pid = children.length + 1;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      children.push(child);
      return child;
    },
    killProcess: () => {},
    stopTimeoutMs: 5
  });
  assert.equal((await service.start()).pid, 1);
  const stopping = service.stop();
  const restarting = service.start();
  await stopping;
  assert.equal((await restarting).pid, 2);
  children[0].emit("exit", 0, null);
  assert.equal(service.status().pid, 2);
});

test("MCP process status preserves an unexpected exit error", async () => {
  let child;
  const service = createMcpGatewayService({ getSettings: () => ({}) }, {
    resolveLaunch: () => ({ executable: "node", prefixArgs: ["cli.js"] }),
    spawnProcess: () => {
      child = new EventEmitter();
      child.pid = 7;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    }
  });
  await service.start();
  child.stderr.emit("data", "configuration failed");
  child.emit("exit", 1, null);
  assert.match(service.status().error, /configuration failed/);
  assert.equal(service.status().installed, true);
});

test("MCP process status reports a missing service executable", () => {
  const service = createMcpGatewayService({ getSettings: () => ({}) }, {
    resolveLaunch: () => { throw new Error("missing"); }
  });
  assert.equal(service.status().installed, false);
});

test("Windows npm shim resolves a scoped package entry without invoking cmd.exe", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-shim-"));
  const shim = path.join(directory, "mcp-gateway-service.cmd");
  const script = path.join(directory, "node_modules", "@scope", "mcp-gateway-service", "dist", "index.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "", "utf8");
  fs.writeFileSync(shim, '"%dp0%\\node_modules\\@scope\\mcp-gateway-service\\dist\\index.js" %*\n', "utf8");
  try {
    assert.deepEqual(resolveWindowsNpmShim(shim, "C:\\node.exe"), {
      executable: "C:\\node.exe",
      prefixArgs: [script]
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("non-loopback gateway listeners require a strong key", () => {
  assert.equal(isStrongGatewayApiKey("short"), false);
  assert.equal(isStrongGatewayApiKey("local-personal-token"), false);
  assert.equal(isStrongGatewayApiKey(`sk-${"a".repeat(32)}`), true);
});

test("usage refresh is single-flight, concurrency-bounded, and stamps passes with at least one success", async () => {
  const accounts = Array.from({ length: 5 }, (_, index) => ({ id: String(index), name: `A${index}`, enabled: true, access_token: "token" }));
  const settingsWrites = [];
  let active = 0;
  let maxActive = 0;
  let failId = "";
  const coordinator = createUsageRefreshCoordinator({
    listAccounts: () => accounts,
    async refreshAccount(id) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (id === failId) throw new Error("failed");
    },
    saveSettings: (patch) => settingsWrites.push(patch),
    addLog: () => {},
    compactError: String,
    now: () => 123000,
    concurrency: 2
  });
  const first = coordinator.refreshAll("first");
  const duplicate = coordinator.refreshAll("duplicate");
  assert.strictEqual(first, duplicate);
  assert.equal((await first).length, 5);
  assert.equal(maxActive, 2);
  assert.deepEqual(settingsWrites, [{ last_usage_refresh_all_at: 123 }]);

  failId = "2";
  const failed = await coordinator.refreshAll("failure");
  assert.equal(failed.find((item) => item.id === "2").ok, false);
  assert.equal(settingsWrites.length, 2);
});

test("usage refresh also refreshes API channel balances and skips channels without balance config", async () => {
  const accounts = [{ id: "a1", name: "Account A", enabled: true, access_token: "token" }];
  const balanceUpstreams = [
    { id: "u1", name: "DeepSeek API", balanceQueryType: "deepseek" },
    { id: "u2", name: "No Balance API", balanceQueryType: "none" }
  ];
  const refreshed = [];
  const entries = [];
  const coordinator = createUsageRefreshCoordinator({
    listAccounts: () => accounts,
    async refreshAccount(id) {
      refreshed.push(`account:${id}`);
    },
    listBalanceUpstreams: () => balanceUpstreams.filter((upstream) => upstream.balanceQueryType !== "none"),
    async refreshBalance(id) {
      refreshed.push(`balance:${id}`);
    },
    saveSettings: (patch) => entries.push({ type: "settings", patch }),
    addLog: (entry) => entries.push({ type: "log", entry }),
    compactError: String,
    now: () => 124000,
    concurrency: 2
  });
  const results = await coordinator.refreshAll("timer");
  assert.equal(refreshed.join(","), "account:a1,balance:u1");
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((item) => [item.kind, item.id, item.ok]), [
    ["account", "a1", true],
    ["balance", "u1", true]
  ]);
  const refreshLog = entries.find((item) => item.type === "log" && item.entry.action === "refresh-all");
  assert.match(refreshLog.entry.message, /账号额度 1\/1/);
  assert.match(refreshLog.entry.message, /渠道余额 1\/1/);
  assert.deepEqual(entries.find((item) => item.type === "settings"), {
    type: "settings",
    patch: { last_usage_refresh_all_at: 124 }
  });
});

test("a failed channel balance refresh reports partial but does not block other targets or the pass timestamp", async () => {
  const settingsWrites = [];
  const coordinator = createUsageRefreshCoordinator({
    listAccounts: () => [{ id: "a1", name: "Account A", enabled: true, access_token: "token" }],
    async refreshAccount() {
      return undefined;
    },
    listBalanceUpstreams: () => [{ id: "u1", name: "DeepSeek API" }],
    async refreshBalance() {
      throw new Error("balance failed");
    },
    saveSettings: (patch) => settingsWrites.push(patch),
    addLog: () => {},
    compactError: String,
    now: () => 125000,
    concurrency: 2
  });
  const results = await coordinator.refreshAll("timer");
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.find((item) => item.kind === "balance").ok, false);
  assert.deepEqual(settingsWrites, [{ last_usage_refresh_all_at: 125 }]);
});

test("a fully failed refresh pass does not stamp the pass timestamp", async () => {
  const settingsWrites = [];
  const coordinator = createUsageRefreshCoordinator({
    listAccounts: () => [{ id: "a1", name: "Account A", enabled: true, access_token: "token" }],
    async refreshAccount() {
      throw new Error("account failed");
    },
    listBalanceUpstreams: () => [{ id: "u1", name: "DeepSeek API" }],
    async refreshBalance() {
      throw new Error("balance failed");
    },
    saveSettings: (patch) => settingsWrites.push(patch),
    addLog: () => {},
    compactError: String,
    now: () => 126000,
    concurrency: 2
  });
  const results = await coordinator.refreshAll("timer");
  assert.equal(results.every((item) => item.ok === false), true);
  assert.equal(settingsWrites.length, 0);
});

function testSecretCodec() {
  return createSecretCodec({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, "")
  });
}
