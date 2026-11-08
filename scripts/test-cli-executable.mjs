import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildCli, compileCSharp } from "./build-cli.mjs";

if (process.platform !== "win32") {
  console.log("SKIPPED: C# executable integration tests require Windows and its built-in .NET Framework compiler.");
  process.exit(0);
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codexia exe 中文 "));
try {
  const installation = path.join(temporary, "original installation");
  const external = path.join(temporary, "external");
  fs.mkdirSync(installation);
  fs.mkdirSync(external);
  const executable = await buildCli(path.join(installation, "codexia-cli.exe"));
  const pe = fs.readFileSync(executable);
  assert.equal(pe.toString("ascii", 0, 2), "MZ");
  const header = pe.readUInt32LE(0x3c);
  assert.equal(pe.toString("ascii", header, header + 4), "PE\0\0");
  assert.equal(pe.readUInt16LE(header + 24 + 68), 3, "CLI must use the Windows console subsystem");
  assert.ok(pe.length < 256 * 1024, "CLI must not embed a runtime");
  const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  function run(entry, args, input = "") {
    return spawnSync(entry, args, {
      cwd: external, input, encoding: "utf8", timeout: 15_000,
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
  fs.symlinkSync(installation, linkedDirectory, "junction");
  const entries = [executable, path.join(linkedDirectory, "codexia-cli.exe")];
  try {
    const first = path.join(external, "first.exe");
    const second = path.join(external, "second.exe");
    fs.symlinkSync(executable, first, "file");
    fs.symlinkSync(first, second, "file");
    entries.push(second);
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error;
    console.log("File symlink test skipped: enable Windows Developer Mode or symlink privilege. Junction test remains enabled.");
  }
  compileCSharp(path.join(installation, "Codexia.exe"), [fileURLToPath(new URL("../test/fixtures/cli-child.cs", import.meta.url))]);
  const args = ["mode", "", "空 格", 'quote"', "trailing\\", 'back\\\\"quote', "$(echo wrong)&"];
  for (const entry of entries) {
    const result = run(entry, args, "input 中文\n");
    assert.equal(result.status, 7, result.stderr);
    const lines = result.stdout.trimEnd().split(/\r?\n/).map((line) => Buffer.from(line, "base64").toString("utf8"));
    assert.deepEqual(lines, ["input 中文\n", external, "", version, "--cli", ...args]);
    assert.equal(result.stderr, "child stderr");
  }
  const bulk = run(executable, ["--bulk"]);
  assert.equal(bulk.status, 0, bulk.stderr);
  assert.equal(bulk.stdout, "x".repeat(256 * 1024));
  // Keep input open to catch blocked exits and buffering until EOF.
  for (const flag of ["--quick", "--line"]) {
    const child = spawn(executable, [flag], { cwd: external, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on("data", (data) => { output += data; });
    if (flag === "--line") child.stdin.write("输入中文\n");
    try {
      const code = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      assert.equal(code, 0);
      assert.equal(output, flag === "--line" ? "输入中文" : "quick");
    } finally { clearTimeout(timer); child.stdin.destroy(); }
  }
  console.log(`C# CLI executable integration checks passed (${pe.length} bytes).`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
