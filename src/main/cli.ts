export const ACCESS_MODES = {
  account: "账号模式", openai: "OpenAI 官方 API 模式", third_party: "第三方 API 模式", gateway: "网关模式"
} as const;
export type AccessMode = keyof typeof ACCESS_MODES;
export interface AccessSelection {
  mode: AccessMode;
  targetId: string;
  proxy: boolean;
  restart: boolean;
}
export interface CliBackend {
  current?: () => AccessSelection | null;
  gatewayRunning?: () => boolean;
  show: () => string;
  choices: (mode: AccessMode) => Array<{ id: string; label: string }>;
  defaults: (mode: AccessMode) => { targetId: string; proxy: boolean; restart: boolean };
  apply: (selection: AccessSelection) => Promise<void>;
}
export interface CliIO {
  write: (text: string) => void;
  ask?: (question: string) => Promise<string>;
}
export const CLI_HELP = `Codexia 命令行
  codexia-cli --version                         查看版本
  codexia-cli mode                              查看当前接入模式
  codexia-cli mode switch                       交互切换接入模式
  codexia-cli mode switch --mode account --account <ID> --proxy false --restart true
  codexia-cli mode switch --mode openai --channel <ID> --proxy false --restart true
  codexia-cli mode switch --mode third_party --channel <ID> --proxy true --restart false
  codexia-cli mode switch --mode gateway --restart true

模式：account / openai / third_party / gateway
无交互终端时必须提供完整参数。--proxy、--restart 取值 true / false。
CLI 不会自动启动 Codexia 或网关。网关模式或代理监控在服务未启动时仍保存配置，并提示手动启动。
仅关联同目录 Codexia，并要求版本一致；不受桌面单实例设置影响。Ctrl+C 或输入流结束会取消尚未应用的修改。`;

export function parseCliArgs(args: string[]) {
  if (args.length === 1 && ["--version", "-v", "version"].includes(args[0]!)) return { action: "version" as const };
  if (args.length === 0 || (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!))) return { action: "help" as const };
  if (args[0] !== "mode") throw new Error("未知命令。使用 codexia-cli --help 查看用法。");
  if (args.length === 1 || (args.length === 2 && args[1] === "show")) return { action: "show" as const };
  if (args[1] !== "switch") throw new Error("使用 codexia-cli mode 或 codexia-cli mode switch。");
  const options: Record<string, string> = {};
  for (let i = 2; i < args.length; i += 2) {
    const name = args[i]!;
    const value = args[i + 1];
    if (!["--mode", "--account", "--channel", "--proxy", "--restart"].includes(name)
      || !value || value.startsWith("--") || name in options) throw new Error(`无效或重复参数：${name}`);
    options[name] = value;
  }
  if (options["--mode"] && !Object.hasOwn(ACCESS_MODES, options["--mode"])) throw new Error("接入模式无效。");
  for (const name of ["--proxy", "--restart"]) {
    if (options[name] && !["true", "false"].includes(options[name])) throw new Error(`${name} 必须为 true 或 false。`);
  }
  return { action: "switch" as const, options };
}

export async function runCli(args: string[], version: string, backend: () => Promise<CliBackend>, io: CliIO): Promise<void> {
  const command = parseCliArgs(args);
  if (command.action === "version") { io.write(`Codexia ${version}`); return; }
  if (command.action === "help") { io.write(CLI_HELP); return; }
  const service = await backend();
  if (command.action === "show") { io.write(service.show()); return; }
  const options = command.options;
  const ask = async (question: string): Promise<string> => {
    if (!io.ask) throw new Error("非交互模式缺少参数，请指定 --mode、账号/渠道、--proxy 和 --restart。");
    return (await io.ask(question)).trim();
  };
  const select = async (title: string, choices: Array<{ id: string; label: string }>, current = ""): Promise<string> => {
    if (!choices.length) throw new Error(`${title}没有可选项，请先在桌面应用中导入账号或配置渠道及模型。`);
    io.write(choices.map((item, i) => `${i + 1}. ${item.label} [${item.id}]${item.id === current ? "（当前）" : ""}`).join("\n"));
    for (;;) {
      const answer = await ask(`${title}：输入序号或 ID${current ? "，回车保留当前" : ""} > `);
      if (!answer && choices.some((item) => item.id === current)) return current;
      const selected = choices.find((item) => item.id === answer) || (/^\d+$/.test(answer) ? choices[Number(answer) - 1] : undefined);
      if (selected) return selected.id;
      io.write("选择无效，请重试。");
    }
  };
  const mode = (options["--mode"] || await select("接入模式", Object.entries(ACCESS_MODES).map(([id, label]) => ({ id, label })))) as AccessMode;
  if ((mode !== "account" && options["--account"]) || (!["openai", "third_party"].includes(mode) && options["--channel"])) {
    throw new Error("账号/渠道参数与接入模式不匹配。");
  }
  if (mode === "gateway" && options["--proxy"]) throw new Error("网关模式不接受 --proxy 参数。");
  const defaults = service.defaults(mode);
  let targetId = "";
  if (mode !== "gateway") {
    const choices = service.choices(mode);
    targetId = options[mode === "account" ? "--account" : "--channel"] || await select(mode === "account" ? "账号" : "渠道", choices, defaults.targetId);
    if (!choices.some((item) => item.id === targetId)) throw new Error("所选账号/渠道不存在、不可用或类型不匹配。");
  }
  const booleanOption = async (name: string, title: string, fallback: boolean): Promise<boolean> => {
    if (options[name] !== undefined) return options[name] === "true";
    for (;;) {
      const answer = (await ask(`${title}（y/n，默认 ${fallback ? "y" : "n"}）> `)).toLowerCase();
      if (!answer) return fallback;
      if (["y", "yes", "true"].includes(answer)) return true;
      if (["n", "no", "false"].includes(answer)) return false;
      io.write("请输入 y 或 n。");
    }
  };
  const proxy = mode !== "gateway" && await booleanOption("--proxy", "是否通过网关代理监控请求", defaults.proxy);
  const restart = await booleanOption("--restart", "应用后是否自动重启 Codex app-server", defaults.restart);
  const selection = { mode, targetId, proxy, restart };
  await service.apply(selection);
  const reminder = gatewayStartReminder(selection, service.gatewayRunning?.() ?? false);
  if (reminder) io.write(reminder);
  io.write(`已应用：${ACCESS_MODES[mode]}${targetId ? ` [${targetId}]` : ""}；${proxy ? "已配置网关代理" : mode === "gateway" ? "使用网关" : "直连"}。`);
  io.write(restart ? "Codex app-server 已重启。" : "未重启 app-server；已有进程可能仍使用旧配置，请在需要时重启。");
}

export function gatewayStartReminder(selection: AccessSelection, gatewayRunning: boolean): string {
  return (selection.mode === "gateway" || selection.proxy) && !gatewayRunning
    ? "提示：配置已保存，但网关服务未启动。请手动启动 Codexia 和网关服务后再使用 Codex。" : "";
}
