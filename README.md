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
