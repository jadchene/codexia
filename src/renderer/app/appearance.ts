export type AppearanceTheme = "light" | "dark" | "system";
export type AppearanceDensity = "comfortable" | "compact";

export interface AppearancePreferences {
  theme: AppearanceTheme;
  density: AppearanceDensity;
  fontFamily: string;
}

export const APPEARANCE_CHANGED_EVENT = "codex-gateway:appearance-changed";

const STORAGE_KEY = "codex-gateway-v1-appearance";
const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme: "system",
  density: "comfortable",
  fontFamily: "system"
};

export const appearanceFromSettings = (settings: Record<string, unknown> = {}): AppearancePreferences => ({
  theme: normalizeTheme(settings.appearance_theme),
  density: normalizeDensity(settings.appearance_density),
  fontFamily: normalizeFontFamily(settings.appearance_font_family)
});

export const loadAppearancePreferences = (): AppearancePreferences => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return appearanceFromSettings(stored);
  } catch {
    return DEFAULT_APPEARANCE;
  }
};

export const applyAppearancePreferences = (preferences: AppearancePreferences): void => {
  const normalized = appearanceFromSettings({
    appearance_theme: preferences.theme,
    appearance_density: preferences.density,
    appearance_font_family: preferences.fontFamily
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    appearance_theme: normalized.theme,
    appearance_density: normalized.density,
    appearance_font_family: normalized.fontFamily
  }));
  window.dispatchEvent(new CustomEvent<AppearancePreferences>(APPEARANCE_CHANGED_EVENT, { detail: normalized }));
};

const normalizeTheme = (value: unknown): AppearanceTheme => {
  const text = String(value || "");
  return text === "light" || text === "dark" ? text : "system";
};

const normalizeDensity = (value: unknown): AppearanceDensity => (
  value === "compact" ? "compact" : "comfortable"
);

const normalizeFontFamily = (value: unknown): string => {
  const text = String(value || "").trim();
  return text && text.length <= 200 && !/[\u0000-\u001f\u007f]/.test(text) ? text : "system";
};

export const appearanceFontStack = (fontFamily: string): string => {
  if (!fontFamily || fontFamily === "system") return "system-ui, sans-serif";
  const escaped = fontFamily.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}", system-ui, sans-serif`;
};
