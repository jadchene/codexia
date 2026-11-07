# Codexia

[English README](README.md)

Codexia 是一个 Windows 桌面应用，用于在 Codex 中集中使用 ChatGPT 订阅账号、OpenAI 官方 API 和第三方模型渠道。

![Codexia 概览](docs/screenshots/overview.png)

## 功能

- 管理订阅账号池和模型渠道，提供本地 Responses API 服务。
- 查看账号额度、调用统计和预估成本。
- 管理 Codex 接入配置和可选的 [MCP 服务](https://github.com/jadchene/mcp-gateway)。

## 快速开始

1. 安装 Codex CLI，确认 `codex` 命令可用。
2. 将 Windows 免安装包解压到可写目录，打开 `Codexia.exe`。
3. 添加订阅账号或模型渠道：账号支持浏览器登录和 Codex 导入；OpenAI 官方渠道只需 API Key；第三方渠道需填写 API 地址、API Key 和模型目录。
4. 在“接入模式”选择模式并应用到 Codex。使用网关模式时，在“服务管理”启动网关服务。
5. 按需启用各模式的“自动重启 appserver”，应用配置后执行 `codex app-server daemon restart`；关闭时请手动重启 Codex。

## 使用要点

- **网关模式**汇集账号池和模型渠道。同名模型优先走已启用的账号池；使用官方 API 时可停用账号池。
- **账号模式**使用选定的订阅账号，支持账号池模型列表覆盖，不包含第三方渠道模型。生效账号的 token 从 Codex 的 `auth.json` 同步，由 Codex 负责刷新。
- **OpenAI 官方 API 模式 / 第三方 API 模式**分别选择对应类型的单独渠道，直接使用其密钥、连接配置和模型目录，渠道开关仅影响网关模式。
- 三种非网关模式均可启用网关代理监控：保留请求与响应业务参数、凭据和错误信息，不做账号轮换、渠道回退、额度改写或压缩适配。维护必要的连接状态并记录日志。
- 第三方模型 ID 不能与其他渠道或内置模型重复。模型费率可在渠道中配置，预估成本不代表实际账单。
- 其他 Responses API 客户端可使用 `http://localhost:8436/v1` 和设置中的本地访问密钥。
- Codex 配置默认位于当前用户的 `.codex`，也可通过 `CODEX_HOME` 指定。

## 数据与升级

数据保存在程序旁的 `data/`。升级时保留该目录，备份前关闭应用。凭据使用 Windows 加密，迁移到其他用户或电脑后可能需要重新登录。

非网关模式的监控代理按数据块提取模型和优先级，不缓存完整请求正文，独立于网关的 16 MiB 请求体大小限制。普通请求日志由独立线程批量写入；查询、清空和正常退出会等待落盘。写入队列有容量限制，满载或写入失败会报告错误并优先维持请求转发。

API 调试会临时记录请求和响应正文，可能包含敏感信息，仅在排障时开启。

## 开发

需要 Node.js 24 或更高版本。

```bash
npm install
npm run dev
npm run verify
npm run pack:unpacked
```

打包输出为 `release/win-unpacked/Codexia.exe`，未进行代码签名。

## License

MIT. See [LICENSE](LICENSE).

### 命令行：版本与接入模式

Windows 解压包提供 Node.js 入口 `codexia-cli.cjs`，可直接执行 `node codexia-cli.cjs --version`、`node codexia-cli.cjs mode` 或 `node codexia-cli.cjs mode switch`，无需先打开桌面应用。入口解析自身真实路径，因此软链接到其他目录后仍操作原安装目录的实例；即使使用 `--preserve-symlinks-main` 也一样。

同时保留 `codexia-cli.cmd` 作为 Windows 快捷入口，借用 Electron 的 Node 模式，不需要额外安装 Node.js。需要软链接时请链接 `.cjs` 文件并用 Node 执行，不要链接 `.cmd`。

```powershell
.\codexia-cli.cmd --version
.\codexia-cli.cmd mode
.\codexia-cli.cmd mode switch
```

`mode` 显示已保存的接入模式、Codex 认证识别结果、代理和重启选项，以及可选账号／渠道的 ID。`mode switch` 依次选择四种接入模式、账号或对应类型的 API 渠道、是否启用网关代理、是否在应用后重启 Codex daemon app-server。账号和渠道需先在桌面应用中导入／配置，命令不会输出 Token 或 API Key。

也可以提供完整参数，无需交互：

```powershell
.\codexia-cli.cmd mode switch --mode account --account <账号ID> --proxy false --restart true
.\codexia-cli.cmd mode switch --mode openai --channel <官方渠道ID> --proxy false --restart true
.\codexia-cli.cmd mode switch --mode third_party --channel <第三方渠道ID> --proxy true --restart false
.\codexia-cli.cmd mode switch --mode gateway --restart true
```

- 直连切换不会启动桌面应用；命令结束仅退出命令行进程，已经运行的 Codexia 保持运行。
- CLI 只关联自己同级目录的 Codexia，完全不考虑桌面的“单实例运行”设置，也不查找其他目录实例。同目录 Codexia 未运行时，四种模式均由 CLI 本地写入该目录的 SQLite 和 Codex 配置；已运行时通过本机 IPC 交给它处理，并校验双方应用版本一致。CLI 不自动启动 Codexia 或网关；网关停止时仍保存配置，仅提示手动启动。
- 四种模式分别保存自动重启偏好。重启失败会明确提示配置已应用；未选择重启时，已有 Codex 进程可能仍使用旧配置。
- 开发环境先运行 `npm run build:main`，再使用 `npm run cli -- --version`、`npm run cli -- mode` 或 `npm run cli -- mode switch`。需要隔离测试时，增加 `--isolated-dev --codex-test-dir=.runtime/v1-dev/codex`。
- CLI 复用桌面应用的数据目录和系统安全存储；它不是无界面服务器版 Electron。Windows 是打包支持平台，其他系统仍需 Electron 可用的运行环境及系统安全存储。


### 本机进程间通信

CLI 与同目录 Codexia 使用 Windows 命名管道或 Unix Socket 通信，无需配置 HTTP 服务、监听 IP、端口或 API 密钥。`data/cli-control.json` 仅记录当前实例的连接信息和每次启动生成的临时认证令牌，不承载配置请求，也不包含账号 token 或渠道 API key。

通信协议使用通用信封，协议版本与应用版本分别校验：

```json
{
  "version": 1,
  "appVersion": "2.0.0",
  "id": "每次请求生成的 UUID",
  "method": "access-mode.apply",
  "params": {
    "mode": "third_party",
    "targetId": "渠道 ID",
    "proxy": true,
    "restart": false
  }
}
```

CLI 自动附加实例目录和临时令牌。响应包含同一 `id`、`version`、`appVersion`、`ok`，以及成功的 `result` 或失败的 `error: { code, message }`。当前方法为 `access-mode.get` 和 `access-mode.apply`；后续功能通过注册新方法及参数校验扩展，无需改动传输协议。未知方法、协议版本或应用版本不一致时不会执行修改。

CLI 不会把请求转给其他目录的实例；即使另一目录运行着同版本单实例 Codexia，也仍按本目录实例未启动处理。已选中的实例退出或重启后，请求不会自动转发到新进程。旧的 `inbox` 请求文件和 HTTP API 不再使用；启动时清理已废弃的外部 API 配置项。
