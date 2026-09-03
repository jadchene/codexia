import fs from "node:fs";
import net from "node:net";
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
  inspection.pageCount = await inspectLazyPages(target.webSocketDebuggerUrl, child);
} finally {
  stopProcessTree(child.pid);
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

async function inspectLazyPages(webSocketDebuggerUrl, processHandle) {
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
        reject(new Error(message.result.exceptionDetails.text || "Renderer evaluation failed."));
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
    if (version !== 5 || fixtureValue !== "preserved" || builtInUpstream !== "https://legacy.example.test/backend-api/codex"
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
