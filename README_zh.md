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
4. 在“接入模式”选择模式并应用到 Codex。使用 API 模式时，在“服务管理”启动 API 服务。
5. 重启 Codex，加载配置并选择模型。

## 使用要点

- **API 模式**汇集账号池和模型渠道。同名模型优先走已启用的账号池；使用官方 API 时可停用账号池。
- **账号模式**使用选定的订阅账号，支持账号池模型列表覆盖，不包含第三方渠道模型。
- 第三方模型 ID 不能与其他渠道或内置模型重复。模型费率可在渠道中配置，预估成本不代表实际账单。
- 其他 Responses API 客户端可使用 `http://localhost:8436/v1` 和设置中的本地访问密钥。
- Codex 配置默认位于当前用户的 `.codex`，也可通过 `CODEX_HOME` 指定。

## 数据与升级

数据保存在程序旁的 `data/`。升级时保留该目录，备份前关闭应用。凭据使用 Windows 加密，迁移到其他用户或电脑后可能需要重新登录。

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
