import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { connectCliControl } from "../src/main/cli-control.ts";
import { startControlApi, ACCESS_MODE_API_PATH, type ApiDiscoveryOptions } from "../src/main/control-api.ts";
const apiKey = "test-key-".repeat(8);
const startCliControl = (dir: string, backend: CliBackend, options: ApiDiscoveryOptions = {}) => startControlApi(dir, backend, { host: "127.0.0.1", port: 0, apiKey, ...options });
import { acquireSingleInstanceChannel, closeSingleInstanceChannel, singleInstanceEndpoint } from "../src/main/single-instance.ts";
import type { CliBackend } from "../src/main/cli.ts";

it("HTTP access mode API authenticates and serializes writes without a gateway dependency", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-api-"));
  let active = 0; let maximum = 0; let current = "before";
  const backend: CliBackend = { show: () => current, choices: () => [{ id: "api", label: "API" }],
    defaults: () => ({ targetId: "api", proxy: false, restart: false }), gatewayRunning: () => false,
    apply: vi.fn(async () => { active++; maximum = Math.max(active, maximum); await new Promise((r) => setTimeout(r, 20)); current = "after"; active--; }) };
  expect(await connectCliControl(dir)).toBeNull();
  const close = await startCliControl(dir, backend);
  try {
    const remote = (await connectCliControl(dir))!;
    expect(remote.show()).toBe("before");
    const selection = { mode: "openai" as const, targetId: "api", proxy: true, restart: false };
    await Promise.all([remote.apply(selection), remote.apply(selection)]);
    expect(maximum).toBe(1); expect(backend.apply).toHaveBeenCalledTimes(2);
    expect((await connectCliControl(dir))!.show()).toBe("after");
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "control-api.json"), "utf8"));
    const raw = (body: string, token = apiKey, route = ACCESS_MODE_API_PATH, contentType = "application/json") => fetch(meta.url + route, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType }, body
    });
    expect((await raw(JSON.stringify(selection), "wrong")).status).toBe(401);
    expect((await raw(JSON.stringify({ ...selection, proxy: "true" }))).status).toBe(400);
    expect((await raw("{")).status).toBe(400);
    expect((await raw("x".repeat(17000))).status).toBe(413);
    expect((await raw("{}", apiKey, "/codexia/api/unknown")).status).toBe(404);
    expect((await raw("{}", apiKey, ACCESS_MODE_API_PATH, "text/plain")).status).toBe(415);
    const wrongInstance = await fetch(meta.url + ACCESS_MODE_API_PATH, { headers: { Authorization: `Bearer ${apiKey}`, "X-Codexia-Instance": "old" } });
    expect(wrongInstance.status).toBe(409);
    expect(backend.apply).toHaveBeenCalledTimes(2);
    const result = await (await raw(JSON.stringify(selection))).json();
    expect(result).toMatchObject({ ok: true, result: { gatewayRunning: false, warning: expect.stringContaining("请手动启动") } });
    const snapshot = await (await fetch(meta.url + ACCESS_MODE_API_PATH, { headers: { Authorization: `Bearer ${apiKey}` } })).text();
    expect(snapshot).not.toContain(apiKey);
    expect(fs.existsSync(path.join(dir, "inbox"))).toBe(false);
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "control-api.json")).mode & 0o777).toBe(0o600);
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("HTTP API reports apply failures and keeps serving later requests", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-api-error-"));
  const backend: CliBackend = { show: () => "current", choices: () => [], defaults: () => ({ targetId: "", proxy: false, restart: false }),
    apply: vi.fn().mockRejectedValueOnce(new Error("配置已应用，但重启失败")).mockResolvedValue(undefined) };
  const close = await startCliControl(dir, backend);
  try {
    const remote = (await connectCliControl(dir))!;
    const selection = { mode: "gateway" as const, targetId: "", proxy: false, restart: false };
    await expect(remote.apply(selection)).rejects.toThrow("配置已应用，但重启失败");
    await expect(remote.apply(selection)).resolves.toBeUndefined();
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("separate installation directories never reuse control metadata or single-instance channels", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-installations-"));
  const first = path.join(root, "first", "data");
  const second = path.join(root, "second", "data");
  fs.mkdirSync(first, { recursive: true }); fs.mkdirSync(second, { recursive: true });
  const firstApply = vi.fn(async () => {}); const secondApply = vi.fn(async () => {});
  const backend = (label: string, apply: CliBackend["apply"]): CliBackend => ({
    show: () => label, choices: () => [], defaults: () => ({ targetId: "", proxy: false, restart: false }), apply
  });
  const closeFirst = await startCliControl(first, backend("first", firstApply));
  let closeSecond: (() => Promise<void>) | undefined;
  let firstLock: Awaited<ReturnType<typeof acquireSingleInstanceChannel>> | undefined;
  let secondLock: Awaited<ReturnType<typeof acquireSingleInstanceChannel>> | undefined;
  const notified = vi.fn();
  try {
    // Portable copies can include a live instance's old control file.
    fs.copyFileSync(path.join(first, "control-api.json"), path.join(second, "control-api.json"));
    expect(await connectCliControl(second)).toBeNull();
    closeSecond = await startCliControl(second, backend("second", secondApply));
    const a = (await connectCliControl(first))!; const b = (await connectCliControl(second))!;
    expect(a.show()).toBe("first"); expect(b.show()).toBe("second");
    await b.apply({ mode: "gateway", targetId: "", proxy: false, restart: false });
    expect(firstApply).not.toHaveBeenCalled(); expect(secondApply).toHaveBeenCalledOnce();
    expect(singleInstanceEndpoint({ instanceDirectory: first })).not.toBe(singleInstanceEndpoint({ instanceDirectory: second }));
    expect(singleInstanceEndpoint({ instanceDirectory: first })).toBe(singleInstanceEndpoint({ instanceDirectory: path.join(first, ".") }));
    firstLock = await acquireSingleInstanceChannel({ instanceDirectory: first, onSecondInstance: notified });
    secondLock = await acquireSingleInstanceChannel({ instanceDirectory: second });
    expect(firstLock.primary).toBe(true); expect(secondLock.primary).toBe(true);
    const sameDirectory = await acquireSingleInstanceChannel({ instanceDirectory: first });
    expect(sameDirectory.primary).toBe(false); expect(notified).toHaveBeenCalledOnce();
  } finally {
    await closeSingleInstanceChannel(firstLock?.server); await closeSingleInstanceChannel(secondLock?.server);
    await closeSecond?.(); await closeFirst(); fs.rmSync(root, { recursive: true, force: true });
  }
});

it("single-instance discovery is global, multi-instance discovery stays local, and applies stay pinned", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-discovery-"));
  const first = path.join(root, "first", "data"); const second = path.join(root, "second", "data");
  const absent = path.join(root, "absent", "data"); const globalFile = path.join(root, "user", "cli-single-instance.json");
  for (const dir of [first, second, absent]) fs.mkdirSync(dir, { recursive: true });
  const aApply = vi.fn(async () => {}); const bApply = vi.fn(async () => {});
  const backend = (name: string, apply: CliBackend["apply"]): CliBackend => ({ show: () => name,
    choices: () => [{ id: name, label: name }], defaults: () => ({ targetId: name, proxy: false, restart: false }), apply });
  const closeA = await startCliControl(first, backend("A", aApply), { singleInstance: true, globalFile });
  const closeB = await startCliControl(second, backend("B", bApply), { singleInstance: false, globalFile });
  let aClosed = false;
  try {
    const global = (await connectCliControl(second, { singleInstance: true, globalFile }))!;
    expect(global.show()).toBe("A"); expect(global.choices("openai")[0]?.id).toBe("A");
    expect((await connectCliControl(absent, { singleInstance: true, globalFile }))!.show()).toBe("A");
    const local = (await connectCliControl(second, { singleInstance: false, globalFile }))!;
    expect(local.show()).toBe("B");
    expect(await connectCliControl(absent, { singleInstance: false, globalFile })).toBeNull();
    // B must neither overwrite nor advertise itself as the global singleton.
    const registry = JSON.parse(fs.readFileSync(globalFile, "utf8"));
    expect(registry.instanceDirectory).toBe(fs.realpathSync(first));
    const selection = { mode: "gateway" as const, targetId: "", proxy: false, restart: false };
    await global.apply(selection); expect(aApply).toHaveBeenCalledOnce(); expect(bApply).not.toHaveBeenCalled();
    await local.apply(selection); expect(bApply).toHaveBeenCalledOnce();
    await closeA(); aClosed = true;
    expect(fs.existsSync(globalFile)).toBe(false);
    // A stale record must not prevent using the local desktop, but a previously selected A cannot redirect to B.
    fs.writeFileSync(globalFile, JSON.stringify(registry));
    expect((await connectCliControl(second, { singleInstance: true, globalFile }))!.show()).toBe("B");
    await expect(global.apply(selection)).rejects.toThrow();
    expect(bApply).toHaveBeenCalledOnce();
    expect(await connectCliControl(absent, { singleInstance: true, globalFile })).toBeNull();
  } finally {
    if (!aClosed) await closeA();
    await closeB(); fs.rmSync(root, { recursive: true, force: true });
  }
});
