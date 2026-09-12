# Codexia

[中文文档](README_zh.md)

## What This Project Is

Codexia is a Windows desktop app for using ChatGPT subscription accounts and third-party model channels from Codex in one place.

![Codexia overview](docs/screenshots/overview.png)

## Why Use It

- Pool multiple ChatGPT subscription accounts behind one local API service.
- Add third-party Responses API channels and select all models from Codex.
- View account quota, reset credits, request analytics, and estimated costs.
- Wake unattended long-running sessions after account quota becomes available.
- Send scheduled messages to existing sessions or start new Codex sessions.
- Manage Codex integration and an optional MCP service in one desktop app.

## Quick Start

1. Install Codex CLI and confirm that the `codex` command is available.
2. Open `Codexia.exe`.
3. Add a ChatGPT subscription account, a model channel, or both.
4. Open **Integration Mode** and apply API mode.
5. Start the API service from **Services**.
6. Return to Codex and select a model.

API mode makes subscription and third-party models available together. Account mode uses one selected subscription account.

## Core Features

### Subscription Accounts and Model Channels

Sign in to a subscription account through the browser or import it from Codex. Codexia supports quota refresh, account enablement, reset-credit use, and account-pool routing.

Third-party channels can configure an API address, API key, `models.json`, WebSocket support, balance lookup, request headers, and model prices. Preview the model catalog and run a connection test before use. Model IDs must be unique across channels. Keep **Remote compaction adaptation** enabled unless the channel natively supports Codex compaction.

The built-in subscription channel also supports an optional Codex Bundled override. When enabled, its custom catalog replaces the CLI catalog before third-party models are merged.

### Integration and Services

**Integration Mode** writes the selected configuration to Codex. API mode uses the local API service. Account mode uses one subscription account and can optionally proxy `/responses` through the same API service for request analytics.

**Services** starts, stops, and restarts the API service and the optional [`mcp-gateway-service`](https://github.com/jadchene/mcp-gateway). Configure the executable path and listening address before starting MCP for the first time. When `CODEX_HOME` is set, Codexia uses the Codex configuration in that directory; otherwise it uses the current user's `.codex` directory.

> Known limitation: Codex CLI 0.154.0 may omit quota from `/status` and the status line in API-key mode. The gateway still uses quota data; view the remaining account-pool quota on Codexia's **Overview** page.

### Session Wakeup

**Session Wakeup** is intended for unattended long-running work. Register a session UUID, active time window, and maximum attempt count:

- When the subscription pool is out of quota and no account can take over, Codexia waits for the nearest reset and wakes the session only after refreshed quota is available.
- **Resume Goal** reactivates an unfinished Goal; otherwise Codexia sends a normal continuation message.
- Disabling, deleting, expiry, or reaching the attempt limit stops pending work. Waiting state survives app restarts, while uncertain deliveries are not automatically duplicated.

Keep Codexia and the target Codex session running, ensure `codex` is available, and use the same `CODEX_HOME`.

### Scheduled Tasks

**Scheduled Tasks** sends ordinary messages to an Agent on a schedule:

- Target an existing session, or start a new session in a selected working directory each time.
- Configure the message, active window, and enabled state. The builder supports minute-step, hourly, daily, and weekly schedules, or enter five-field Cron directly. `0 22 * * *` runs daily at 22:00 in local time.
- The same task never overlaps itself, and missed occurrences are not replayed after restart or sleep. Disabling or deleting a task does not interrupt work already started.

Slash commands sent to an existing session remain plain text. Keep Codexia running; existing sessions must use the same `CODEX_HOME`.

### Settings

| Area | Available settings |
| --- | --- |
| General | Launch with Windows, close behavior, theme, and interface density. |
| API and MCP | Addresses, ports, access key, configuration file, and automatic startup. |
| Accounts and quotas | Refresh policy, account selection, Session affinity, failure cooldown, and quota display. |
| Logs and billing | Retention, billing currency, data location, and cleanup actions. |
| Advanced network | Timeouts, connection limits, request size, and fallback for HTTP-only models. Defaults suit normal use. |

Some service settings take effect after the corresponding service is restarted.

### Data, Security, and Debugging

Packaged application data is stored in `data/` beside the app. Preserve it during upgrades and back it up before moving or replacing the application. Do not share it because it contains account and channel configuration.

Database upgrades create an encrypted backup under `data/backups/` and remove it after 24 hours. A backup is bound to the Windows user that created it.

API debug logging is disabled by default. When enabled, request and response bodies are temporarily written under `data/logs/`, while sensitive headers are redacted. Debugging lasts at most 10 minutes, and its logs are deleted when disabled, expired, or the app exits. Bodies may contain sensitive data, so enable it only for troubleshooting.

This project is intended for personal local use. Use your own accounts and API keys, and follow each provider's terms.

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
