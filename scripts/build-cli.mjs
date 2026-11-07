import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// No third-party Go packages or end-user runtimes are required.
export async function buildCli(output, { platform = "windows", arch = process.arch } = {}) {
  const goarch = { x64: "amd64", arm64: "arm64" }[arch];
  if (!goarch || !["windows", "linux"].includes(platform)) throw new Error("CLI supports Windows/Linux x64 and arm64 builds.");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(output), ".cli-native-"));
  try {
    const executable = path.join(temporary, "codexia-cli.exe");
    const built = spawnSync(process.env.CODEXIA_GO || "go", [
      "build", "-trimpath", "-buildvcs=false", "-ldflags", `-s -w -X main.version=${manifest.version}`,
      "-o", executable, "."
    ], {
      cwd: path.join(root, "native", "cli"), encoding: "utf8",
      env: { ...process.env, GOOS: platform, GOARCH: goarch, CGO_ENABLED: "0", GOTOOLCHAIN: "local",
        GOCACHE: process.env.GOCACHE || path.join(root, "node_modules", ".cache", "go-build") }
    });
    if (built.error || built.status !== 0) {
      throw new Error(`CLI build requires Go 1.24+ (set CODEXIA_GO to its executable): ${built.error?.message ?? built.stderr}`);
    }
    fs.copyFileSync(executable, output);
    fs.chmodSync(output, 0o755);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.join(root, "dist", "cli", "codexia-cli.exe");
  await buildCli(output);
  console.log(`CLI executable created: ${output} (${fs.statSync(output).size} bytes)`);
}
