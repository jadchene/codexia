import type { ModelPricing } from "../../shared/contracts/upstreams";

interface BillableTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

interface EstimatedCost {
  amount: number;
  unit: string;
}

export function estimateUpstreamCost(
  usage: BillableTokenUsage,
  factors: ModelPricing | null | undefined,
  currency = "USD",
  priorityMultiplier = 1
): EstimatedCost | null {
  if (!factors) return null;
  const inputRate = validRate(factors.inputPerMillion);
  const cachedRate = validRate(factors.cachedInputPerMillion);
  const outputRate = validRate(factors.outputPerMillion);
  if (inputRate === null && cachedRate === null && outputRate === null) return null;

  const input = nonNegative(usage.input_tokens);
  const cached = Math.min(input, nonNegative(usage.cached_input_tokens));
  const uncached = Math.max(0, input - cached);
  const output = nonNegative(usage.output_tokens);
  const amount = (
    uncached * (inputRate ?? 0)
    + cached * (cachedRate ?? 0)
    + output * (outputRate ?? 0)
  ) / 1_000_000 * (Number.isFinite(priorityMultiplier) && priorityMultiplier >= 0 ? priorityMultiplier : 1);
  return { amount, unit: String(currency || "USD").toUpperCase() };
}

function validRate(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function nonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
