import { App, ConfigProvider, theme } from "antd";
import type { PropsWithChildren } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { queryClient } from "./query-client";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useMemo, useState } from "react";
import {
  APPEARANCE_CHANGED_EVENT,
  loadAppearancePreferences,
  type AppearancePreferences
} from "./appearance";

dayjs.locale("zh-cn");

export const AppProviders = ({ children }: PropsWithChildren) => {
  const [appearance, setAppearance] = useState(loadAppearancePreferences);
  const [prefersDark, setPrefersDark] = useState(
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false
  );

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onSystemThemeChanged = (event: MediaQueryListEvent): void => setPrefersDark(event.matches);
    const onAppearanceChanged = (event: Event): void => {
      setAppearance((event as CustomEvent<AppearancePreferences>).detail);
    };
    media?.addEventListener("change", onSystemThemeChanged);
    window.addEventListener(APPEARANCE_CHANGED_EVENT, onAppearanceChanged);
    return () => {
      media?.removeEventListener("change", onSystemThemeChanged);
      window.removeEventListener(APPEARANCE_CHANGED_EVENT, onAppearanceChanged);
    };
  }, []);

  const isDark = appearance.theme === "dark" || (appearance.theme === "system" && prefersDark);
  const algorithms = useMemo(
    () => isDark
      ? [theme.darkAlgorithm, ...(appearance.density === "compact" ? [theme.compactAlgorithm] : [])]
      : [theme.defaultAlgorithm, ...(appearance.density === "compact" ? [theme.compactAlgorithm] : [])],
    [appearance.density, isDark]
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        componentSize={appearance.density === "compact" ? "small" : "middle"}
        locale={zhCN}
        theme={{
          algorithm: algorithms,
          cssVar: { key: "codex-gateway-v1" },
          token: {
            colorPrimary: "#2563eb",
            colorSuccess: "#16a34a",
            colorWarning: "#d97706",
            colorError: "#dc2626",
            borderRadius: 12,
            fontFamily: '"Microsoft YaHei UI", "PingFang SC", "Segoe UI", sans-serif'
          },
          components: {
            Layout: { headerBg: "transparent", siderBg: "transparent" },
            Menu: { itemBorderRadius: 10, itemHeight: 40 }
          }
        }}
      >
        <div className="v1-app-root" data-theme={isDark ? "dark" : "light"} data-density={appearance.density}>
          <App>{children}</App>
        </div>
      </ConfigProvider>
    </QueryClientProvider>
  );
};
