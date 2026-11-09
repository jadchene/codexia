import { beforeEach, expect, test, vi } from "vitest";
import path from "node:path";
const command = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: command }));
import { restartCodexDaemon } from "../src/main/codex-daemon.ts";
beforeEach(() => { command.mockReset(); });
test("daemon restart uses the same Codex home and waits for command completion", async () => {
  command.mockImplementation((_file, _args, _options, callback) => callback(null, "", ""));
  await restartCodexDaemon({ codexDir: "/tmp/codexia-daemon-test" });
  expect(command).toHaveBeenCalledOnce();
  expect(command.mock.calls[0]?.[1]).toEqual(process.platform === "win32"
    ? ["/d", "/s", "/c", "codex app-server daemon restart"] : ["app-server", "daemon", "restart"]);
  expect(command.mock.calls[0]?.[2]).toMatchObject({ timeout: 60_000, env: { CODEX_HOME: path.resolve("/tmp/codexia-daemon-test") } });
});
test("daemon failure reports already applied configuration without exposing process output", async () => {
  command.mockImplementation((_file, _args, _options, callback) => callback(new Error("secret command output")));
  await expect(restartCodexDaemon()).rejects.toThrow(/配置已应用.*重启失败/);
  await expect(restartCodexDaemon()).rejects.not.toThrow(/secret command output/);
});
