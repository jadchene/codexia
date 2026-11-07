import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inject } from "postject";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Build with the exact runtime being embedded; SEA blobs are Node-version specific.
export async function buildCli(output) {
  if (!["win32", "linux"].includes(process.platform) || Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error("CLI packaging requires Node.js 24+ on Windows (Linux is supported for tests).");
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(output), ".cli-sea-"));
  try {
    const blob = path.join(temporary, "cli.blob");
    const config = path.join(temporary, "sea.json");
    fs.writeFileSync(config, JSON.stringify({
      main: path.join(root, "scripts", "cli-launcher.cjs"),
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      assets: { manifest: path.join(root, "package.json") }
    }));
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const prepared = spawnSync(process.execPath, ["--experimental-sea-config", config], { env, encoding: "utf8" });
    if (prepared.error || prepared.status !== 0) {
      throw new Error(`Cannot prepare CLI executable: ${prepared.error?.message ?? prepared.stderr}`);
    }
    const executable = path.join(temporary, process.platform === "win32" ? "codexia-cli.exe" : "codexia-cli");
    fs.copyFileSync(process.execPath, executable);
    fs.chmodSync(executable, 0o755);
    await inject(executable, "NODE_SEA_BLOB", fs.readFileSync(blob), {
      sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
    });
    fs.copyFileSync(executable, output);
    fs.chmodSync(output, 0o755);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.join(root, "dist", "cli", process.platform === "win32" ? "codexia-cli.exe" : "codexia-cli");
  await buildCli(output);
  console.log(`CLI executable created: ${output}`);
}
