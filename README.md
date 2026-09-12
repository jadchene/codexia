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
- Optionally route account-mode requests through the API service and include Responses calls in request analytics.

## Quick Start

1. Open `Codexia.exe`.
2. Add a ChatGPT subscription account, a model channel, or both.
3. Open **Integration Mode** and apply API mode.
4. Start the API service from **Services**.
5. Return to Codex and select a model.

API mode makes subscription and third-party models available together. Account mode uses one selected subscription account and can optionally route requests through the API service.

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

The **Integration Mode** page applies either API or account mode to Codex. API mode also lets you choose the recommended Base URL configuration or a custom Provider configuration before applying it. Account mode can enable **Use API service proxy**. When applied, Codexia starts the existing API service, writes its `/v1` Base URL, transparently forwards account credentials to the ChatGPT Codex backend, and records only HTTP and WebSocket `/responses` calls. Other paths are forwarded without analytics or debug logging. Codexia reads and writes Codex configuration from `CODEX_HOME` when that environment variable is set, otherwise it uses the current user's default `.codex` directory.

### Services

The **Services** page starts, stops, and restarts the local API service and the optional MCP service powered by [`mcp-gateway-service`](https://github.com/jadchene/mcp-gateway). The API service also carries account-mode transparent proxy traffic when that option is enabled. Configure the MCP service file path and address before starting it.

### Session Wakeup

Register a Codex session UUID under **Session Wakeup**, choose a start/end date and time, and set the maximum number of attempts. Keep Codexia and the corresponding Codex session running, with Codex CLI available on PATH and the same `CODEX_HOME` used by that session.

When a subscription-pool request fails because quota is exhausted and no account can take over, Codexia schedules one check after the nearest quota reset, with a one-minute grace period. At that time it refreshes account quota and wakes the session only if a successfully refreshed account has available quota. Without a future reset time, checks are spaced five minutes apart. HTTP, SSE quota errors, and WebSocket requests are supported; third-party channel errors and account-mode transparent proxy traffic do not trigger pool wakeups.

Enable **Resume Goal** to reactivate an unfinished Goal through the Codex app-server control protocol without loading the session. Completed Goals are skipped. When disabled, or when the session has no Goal, Codexia sends a continuation message using `codex queue`. This requires a CLI version supporting these commands; verified with 0.154.0.

Each quota check and its optional wakeup count as one attempt, including failures. The count covers the whole configured time window and does not reset after a successful wakeup. Changing the session or time window starts a new count. Disabling or deleting an entry cancels pending work; no wakeup is sent after the end time. Waiting records survive application restarts. If the app exits during message delivery, that entry requires manual confirmation instead of automatically sending a duplicate message.

### Scheduled Tasks

Use **Scheduled Tasks** to send a plain message to an existing session UUID, or choose **New session each time** and provide an existing absolute working-directory path. Configure the message, an effective start/end date and time, a five-field Cron expression, and whether the task is enabled. Cron uses the machine's local time zone: `0 * * * *` runs hourly, `0 22 * * *` runs daily at 22:00, and `0 9 * * MON` runs on Mondays at 09:00.

The expression builder supports minute steps, hourly, daily, and weekly schedules. Apply the generated expression or edit Cron directly. Minute steps are evaluated within each hour.

Existing sessions receive the text through `codex queue`; slash commands such as `/goal resume` remain ordinary text. New sessions run with `codex exec` and automatic approval review in the workspace sandbox. Their latest session ID and result are recorded in the task list. Keep Codexia running and use the same `CODEX_HOME` as the intended sessions.

The time window controls new triggers. Disabling or deleting a task stops future triggers but does not cancel work already started. A task never overlaps its own execution; up to four scheduled tasks run concurrently. Missed occurrences after restart or prolonged sleep are skipped rather than replayed. Failures are shown in the task list and wait for the next Cron occurrence instead of repeatedly sending at the same time point. Closing Codexia stops the new-session processes it owns; after restart, an interrupted occurrence is not automatically replayed.

### Settings

| Area | Available settings |
| --- | --- |
| General | Launch with Windows, window-close behavior, theme, and interface density. |
| API service | Listening address, port, access key, automatic service start, and an opt-in API debug request/response log. |
| MCP service | Installation notice, automatic start, configuration file path, host, port, and HTTP path. |
| Accounts and quotas | Refresh interval, refresh timeout, account-selection policy, sliding Session-affinity lifetime, account-failure cooldown, quota display, and an optional third-party fallback model for auto review. |
| Logs and billing | Request-log retention, runtime-log retention, and billing currency. |
| Storage | Current data location and controls for clearing request or runtime logs. |
| Advanced network | Connection and idle timeouts, request timeout, shutdown grace period, HTTP and WebSocket limits, payload and buffer limits, and automatic HTTP fallback for HTTP-only models. Defaults are suitable for normal use. |

Some service settings take effect after the corresponding service is restarted.

### API Debug Logs

Disabled by default (Settings > API service). Enabling it displays a sensitive-data warning and records HTTP and WebSocket API requests and responses as JSON Lines in `data/logs/<yyyymmdd>.jsonl`. In account proxy mode, only `/responses` is recorded. Sensitive headers are redacted, while bodies are retained for troubleshooting and capped at 1 MiB per entry. Debug mode runs for at most 10 minutes; all debug logs are deleted when it is disabled manually, expires automatically, or the app exits.

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
