import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { expect, it, vi } from "vitest";
import { connectCliControl, startCliControl } from "../src/main/cli-control.ts";
import { acquireSingleInstanceChannel, closeSingleInstanceChannel, singleInstanceEndpoint } from "../src/main/single-instance.ts";
import type { CliBackend } from "../src/main/cli.ts";

it("local control authenticates, validates and serializes mode changes without exposing credentials", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia-control-"));
  let active = 0; let maximum = 0;
  const backend: CliBackend = { show: () => "current", choices: () => [{ id: "api", label: "API" }], defaults: () => ({ targetId: "api", proxy: false, restart: false }),
    apply: vi.fn(async () => { active++; maximum = Math.max(active, maximum); await new Promise((r) => setTimeout(r, 20)); active--; }) };
  expect(await connectCliControl(dir)).toBeNull();
  const close = await startCliControl(dir, backend);
  try {
    const remote = (await connectCliControl(dir))!;
    expect(remote.show()).toBe("current");
    expect(remote.choices("openai")).toEqual([{ id: "api", label: "API" }]);
    const selection = { mode: "openai" as const, targetId: "api", proxy: true, restart: false };
    await Promise.all([remote.apply(selection), remote.apply(selection)]);
    expect(maximum).toBe(1); expect(backend.apply).toHaveBeenCalledTimes(2);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "cli-control.json"), "utf8"));
    const raw = (message: object) => new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(meta.endpoint); let text = "";
      socket.on("error", reject); socket.on("data", (c) => text += c);
      socket.on("end", () => resolve(text)); socket.on("connect", () => socket.end(JSON.stringify({ instanceDirectory: meta.instanceDirectory, ...message }) + "\n"));
    });
    expect(await raw({ token: "wrong", action: "apply", selection })).toContain("认证失败");
    expect(await raw({ token: meta.token, action: "apply", selection: { ...selection, proxy: "true" } })).toContain("参数无效");
    expect(backend.apply).toHaveBeenCalledTimes(2);
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "cli-control.json")).mode & 0o777).toBe(0o600);
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
    fs.copyFileSync(path.join(first, "cli-control.json"), path.join(second, "cli-control.json"));
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
