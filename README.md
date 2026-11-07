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

The Windows unpacked build includes a separate `codexia-cli.cmd` launcher. It does not require a separate Node.js installation or a running desktop app. Use this explicit filename to avoid resolving `Codexia.exe` instead.

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

CLI never starts Codexia or the gateway automatically. If Codexia is not running, CLI writes SQLite and Codex configuration locally for all four modes. A stopped gateway does not prevent saving; gateway/proxy selections print a manual-start reminder afterward. When a desktop is running, all reads and writes use its HTTP API. Discovery follows the launcher installation’s single-instance setting: globally reuse the current user’s single-instance desktop when enabled, or only the same installation when disabled. Changing this setting still requires a desktop restart. Restart preferences remain per mode; a daemon restart failure explicitly reports that configuration was already applied.

For development, build with `npm run build:main`, then use `npm run cli -- --version`, `npm run cli -- mode`, or `npm run cli -- mode switch`. Add `--isolated-dev --codex-test-dir=.runtime/v1-dev/codex` for isolated development data. The CLI uses the same system secret storage as the desktop app; it is not a server/headless Electron distribution. Windows is the packaged target; other systems still need a working Electron environment and system secret storage.


### External HTTP API

Settings → External API configures the listening address, port and independent Bearer key. Restart the application after saving changes. The default is `127.0.0.1:8437`; this service starts with Codexia independently of the model gateway. Generate and copy a new key in settings before saving it. Use distinct API ports for multiple installations.

All routes use `/codexia/api`. Currently one resource is implemented:

- `GET /codexia/api/access-mode` returns `{ "ok": true, "result": ... }`. The result contains `current` (mode, target ID, proxy and restart; `null` when unset), per-mode `choices` and `defaults`, `gatewayRunning`, and human-readable `show`. No account tokens or upstream API keys are returned.
- `POST /codexia/api/access-mode` accepts `Content-Type: application/json` and `{ "mode": "third_party", "targetId": "channel-id", "proxy": true, "restart": false }`, saves configuration and refreshes the desktop. Modes are `account`, `openai`, `third_party`, and `gateway`; gateway requires an empty target ID and `proxy: false`.

Send `Authorization: Bearer <API key>` with every request. POST success returns `{ "ok": true, "result": { "gatewayRunning": false, "warning": "manual-start reminder, or an empty string" } }`. Saving works with the gateway stopped; neither API nor CLI starts the gateway or desktop. The `restart` flag only controls restarting Codex daemon app-server after applying configuration.

Errors use `{ "ok": false, "error": { "code": "CODE", "message": "details" } }`: HTTP 401 for authentication, 400 for malformed JSON/parameters, 413 above 16 KiB, and 500 for execution failures. A daemon restart failure can occur after configuration was applied; check the reported state before retrying.

CLI exchanges business data exclusively over HTTP when Codexia is running. There is no inbox watcher or JSON request protocol. The local `control-api.json` and global single-instance registration only locate the owning process; they do not carry synchronization requests.
