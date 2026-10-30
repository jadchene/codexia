# Codexia

[中文文档](README_zh.md)

Codexia is a Windows desktop app for using ChatGPT subscription accounts and third-party model channels from Codex in one place.

![Codexia overview](docs/screenshots/overview.png)

## Features

- Pool multiple ChatGPT subscription accounts behind one local API service.
- Add third-party Responses API channels and select all models from Codex.
- View account quota, reset credits, request analytics, and estimated costs.
- Request details show the requested tier, billing tier, and multiplier used for that call. Under **Logs & billing**, configure Standard / Fast / Ultrafast multipliers (defaults: 1 / 2 / 6); `priority` is treated as Fast. Estimates use only the requested tier; a missing or empty tier means Standard. The response tier does not affect estimates. Multipliers apply to input, cached input, and output costs and are saved per call. These are local estimates, not subscription quota consumption or guaranteed API billing rates.
- Wake unattended long-running sessions after account quota becomes available.
- Send scheduled messages to existing sessions or start new Codex sessions.
- Session Wakeups and Scheduled Tasks menus are hidden by default. Enable them individually under **Settings → General → Optional menus**. Hiding a menu does not stop existing tasks; manage their enabled state on the corresponding page.
- Manage Codex integration and an optional MCP service in one desktop app.

## Quick Start

1. Install Codex CLI and confirm that the `codex` command is available.
2. Extract the Windows unpacked build into a writable directory and open `Codexia.exe`. For source builds, see [Development](#development).
3. Add a ChatGPT subscription account, a model channel, or both.
4. Open **Integration Mode** and apply API mode.
5. Start the API service from **Services**.
6. Restart Codex to load the applied configuration and select a model.

## Usage

### Subscription Accounts and Model Channels

Sign in to a subscription account through the browser or import it from Codex. Codexia supports quota refresh, account enablement, reset-credit use, and account-pool routing.

Configure each third-party channel with an API address, API key, and model catalog, then preview and test it. Model IDs must be unique across channels. Keep **Remote compaction adaptation** enabled unless the channel natively supports Codex compaction.

The account-pool catalog updates at startup and on manual refresh, with cached and local Codex catalogs as fallbacks. Use the Codex Bundled override for a custom catalog.

View pool quota on **Overview**. Optional Plus-baseline normalization is off by default and supports plan multipliers. Total remaining quota can exceed 100%; the overview ring and client show the percentage of total capacity.

### Integration and Services

API mode combines subscription and third-party models. Account mode uses one subscription account, with an optional API proxy for request analytics.

**Services** starts, stops, and restarts the API service and the optional [`mcp-gateway-service`](https://github.com/jadchene/mcp-gateway). Configure the executable path and listening address before starting MCP for the first time. When `CODEX_HOME` is set, Codexia uses the Codex configuration in that directory; otherwise it uses the current user's `.codex` directory.

API or MCP setting changes may require restarting the corresponding service.

Single-instance mode is enabled by default. To run separate copies, turn off **Settings → General → App behavior → Single-instance mode**, save, and restart the app. Use separate program directories, service ports, and API keys for independent account pools. Only apply integration settings from the copy used by your local Codex, or use a separate `CODEX_HOME` for each copy.

For other Responses API clients, use the service address with `/v1` as the base URL (default `http://localhost:8436/v1`) and the local access key from Settings. Model discovery uses `GET /v1/models`; requests use `POST /v1/responses`. Availability depends on the configured subscription accounts and channels.

### Session Wakeup

Register a session UUID, active window, and attempt limit. When pool quota is exhausted, Codexia waits for a reset, refreshes quota, and sends a continuation message after recovery. **Resume Goal** reactivates an unfinished Goal. Disabling, deleting, expiry, or reaching the limit stops pending wakeups.

### Scheduled Tasks

Send messages to an existing session or start a new session in a chosen directory on each run. Use the visual builder or a five-field Cron expression; `0 22 * * *` runs daily at 22:00 local time. A task never overlaps itself, and missed runs after restart or sleep are not replayed. Slash commands sent to existing sessions remain plain text.

Both features require Codexia to stay running and `codex` to be available. Existing sessions must stay running and use the same `CODEX_HOME`.

### Data and Debugging

Packaged data lives in `data/` beside the executable; development uses the project's `data/`. Preserve it during upgrades and close the app before backup. Credentials use Windows encryption and may not work under another user or on another machine.

Database upgrade backups live in `data/backups/`; backups older than 24 hours are removed at startup or during cleanup.

API debugging is off by default. When enabled, request and response bodies are saved temporarily in `data/logs/` for up to 10 minutes and deleted when debugging stops, expires, or the app exits. Bodies may contain sensitive data; enable debugging only for troubleshooting.

## Development

Node.js 24 or newer is required.

```bash
npm install
npm run dev
npm run verify
```

Create the Windows unpacked build with:

```bash
npm run pack:unpacked
```

The output is `release/win-unpacked/Codexia.exe`. It is not code-signed and does not include an installer.

## License

MIT. See [LICENSE](LICENSE).
