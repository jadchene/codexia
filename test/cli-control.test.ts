import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { expect, it, vi } from "vitest";
import { connectCliControl, startCliControl } from "../src/main/cli-control.ts";
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
      socket.on("end", () => resolve(text)); socket.on("connect", () => socket.end(JSON.stringify(message) + "\n"));
    });
    expect(await raw({ token: "wrong", action: "apply", selection })).toContain("认证失败");
    expect(await raw({ token: meta.token, action: "apply", selection: { ...selection, proxy: "true" } })).toContain("参数无效");
    expect(backend.apply).toHaveBeenCalledTimes(2);
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "cli-control.json")).mode & 0o777).toBe(0o600);
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
