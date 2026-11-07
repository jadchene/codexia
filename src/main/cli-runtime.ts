import { app, safeStorage } from "electron";
import fs from "node:fs";
import { readSingleInstanceSetting } from "./single-instance.ts";
import { connectCliControl } from "./cli-control.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { runCli } from "./cli.ts";
import { createCliAccess } from "./cli-access.ts";
import { createRuntimeProfile, codexAccessOptions } from "./runtime-profile.ts";
import { browserDataDir, dataDir } from "./paths.ts";
import { createStore } from "./store.ts";
import { createSecretCodec } from "./secret-codec.ts";
import { createUpstreamService } from "./upstreams/upstream-service.ts";
import { createCodexModelCatalogService } from "./codex-model-catalog.ts";
import type { ModelManagementInput } from "../shared/contracts/upstreams.ts";

export async function startCli(args: string[]): Promise<void> {
  let store: ReturnType<typeof createStore> | undefined;
  let input: ReturnType<typeof createInterface> | undefined;
  let exitCode = 0;
  let ownsLock = false;
  const release = () => { store?.db.close(); store = undefined; if (ownsLock) app.releaseSingleInstanceLock(); ownsLock = false; };
  try {
    const version = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")).version as string;
    const backend = async () => {
      const profile = createRuntimeProfile({ argv: process.argv, isPackaged: app.isPackaged, projectRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") });
      const activeDataDir = profile.paths?.dataDir || dataDir();
      const discovery = {
        singleInstance: profile.useSingleInstance && readSingleInstanceSetting(path.join(activeDataDir, "codex-gateway.sqlite")),
        globalFile: profile.isolated ? path.join(profile.paths!.runtimeRoot, "cli-single-instance.json")
          : path.join(app.getPath("appData"), "Codexia", "cli-single-instance.json")
      };
      const remote = await connectCliControl(activeDataDir, discovery);
      if (remote) return remote;
      const userData = profile.paths?.browserDataDir || browserDataDir();
      fs.mkdirSync(userData, { recursive: true });
      app.setPath("userData", userData);
      app.setName(profile.appName);
      // Avoid configuring a running desktop instance with stale in-memory settings.
      if (!app.requestSingleInstanceLock({ cli: true })) {
        const running = await connectCliControl(activeDataDir, discovery);
        if (running) return running;
        throw new Error("Codexia 已运行，但外部 API 未就绪。请检查 API 设置及运行日志后重试。");
      }
      ownsLock = true;
      await app.whenReady();
      const secretCodec = createSecretCodec(safeStorage);
      store = createStore({ secretCodec, ...(profile.paths ? { dataDir: profile.paths.dataDir, dbPath: profile.paths.dbPath } : {}) });
      if (profile.isolated) store.saveSettings(profile.settingsOverrides);
      const upstreams = createUpstreamService({ db: store.db, secretCodec });
      const catalog = createCodexModelCatalogService({ db: store.db, dataDir: store.paths.dataDir,
        getBundledOverride: () => ({ enabled: store!.getSettings().codex_bundled_override_enabled === "true", modelCatalogJson: store!.getSettings().codex_bundled_override_json || "" }),
        getModelManagement: () => {
          try {
            const value: unknown = JSON.parse(store!.getSettings().model_management_json || "[]");
            return Array.isArray(value) ? value.filter((item): item is ModelManagementInput => item && typeof item.slug === "string" && typeof item.displayName === "string" && typeof item.visible === "boolean") : [];
          } catch { return []; }
        }
      });
      return createCliAccess({ store, upstreams, catalog, codexOptions: codexAccessOptions(profile) });
    };
    let ask: ((question: string) => Promise<string>) | undefined;
    if (process.stdin.isTTY || process.argv.includes("--cli-interactive")) {
      input = createInterface({ input: process.stdin, terminal: false });
      const lines = input[Symbol.asyncIterator]();
      ask = async (question) => {
        process.stdout.write(question);
        const next = await lines.next();
        if (next.done) throw new Error("输入已结束，未应用接入模式修改。");
        return next.value;
      };
    }
    await runCli(args, version, backend, { write: (text) => process.stdout.write(`${text}\n`), ...(ask ? { ask } : {}) });
  } catch (error) {
    exitCode = 1;
    process.stderr.write(`${error instanceof Error ? error.message : "命令执行失败。"}\n`);
  } finally {
    input?.close();
    release();
    // Let pipe writes drain before Electron terminates the process.
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
    await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
    app.exit(exitCode);
  }
}
