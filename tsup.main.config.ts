import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main/main.ts" },
  format: ["esm"],
  outDir: "dist/main",
  outExtension: () => ({ js: ".mjs" }),
  platform: "node",
  target: "node24",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  ignoreWatch: ["**/.runtime/**", "**/data/**", "**/release/**"],
  external: ["electron", "ws"],
  noExternal: ["zod"],
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __pathDirname } from "node:path";',
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);"
    ].join("\n")
  },
  treeshake: false
});
