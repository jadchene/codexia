#!/usr/bin/env node
// Shared by the development launcher and the packaged Node single executable.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
// Resolve the entry file itself, including --preserve-symlinks-main invocations.
const sea = require('node:sea');
const standalone = sea.isSea();
const launcher = fs.realpathSync(standalone ? process.execPath : __filename);
const packaged = standalone || path.basename(launcher) === 'codexia-cli.cjs';
const installation = path.dirname(launcher);
const root = packaged ? path.join(installation, 'resources', 'app') : path.resolve(installation, '..');
const manifest = JSON.parse(standalone ? sea.getAsset('manifest', 'utf8') : fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
if (args.length === 1 && ['--version', '-v', 'version'].includes(args[0])) {
  console.log(`Codexia ${manifest.version}`);
} else {
  const executable = packaged ? path.join(installation, 'Codexia.exe') : require(path.join(root, 'node_modules', 'electron'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [...(packaged ? [] : [root]), '--cli', ...(process.stdin.isTTY ? ['--cli-interactive'] : []), ...args], {
    env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') console.error(error.message); });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; process.stdin.destroy(); });
  child.on('close', (code, signal) => {
    process.stdin.unpipe(child.stdin);
    process.stdin.destroy();
    process.exitCode = code !== null && code >= 0 ? code : (signal === 'SIGINT' ? 130 : 1);
  });
}
