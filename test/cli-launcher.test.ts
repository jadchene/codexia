import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexia cli 中文 "));
  temporary.push(dir);
  const app = path.join(dir, "resources", "app");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ version: "2.0.0" }));
  const launcher = path.join(dir, "codexia-cli.cjs");
  fs.copyFileSync("scripts/cli-launcher.cjs", launcher);
  return { dir, launcher };
}

it("reads the packaged version through Node without launching Electron", () => {
  const { launcher } = fixture();
  const result = spawnSync(process.execPath, [launcher, "--version"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("Codexia 2.0.0");
});

it.skipIf(process.platform === "win32")("resolves chained entry symlinks and forwards arguments, input, output and exit status", () => {
  const { dir, launcher } = fixture();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "codexia cli links "));
  temporary.push(elsewhere);
  const link = path.join(elsewhere, "external.cjs");
  fs.symlinkSync(launcher, path.join(elsewhere, "first.cjs"));
  fs.symlinkSync("first.cjs", link);
  fs.writeFileSync(path.join(dir, "Codexia.exe"), `#!${process.execPath}
const fs = require('node:fs');
process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,'utf8'),cwd:process.cwd(),nodeMode:process.env.ELECTRON_RUN_AS_NODE??null}));
process.stderr.write('child stderr');
process.exitCode = 7;
`, { mode: 0o755 });
  const args = ["mode", "空 格", 'quote"', "trailing\\", "$(echo wrong)&"];
  const result = spawnSync(process.execPath, ["--preserve-symlinks-main", link, ...args], {
    cwd: elsewhere, input: "input\n", encoding: "utf8", timeout: 10_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });
  expect(result.status).toBe(7);
  expect(JSON.parse(result.stdout)).toEqual({ args: ["--cli", ...args], input: "input\n", cwd: elsewhere, nodeMode: null });
  expect(result.stderr).toBe("child stderr");
});

it("reports a missing same-directory executable without falling back to another installation", () => {
  const { launcher } = fixture();
  const result = spawnSync(process.execPath, [launcher, "mode"], { encoding: "utf8", timeout: 10_000 });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("ENOENT");
});
