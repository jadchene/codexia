import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildCli } from "./build-cli.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codexia exe 中文 "));
try {
  const installation = path.join(temporary, "original installation");
  const external = path.join(temporary, "external");
  fs.mkdirSync(installation);
  fs.mkdirSync(external);
  const executable = await buildCli(path.join(installation, process.platform === "win32" ? "codexia-cli.exe" : "codexia-cli"));
  const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  function run(entry, args, input = "") {
    return spawnSync(entry, args, {
      cwd: external, input, encoding: "utf8", timeout: 15_000,
      // The installed entry must not search PATH for Node or another Codexia.
      env: { ...process.env, PATH: "", ELECTRON_RUN_AS_NODE: "1" }
    });
  }
  for (const flag of ["--version", "-v", "version"]) {
    const result = run(executable, [flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `Codexia ${version}`);
  }
  const missing = run(executable, ["mode"]);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /ENOENT/);

  const linkedDirectory = path.join(external, "linked installation");
  fs.symlinkSync(installation, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  const entries = [executable, path.join(linkedDirectory, path.basename(executable))];
  try {
    const first = path.join(external, "first.exe");
    const second = path.join(external, "second.exe");
    fs.symlinkSync(executable, first, "file");
    fs.symlinkSync(first, second, "file");
    entries.push(second);
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
    console.log("File symlink test skipped: Windows requires Developer Mode or symlink privilege; directory junction test remains enabled.");
  }
  for (const entry of entries) {
    const result = run(entry, ["--version"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `Codexia ${version}`);
  }
  if (process.platform === "linux") {
    fs.writeFileSync(path.join(installation, "Codexia.exe"), `#!${process.execPath}
const fs = require('node:fs');
process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,'utf8'),cwd:process.cwd(),nodeMode:process.env.ELECTRON_RUN_AS_NODE??null}));
process.stderr.write('child stderr');
process.exitCode = 7;
`, { mode: 0o755 });
    const args = ["mode", "空 格", 'quote"', "trailing\\", "$(echo wrong)&"];
    for (const entry of entries) {
      const result = run(entry, args, "input\n");
      assert.equal(result.status, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { args: ["--cli", ...args], input: "input\n", cwd: external, nodeMode: null });
      assert.equal(result.stderr, "child stderr");
    }
  } else {
    console.log("Run npm run smoke:unpacked to verify forwarding to the real Windows Codexia.exe.");
  }
  console.log("CLI executable integration checks passed.");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
