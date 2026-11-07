import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { connectCliControl, startCliControl } from "../src/main/cli-control.ts";
import { acquireSingleInstanceChannel, closeSingleInstanceChannel, singleInstanceEndpoint } from "../src/main/single-instance.ts";
import type { CliBackend } from "../src/main/cli.ts";

it("directory sync applies once, deletes successful requests and refreshes the snapshot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-sync-"));
  let current = "before";
  const apply = vi.fn(async () => { current = "after"; });
  const backend: CliBackend = { show: () => current, choices: () => [{ id: "api", label: "API" }],
    defaults: () => ({ targetId: "api", proxy: false, restart: false }), apply };
  expect(await connectCliControl(dir)).toBeNull();
  const close = await startCliControl(dir, backend);
  try {
    const remote = (await connectCliControl(dir))!;
    expect(remote.show()).toBe("before");
    const selection = { mode: "openai" as const, targetId: "api", proxy: true, restart: false };
    await remote.apply(selection);
    expect(apply).toHaveBeenCalledExactlyOnceWith(selection);
    expect(fs.existsSync(path.join(dir, "inbox/request.json"))).toBe(false);
    expect((await connectCliControl(dir))!.show()).toBe("after");
    current = "desktop change"; close.refresh();
    expect((await connectCliControl(dir))!.show()).toBe("desktop change");
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, "inbox/instance.json"), "utf8"));
    expect(metadata.token).toBeUndefined(); expect(metadata.endpoint).toBeUndefined();
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "inbox/instance.json")).mode & 0o777).toBe(0o600);
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("generic envelopes reject unsupported versions, message types, stale requests and invalid payloads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-sync-format-"));
  const apply = vi.fn(async () => {});
  const backend: CliBackend = { show: () => "current", choices: () => [], defaults: () => ({ targetId: "", proxy: false, restart: false }), apply };
  const close = await startCliControl(dir, backend);
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, "inbox/instance.json"), "utf8"));
    const message = { version: 1, id: "test", type: "access-mode.apply", targetInstanceId: metadata.instanceId,
      createdAt: Date.now(), expiresAt: Date.now() + 90000, status: "pending", payload: { mode: "gateway", targetId: "", proxy: false, restart: false } };
    const file = path.join(dir, "inbox/request.json");
    for (const patch of [{ version: 2 }, { type: "future.action" }, { expiresAt: 1 }, { payload: { ...message.payload, proxy: "false" } }]) {
      fs.writeFileSync(file, JSON.stringify({ ...message, ...patch }));
      await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(file, "utf8")).status).toBe("failed"));
      expect(JSON.parse(fs.readFileSync(file, "utf8")).error).toMatchObject({ code: "SYNC_FAILED" });
      fs.unlinkSync(file);
    }
    expect(apply).not.toHaveBeenCalled();
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("concurrent CLI requests cannot overwrite an active selection, and errors reach the caller", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-sync-busy-"));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const apply = vi.fn(async () => { await blocked; });
  const backend: CliBackend = { show: () => "current", choices: () => [], defaults: () => ({ targetId: "", proxy: false, restart: false }), apply };
  const close = await startCliControl(dir, backend);
  try {
    const remote = (await connectCliControl(dir))!;
    const selection = { mode: "gateway" as const, targetId: "", proxy: false, restart: false };
    const first = remote.apply(selection);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    const message = JSON.parse(fs.readFileSync(path.join(dir, "inbox/request.json"), "utf8"));
    expect(message).toMatchObject({ version: 1, type: "access-mode.apply", payload: selection, status: "applying" });
    await expect(remote.apply(selection)).rejects.toThrow(/正在进行/);
    release(); await first;
    apply.mockRejectedValueOnce(new Error("配置已应用，但重启失败"));
    await expect(remote.apply(selection)).rejects.toThrow("配置已应用，但重启失败");
    expect(fs.existsSync(path.join(dir, "inbox/request.json"))).toBe(false);
  } finally { release(); await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("restart does not replay a request from the previous instance", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-sync-restart-"));
  const apply = vi.fn(async () => {});
  const backend: CliBackend = { show: () => "current", choices: () => [], defaults: () => ({ targetId: "", proxy: false, restart: false }), apply };
  const close = await startCliControl(dir, backend);
  const file = path.join(dir, "inbox/request.json");
  await close();
  fs.writeFileSync(file, JSON.stringify({ version: 1, id: "old", type: "access-mode.apply", status: "applying" }));
  const closeNew = await startCliControl(dir, backend);
  try {
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ status: "failed", error: { code: "INSTANCE_CHANGED" } });
    expect(apply).not.toHaveBeenCalled();
    await (await connectCliControl(dir))!.apply({ mode: "gateway", targetId: "", proxy: false, restart: false });
    expect(apply).toHaveBeenCalledOnce();
  } finally { await closeNew(); fs.rmSync(dir, { recursive: true, force: true }); }
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
    fs.mkdirSync(path.join(second, "inbox"));
    fs.copyFileSync(path.join(first, "inbox/instance.json"), path.join(second, "inbox/instance.json"));
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
