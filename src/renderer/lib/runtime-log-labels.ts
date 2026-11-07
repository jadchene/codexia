export const logLevelLabels: Record<string, string> = {
  debug: "调试", info: "信息", warn: "警告", warning: "警告", error: "错误"
};

export const logScopeLabels: Record<string, string> = {
  app: "应用", gateway: "接口服务", "gateway-http": "请求代理", "gateway-websocket": "长连接代理",
  upstream: "模型渠道", usage: "额度刷新", "v1-dev": "开发模式", security: "安全",
  models: "模型目录", auth: "账号认证", mcp: "工具服务", logs: "日志管理", storage: "数据存储", "api-debug": "接口调试"
};

export const logActionLabels: Record<string, string> = {
  start: "启动", stop: "停止", request: "处理请求", connect: "建立连接", disconnect: "断开连接",
  reject: "拒绝连接", relay: "转发请求", observe: "采集调用信息", logging: "调试日志记录",
  "refresh-all": "刷新全部额度", "persist-routing": "保存路由状态", "account-proxy": "账号请求代理",
  "account-proxy-websocket": "账号长连接代理", "auto-review-fallback": "自动审核回退",
  "daily-rebalance": "每日账号重平衡", "refresh-token": "刷新令牌", "quota-refresh": "刷新额度",
  "account-disabled-reconnect": "账号停用后重连", "quota-reconnect": "额度不足后重连",
  "isolated-profile": "隔离运行配置", "initial-refresh": "初始刷新", "remote-refresh": "远程刷新",
  "auto-start": "自动启动", "startup-refresh-check": "启动时检查额度", "startup-hidden": "启动时隐藏窗口",
  "startup-delay": "延迟启动", "startup-launch": "开机自启", "invocation-test": "调用测试",
  "clear-token-logs": "清空调用日志", "apply-gateway": "应用接口模式配置", "apply-account": "应用账号模式配置",
  "refresh-account": "刷新账号额度", "refresh-subscription": "刷新订阅信息", "bundled-override-rollback": "回退内置模型覆盖配置",
  "tray-start": "托盘启动", "tray-stop": "托盘停止", "import-local-codex": "导入本地账号",
  "tray-icon": "加载托盘图标", "show-window": "显示窗口", "detect-startup": "检测启动接入模式",
  shutdown: "关闭服务", "login-server-stop": "停止登录服务", "close-window": "关闭窗口",
  "timer-stop": "停止定时刷新", "timer-disabled": "禁用定时刷新", "timer-refresh": "定时刷新额度",
  "timer-start": "启动定时刷新", "retention-cleanup": "清理过期数据", "startup-stale-refresh": "启动时刷新过期额度",
  "consume-reset-credit": "使用额度重置卡", "reset-refresh-reschedule": "重新安排重置后刷新",
  "reset-refresh-limit": "限制重置后刷新", "reset-refresh-run": "执行重置后刷新",
  "reset-refresh-schedule": "安排重置后刷新", "reset-refresh-stop": "停止重置后刷新",
  "reset-refresh-stop-all": "停止全部重置后刷新"
};

export const logStatusLabels: Record<string, string> = {
  success: "成功", failed: "失败", error: "错误", partial: "部分成功", forced: "强制结束",
  "api-upstream": "渠道转发", retry: "重试中", "connection-limit": "连接数超限",
  WEBSOCKET_NOT_SUPPORTED: "不支持长连接", aborted: "已中止", active: "已激活", ignored: "已忽略",
  start: "开始", pending: "等待中", enabled: "已启用", disabled: "已停用", expired: "已过期", fresh: "无需刷新",
  client_cancelled: "客户端取消", gateway_shutdown: "服务关闭", request_aborted: "请求中止",
  request_timeout: "请求超时", upstream_timeout: "上游超时", upstream_idle_timeout: "上游空闲超时",
  connect_timeout: "连接超时", stream_idle_timeout: "响应流空闲超时", compaction_timeout: "对话压缩超时",
  websocket_idle_timeout: "长连接空闲超时", websocket_forward_error: "长连接转发失败", websocket_transport_error: "长连接传输失败",
  reset: "重置成功", already_redeemed: "已执行重置", nothing_to_reset: "无需重置", no_credit: "无可用重置卡",
  "refresh-failed": "刷新失败", manual: "手动操作", timer: "定时刷新", startup: "应用启动",
  "startup-expired": "启动时额度过期", "settings-save": "保存设置", "usage-refresh": "额度刷新",
  "gateway-no-usable-account": "无可用账号", shutdown: "正在关闭", tray: "托盘操作",
  "app-before-quit": "应用退出", "tray-quit": "托盘退出", sigint: "中断退出", sigterm: "终止退出",
  "uncaught-exception": "未捕获异常", "unhandled-rejection": "未处理异常",
  account: "账号模式", api: "接口模式", gateway: "接口模式", unknown: "未知", none: "未配置",
  ECONNRESET: "连接重置", ECONNREFUSED: "连接被拒绝", ETIMEDOUT: "连接超时", ENOTFOUND: "地址无法解析",
  "1000": "正常关闭", "1001": "连接离开", "1006": "异常断开", "1008": "策略拒绝", "1011": "服务异常"
};

export const logDictionaryLabel = (dictionary: Record<string, string>, value: unknown, kind: string): string => {
  const key = String(value ?? "");
  if (!key) return "-";
  if (dictionary[key]) return dictionary[key];
  if (kind === "状态" && /^(http_)?\d{3}$/.test(key)) {
    const code = Number(key.replace("http_", ""));
    return `${code >= 200 && code < 300 ? "请求成功" : "请求失败"}（${code}）`;
  }
  return `其他${kind}（${key}）`;
};

// 保留历史或扩展模块的值，选项来源不受当前页和筛选结果限制。
export const logDictionaryOptions = (dictionary: Record<string, string>, values: string[], kind: string) => (
  [...new Set([...Object.keys(dictionary), ...values])].map((value) => ({ value, label: logDictionaryLabel(dictionary, value, kind) }))
);
