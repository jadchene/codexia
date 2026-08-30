import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererOutput = path.join(projectRoot, "dist", "renderer");

if (path.dirname(rendererOutput) !== path.join(projectRoot, "dist")) {
  throw new Error("Refusing to clean an unexpected renderer output path.");
}

fs.rmSync(rendererOutput, { recursive: true, force: true });
