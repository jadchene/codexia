import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

export function frameworkCompiler() {
  if (process.platform !== "win32") throw new Error("CLI EXE compilation requires Windows and its built-in .NET Framework C# compiler.");
  const windows = process.env.SystemRoot || process.env.WINDIR;
  if (!windows) throw new Error("Cannot locate Windows: SystemRoot is missing.");
  for (const framework of ["Framework64", "Framework"]) {
    const compiler = path.join(windows, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
    if (fs.existsSync(compiler)) return compiler;
  }
  throw new Error("Windows .NET Framework csc.exe was not found. Check that the built-in .NET Framework 4.x component is enabled.");
}

export function compileCSharp(output, sources) {
  const compiler = frameworkCompiler();
  const built = spawnSync(compiler, [
    "/nologo", "/target:exe", "/platform:anycpu", "/optimize+", "/debug-", "/utf8output",
    `/out:${output}`, ...sources
  ], { encoding: "utf8", windowsHide: true });
  if (built.error || built.status !== 0) {
    throw new Error(`CLI compilation failed: ${built.error?.message ?? built.stdout + built.stderr}`);
  }
}

export async function buildCli(output) {
  frameworkCompiler(); // Fail before changing output if the Windows compiler is unavailable.
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(output), ".cli-csharp-"));
  try {
    const executable = path.join(temporary, "codexia-cli.exe");
    const version = path.join(temporary, "Version.cs");
    fs.writeFileSync(version, `internal static class BuildInfo { internal const string Version = ${JSON.stringify(manifest.version)}; }\n`);
    compileCSharp(executable, [path.join(root, "native", "cli", "Launcher.cs"), version]);
    fs.copyFileSync(executable, output);
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
