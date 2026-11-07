import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { buildCli } from "./build-cli.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codexia exe 中文 "));
try {
  const installation = path.join(temporary, "original installation");
  const external = path.join(temporary, "external");
  fs.mkdirSync(installation);
  fs.mkdirSync(external);
  const executable = await buildCli(path.join(installation, process.platform === "win32" ? "codexia-cli.exe" : "codexia-cli"), { platform: process.platform === "win32" ? "windows" : "linux" });
  // Validate the actual Windows artifact even when running behavior tests on Linux.
  const windowsExe = process.platform === "win32" ? executable : await buildCli(path.join(temporary, "windows", "codexia-cli.exe"));
  const pe = fs.readFileSync(windowsExe);
  assert.equal(pe.toString("ascii", 0, 2), "MZ");
  const header = pe.readUInt32LE(0x3c);
  assert.equal(pe.toString("ascii", header, header + 4), "PE\0\0");
  assert.equal(pe.readUInt16LE(header + 4), process.arch === "arm64" ? 0xaa64 : 0x8664);
  assert.equal(pe.readUInt16LE(header + 24 + 68), 3, "CLI must use the Windows console subsystem");
  assert.ok(pe.length < 5 * 1024 * 1024, "CLI must not embed another large runtime");
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
  assert.match(missing.stderr, /Cannot start same-directory Codexia/);

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
if (process.argv.includes('--quick')) { process.stdout.write('quick'); }
else if (process.argv.includes('--bulk')) { process.stdout.write('x'.repeat(256 * 1024)); }
else if (process.argv.includes('--block')) { process.stdout.write('ready'); process.stdin.resume(); }
else {
process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,'utf8'),cwd:process.cwd(),nodeMode:process.env.ELECTRON_RUN_AS_NODE??null}));
process.stderr.write('child stderr');
process.exitCode = 7;
}
`, { mode: 0o755 });
    const args = ["mode", "空 格", 'quote"', "trailing\\", "$(echo wrong)&"];
    for (const entry of entries) {
      const result = run(entry, args, "input\n");
      assert.equal(result.status, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { args: ["--cli", ...args], input: "input\n", cwd: external, nodeMode: null });
      assert.equal(result.stderr, "child stderr");
    }
    const bulk = run(executable, ["--bulk"]);
    assert.equal(bulk.status, 0, bulk.stderr);
    assert.equal(bulk.stdout, "x".repeat(256 * 1024));
    // Keep the parent's stdin open: --help must still exit without waiting for input.
    async function live(args, interrupt) {
      const child = spawn(executable, args, { cwd: external, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.stdout.on("data", (data) => {
        output += data;
        if (interrupt && output.includes("ready")) child.kill("SIGINT");
      });
      try {
        const code = await new Promise((resolve, reject) => {
          child.on("error", reject);
          child.on("close", (code) => resolve(code));
        });
        assert.equal(code, interrupt ? 130 : 0);
        assert.equal(output, interrupt ? "ready" : "quick");
      } finally { clearTimeout(timer); child.stdin.destroy(); }
    }
    await live(["--quick"], false);
    await live(["--block"], true);
  } else {
    console.log("Run npm run smoke:unpacked to verify forwarding to the real Windows Codexia.exe.");
  }
  console.log("CLI executable integration checks passed.");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
