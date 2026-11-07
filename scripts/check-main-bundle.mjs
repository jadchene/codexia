import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = ["main.mjs", "request-log-worker.mjs"]
  .map((name) => fs.readFileSync(path.join(projectRoot, "dist", "main", name), "utf8"))
  .join("\n");

const forbidden = [
  {
    pattern: /(?:require\d*|require)\(["']\.{1,2}\/[^"']+\.ts["']\)/,
    message: "main bundle still loads a TypeScript source file at runtime"
  },
  {
    pattern: /from\s+["']\.{1,2}\/[^"']+\.ts["']/,
    message: "main bundle still imports a TypeScript source file at runtime"
  },
  {
    pattern: /(?:from\s+["']sqlite["']|(?:require\d*|require)\(["']sqlite["']\))/,
    message: "node:sqlite was rewritten to the nonexistent sqlite package"
  }
];

for (const rule of forbidden) {
  if (rule.pattern.test(bundle)) throw new Error(`Invalid main bundle: ${rule.message}.`);
}

if (!bundle.includes('"node:sqlite"')) {
  throw new Error("Invalid main bundle: node:sqlite runtime binding is missing.");
}

const runtimeImports = new Set([
  ...Array.from(bundle.matchAll(/\bfrom\s+["']([^"']+)["']/g), (match) => match[1]),
  ...Array.from(bundle.matchAll(/\bimport\s*["']([^"']+)["']/g), (match) => match[1]),
  ...Array.from(bundle.matchAll(/\brequire\d*\(["']([^"']+)["']\)/g), (match) => match[1])
].filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:")));
const allowedRuntimeImports = new Set(["electron", "ws", ...builtinModules, ...builtinModules.map((specifier) => `node:${specifier}`)]);
const unexpectedRuntimeImports = [...runtimeImports].filter((specifier) => !allowedRuntimeImports.has(specifier));
if (unexpectedRuntimeImports.length > 0) {
  throw new Error(`Invalid main bundle: undeclared runtime packages remain external: ${unexpectedRuntimeImports.join(", ")}.`);
}

console.log("Main bundle audit passed: source TypeScript imports are absent, node:sqlite is preserved, and only electron/ws remain external.");
