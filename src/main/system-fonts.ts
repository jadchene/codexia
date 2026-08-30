import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 15_000;

export async function listSystemFontFamilies(platform = process.platform): Promise<string[]> {
  try {
    if (platform === "win32") return await listWindowsFonts();
    if (platform === "darwin") return await listMacFonts();
    return await listFontconfigFonts();
  } catch {
    return [];
  }
}

async function listWindowsFonts(): Promise<string[]> {
  const registryKeys = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
    "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"
  ];
  const outputs = await Promise.all(registryKeys.map(async (key) => {
    try {
      return (await execFileAsync("reg.exe", ["query", key], windowsOptions())).stdout;
    } catch {
      return "";
    }
  }));
  return normalizeFontFamilies(outputs.flatMap(parseWindowsFontRegistry));
}

async function listMacFonts(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "system_profiler",
    ["SPFontsDataType", "-json", "-detailLevel", "mini"],
    commandOptions()
  );
  return normalizeFontFamilies(parseMacFontProfiler(stdout));
}

async function listFontconfigFonts(): Promise<string[]> {
  const { stdout } = await execFileAsync("fc-list", ["--format=%{family}\n"], commandOptions());
  return normalizeFontFamilies(parseFontconfig(stdout));
}

export function parseWindowsFontRegistry(output: string): string[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s{2,}(.+?)\s+REG_(?:SZ|EXPAND_SZ)\s+/i);
    if (!match) return [];
    return [match[1]!
      .replace(/\s*\((?:TrueType|OpenType|All Res)\)\s*$/i, "")
      .replace(/\s*&\s*/g, ",")];
  });
}

export function parseMacFontProfiler(output: string): string[] {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if ((key === "family" || key === "family_name") && typeof item === "string") values.push(item);
      visit(item);
    }
  };
  try {
    visit(JSON.parse(output));
  } catch {
    return [];
  }
  return values;
}

export function parseFontconfig(output: string): string[] {
  return output.split(/\r?\n/).flatMap((line) => line.split(","));
}

function normalizeFontFamilies(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => (
    value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
  )))].sort((left, right) => left.localeCompare(right));
}

function commandOptions(): { encoding: "utf8"; timeout: number; windowsHide: boolean; maxBuffer: number } {
  return { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 };
}

function windowsOptions(): ReturnType<typeof commandOptions> {
  return commandOptions();
}
