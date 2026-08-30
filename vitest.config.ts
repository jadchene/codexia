import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          testTimeout: 10_000,
          include: ["test/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "renderer",
          environment: "happy-dom",
          testTimeout: 10_000,
          include: ["src/renderer/**/*.test.ts", "src/renderer/**/*.test.tsx"]
        }
      }
    ]
  }
});
