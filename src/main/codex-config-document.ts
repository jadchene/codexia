import { parse } from "smol-toml";

/** 按 TOML 语句编辑配置，保留未接管的表、注释和多行字符串。 */
export const cleanCodexConnectionConfig = (source: string): string => {
  const config = parseCodexConfig(source);
  if (config.profile) throw new Error("config.toml 已选择 profile，请先取消顶层 profile 设置后再应用接入模式，避免它覆盖连接配置；profile 定义无需删除。");
  const rootKeys = new Set(["model_provider", "model_catalog_json", "openai_base_url"]);
  let section: string[] = [];
  return tomlStatements(source).filter((statement) => {
    const trimmed = statement.trim();
    const header = /^\[\[?(.+?)\]\]?\s*(?:#.*)?$/s.exec(trimmed);
    if (header) section = keyPath(header[1]!);
    if (section[0] === "model_providers" && ["codexia", "codex_gateway"].includes(section[1] || "")) return false;
    if (header) return true;
    if (!section.length && /^#\s*codexia_channel\s*=/.test(trimmed)) return false;
    const assignment = /^((?:"(?:\\.|[^"\\])*"|'[^']*'|[\w-]+)(?:\s*\.\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[\w-]+))*)\s*=/.exec(trimmed);
    if (!assignment) return true;
    const keys = [...section, ...keyPath(assignment[1]!)];
    if (keys.length === 1 && rootKeys.has(keys[0]!)) return false;
    if (keys[0] === "model_providers" && ["codexia", "codex_gateway"].includes(keys[1] || "")) return false;
    // 混合内联 provider 表无法逐项保留格式，拒绝写入，避免误删用户渠道。
    if (keys.length === 1 && keys[0] === "model_providers") {
      const providers = parse(statement).model_providers as Record<string, unknown>;
      if (providers.codexia || providers.codex_gateway) throw new Error("请先将内联 model_providers 配置展开为独立表，再应用接入模式。");
    }
    return true;
  }).join("");
};

/** 在首个表之前插入顶层字段，避免把字段写入其他配置表。 */
export const insertCodexConfigBlock = (source: string, block: string): string => {
  const statements = tomlStatements(source);
  const index = statements.findIndex((statement) => /^\s*\[/.test(statement));
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const before = (index < 0 ? source : statements.slice(0, index).join("")).trimEnd();
  const after = index < 0 ? "" : statements.slice(index).join("");
  const next = `${before ? before + newline + newline : ""}${block.trimEnd().replace(/\r?\n/g, newline)}${newline}${after ? newline + after : ""}`;
  parseCodexConfig(next);
  return next;
};

/** 配置可能含有密钥，解析失败时只报告格式错误，不输出原文。 */
const parseCodexConfig = (source: string) => {
  try { return parse(source); }
  catch { throw new Error("config.toml 格式无效，未修改认证和配置文件，请先修复 TOML 语法。"); }
};

/** 解码 TOML 的裸键和引号键，不将引号内的点拆成路径。 */
const keyPath = (value: string): string[] => (value.match(/"(?:\\.|[^"\\])*"|'[^']*'|[\w-]+/g) || [])
  .map((key) => Object.keys(parse(`${key} = 0`))[0]!);

/** 识别完整语句边界；数组、多行字符串内的换行不能作为编辑边界。 */
const tomlStatements = (source: string): string[] => {
  const statements: string[] = [];
  let start = 0;
  let quote = "";
  let depth = 0;
  let comment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (comment) {
      if (char !== "\n") continue;
      comment = false;
    } else if (quote) {
      if (quote.startsWith('"') && char === "\\") { index += 1; continue; }
      if (source.startsWith(quote, index)) {
        index += quote.length - 1;
        if (quote.length === 3) while (source[index + 1] === quote[0]) index += 1;
        quote = "";
      }
      continue;
    } else if (char === "#") {
      comment = true;
      continue;
    } else if (char === '"' || char === "'") {
      quote = source.slice(index, index + 3) === char.repeat(3) ? char.repeat(3) : char;
      index += quote.length - 1;
      continue;
    } else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    if (char === "\n" && depth === 0) {
      statements.push(source.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < source.length) statements.push(source.slice(start));
  return statements;
};
