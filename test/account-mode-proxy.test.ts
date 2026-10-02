import assert from "node:assert/strict";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createGateway } from "../src/main/gateway.ts";
import { applyAccountMode, readOpenaiBaseUrl } from "../src/main/codex-cli-auth.ts";

test("账号模式通过 API 服务透明转发 HTTP 并只观察 Responses", async () => {
  const received: Array<{ url: string; headers: IncomingMessage["headers"]; body: Buffer }> = [];
  const upstream = await listenHttp(async (request, response) => {
    const body = await readBody(request);
    received.push({ url: request.url || "", headers: request.headers, body });
    if (request.url?.startsWith("/backend-api/codex/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"data":[]}');
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"cached_input_tokens":2,"output_tokens":3,"total_tokens":10}}}\n\n');
  });
  const harness = await createHarness(upstream.url, true);
  try {
    const body = JSON.stringify({ model: "gpt-account-proxy", input: "hello" });
    const response = await fetch(`${harness.gateway.status().url}/v1/responses?stream=true`, {
      method: "POST",
      headers: {
        authorization: "Bearer account-token",
        "content-type": "application/json",
        "session-id": "account-session",
        version: "0.154.0"
      },
      body
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response\.completed/);
    assert.equal(received[0]?.url, "/backend-api/codex/responses?stream=true");
    assert.equal(received[0]?.headers.authorization, "Bearer account-token");
    assert.equal(received[0]?.headers.host, new URL(upstream.url).host);
    assert.equal(received[0]?.body.toString("utf8"), body);
    expect(harness.tokenLogs[0]).toEqual(expect.objectContaining({
      account_id: "account-a",
      method: "POST",
      request_path: "/v1/responses",
      upstream_path: "/backend-api/codex/responses?stream=true",
      status: 200,
      input_tokens: 7,
      output_tokens: 3,
      estimated_cost: 0.000009,
      cost_unit: "USD"
    }));

    const models = await fetch(`${harness.gateway.status().url}/v1/models`, {
      headers: { authorization: "Bearer account-token" }
    });
    assert.equal(models.status, 200);
    assert.equal(await models.text(), '{"data":[]}');
    assert.equal(received[1]?.url, "/backend-api/codex/models");
    assert.equal(harness.tokenLogs.length, 1);

    await harness.gateway.apiDebugLogger.flush();
    const entries = readDebugEntries(harness.dataDir);
    assert.deepEqual(entries.map((entry) => entry.kind), ["request", "response"]);
    assert.ok(entries.every((entry) => entry.mode === "account_proxy" && entry.transport === "http"));
    assert.equal(entries[0]?.headers.authorization, "[REDACTED]");
    assert.equal(entries[0]?.path, "/v1/responses?stream=true");
  } finally {
    await harness.close();
    await upstream.close();
  }
});

test("账号代理模式透明转发独立搜索并保留账号凭证", async () => {
  const body = JSON.stringify({ id: "account-search", model: "gpt-6-astra", commands: { search_query: [{ q: "OpenAI 官网" }] } });
  const output = JSON.stringify({ output: "搜索结果", results: [] });
  const received: Array<{ url: string; authorization: string | undefined; body: string }> = [];
  const upstream = await listenHttp(async (request, response) => {
    received.push({ url: request.url || "", authorization: request.headers.authorization, body: (await readBody(request)).toString("utf8") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(output);
  });
  const harness = await createHarness(upstream.url, false);
  try {
    const response = await fetch(`${harness.gateway.status().url}/v1/alpha/search`, {
      method: "POST",
      headers: { authorization: "Bearer account-token", "content-type": "application/json" },
      body
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), output);
    assert.deepEqual(received, [{ url: "/backend-api/codex/alpha/search", authorization: "Bearer account-token", body }]);
    assert.equal(harness.tokenLogs.length, 0);
  } finally {
    await harness.close();
    await upstream.close();
  }
});

test("账号模式通过 API 服务透明转发 WebSocket 并只观察 Responses", async () => {
  const upstreamServer = http.createServer();
  const upstreamWebSocket = new WebSocketServer({ server: upstreamServer, perMessageDeflate: true });
  const received: Array<{ url: string; authorization: string; message: string }> = [];
  upstreamWebSocket.on("connection", (websocket, request) => {
    websocket.on("message", (data, isBinary) => {
      received.push({
        url: request.url || "",
        authorization: String(request.headers.authorization || ""),
        message: data.toString()
      });
      websocket.send(data, { binary: isBinary });
      websocket.send('{"type":"response.completed","response":{"model":"gpt-account-ws","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}');
    });
  });
  const upstream = await listenExisting(upstreamServer);
  const harness = await createHarness(upstream.url, true);
  try {
    const gatewayUrl = harness.gateway.status().url.replace(/^http:/, "ws:");
    const websocket = new WebSocket(`${gatewayUrl}/v1/responses?stream=true`, {
      headers: {
        authorization: "Bearer account-ws-token",
        "session-id": "account-ws-session",
        version: "0.154.0"
      }
    });
    await onceOpen(websocket);
    const messages = nextMessages(websocket, 2);
    const requestMessage = '{"type":"response.create","model":"gpt-account-ws"}';
    websocket.send(requestMessage);
    assert.equal((await messages)[0], requestMessage);
    websocket.close(1000, "done");
    await onceClose(websocket);

    assert.deepEqual(received, [{
      url: "/backend-api/codex/responses?stream=true",
      authorization: "Bearer account-ws-token",
      message: requestMessage
    }]);
    await waitFor(() => harness.tokenLogs.length === 1);
    expect(harness.tokenLogs[0]).toEqual(expect.objectContaining({
      account_id: "account-a",
      method: "WS",
      request_path: "/v1/responses",
      upstream_path: "/backend-api/codex/responses?stream=true",
      input_tokens: 4,
      output_tokens: 2,
      estimated_cost: 0.000006
    }));

    const passthrough = new WebSocket(`${gatewayUrl}/v1/other`, {
      headers: { authorization: "Bearer other-token" }
    });
    await onceOpen(passthrough);
    const passthroughMessages = nextMessages(passthrough, 2);
    passthrough.send("other-message");
    await passthroughMessages;
    passthrough.close(1000, "done");
    await onceClose(passthrough);
    assert.equal(harness.tokenLogs.length, 1);

    await harness.gateway.apiDebugLogger.flush();
    const entries = readDebugEntries(harness.dataDir);
    assert.ok(entries.some((entry) => entry.status === 101));
    assert.ok(entries.some((entry) => String(entry.message || "").includes("response.completed")));
    assert.equal(entries.some((entry) => String(entry.message || "").includes("other-message")), false);
  } finally {
    await harness.close();
    await new Promise<void>((resolve) => upstreamWebSocket.close(() => resolve()));
    await upstream.close();
  }
});

test("关闭账号代理开关后恢复原 API 鉴权，应用账号模式按开关更新 Base URL", async () => {
  const upstream = await listenHttp((_request, response) => response.end("{}"));
  const harness = await createHarness(upstream.url, false);
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-account-config-"));
  const configPath = path.join(codexDir, "config.toml");
  fs.writeFileSync(configPath, 'model = "gpt-test"\nopenai_base_url = "https://example.test/original"\n', "utf8");
  try {
    harness.settings.account_mode_use_api_proxy = "false";
    const unauthorized = await fetch(`${harness.gateway.status().url}/v1/models`, {
      headers: { authorization: "Bearer account-token" }
    });
    assert.equal(unauthorized.status, 401);

    const account = { id: "account-a", access_token: "access-a", refresh_token: "refresh-a", account_id: "workspace-a" };
    applyAccountMode(account, { codexDir, accountModeBaseUrl: "http://127.0.0.1:8436/v1" });
    assert.equal(readOpenaiBaseUrl(fs.readFileSync(configPath, "utf8")), "http://127.0.0.1:8436/v1");
    applyAccountMode(account, { codexDir });
    assert.equal(readOpenaiBaseUrl(fs.readFileSync(configPath, "utf8")), "");
  } finally {
    fs.rmSync(codexDir, { recursive: true, force: true });
    await harness.close();
    await upstream.close();
  }
});

test("API 调试关闭或观察写入失败都不影响账号 Responses 转发", async () => {
  const upstream = await listenHttp((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}');
  });
  const harness = await createHarness(upstream.url, false, true);
  try {
    const response = await fetch(`${harness.gateway.status().url}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer account-token", "content-type": "application/json" },
      body: '{"model":"gpt-observer-failure"}'
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /total_tokens/);
    await harness.gateway.apiDebugLogger.flush();
    assert.equal(fs.existsSync(path.join(harness.dataDir, "logs")), false);
  } finally {
    await harness.close();
    await upstream.close();
  }
});

test("账号透明代理按实际身份同步 HTTP 头和 SSE 周额度", async () => {
  const upstream = await listenHttp(async (request, response) => {
    await readBody(request);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "x-codex-primary-used-percent": "20",
      "x-codex-primary-window-minutes": "10080"
    });
    response.end('data: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":21,"window_minutes":10080}}}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3}}}\n\n');
  });
  const harness = await createHarness(upstream.url, false);
  harness.accounts.push({ id: "actual-account", account_id: "actual-workspace" });
  harness.settings.ignore_five_hour_limit = "true";
  try {
    for (const workspace of ["actual-workspace", "unknown-workspace"]) {
      const response = await fetch(`${harness.gateway.status().url}/v1/responses`, {
        method: "POST", headers: { authorization: "Bearer account-token", "chatgpt-account-id": workspace }, body: "{}"
      });
      assert.match(await response.text(), /response.completed/);
    }
    assert.deepEqual(harness.quotaUpdates.map((usage) => [usage.id, usage.quota_7d_used_percent]), [["actual-account", 20], ["actual-account", 21]]);
  } finally {
    await harness.close();
    await upstream.close();
  }
});

test("账号透明代理在 WebSocket 完成响应后仍同步周额度并归属实际账号", async () => {
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => socket.once("message", () => {
    socket.send('{"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3}}}');
    socket.send('{"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":48,"window_minutes":10080},"secondary":null}}');
  }));
  const upstream = await listenExisting(server);
  const harness = await createHarness(upstream.url, false);
  harness.accounts.push({ id: "actual-account", account_id: "workspace-b", access_token: "account-token" });
  harness.settings.ignore_five_hour_limit = "true";
  let client: WebSocket | undefined;
  try {
    client = new WebSocket(`${harness.gateway.status().url.replace(/^http:/, "ws:")}/v1/responses`, {
      headers: { authorization: "Bearer account-token", "chatgpt-account-id": "workspace-b" }
    });
    await onceOpen(client);
    const messages = nextMessages(client, 2);
    client.send('{"type":"response.create","model":"gpt-account-ws"}');
    await messages;
    assert.equal(harness.tokenLogs[0]?.account_id, "actual-account");
    assert.equal(harness.tokenLogs[0]?.total_tokens, 15);
    assert.equal(harness.quotaUpdates[0]?.id, "actual-account");
    assert.equal(harness.quotaUpdates[0]?.quota_7d_used_percent, 48);
    assert.equal(harness.quotaUpdates[0]?.has_five_hour_quota, 0);
    const closed = onceClose(client);
    client.close();
    await closed;
  } finally {
    client?.terminate();
    await harness.close();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await upstream.close();
  }
});

const createHarness = async (upstreamBaseUrl: string, debugEnabled: boolean, failObservation = false) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-account-api-proxy-"));
  const tokenLogs: Array<Record<string, unknown>> = [];
  const quotaUpdates: Array<Record<string, unknown>> = [];
  const accounts: Array<Record<string, any>> = [];
  const settings: Record<string, string> = {
    gateway_host: "127.0.0.1",
    gateway_port: "0",
    gateway_api_key: "local-key",
    gateway_shutdown_grace_ms: "100",
    gateway_websocket_buffer_high_water_bytes: "2097152",
    gateway_websocket_idle_timeout_ms: "5000",
    codex_auth_mode: "account",
    account_mode_use_api_proxy: "true",
    codex_selected_account_id: "account-a",
    debug_api_logging: debugEnabled ? "true" : "false",
    billing_currency: "USD"
  };
  const store = {
    paths: { dataDir },
    getSettings: () => ({ ...settings }),
    saveSettings: (patch: Record<string, string>) => Object.assign(settings, patch),
    listAccounts: () => accounts,
    updateUsage: (id: string, usage: Record<string, unknown>) => quotaUpdates.push({ id, ...usage }),
    addTokenLog: (entry: Record<string, unknown>) => {
      if (failObservation) throw new Error("database unavailable");
      tokenLogs.push(entry);
    },
    addAppLog: () => undefined
  };
  const gateway = createGateway(store, null, {
    accountModeUpstreamBaseUrl: upstreamBaseUrl,
    upstreamService: {
      getModelPricing: () => ({ inputPerMillion: 1, cachedInputPerMillion: 0.5, outputPerMillion: 1 })
    }
  });
  await gateway.start();
  if (debugEnabled) await gateway.setApiDebugLogging(true);
  return {
    dataDir,
    gateway,
    settings,
    tokenLogs,
    accounts,
    quotaUpdates,
    async close() {
      await gateway.stop();
      await gateway.apiDebugLogger.flush();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
};

const listenHttp = async (handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) => {
  const server = http.createServer((request, response) => void handler(request, response));
  return listenExisting(server);
};

const listenExisting = async (server: http.Server) => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务没有监听端口。");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
};

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const readDebugEntries = (dataDir: string): Array<Record<string, any>> => {
  const logDir = path.join(dataDir, "logs");
  const files = fs.readdirSync(logDir);
  assert.equal(files.length, 1);
  return fs.readFileSync(path.join(logDir, files[0] || ""), "utf8").trim().split("\n").map((line) => JSON.parse(line));
};

const onceOpen = (websocket: WebSocket): Promise<void> => new Promise((resolve, reject) => {
  websocket.once("open", () => resolve());
  websocket.once("error", reject);
});

const onceClose = (websocket: WebSocket): Promise<void> => new Promise((resolve) => websocket.once("close", () => resolve()));

const nextMessages = (websocket: WebSocket, count: number): Promise<string[]> => new Promise((resolve, reject) => {
  const messages: string[] = [];
  const timer = setTimeout(() => reject(new Error("等待 WebSocket 消息超时。")), 2_000);
  websocket.on("message", (data) => {
    messages.push(data.toString());
    if (messages.length < count) return;
    clearTimeout(timer);
    resolve(messages);
  });
});

const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("等待测试状态超时。");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
