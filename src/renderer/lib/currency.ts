const CURRENCY_NAMES: Record<string, string> = {
  USD: "美元",
  CNY: "人民币",
  EUR: "欧元",
  JPY: "日元"
};

export const CURRENCY_OPTIONS = Object.entries(CURRENCY_NAMES).map(([value, name]) => ({
  value,
  label: `${name}（${value}）`
}));

export const currencyName = (currency: unknown): string => {
  const code = String(currency || "").trim().toUpperCase();
  return CURRENCY_NAMES[code] || code;
};

/** Compact unit for metric titles; values themselves remain unitless. */
export const currencySymbol = (currency: unknown): string => {
  const code = String(currency || "USD").trim().toUpperCase();
  return ({ USD: "$", CNY: "¥", EUR: "€", JPY: "JP¥" } as Record<string, string>)[code] || code;
};
