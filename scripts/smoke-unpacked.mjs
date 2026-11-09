import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const backupMagic = Buffer.from("CODEXIA-BACKUP-V1\n", "utf8");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceUnpackedRoot = path.join(projectRoot, "release", "win-unpacked");
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-packaged-smoke-"));
const unpackedRoot = path.join(smokeRoot, "win-unpacked");
const smokeHome = path.join(smokeRoot, "home");
if (!fs.existsSync(path.join(sourceUnpackedRoot, "Codexia.exe"))) {
  throw new Error(`Missing unpacked executable: ${path.join(sourceUnpackedRoot, "Codexia.exe")}`);
}
fs.cpSync(sourceUnpackedRoot, unpackedRoot, { recursive: true });
fs.mkdirSync(smokeHome, { recursive: true });
process.once("exit", cleanupSmokeRoot);
const executable = path.join(unpackedRoot, "Codexia.exe");
const database = path.join(unpackedRoot, "data", "codex-gateway.sqlite");
const screenshotArgument = process.argv.find((argument) => argument.startsWith("--screenshot="));
const screenshotPath = screenshotArgument ? path.resolve(projectRoot, screenshotArgument.slice("--screenshot=".length)) : null;

if (process.platform !== "win32") throw new Error("The unpacked smoke test currently supports Windows only.");
// 只给即将删除的测试副本添加沙箱读取权限，避免继承临时目录 ACL 后被 Electron 拒绝启动。
const sandboxReadAccess = spawnSync("icacls.exe", [unpackedRoot, "/grant", "*S-1-15-2-1:(OI)(CI)(RX)"], {
  windowsHide: true,
  encoding: "utf8"
});
if (sandboxReadAccess.status !== 0) {
  throw new Error(`Cannot grant sandbox read access to the isolated test copy: ${sandboxReadAccess.stderr || sandboxReadAccess.stdout}`);
}
const debuggingPort = await freePort();
const child = spawn(executable, [
  "--no-sandbox",
  "--disable-gpu",
  "--disable-software-rasterizer",
  `--remote-debugging-port=${debuggingPort}`
], {
  cwd: unpackedRoot,
  env: {
    ...process.env,
    CODEX_HOME: path.join(smokeHome, ".codex"),
    HOME: smokeHome,
    USERPROFILE: smokeHome
  },
  detached: false,
  stdio: "ignore",
  windowsHide: true
});

let inspection;
try {
  const target = await waitForPage(debuggingPort, child);
  inspection = await waitForRenderer(target.webSocketDebuggerUrl, child);
  if (screenshotPath) {
    assertScreenshotPath(screenshotPath);
    await navigateToPage(target.webSocketDebuggerUrl, child, "overview", "运行概览");
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, await captureScreenshot(target.webSocketDebuggerUrl));
  }
  inspection.statisticLayout = await inspectStatisticLayout(target.webSocketDebuggerUrl, child);
  inspection.pageCount = await inspectLazyPages(target.webSocketDebuggerUrl, child);
  await navigateToPage(target.webSocketDebuggerUrl, child, "settings", "账号与额度");
  inspection.quotaNormalization = await inspectQuotaNormalization(target.webSocketDebuggerUrl);
  inspection.officialPricing = await inspectOfficialPricing(target.webSocketDebuggerUrl);
  inspection.overviewModelCount = await inspectOverviewModelCount(target.webSocketDebuggerUrl, child);
  inspection.accessModeMonitoring = await inspectAccessModeMonitoring(target.webSocketDebuggerUrl);
} finally {
  stopProcessTree(child.pid);
}

/** 只在隔离配置目录及本机测试上游验证模式切换、透明转发与 Electron 写入线程。 */
async function inspectAccessModeMonitoring(debuggerUrl) {
  const body = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n';
  const received = [];
  const upstream = http.createServer((request, response) => {
    received.push({ url: request.url, key: request.headers.authorization });
    request.resume();
    request.on("end", () => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(body); });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const port = await freePort();
  try {
    const channel = await evaluate(debuggerUrl, `(async () => {
      const api = window.codexGateway;
      await api.saveSettings({ gateway_host: '127.0.0.1', gateway_port: '${port}', third_party_auto_restart_app_server: 'false' });
      const channel = await api.saveUpstream({ name: '隔离监控检查', provider: 'custom',
        enabled: false, supportsWebSocket: false, balanceQueryType: 'none', modelPricing: {},
        baseUrl: 'http://127.0.0.1:${upstream.address().port}/custom/v1', apiKey: 'smoke-monitor-key',
        modelCatalogJson: JSON.stringify({ models: [{ slug: 'smoke-monitor-model', display_name: '测试模型' }] }) });
      await api.applyApiAuth('third_party', channel.id, false);
      const applied = await api.bootstrap();
      if (applied.settings.third_party_use_api_proxy !== 'true') throw new Error('第三方模式未强制启用代理');
      await api.applyApiAuth('third_party', channel.id, true);
      return channel.id;
    })()`);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", headers: { authorization: "Bearer smoke-monitor-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "smoke-monitor-model", stream: true })
    });
    if (response.status !== 200 || await response.text() !== body) throw new Error("打包代理改写了响应");
    const logs = await evaluate(debuggerUrl, `window.codexGateway.listTokenLogs({ page: 1, pageSize: 10, startAt: 0, endAt: ${Math.floor(Date.now() / 1000) + 60}, upstreamId: ${JSON.stringify(channel)} })`);
    if (logs.total !== 1 || logs.items[0].total_tokens !== 5) throw new Error("打包监控线程未正确落盘");
    if (received[0]?.url !== "/custom/v1/responses" || received[0]?.key !== "Bearer smoke-monitor-key") throw new Error("透明代理请求不一致");
    const models = await fetch(`http://127.0.0.1:${port}/v1/models`).then(response => response.json());
    if (models.data.length !== 1 || models.data[0].id !== 'smoke-monitor-model') throw new Error('第三方模式泄露了其他渠道模型');
    await evaluate(debuggerUrl, "window.codexGateway.stopGateway()");
    return { forcedProxyApplied: true, transparent: true, workerPersisted: true, selectedModelsOnly: true };
  } finally { await new Promise(resolve => upstream.close(resolve)); }
}

/** 检查官方渠道在真实打包 IPC 中继承费率，并保留用户明确设置的零费率。 */
async function inspectOfficialPricing(webSocketDebuggerUrl) {
  return evaluate(webSocketDebuggerUrl, `(async () => {
    const api = window.codexGateway;
    const poolId = 'builtin-chatgpt-subscription-pool';
    const model = (await api.listUpstreamModels(poolId)).find(item => item.available);
    if (!model) throw new Error('内置模型目录为空，无法验证官方费率');
    const rates = { inputPerMillion: 2, cachedInputPerMillion: 0.1, outputPerMillion: 10 };
    await api.saveUpstreamModelPricing(poolId, { [model.modelId]: rates });
    let channel;
    try {
      channel = await api.saveUpstream({ provider: 'openai', apiKey: 'packaged-test-key' });
      const inherited = (await api.listUpstreamModels(channel.id)).find(item => item.modelId === model.modelId);
      if (!inherited?.pricingConfigured || JSON.stringify(inherited.pricing) !== JSON.stringify(rates)) throw new Error('官方渠道未继承费率');
      await api.saveUpstreamModelPricing(channel.id, { [model.modelId]: { inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 } });
      await api.saveUpstream({ id: channel.id, provider: 'openai', name: '打包费率检查' });
      const saved = (await api.listUpstreamModels(channel.id)).find(item => item.modelId === model.modelId);
      if (!saved?.pricingConfigured || saved.pricing.inputPerMillion !== 0) throw new Error('官方渠道没有保留手动零费率');
    } finally {
      if (channel) await api.deleteUpstream(channel.id);
      await api.saveUpstreamModelPricing(poolId, { [model.modelId]: model.pricing });
    }
    return true;
  })()`);
}

/** 在官方渠道与订阅池共享模型时，检查实际打包页面是否按可见模型去重统计。 */
async function inspectOverviewModelCount(webSocketDebuggerUrl, processHandle) {
  const fixture = await evaluate(webSocketDebuggerUrl, `(async () => {
    const api = window.codexGateway;
    const channel = await api.saveUpstream({ provider: 'openai', apiKey: 'packaged-model-count-test-key' });
    return { id: channel.id, expected: (await api.getModelManagement()).filter(model => model.visible).length };
  })()`);
  try {
    // 重新加载以清空查询缓存，确保读到的是官方渠道启用后的真实统计。
    await evaluate(webSocketDebuggerUrl, "location.reload(); true");
    await waitForRenderer(webSocketDebuggerUrl, processHandle);
    await navigateToPage(webSocketDebuggerUrl, processHandle, "overview", "运行概览");
    const actual = await evaluate(webSocketDebuggerUrl, `(async () => {
      for (let attempt = 0; attempt < 60; attempt++) {
        const title = Array.from(document.querySelectorAll('.ant-statistic-title')).find(item => item.textContent === '可选模型');
        const value = title?.closest('.ant-statistic')?.querySelector('.ant-statistic-content-value')?.textContent;
        if (value && value !== '-') return Number(value.replaceAll(',', ''));
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('打包页面未显示可选模型数量');
    })()`);
    if (actual !== fixture.expected) throw new Error(`可选模型数量重复统计：预期 ${fixture.expected}，实际 ${actual}`);
    return { expected: fixture.expected, actual };
  } finally {
    await evaluate(webSocketDebuggerUrl, `window.codexGateway.deleteUpstream(${JSON.stringify(fixture.id)})`);
  }
}

/** 检查真实安装包中的额度配置、表单默认值及保存回读。 */
async function inspectQuotaNormalization(webSocketDebuggerUrl) {
  return evaluate(webSocketDebuggerUrl, `(async () => {
    const api = window.codexGateway;
    const defaults = { plus: '1', prolite: '10', pro: '20', promax: '50', free: '0', go: '0', other: '1' };
    const original = (await api.bootstrap()).settings;
    for (const [plan, value] of Object.entries(defaults)) {
      if (original['gpt_quota_multiplier_' + plan] !== value) throw new Error('套餐默认倍率错误：' + plan);
    }
    const menu = Array.from(document.querySelectorAll('[role="menuitem"]')).find(item => item.textContent.includes('账号与额度'));
    if (!menu) throw new Error('没有找到账号与额度设置');
    menu.click();
    for (let attempt = 0; attempt < 50 && !document.getElementById('gpt_quota_multiplier_pro'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    for (const [plan, value] of Object.entries(defaults)) {
      if (document.getElementById('gpt_quota_multiplier_' + plan)?.value !== value) throw new Error('套餐倍率表单错误：' + plan);
    }
    const toggle = document.querySelector('[aria-label="按 Plus 基准折算额度"]');
    if (toggle) throw new Error('不应显示额度折算开关');
    try {
      await api.saveSettings({ gpt_quota_multiplier_pro: '12.5' });
      const saved = (await api.bootstrap()).settings;
      if (saved.gpt_quota_multiplier_pro !== '12.5') throw new Error('套餐额度配置保存失败');
      const quota = await api.quotaSummary();
      if (!Number.isFinite(quota.capacity_percent) || !Number.isFinite(quota.primary.remaining_percent)) throw new Error('额度折算结果无效');
    } finally {
      await api.saveSettings({ gpt_quota_multiplier_pro: original.gpt_quota_multiplier_pro });
    }
    const restored = (await api.bootstrap()).settings;
    if (restored.gpt_quota_multiplier_pro !== original.gpt_quota_multiplier_pro) throw new Error('额度配置恢复失败');
    return true;
  })()`);
}

async function inspectRenderer(webSocketDebuggerUrl) {
  return evaluate(webSocketDebuggerUrl, `
    (async () => {
      const bootstrap = await window.codexGateway.bootstrap();
      const root = document.getElementById("root");
      const shell = document.querySelector(".v1-shell");
      const content = document.querySelector(".v1-content");
      const navigation = document.querySelector(".v1-navigation");
      return {
        bridgeReady: typeof window.codexGateway === "object"
          && typeof window.codexGateway.bootstrap === "function",
        rootChildCount: root?.childElementCount ?? 0,
        title: document.title,
        gatewayRunning: bootstrap.gateway.running,
        mcpGatewayRunning: bootstrap.mcpGateway.running,
        gatewayKeyExposed: Object.prototype.hasOwnProperty.call(bootstrap.settings, "gateway_api_key"),
        viewportHeight: window.innerHeight,
        rootHeight: Math.round(root?.getBoundingClientRect().height ?? 0),
        shellHeight: Math.round(shell?.getBoundingClientRect().height ?? 0),
        contentOverflowY: content ? getComputedStyle(content).overflowY : null,
        navigationOverflowY: navigation ? getComputedStyle(navigation).overflowY : null
      };
    })()
  `);
}

if (!inspection?.bridgeReady) throw new Error("Packaged preload bridge was not exposed.");
if (inspection.rootChildCount < 1) throw new Error("Packaged renderer did not mount its React root.");
if (inspection.title !== "Codexia") throw new Error(`Unexpected packaged page title: ${inspection.title}`);
if (inspection.gatewayRunning || inspection.mcpGatewayRunning) {
  throw new Error("Fresh packaged data unexpectedly auto-started the API or MCP service.");
}
if (inspection.gatewayKeyExposed) throw new Error("Gateway API key crossed the packaged renderer boundary.");
if (Math.abs(inspection.rootHeight - inspection.viewportHeight) > 2
  || Math.abs(inspection.shellHeight - inspection.viewportHeight) > 2) {
  throw new Error(`Packaged shell did not fill the viewport: ${JSON.stringify(inspection)}`);
}
if (inspection.contentOverflowY !== "auto" || inspection.navigationOverflowY !== "auto") {
  throw new Error(`Packaged shell lost its independent scroll regions: ${JSON.stringify(inspection)}`);
}
if (!fs.existsSync(database) || fs.statSync(database).size === 0) {
  throw new Error("Packaged application did not initialize its SQLite database.");
}
if (fs.existsSync(path.join(unpackedRoot, "resources", "app", "src"))) {
  throw new Error("Packaged application unexpectedly contains the source directory.");
}
const legacyUpgrade = process.argv.includes("--expect-legacy-upgrade")
  ? verifyLegacyUpgrade(database, unpackedRoot)
  : null;
const packageAudit = verifyPackageResources(unpackedRoot);

console.log(JSON.stringify({
  ...inspection,
  databaseBytes: fs.statSync(database).size,
  sourceDirectoryAbsent: true,
  isolatedPackageLaunch: true,
  independentScrollRegions: true,
  packageAudit,
  ...(legacyUpgrade ? { legacyUpgrade } : {})
}));
process.exit(0);

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not reserve a DevTools inspection port.");
  return port;
}

async function waitForPage(port, processHandle) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Packaged application exited before renderer inspection (code ${processHandle.exitCode}).`);
    }
    try {
      const response = await fetch(endpoint);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page?.title === "Codexia" && page.url?.endsWith("/dist/renderer/index.html")) return page;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for packaged renderer.${lastError ? ` ${lastError.message}` : ""}`);
}

async function waitForRenderer(webSocketDebuggerUrl, processHandle) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Packaged application exited before renderer bootstrap (code ${processHandle.exitCode}).`);
    }
    try {
      const result = await inspectRenderer(webSocketDebuggerUrl);
      if (result?.bridgeReady
        && result.rootChildCount > 0
        && result.shellHeight > 0
        && result.contentOverflowY
        && result.navigationOverflowY) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for packaged preload and React bootstrap.${lastError ? ` ${lastError.message}` : ""}`);
}

/** 使用真实 Chromium 排版检查统计项的权重、换行及窄容器边界。 */
async function inspectStatisticLayout(webSocketDebuggerUrl, processHandle) {
  const results = {};
  for (const [route, title, selector] of [
    ["overview", "今日调用", ".v1-overview-statistics"],
    ["analytics", "汇总指标", ".v1-analytics-summary"]
  ]) {
    await navigateToPage(webSocketDebuggerUrl, processHandle, route, title);
    if (route === "analytics") {
      await evaluate(webSocketDebuggerUrl, `(() => {
        const header = Array.from(document.querySelectorAll('th')).find(item => item.textContent.includes('输出速度'));
        if (!header) throw new Error('输出速度列缺失');
        const range = document.createRange();
        range.selectNodeContents(header);
        const text = range.getBoundingClientRect();
        const cell = header.getBoundingClientRect();
        const style = getComputedStyle(header);
        if (text.width > cell.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + 1) {
          throw new Error('输出速度表头宽度不足：文字 ' + text.width + 'px，单元格 ' + cell.width + 'px');
        }
        return true;
      })()`);
    }
    results[route] = await evaluate(webSocketDebuggerUrl, `(() => {
      const container = document.querySelector(${JSON.stringify(selector)});
      const sizing = container.parentElement;
      const originalWidth = sizing.style.width;
      const originalFlex = sizing.style.flex;
      const samples = [];
      try {
        sizing.style.flex = 'none';
        for (const width of [1100, 780, 420, 280]) {
          sizing.style.width = width + 'px';
          const bounds = container.getBoundingClientRect();
          const cells = Array.from(container.children).map(cell => ({
            title: cell.querySelector('.ant-statistic-title')?.textContent,
            width: cell.getBoundingClientRect().width,
            left: cell.getBoundingClientRect().left,
            right: cell.getBoundingClientRect().right,
            top: cell.getBoundingClientRect().top
          }));
          if (cells.some(cell => cell.width <= 0 || cell.left < bounds.left - 1 || cell.right > bounds.right + 1)) throw new Error('统计项超出容器');
          if (width >= 780 && new Set(cells.map(cell => Math.round(cell.top))).size !== 1) throw new Error('桌面统计项没有保持单行');
          if (width === 1100) {
            const calls = cells.find(cell => cell.title === '调用');
            const tokens = cells.find(cell => cell.title === '总 Token');
            const cost = cells.find(cell => cell.title.startsWith('估算成本'));
            if (!(tokens.width > calls.width && cost.width > calls.width)) throw new Error('统计项仍为平均宽度');
          }
          if (width === 280 && new Set(cells.map(cell => Math.round(cell.top))).size <= 1) throw new Error('窄屏统计项未换行');
          samples.push({ width, cells: cells.map(({ title, width }) => ({ title, width: Math.round(width) })) });
        }
      } finally { sizing.style.width = originalWidth; sizing.style.flex = originalFlex; }
      return samples;
    })()`);
    if (screenshotPath) {
      const file = screenshotPath.replace(/\.png$/i, '-' + route + '-statistics.png');
      await evaluate(webSocketDebuggerUrl, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block: 'center', behavior: 'instant'}); true`);
      fs.writeFileSync(file, await captureScreenshot(webSocketDebuggerUrl));
    }
  }
  return results;
}

async function inspectLazyPages(webSocketDebuggerUrl, processHandle) {
  // 已下线的任务菜单及预加载接口均不可再访问。
  const removed = await evaluate(webSocketDebuggerUrl, `({
    menus: Array.from(document.querySelectorAll("[role=menuitem]")).some(item => /会话唤醒|定时任务/.test(item.textContent)),
    methods: Object.keys(window.codexGateway).filter(key => /SessionWakeup|ScheduledTask/.test(key))
  })`);
  if (removed.menus || removed.methods.length) throw new Error("已下线任务功能仍可访问");
  const pages = [
    ["overview", "运行概览"],
    ["accounts", "订阅账号"],
    ["upstreams", "模型渠道"],
    ["services", "服务管理"],
    ["analytics", "调用分析"],
    ["runtimeLogs", "运行日志"],
    ["codexIntegration", "接入模式"],
    ["settings", "设置中心"]
  ];
  for (const [route, expectedText] of pages) {
    await navigateToPage(webSocketDebuggerUrl, processHandle, route, expectedText);
  }
  return pages.length;
}

async function navigateToPage(webSocketDebuggerUrl, processHandle, route, expectedText) {
  await evaluate(webSocketDebuggerUrl, `location.hash = ${JSON.stringify(`#/${route}`)}; true`);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Packaged application exited while loading ${route} (code ${processHandle.exitCode}).`);
    }
    const state = await evaluate(webSocketDebuggerUrl, `({
      text: document.body.innerText,
      rootChildCount: document.getElementById("root")?.childElementCount ?? 0
    })`);
    if (state?.rootChildCount > 0 && state.text?.includes(expectedText)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Packaged lazy page did not render: ${route} (${expectedText}).`);
}

function captureScreenshot(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Timed out capturing packaged renderer screenshot."));
    }, 5_000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Page.captureScreenshot",
        params: { format: "png", captureBeyondViewport: false }
      }));
    });
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.terminate();
      if (message.error || !message.result?.data) {
        reject(new Error(message.error?.message || "Packaged renderer screenshot was empty."));
        return;
      }
      resolve(Buffer.from(message.result.data, "base64"));
    });
  });
}

function assertScreenshotPath(targetPath) {
  const screenshotRoot = path.resolve(projectRoot, "docs", "screenshots");
  const relative = path.relative(screenshotRoot, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(targetPath).toLowerCase() !== ".png") {
    throw new Error(`Screenshot output must be a PNG under docs/screenshots: ${targetPath}`);
  }
}

function evaluate(webSocketUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Timed out evaluating packaged renderer state."));
    }, 5_000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true }
      }));
    });
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.terminate();
      if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text || "Renderer evaluation failed."));
        return;
      }
      resolve(message.result?.result?.value);
    });
  });
}

function stopProcessTree(pid) {
  if (!pid) return;
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore"
  });
  spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-Process | Where-Object { $_.Path -eq $env:CODEX_GATEWAY_SMOKE_EXE } | Stop-Process -Force"
  ], {
    env: { ...process.env, CODEX_GATEWAY_SMOKE_EXE: executable },
    windowsHide: true,
    stdio: "ignore"
  });
}

function verifyLegacyUpgrade(databasePath, applicationRoot) {
  const databaseHandle = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = Number(databaseHandle.prepare("PRAGMA user_version").get()?.user_version || 0);
    const fixtureValue = databaseHandle.prepare("SELECT value FROM settings WHERE key = 'legacy_packaged_fixture'").get()?.value;
    const builtInUpstream = databaseHandle.prepare("SELECT base_url FROM upstreams WHERE id = 'builtin-chatgpt-subscription-pool'").get()?.base_url;
    const compactAdaptColumn = databaseHandle.prepare("PRAGMA table_info(upstreams)").all()
      .some((column) => column.name === "compact_adapt_enabled");
    const legacyRoutingTableCount = Number(databaseHandle.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('routing_policy_targets', 'routing_policies', 'model_mappings', 'codex_sessions')
    `).get()?.count || 0);
    const backupDirectory = path.join(applicationRoot, "data", "backups");
    const backups = fs.existsSync(backupDirectory)
      ? fs.readdirSync(backupDirectory).filter((file) => file.endsWith(".sqlite.enc"))
      : [];
    const encryptedBackups = backups.filter((file) => {
      const handle = fs.openSync(path.join(backupDirectory, file), "r");
      try {
        const magic = Buffer.alloc(backupMagic.length);
        return fs.readSync(handle, magic, 0, magic.length, 0) === magic.length
          && magic.equals(backupMagic);
      } finally {
        fs.closeSync(handle);
      }
    });
    const browserMarkerPreserved = fs.existsSync(path.join(applicationRoot, "data", "browser", "v0-browser-marker.txt"));
    if (version !== 9 || fixtureValue !== "preserved" || builtInUpstream !== "https://legacy.example.test/backend-api/codex"
      || !compactAdaptColumn || legacyRoutingTableCount !== 0 || encryptedBackups.length < 1 || !browserMarkerPreserved) {
      throw new Error("Packaged legacy upgrade did not preserve data, reach the current schema, or create an encrypted backup.");
    }
    return {
      version,
      backupCount: encryptedBackups.length,
      browserMarkerPreserved,
      compactAdaptColumn,
      legacyRoutingTablesRemoved: true
    };
  } finally {
    databaseHandle.close();
  }
}

function verifyPackageResources(applicationRoot) {
  const appRoot = path.join(applicationRoot, "resources", "app");
  const rendererRoot = path.join(appRoot, "dist", "renderer");
  const html = fs.readFileSync(path.join(rendererRoot, "index.html"), "utf8");
  const mainBundle = fs.readFileSync(path.join(appRoot, "dist", "main", "main.mjs"), "utf8");
  const packagedFiles = listFiles(appRoot).map((file) => path.relative(appRoot, file).replaceAll("\\", "/"));
  const forbidden = packagedFiles.filter((file) => /(^|\/)(?:test|tests|fixtures|backups)(\/|$)|\.(?:sqlite|db|bak|env)$/i.test(file));
  if (forbidden.length > 0) throw new Error(`Packaged application contains forbidden files: ${forbidden.join(", ")}`);
  if (/(?:src|href)=["']https?:\/\//i.test(html)) throw new Error("Packaged renderer references a remote script, style, font, or image.");
  const rendererScripts = listFiles(rendererRoot)
    .filter((file) => file.endsWith(".js"))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  if (!mainBundle.includes("app:listSystemFonts") || !mainBundle.includes("CurrentVersion\\\\Fonts")) {
    throw new Error("Packaged main process is missing system font discovery.");
  }
  if (!rendererScripts.includes("appearance_font_family") || !rendererScripts.includes("选择系统字体")) {
    throw new Error("Packaged renderer is missing the system font selector.");
  }
  if (packagedFiles.some((file) => file.includes("MiSans-Medium"))) {
    throw new Error("Packaged application still contains the obsolete bundled MiSans font.");
  }
  if (!fs.existsSync(path.join(appRoot, "node_modules", "ws", "index.js"))) {
    throw new Error("Packaged application is missing the externalized ws dependency.");
  }
  return { fileCount: packagedFiles.length, systemFontSelection: true, externalizedWs: true };
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  });
}

function cleanupSmokeRoot() {
  const temporaryRoot = path.resolve(os.tmpdir());
  const relative = path.relative(temporaryRoot, smokeRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(smokeRoot).startsWith("codex-gateway-packaged-smoke-")) {
    return;
  }
  try {
    fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A failed cleanup must not hide the packaged startup result; the path is confined to the OS temp directory.
  }
}
