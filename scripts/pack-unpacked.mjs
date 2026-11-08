import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { rcedit } from "rcedit";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(projectRoot, "release");
const outputDir = path.join(releaseRoot, "win-unpacked");
const electronExecutable = require("electron");
const electronDist = path.dirname(electronExecutable);
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const iconPath = path.join(projectRoot, "assets", "app-icon.ico");

if (path.dirname(outputDir) !== releaseRoot || path.dirname(releaseRoot) !== projectRoot) {
  throw new Error(`拒绝清理非预期打包目录：${outputDir}`);
}
for (const requiredFile of [
  path.join(projectRoot, "dist", "main", "main.mjs"),
  path.join(projectRoot, "dist", "preload", "index.cjs"),
  path.join(projectRoot, "dist", "renderer", "index.html"),
  path.join(projectRoot, "assets", "app-icon.png"),
  iconPath
]) {
  if (!fs.existsSync(requiredFile)) throw new Error(`缺少构建产物：${requiredFile}`);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(releaseRoot, { recursive: true });
fs.cpSync(electronDist, outputDir, { recursive: true });

const sourceExecutable = path.join(outputDir, path.basename(electronExecutable));
const targetExecutable = path.join(outputDir, "Codexia.exe");
fs.renameSync(sourceExecutable, targetExecutable);
await rcedit(targetExecutable, {
  icon: iconPath,
  "file-version": manifest.version,
  "product-version": manifest.version,
  "version-string": {
    CompanyName: manifest.author,
    FileDescription: "Codexia",
    InternalName: "Codexia",
    OriginalFilename: "Codexia.exe",
    ProductName: "Codexia"
  }
});

const resourcesDir = path.join(outputDir, "resources");
fs.rmSync(path.join(resourcesDir, "default_app.asar"), { force: true });
const appDir = path.join(resourcesDir, "app");
fs.mkdirSync(path.join(appDir, "dist"), { recursive: true });
for (const output of ["main", "preload", "renderer"]) {
  fs.cpSync(path.join(projectRoot, "dist", output), path.join(appDir, "dist", output), { recursive: true });
}
fs.cpSync(path.join(projectRoot, "assets"), path.join(appDir, "assets"), { recursive: true });
fs.mkdirSync(path.join(appDir, "node_modules"), { recursive: true });
fs.cpSync(path.join(projectRoot, "node_modules", "ws"), path.join(appDir, "node_modules", "ws"), { recursive: true });

fs.writeFileSync(path.join(appDir, "package.json"), `${JSON.stringify({
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  license: manifest.license,
  main: manifest.main,
  dependencies: { ws: manifest.dependencies.ws }
}, null, 2)}\n`, "utf8");

console.log(`Unpacked application created: ${outputDir}`);
