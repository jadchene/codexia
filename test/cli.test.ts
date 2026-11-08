import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCliLauncherVersion, parseCliArgs, runCli, type CliBackend } from "../src/main/cli.ts";
import { createCliAccess } from "../src/main/cli-access.ts";
import { createStore } from "../src/main/store.ts";
import { createSecretCodec } from "../src/main/secret-codec.ts";
import { createUpstreamService } from "../src/main/upstreams/upstream-service.ts";
import { createCodexModelCatalogService } from "../src/main/codex-model-catalog.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const fake = (): CliBackend => ({ show: () => "当前模式", choices: () => [{ id: "one", label: "候选" }],
  defaults: () => ({ targetId: "one", proxy: false, restart: true }), apply: vi.fn(async () => {}) });

it("version and help do not initialize Electron services, database or credentials", async () => {
  const backend = vi.fn(); const write = vi.fn();
  await runCli(["--version"], "2.0.0", backend, { write });
  expect(write).toHaveBeenCalledWith("Codexia 2.0.0");
  await runCli(["--help"], "2.0.0", backend, { write });
  expect(backend).not.toHaveBeenCalled();
});
it.each([['bad'], ['mode', 'bad'], ['mode', 'switch', '--mode', 'invalid'],
  ['mode', 'switch', '--proxy', 'yes'], ['mode', 'switch', '--restart'],
  ['mode', 'switch', '--restart', 'true', '--restart', 'false']])("rejects malformed arguments %j", (...args) => {
  expect(() => parseCliArgs(args)).toThrow();
});
it("mode viewing never applies configuration", async () => {
  const backend = fake(); const write = vi.fn();
  await runCli(["mode"], "2", async () => backend, { write });
  expect(write).toHaveBeenCalledWith("当前模式"); expect(backend.apply).not.toHaveBeenCalled();
});
it("interactive switch selects mode and target before applying the chosen options once", async () => {
  const backend = fake(); const answers = ["invalid", "third_party", "1", "y", "n"];
  await runCli(["mode", "switch"], "2", async () => backend, { write: vi.fn(), ask: async () => answers.shift()! });
  expect(backend.apply).toHaveBeenCalledExactlyOnceWith({ mode: "third_party", targetId: "one", proxy: true, restart: false });
});
it("EOF, invalid targets, mismatched options and missing noninteractive options cannot apply", async () => {
  const backend = fake();
  await expect(runCli(["mode", "switch"], "2", async () => backend, { write: vi.fn(), ask: async () => { throw Error("EOF"); } })).rejects.toThrow("EOF");
  for (const args of [
    ["--mode", "account", "--account", "missing", "--proxy", "false", "--restart", "false"],
    ["--mode", "account", "--account", "one", "--channel", "one"],
    ["--mode", "gateway", "--proxy", "true", "--restart", "true"],
    ["--mode", "account", "--account", "one", "--proxy", "false"]
  ]) await expect(runCli(["mode", "switch", ...args], "2", async () => backend, { write: vi.fn() })).rejects.toThrow();
  expect(backend.apply).not.toHaveBeenCalled();
});
it("noninteractive gateway switch does not request a target or proxy", async () => {
  const backend = fake();
  await runCli(["mode", "switch", "--mode", "gateway", "--restart", "false"], "2", async () => backend, { write: vi.fn() });
  expect(backend.apply).toHaveBeenCalledExactlyOnceWith({ mode: "gateway", targetId: "", proxy: false, restart: false });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-cli-"));
  const secretCodec = createSecretCodec({ isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() });
  const store = createStore({ secretCodec, dataDir: root, dbPath: path.join(root, "test.sqlite") });
  cleanup.push(() => { store.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const upstreams = createUpstreamService({ db: store.db, secretCodec });
  const catalog = createCodexModelCatalogService({ db: store.db, dataDir: root, runBundledModels: () => JSON.stringify({ models: [{ slug: "gpt-test" }] }) });
  catalog.refresh();
  const official = upstreams.save({ provider: "openai", apiKey: "official-secret" });
  const third = upstreams.save({ name: "Third", baseUrl: "https://third.example/v1", apiKey: "third-secret", enabled: true,
    modelCatalogJson: JSON.stringify({ models: [{ slug: "third-model" }] }) });
  const account = store.saveAccount({ name: "Account", email: "test@example.test", account_id: "owner", enabled: true, access_token: "old-access", refresh_token: "old-refresh" });
  const codexDir = path.join(root, "codex");
  const auth = () => JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8"));
  const config = () => fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
  const restart = vi.fn(async () => { expect(fs.existsSync(path.join(codexDir, "config.toml"))).toBe(true); });
  const access = createCliAccess({ store, upstreams, catalog, codexOptions: { codexDir }, restart });
  return { root, store, upstreams, official, third, account, codexDir, auth, config, restart, access };
}
describe("real isolated config application", () => {
  it("filters candidates, never exposes secrets and preserves Codex-refreshed tokens", async () => {
    const f = fixture();
    expect(f.access.choices("openai").map((c) => c.id)).toEqual([f.official.id]);
    expect(f.access.choices("third_party").map((c) => c.id)).toEqual([f.third.id]);
    const output = f.access.show();
    for (const secret of ["official-secret", "third-secret", "old-access", "old-refresh"]) expect(output).not.toContain(secret);
    await f.access.apply({ mode: "account", targetId: f.account.id, proxy: false, restart: false });
    const refreshed = f.auth(); refreshed.tokens.access_token = "new-access"; refreshed.tokens.refresh_token = "new-refresh";
    fs.writeFileSync(path.join(f.codexDir, "auth.json"), JSON.stringify(refreshed));
    await f.access.apply({ mode: "account", targetId: f.account.id, proxy: true, restart: true });
    expect(f.auth().tokens.refresh_token).toBe("new-refresh");
    expect(f.store.listAccounts()[0].access_token).toBe("new-access");
    expect(f.config()).toContain('openai_base_url = "http://localhost:8436/v1"');
    expect(f.restart).toHaveBeenCalledOnce();
    await f.access.apply({ mode: "account", targetId: f.account.id, proxy: false, restart: false });
    expect(f.config()).not.toContain("openai_base_url");
    expect(f.store.getSettings().account_auto_restart_app_server).toBe("false");
  });
  it("applies official, third-party and gateway modes with per-mode preferences", async () => {
    const f = fixture();
    await f.access.apply({ mode: "openai", targetId: f.official.id, proxy: false, restart: false });
    expect(f.auth().OPENAI_API_KEY).toBe("official-secret");
    expect(f.config()).toContain("https://api.openai.com/v1");
    await f.access.apply({ mode: "third_party", targetId: f.third.id, proxy: true, restart: true });
    expect(f.auth().OPENAI_API_KEY).toBe("third-secret");
    expect(f.config()).toContain("http://localhost:8436/v1");
    expect(f.access.defaults("third_party")).toEqual({ targetId: f.third.id, proxy: true, restart: true });
    await f.access.apply({ mode: "third_party", targetId: f.third.id, proxy: false, restart: false });
    expect(f.config()).toContain("https://third.example/v1");
    await f.access.apply({ mode: "gateway", targetId: "", proxy: false, restart: true });
    expect(f.auth().OPENAI_API_KEY).toBe(f.store.getSettings().gateway_api_key);
    expect(f.store.getSettings().codex_auth_mode).toBe("gateway");
    expect(f.restart).toHaveBeenCalledTimes(2);
  });
  it("does not rewrite config or restart on wrong-type or unavailable channels", async () => {
    const f = fixture();
    await f.access.apply({ mode: "openai", targetId: f.official.id, proxy: false, restart: false });
    const config = f.config(); const auth = f.auth();
    await expect(f.access.apply({ mode: "openai", targetId: f.third.id, proxy: false, restart: true })).rejects.toThrow();
    f.upstreams.setEnabled(f.official.id, false);
    await expect(f.access.apply({ mode: "openai", targetId: f.official.id, proxy: false, restart: true })).rejects.toThrow();
    expect(f.config()).toBe(config); expect(f.auth()).toEqual(auth); expect(f.restart).not.toHaveBeenCalled();
  });
});

it("CLI writes gateway configuration while stopped and only prints a manual-start reminder", async () => {
  const f = fixture();
  const write = vi.fn();
  await runCli(["mode", "switch", "--mode", "gateway", "--restart", "false"], "2", async () => f.access, { write });
  expect(f.store.getSettings().codex_auth_mode).toBe("gateway");
  expect(f.config()).toContain("http://localhost:8436/v1");
  expect(write).toHaveBeenCalledWith(expect.stringContaining("请手动启动"));
  expect(f.restart).not.toHaveBeenCalled();
});

it("restart failures preserve applied settings and propagate the failure", async () => {
  const f = fixture();
  const fail = createCliAccess({ store: f.store, upstreams: f.upstreams,
    catalog: createCodexModelCatalogService({ db: f.store.db, dataDir: f.root }), codexOptions: { codexDir: f.codexDir },
    restart: async () => { throw Error("配置已应用，但重启失败"); } });
  await expect(fail.apply({ mode: "third_party", targetId: f.third.id, proxy: false, restart: true })).rejects.toThrow("配置已应用");
  expect(f.config()).toContain("https://third.example/v1");
  expect(f.store.getSettings().third_party_auto_restart_app_server).toBe("true");
});

it("failed API channel switching rolls back the model catalog together with auth and config", async () => {
  const f = fixture();
  await f.access.apply({ mode: "openai", targetId: f.official.id, proxy: false, restart: false });
  const catalog = path.join(f.root, "api-models.json");
  const originalCatalog = fs.readFileSync(catalog, "utf8");
  const originalConfig = f.config(); const originalAuth = f.auth();
  const rename = fs.renameSync;
  const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(from).includes("config.toml.tmp-")) throw Object.assign(new Error("config busy"), { code: "EBUSY" });
    rename(from, to);
  });
  try {
    await expect(f.access.apply({ mode: "third_party", targetId: f.third.id, proxy: false, restart: true })).rejects.toThrow("config busy");
    expect(f.config()).toBe(originalConfig); expect(f.auth()).toEqual(originalAuth);
    expect(fs.readFileSync(catalog, "utf8")).toBe(originalCatalog);
    expect(f.store.getSettings().codex_auth_mode).toBe("openai");
    expect(f.restart).not.toHaveBeenCalled();
  } finally { fault.mockRestore(); }
});

it("checks the launcher version independently of the backend's IPC version", () => {
  expect(() => assertCliLauncherVersion("1.9.9", "2.0.0")).toThrow(/版本不一致/);
  expect(() => assertCliLauncherVersion("", "2.0.0")).toThrow(/版本不一致/);
  expect(() => assertCliLauncherVersion("2.0.0", "2.0.0")).not.toThrow();
  expect(() => assertCliLauncherVersion(undefined, "2.0.0")).not.toThrow();
});

it("account list prints quota and credit counts without tokens", async () => {
  const f = fixture();
  f.store.updateUsage(f.account.id, { reset_credits_available_count: 4, quota_5h_used_percent: 12 });
  const output: string[] = [];
  await runCli(["accounts"], "2.0.0", async () => f.access, { write: (line) => output.push(line) });
  expect(output.join()).toContain("剩余重置次数：4");
  expect(output.join()).not.toContain("old-access");
  expect(output.join()).not.toContain("old-refresh");
});

it("batch account refresh continues after failures and excludes disabled accounts", async () => {
  const refreshAccount = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue({ id: "b", name: "B", enabled: true });
  const service = { ...fake(), accounts: () => [
    { id: "a", name: "A", enabled: true }, { id: "b", name: "B", enabled: true }, { id: "disabled", enabled: false }
  ] as ReturnType<NonNullable<CliBackend["accounts"]>>, refreshAccount };
  const write = vi.fn();
  await expect(runCli(["accounts", "refresh", "--all", "--type", "usage"], "2.0.0", async () => service, { write })).rejects.toThrow("1 成功，1 失败");
  expect(refreshAccount.mock.calls).toEqual([["a", "usage"], ["b", "usage"]]);
  expect(write).toHaveBeenCalledWith(expect.stringContaining("刷新成功"));
});

it("interactive account refresh selects a target and noninteractive mode requires a selector", async () => {
  const refreshAccount = vi.fn().mockResolvedValue({ id: "a", enabled: true });
  const service = { ...fake(), accounts: () => [{ id: "a", name: "A", enabled: true }] as ReturnType<NonNullable<CliBackend["accounts"]>>, refreshAccount };
  await expect(runCli(["accounts", "refresh"], "2", async () => service, { write: vi.fn() })).rejects.toThrow(/--account/);
  await runCli(["accounts", "refresh", "--type", "token"], "2", async () => service, { write: vi.fn(), ask: async () => "1" });
  expect(refreshAccount).toHaveBeenCalledExactlyOnceWith("a", "token");
});

it.each([
  ["refresh", "--all", "--account", "one"], ["refresh", "--type", "bad"], ["refresh", "--account"],
  ["refresh", "--all", "--all"], ["refresh", "--force"], ["list", "--all"]
])("rejects invalid account command %j before opening services", async (...args) => {
  const backend = vi.fn();
  await expect(runCli(["accounts", ...args], "2", backend, { write: vi.fn() })).rejects.toThrow();
  expect(backend).not.toHaveBeenCalled();
});

it("offline CLI token refresh syncs the direct account without exposing credentials or changing Codex config", async () => {
  const f = fixture();
  await f.access.apply({ mode: "account", targetId: f.account.id, proxy: false, restart: false });
  const auth = f.auth();
  auth.tokens.access_token = "direct-rotated-access";
  auth.tokens.refresh_token = "direct-rotated-refresh";
  fs.writeFileSync(path.join(f.codexDir, "auth.json"), JSON.stringify(auth));
  const before = f.config();
  const output: string[] = [];
  await runCli(["accounts", "refresh", "--account", f.account.id, "--type", "token"], "2.0.0", async () => f.access, { write: (line) => output.push(line) });
  expect(f.store.listAccounts()[0].refresh_token).toBe("direct-rotated-refresh");
  expect(output.join()).toContain("刷新成功");
  expect(output.join()).not.toContain("direct-rotated");
  expect(f.config()).toBe(before);
  expect(f.auth()).toEqual(auth);
});
