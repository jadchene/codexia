import path from "node:path";
import type { Settings } from "../shared/contracts/settings";

const ISOLATED_DEV_FLAG = "--isolated-dev";
const CODEX_TEST_DIR_PREFIX = "--codex-test-dir=";

interface RuntimeProfile {
  mode: "isolated-dev" | "production";
  isolated: boolean;
  isolatedRequested: boolean;
  rejectedPackagedFlag: boolean;
  appName: string;
  appUserModelId: string;
  windowTitle: string;
  trayToolTip: string;
  rendererDevOrigin: string;
  useSingleInstance: boolean;
  allowServiceAutoStart: boolean;
  allowStartupIntegration: boolean;
  allowLiveCodexAccess: boolean;
  paths: {
    runtimeRoot: string;
    dataDir: string;
    browserDataDir: string;
    dbPath: string;
    codexDir: string | null;
  } | null;
  settingsOverrides: Settings;
}

export function createRuntimeProfile(options: {
  argv?: string[];
  isPackaged?: boolean;
  projectRoot?: string;
} = {}): RuntimeProfile {
  const argv = Array.isArray(options.argv) ? options.argv : process.argv;
  const isPackaged = Boolean(options.isPackaged);
  const root = path.resolve(options.projectRoot || path.resolve(__dirname, "..", ".."));
  const isolatedRequested = argv.includes(ISOLATED_DEV_FLAG);
  const isolated = isolatedRequested && !isPackaged;
  const runtimeRoot = path.join(root, ".runtime", "v1-dev");
  const requestedCodexDir = argumentValue(argv, CODEX_TEST_DIR_PREFIX);
  const codexDir = isolated && requestedCodexDir
    ? resolveContainedPath(runtimeRoot, requestedCodexDir, root)
    : null;

  return {
    mode: isolated ? "isolated-dev" : "production",
    isolated,
    isolatedRequested,
    rejectedPackagedFlag: isolatedRequested && isPackaged,
    appName: isolated ? "Codexia v1 Dev" : "Codexia",
    appUserModelId: isolated
      ? "io.github.jadchene.codexia.v1-dev"
      : "io.github.jadchene.codexia",
    windowTitle: isolated ? "Codexia · v1 Dev" : "Codexia",
    trayToolTip: isolated ? "Codexia · v1 Dev" : "Codexia",
    rendererDevOrigin: isolated ? "http://127.0.0.1:18435" : "http://127.0.0.1:8435",
    useSingleInstance: true,
    allowServiceAutoStart: true,
    allowStartupIntegration: !isolated,
    allowLiveCodexAccess: !isolated,
    paths: isolated ? {
      runtimeRoot,
      dataDir: runtimeRoot,
      browserDataDir: path.join(runtimeRoot, "browser"),
      dbPath: path.join(runtimeRoot, "codex-gateway.sqlite"),
      codexDir
    } : null,
    settingsOverrides: isolated ? {
      gateway_host: "127.0.0.1",
      gateway_port: "18436",
      mcp_gateway_host: "127.0.0.1",
      mcp_gateway_port: "13000"
    } : {}
  };
}

function argumentValue(argv: string[], prefix: string): string {
  const argument = argv.find((value) => String(value).startsWith(prefix));
  return argument ? String(argument).slice(prefix.length).trim() : "";
}

function resolveContainedPath(container: string, requestedPath: string, projectRoot: string): string {
  const target = path.resolve(projectRoot, requestedPath);
  const relative = path.relative(container, target);
  if (!relative || relative === ".") return target;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw runtimeProfileError(
      "DEV_CODEX_DIR_OUTSIDE_RUNTIME",
      `隔离开发的 Codex 测试目录必须位于 ${container} 内。`
    );
  }
  return target;
}

export function codexAccessOptions(profile: RuntimeProfile): { codexDir?: string } {
  if (profile.allowLiveCodexAccess) return {};
  if (profile.paths?.codexDir) return { codexDir: profile.paths.codexDir };
  throw runtimeProfileError(
    "DEV_PROFILE_WRITE_BLOCKED",
    "隔离开发模式禁止访问当前用户的 Codex 配置；请使用 .runtime/v1-dev 下的专用测试目录。"
  );
}

function runtimeProfileError(code: string, message: string): Error & { code: string } {
  const error = new Error(message);
  return Object.assign(error, { code });
}
