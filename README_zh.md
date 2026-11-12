# Codexia

[English README](README.md)

Codexia 是一个 Windows 桌面应用，用于在 Codex 中集中使用 ChatGPT 订阅账号、OpenAI 官方 API 和第三方模型渠道。

![Codexia 概览](docs/screenshots/overview-v2.png)

## 功能

- 管理订阅账号池和模型渠道，提供本地 Responses API 服务。
- 查看账号额度、调用统计和预估成本。
- 管理 Codex 接入配置和可选的 [MCP 服务](https://github.com/jadchene/mcp-gateway)。

## 快速开始

1. 安装 Codex CLI，确认 `codex` 命令可用。
2. 将 Windows 免安装包解压到可写目录，打开 `Codexia.exe`。
3. 添加订阅账号或模型渠道：账号支持浏览器登录和 Codex 导入；OpenAI 官方渠道只需 API Key；第三方渠道需填写 API 地址、API Key 和模型目录。
4. 在“接入模式”选择模式和连接选项，核对配置预览后应用到 Codex。网关模式需在“服务管理”启动网关；其余模式开启代理时，应用配置会自动启动网关。
5. 应用后手动重启 Codex，或为当前模式启用“自动重启 Codex 服务”。自动重启需要 Codex 支持 `codex app-server daemon restart`。若提示配置已应用但重启失败，配置仍已保存，手动重启 Codex 即可。

## 选择接入模式

| 模式 | 使用的账号或渠道 | 网关代理 | 模型目录开启时 |
| --- | --- | --- | --- |
| 网关 | 订阅账号池和已启用的 API 渠道 | 始终开启 | 汇总账号池和渠道模型 |
| 账号 | 一个选定的 ChatGPT 订阅账号 | 默认关闭，可开启 | 订阅账号模型，沿用账号池模型设置 |
| OpenAI API | 一个选定的 OpenAI 渠道 | 默认关闭，可开启 | 所选 OpenAI 渠道的模型 |
| 第三方 API | 一个选定的第三方渠道 | 强制开启 | 强制使用所选渠道的可用模型 |

“使用模型目录”默认开启，网关、账号和 OpenAI API 模式分别保存开关；关闭后使用 Codex 默认模型目录。第三方模式仅显示和允许调用所选渠道的可用模型，HTTP 和 WebSocket 请求均受此限制。

使用网关或代理时，需保持 Codexia 和网关服务运行。账号和 OpenAI API 模式直连时，调用不会经过 Codexia，也不会生成 Codexia 调用记录。非网关模式的代理固定使用选定账号或渠道，不做账号轮换、渠道回退、额度改写或压缩适配。

## 配置写入与预览

四种模式均显示 `config.toml` 变更预览，网关和 API 模式还显示脱敏的 `auth.json`。预览展示本次接管的字段及清除说明，不是整个文件；API Key 的掩码不能作为实际密钥使用。

- 连接本地网关时写入 `openai_base_url`；账号和 OpenAI API 模式关闭代理时清除此字段。
- 开启模型目录时写入 `model_catalog_json`，关闭时清除。第三方模式不能关闭。
- 应用时清理旧的顶层 `model_provider` 和 Codexia 管理的 provider 配置，保留其他渠道定义、MCP 等无关配置。
- API 模式中的 `# codexia_channel = "…"` 是用于识别所选渠道的注释，不是 Codex 配置项，也不控制请求路由。

配置默认位于当前用户的 `.codex`，可通过 `CODEX_HOME` 指定。若配置语法无效，或顶层 `profile` 可能覆盖接入配置，应用会提示错误；先修复语法或取消顶层 `profile` 选择，已有 profile 定义可以保留。

## 使用要点

- 网关模式下，同名模型优先走已启用的账号池；使用 OpenAI API 时可停用账号池。渠道的“参与网关路由”开关只影响网关模式。
- 账号模式使用的 token 从 Codex 的 `auth.json` 同步，由 Codex 负责刷新。
- 第三方模型 ID 不能与其他渠道或内置模型重复。模型费率可在渠道中配置，预估成本不代表实际账单。
- 在网关模式下，其他 Responses API 客户端可使用 `http://localhost:8436/v1` 和设置中的本地访问密钥。

## 数据与升级

数据保存在程序旁的 `data/`。升级时保留该目录，备份前关闭应用。凭据使用 Windows 加密，迁移到其他用户或电脑后可能需要重新登录。

升级不会自动重新应用接入配置。若旧配置中仍有 Codexia provider，请在“接入模式”核对选项后重新应用，并重启 Codex。

存储故障或写入队列满载时，监控日志可能缺失，请求仍会继续转发。费用核对应以渠道账单为准。

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
