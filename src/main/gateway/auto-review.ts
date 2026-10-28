type Dynamic = any;

export const AUTO_REVIEW_MODEL_ID = "codex-auto-review";
const AUTO_REVIEW_CACHE_KEY_PREFIX = "guardian:";

export function isAutoReviewRequest(body: Dynamic): boolean {
  return String(body?.model || "") === AUTO_REVIEW_MODEL_ID
    || String(body?.prompt_cache_key || "").startsWith(AUTO_REVIEW_CACHE_KEY_PREFIX);
}

export function resolveAutoReviewFallback(settings: Dynamic, hooks: Dynamic): { model: string; upstream: Dynamic } | null {
  const fallbackModel = String(settings?.auto_review_upstream_model || "").trim();
  const fallbackUpstream = fallbackModel ? hooks?.upstreamService?.findRuntimeByModel?.(fallbackModel) : null;
  if (!fallbackModel || !fallbackUpstream || fallbackUpstream.kind !== "responses_api") return null;
  return { model: fallbackModel, upstream: fallbackUpstream };
}
