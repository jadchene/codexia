# Codexia

[中文文档](README_zh.md)

Codexia is a Windows desktop app for using ChatGPT subscription accounts, the official OpenAI API, and third-party model channels from Codex.

![Codexia overview](docs/screenshots/overview.png)

## Features

- Manage subscription pools and model channels through a local Responses API service.
- View account quota, request analytics, and estimated costs.
- Manage Codex integration and an optional [MCP service](https://github.com/jadchene/mcp-gateway).

## Quick Start

1. Install Codex CLI and confirm that the `codex` command is available.
2. Extract the Windows portable build into a writable directory and open `Codexia.exe`.
3. Add an account or model channel. Accounts support browser login and Codex import. Official OpenAI channels need only an API key; third-party channels need an API address, API key, and model catalog.
4. Choose a mode under **Integration Mode** and apply it to Codex. For Gateway mode, start the gateway service under **Services**.
5. Enable automatic app-server restart for the selected mode, or restart Codex manually after applying.

## Usage Notes

- **Gateway mode** combines the account pool and model channels. Shared model IDs prefer the enabled pool; disable the pool to use the official API.
- **Account mode** uses the selected subscription account and supports the pool's model catalog override, excluding third-party channel models.
- Third-party model IDs must be unique across channels and the built-in catalog. Configure model rates per channel; estimates do not represent actual bills.
- Other Responses API clients can use `http://localhost:8436/v1` with the local access key from Settings.
- Codex configuration defaults to the current user's `.codex` directory. Set `CODEX_HOME` to use another location.

## Data and Upgrades

Data lives in `data/` beside the executable. Preserve this directory during upgrades and close the app before backup. Credentials use Windows encryption; moving to another user or machine may require signing in again.

API debugging temporarily records request and response bodies, which may contain sensitive data. Enable it only for troubleshooting.

## Development

Node.js 24 or newer is required.

```bash
npm install
npm run dev
npm run verify
npm run pack:unpacked
```

The package output is `release/win-unpacked/Codexia.exe`. It is not code-signed.

## License

MIT. See [LICENSE](LICENSE).

## Access modes in 2.0.0

Choose Account, OpenAI API, Third-party API, or Gateway mode (formerly API mode). The two independent API modes use one selected channel and its model catalog; channel enable switches only control gateway routing. All three non-gateway modes can use the local gateway as a monitoring proxy without changing business payloads, credentials, quotas, or routing.

Each mode has its own automatic app-server restart switch. After applying configuration it runs `codex app-server daemon restart` with the same `CODEX_HOME`. Active account tokens are read from Codex’s `auth.json`; Codex owns token refresh.

### CLI: version and access modes

The Windows unpacked build includes a Node.js entry point, `codexia-cli.cjs`: run `node codexia-cli.cjs --version`, `node codexia-cli.cjs mode`, or `node codexia-cli.cjs mode switch`. No running desktop is required. The entry resolves its real file path, so symlinks still target the original installation, including with `--preserve-symlinks-main`.

The optional `codexia-cli.cmd` shortcut uses Electron’s Node mode and requires no separate Node.js installation. For symlinks, link the `.cjs` file and run it with Node; do not link the `.cmd` shortcut.

```powershell
.\codexia-cli.cmd --version
.\codexia-cli.cmd mode
.\codexia-cli.cmd mode switch
.\codexia-cli.cmd mode switch --mode account --account <account-id> --proxy false --restart true
.\codexia-cli.cmd mode switch --mode openai --channel <channel-id> --proxy false --restart true
.\codexia-cli.cmd mode switch --mode third_party --channel <channel-id> --proxy true --restart false
.\codexia-cli.cmd mode switch --mode gateway --restart true
```

`mode` shows the saved mode, detected Codex authentication, proxy/restart preferences and available account/channel IDs. Interactive switching offers accounts or channels of the selected type. Import accounts and configure channels/models in the desktop app first. Tokens and API keys are never printed.

CLI only associates with the desktop in its own installation directory, independently of the desktop single-instance setting. It never discovers or reuses other installations. Without a running local desktop, CLI writes that installation's SQLite and Codex configuration itself for all four modes. With a running local desktop, it delegates through local IPC and requires matching application versions. CLI never starts Codexia or the gateway automatically. A stopped gateway does not prevent saving; gateway/proxy selections print a manual-start reminder. Restart preferences remain per mode; daemon restart errors report that configuration may already be applied.

For development, build with `npm run build:main`, then use `npm run cli -- --version`, `npm run cli -- mode`, or `npm run cli -- mode switch`. Add `--isolated-dev --codex-test-dir=.runtime/v1-dev/codex` for isolated development data. The CLI uses the same system secret storage as the desktop app; it is not a server/headless Electron distribution. Windows is the packaged target; other systems still need a working Electron environment and system secret storage.


### Local process communication

CLI talks to its own installation's desktop over a Windows named pipe or Unix Socket. No HTTP listener, IP/port settings, or API key configuration is needed. `data/cli-control.json` only records the current endpoint, instance directory, application version and a temporary authentication token generated on every launch; it carries no configuration requests or upstream credentials.

The extensible request envelope contains `version: 1`, `appVersion: "2.0.0"`, a unique `id`, `method` and `params`. CLI attaches the target instance directory and temporary token. Responses echo the ID and versions, with `ok` and either `result` or `error: { code, message }`. Application and protocol versions are checked separately.

Currently `access-mode.get` reads the current mode, choices, preferences and gateway state. `access-mode.apply` accepts `{ "mode": "third_party", "targetId": "channel-id", "proxy": true, "restart": false }`. Gateway mode uses an empty target ID and `proxy: false`. Future features register additional methods with their own parameter validation without changing the transport. Unknown methods and incompatible versions never execute writes.

Other installations are ignored even when they run the same version in single-instance mode. Requests remain pinned to the chosen process and are never redirected after it exits or restarts. Inbox request files and the HTTP control service are no longer used; obsolete HTTP configuration keys are removed on startup.
