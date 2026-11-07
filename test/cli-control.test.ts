import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { expect, it, vi } from "vitest";
import { connectCliControl, startCliControl } from "../src/main/cli-control.ts";
import { controlFile, readControlMetadata, requestLocalControl, startLocalControl } from "../src/main/local-control.ts";
import type { CliBackend } from "../src/main/cli.ts";

const options = { appVersion: "2.0.0" };
const selection = { mode: "gateway" as const, targetId: "", proxy: false, restart: false };
const backend = (name: string, apply = vi.fn(async () => {})): CliBackend => ({ show: () => name,
  choices: () => [{ id: name, label: name }], defaults: () => ({ targetId: name, proxy: false, restart: false }), apply });

it("local IPC serializes mode changes and returns current gateway status without starting services", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-ipc-"));
  let active = 0; let maximum = 0;
  const apply = vi.fn(async () => { active++; maximum = Math.max(active, maximum); await new Promise((r) => setTimeout(r, 20)); active--; });
  expect(await connectCliControl(dir, options)).toBeNull();
  const close = await startCliControl(dir, backend("one", apply), options);
  try {
    const remote = (await connectCliControl(dir, options))!;
    expect(remote.show()).toBe("one"); expect(remote.choices("openai")[0]?.id).toBe("one");
    await Promise.all([remote.apply(selection), remote.apply(selection)]);
    expect(maximum).toBe(1); expect(apply).toHaveBeenCalledTimes(2); expect(remote.gatewayRunning?.()).toBe(false);
    const metadata = readControlMetadata(controlFile(dir))!;
    await expect(requestLocalControl({ ...metadata, token: "wrong" }, options.appVersion, "access-mode.apply", selection)).rejects.toThrow(/认证失败/);
    await expect(requestLocalControl(metadata, options.appVersion, "access-mode.apply", { ...selection, proxy: "true" })).rejects.toThrow(/参数无效/);
    expect(apply).toHaveBeenCalledTimes(2);
    if (process.platform !== "win32") expect(fs.statSync(controlFile(dir)).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(dir, "inbox"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "control-api.json"))).toBe(false);
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("IPC errors reach the caller and do not block subsequent commands", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-ipc-errors-"));
  const apply = vi.fn().mockRejectedValueOnce(new Error("配置已应用，但重启失败")).mockResolvedValue(undefined);
  const close = await startCliControl(dir, backend("one", apply), options);
  try {
    const remote = (await connectCliControl(dir, options))!;
    await expect(remote.apply(selection)).rejects.toThrow("配置已应用，但重启失败");
    await expect(remote.apply(selection)).resolves.toBeUndefined();
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("CLI only associates its own directory, ignoring other instances and copied or global metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-ipc-directories-"));
  const first = path.join(root, "first"); const second = path.join(root, "second");
  fs.mkdirSync(first); fs.mkdirSync(second);
  const applyA = vi.fn(async () => {}); const applyB = vi.fn(async () => {});
  const closeA = await startCliControl(first, backend("A", applyA), options);
  let closeB: (() => Promise<void>) | undefined;
  try {
    fs.copyFileSync(controlFile(first), path.join(root, "cli-single-instance.json"));
    expect(await connectCliControl(second, options)).toBeNull();
    fs.copyFileSync(controlFile(first), controlFile(second));
    expect(await connectCliControl(second, options)).toBeNull();
    closeB = await startCliControl(second, backend("B", applyB), options);
    const remote = (await connectCliControl(second, options))!;
    expect(remote.show()).toBe("B"); await remote.apply(selection);
    expect(applyA).not.toHaveBeenCalled(); expect(applyB).toHaveBeenCalledOnce();
    expect((await connectCliControl(path.join(first, "."), options))!.show()).toBe("A");
  } finally { await closeB?.(); await closeA(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("application version mismatch is rejected by the running owner before executing any operation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-ipc-version-"));
  const apply = vi.fn(async () => {});
  const close = await startCliControl(dir, backend("one", apply), options);
  try {
    await expect(connectCliControl(dir, { appVersion: "2.1.0" })).rejects.toThrow(/版本不一致/);
    const metadata = readControlMetadata(controlFile(dir))!;
    await expect(requestLocalControl(metadata, "2.1.0", "access-mode.apply", selection)).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
    expect(apply).not.toHaveBeenCalled();
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("the generic method registry validates protocol versions and rejects unknown operations", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-ipc-protocol-"));
  const echo = vi.fn(async (params: unknown) => params);
  const close = await startLocalControl(dir, { "example.echo": echo }, options);
  try {
    const metadata = readControlMetadata(controlFile(dir))!;
    expect(await requestLocalControl(metadata, options.appVersion, "example.echo", { example: 42 })).toEqual({ example: 42 });
    await expect(requestLocalControl(metadata, options.appVersion, "future.unknown", {})).rejects.toMatchObject({ code: "UNKNOWN_METHOD" });
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(metadata.endpoint); let result = "";
      socket.on("error", reject); socket.on("data", (chunk) => { result += chunk; }); socket.on("end", () => resolve(result));
      socket.on("connect", () => socket.write(JSON.stringify({ version: 99, appVersion: options.appVersion, id: "version-test", method: "example.echo",
        token: metadata.token, instanceDirectory: metadata.instanceDirectory, params: {} }) + "\n"));
    });
    expect(JSON.parse(reply)).toMatchObject({ version: 1, id: "version-test", ok: false, error: { code: "PROTOCOL_MISMATCH" } });
    expect(echo).toHaveBeenCalledOnce();
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("a selected process is pinned and a stopped or restarted owner cannot silently redirect writes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-ipc-pinned-"));
  const close = await startCliControl(dir, backend("old"), options);
  const remote = (await connectCliControl(dir, options))!;
  const metadata = fs.readFileSync(controlFile(dir));
  await close();
  fs.writeFileSync(controlFile(dir), metadata);
  expect(await connectCliControl(dir, options)).toBeNull();
  const apply = vi.fn(async () => {});
  const closeNew = await startCliControl(dir, backend("new", apply), options);
  try {
    await expect(remote.apply(selection)).rejects.toThrow(); expect(apply).not.toHaveBeenCalled();
    await (await connectCliControl(dir, options))!.apply(selection); expect(apply).toHaveBeenCalledOnce();
  } finally { await closeNew(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("IPC permission failures must not be treated as an absent desktop", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-ipc-permission-"));
  const close = await startCliControl(dir, backend("one"), options);
  const connection = vi.spyOn(net, "createConnection").mockImplementation(() => {
    const socket = new net.Socket();
    queueMicrotask(() => socket.emit("error", Object.assign(new Error("denied"), { code: "EACCES" })));
    return socket;
  });
  try { await expect(connectCliControl(dir, options)).rejects.toThrow(/无法连接/); }
  finally { connection.mockRestore(); await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("corrupt instance metadata stops the CLI instead of enabling local writes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-ipc-corrupt-"));
  try {
    fs.writeFileSync(controlFile(dir), "{incomplete");
    await expect(connectCliControl(dir, options)).rejects.toMatchObject({ code: "DISCOVERY_FAILED" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
