const cliIndex = process.argv.indexOf("--cli");
if (cliIndex >= 0) {
  const { startCli } = await import("./cli-runtime.ts");
  void startCli(process.argv.slice(cliIndex + 1).filter((arg) => arg !== "--cli-interactive" && arg !== "--isolated-dev" && !arg.startsWith("--codex-test-dir=")));
} else {
  await import("./runtime.ts");
}
export {};
