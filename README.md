# Codexia

[中文文档](README_zh.md)

## What This Project Is

Codexia is a Windows desktop app for using ChatGPT subscription accounts and third-party model channels from Codex in one place.

![Codexia overview](docs/screenshots/overview.png)

## Why Use It

- Turn ChatGPT subscription accounts into a local API service.
- Connect third-party models through Responses API channels.
- Switch easily between subscription and third-party models from the Codex model picker.
- Integrate and manage an optional MCP service from the same desktop app.
- Quickly view and use available Bank Reset cards for subscription accounts.
- Estimate request costs from each model's input, cached-input, and output prices.

## Quick Start

1. Open `Codexia.exe`.
2. Add a ChatGPT subscription account, a model channel, or both.
3. Open **Integration Mode** and apply API mode.
4. Start the API service from **Services**.
5. Return to Codex and select a model.

API mode makes subscription and third-party models available together. Account mode connects Codex directly to one selected subscription account.

## Reference

### Subscription Accounts

Sign in through the browser or import the account currently used by Codex. You can view quota and reset-credit status, refresh an account, enable or disable it, use an available reset credit, or remove the account.

### Model Channels

Each Responses API channel supports the following settings:

- Channel name, API address, API key, and enabled state.
- Provider-supplied Codex `models.json`; model IDs must be unique across channels.
- WebSocket support. Leave it off when the provider supports HTTP only.
- Remote compaction adaptation. Keep it enabled unless the provider explicitly supports native Codex compaction.
- Optional balance lookup, public or encrypted request headers, and per-model input, cached-input, and output prices.

The built-in subscription channel also provides an optional Codex Bundled override, disabled by default. When enabled, its manually supplied model JSON replaces the CLI bundled catalog before third-party models are merged into the final `models.json`.

You can inspect the imported model catalog and test a channel before using it in Codex.

The **Integration Mode** page applies either API or account mode to Codex. API mode also lets you choose the recommended Base URL configuration or a custom Provider configuration before applying it.

### Services

The **Services** page starts, stops, and restarts the local API service and the optional MCP service powered by [`mcp-gateway-service`](https://github.com/jadchene/mcp-gateway). Configure the MCP service file path and address before starting it.

### Settings

| Area | Available settings |
| --- | --- |
| General | Launch with Windows, window-close behavior, theme, and interface density. |
| API service | Listening address, port, access key, and automatic service start. |
| MCP service | Installation notice, automatic start, configuration file path, host, port, and HTTP path. |
| Accounts and quotas | Refresh interval, refresh timeout, account-selection policy, sliding Session-affinity lifetime, account-failure cooldown, quota display, and an optional third-party fallback model for auto review. |
| Logs and billing | Request-log retention, runtime-log retention, and billing currency. |
| Storage | Current data location and controls for clearing request or runtime logs. |
| Advanced network | Connection and idle timeouts, request timeout, shutdown grace period, HTTP and WebSocket limits, payload and buffer limits, and automatic HTTP fallback for HTTP-only models. Defaults are suitable for normal use. |

Some service settings take effect after the corresponding service is restarted.

### Data and Backup

Packaged application data is stored in `data/` beside the app. Back up this directory before moving or replacing the application. Do not share it because it contains account and channel configuration.

Automatic schema-migration backups under `data/backups/` are encrypted as complete files with a per-backup AES-256-GCM key. That key is wrapped by Electron `safeStorage`, so the encrypted backup is bound to the Windows user security context that created it. Unencrypted migration backups from earlier versions are encrypted automatically on the next start, and migration backups are removed after 24 hours.

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
