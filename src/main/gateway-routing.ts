import { pickBalancedGatewayAccount, usableAccount, type GatewayAccount } from "./selection.ts";

const DEFAULT_TURN_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 168 * 60 * 60 * 1000;
const PENDING_SESSION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;
const MAX_BINDINGS_PER_KIND = 500;
const BUILTIN_SUBSCRIPTION_TARGET_ID = "builtin-chatgpt-subscription-pool";

interface Binding {
  targetId: string;
  accountId: string;
  credentialRef: string;
  clientModel: string;
  upstreamModel: string;
  lastSeenAt: number;
}
interface BindingEntry extends Binding { key: string }
interface RoutingSnapshot { schemaVersion?: number; turns?: BindingEntry[]; states?: BindingEntry[]; sessions?: BindingEntry[] }
interface RouteContext {
  turnId: string;
  turnState: string;
  sessionId: string;
  accountId: string;
  targetId: string;
  clientModel: string;
  upstreamModel: string;
  established: boolean;
  sessionPreferred: boolean;
  unknownTurnState: boolean;
}
interface BindingTarget {
  targetId: string;
  accountId?: string;
  credentialRef?: string;
  clientModel?: string;
  upstreamModel?: string;
}
interface RoutingOptions {
  now?: () => number;
  snapshot?: RoutingSnapshot;
  getIgnoreFiveHourLimit?: () => boolean;
  ignoreFiveHourLimit?: boolean;
  getSessionAffinityTtlMs?: () => number;
  sessionAffinityTtlMs?: number;
  onChanged?: (snapshot: RoutingSnapshot) => void;
}
type HeaderRecord = Record<string, string | string[] | number | undefined>;
type ResponseHeaders = Headers | HeaderRecord;

export function createGatewayRouting(options: RoutingOptions = {}) {
  const now = options.now || (() => Date.now());
  const turnBindings = bindingMap(options.snapshot?.turns);
  const stateBindings = bindingMap(options.snapshot?.states);
  const sessionBindings = bindingMap(options.snapshot?.sessions);
  const pendingSessionBindings = new Map<string, Binding>();
  const cooldowns = new Map<string, number>();
  const activeRequests = new Map<string, number>();
  const getIgnoreFiveHourLimit = typeof options.getIgnoreFiveHourLimit === "function"
    ? options.getIgnoreFiveHourLimit
    : () => options.ignoreFiveHourLimit === true;
  const getSessionAffinityTtlMs = typeof options.getSessionAffinityTtlMs === "function"
    ? options.getSessionAffinityTtlMs
    : () => options.sessionAffinityTtlMs || DEFAULT_SESSION_TTL_MS;

  function context(headers: HeaderRecord = {}): RouteContext {
    prune();
    const turnId = turnIdFromHeaders(headers);
    const turnState = headerValue(headers, "x-codex-turn-state");
    const sessionId = sessionIdFromHeaders(headers);
    const turnBinding = (turnId && turnBindings.get(turnId)) || (turnState && stateBindings.get(turnState)) || null;
    const sessionBinding = sessionId
      ? pendingSessionBindings.get(sessionId) || sessionBindings.get(sessionId) || null
      : null;
    return {
      turnId,
      turnState,
      sessionId,
      accountId: turnBinding?.accountId || sessionBinding?.accountId || "",
      targetId: turnBinding?.targetId || sessionBinding?.targetId || "",
      clientModel: turnBinding?.clientModel || sessionBinding?.clientModel || "",
      upstreamModel: turnBinding?.upstreamModel || sessionBinding?.upstreamModel || "",
      established: Boolean(turnBinding),
      sessionPreferred: !turnBinding && Boolean(sessionBinding),
      unknownTurnState: Boolean(turnState && !turnBinding)
    };
  }

  function findBoundAccount(routeContext: RouteContext | null | undefined, accounts: GatewayAccount[]): GatewayAccount | null {
    if (routeContext?.targetId && routeContext.targetId !== BUILTIN_SUBSCRIPTION_TARGET_ID) return null;
    if (!routeContext?.accountId) return null;
    return accounts.find((account) => account.id === routeContext.accountId
      && account.enabled
      && account.status !== "disabled"
      && account.access_token) || null;
  }

  function findPreferredAccount(routeContext: RouteContext | null | undefined, accounts: GatewayAccount[]): GatewayAccount | null {
    if (routeContext?.targetId && routeContext.targetId !== BUILTIN_SUBSCRIPTION_TARGET_ID) return null;
    if (!routeContext?.accountId) return null;
    if (Number(cooldowns.get(routeContext.accountId) || 0) > now()) return null;
    return accounts.find((account) => account.id === routeContext.accountId
      && usableAccount(account, Math.floor(now() / 1000), { ignoreFiveHourLimit: getIgnoreFiveHourLimit() })) || null;
  }

  function selectNewAccount(accounts: GatewayAccount[], excludedIds: string[] = []): GatewayAccount | null {
    prune();
    return pickBalancedGatewayAccount(accounts, excludedIds, {
      nowMs: now(),
      activeRequests,
      cooldowns,
      ignoreFiveHourLimit: getIgnoreFiveHourLimit()
    });
  }

  function beginRequest(accountId: string): () => void {
    if (!accountId) return () => {};
    activeRequests.set(accountId, Number(activeRequests.get(accountId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = Number(activeRequests.get(accountId) || 0) - 1;
      if (next > 0) activeRequests.set(accountId, next);
      else activeRequests.delete(accountId);
    };
  }

  function reserveSession(routeContext: RouteContext | null | undefined, account: GatewayAccount | null | undefined): void {
    if (!routeContext?.sessionId || routeContext.established || !account?.id) return;
    pendingSessionBindings.set(routeContext.sessionId, bindingFromTarget({
      targetId: BUILTIN_SUBSCRIPTION_TARGET_ID,
      accountId: account.id
    }, now()));
    routeContext.targetId = BUILTIN_SUBSCRIPTION_TARGET_ID;
    routeContext.accountId = account.id;
    routeContext.sessionPreferred = true;
  }

  function releaseSessionReservation(routeContext: RouteContext | null | undefined, accountId = ""): void {
    if (!routeContext?.sessionId) return;
    const pending = pendingSessionBindings.get(routeContext.sessionId);
    if (!pending || (accountId && pending.accountId !== accountId)) return;
    pendingSessionBindings.delete(routeContext.sessionId);
  }

  function bind(routeContext: RouteContext | null | undefined, account: GatewayAccount | null | undefined): void {
    if (!routeContext || !account?.id) return;
    bindTarget(routeContext, {
      targetId: BUILTIN_SUBSCRIPTION_TARGET_ID,
      accountId: account.id
    });
  }

  function bindTarget(routeContext: RouteContext | null | undefined, target: BindingTarget | null | undefined): void {
    if (!routeContext || !target?.targetId) return;
    const binding = bindingFromTarget(target, now());
    if (routeContext.turnId) turnBindings.set(routeContext.turnId, binding);
    if (routeContext.turnState) stateBindings.set(routeContext.turnState, binding);
    if (routeContext.sessionId) {
      sessionBindings.set(routeContext.sessionId, binding);
      pendingSessionBindings.delete(routeContext.sessionId);
    }
    trimBindings(turnBindings);
    trimBindings(stateBindings);
    trimBindings(sessionBindings);
    routeContext.targetId = binding.targetId;
    routeContext.accountId = binding.accountId;
    routeContext.clientModel = binding.clientModel;
    routeContext.upstreamModel = binding.upstreamModel;
    routeContext.established = true;
  }

  function observeResponse(routeContext: RouteContext, account: GatewayAccount | null | undefined, headers: ResponseHeaders): void {
    bind(routeContext, account);
    const turnState = responseHeader(headers, "x-codex-turn-state");
    if (turnState && account?.id) {
      const binding = bindingFromTarget({
        targetId: BUILTIN_SUBSCRIPTION_TARGET_ID,
        accountId: account.id
      }, now());
      stateBindings.set(turnState, binding);
      trimBindings(stateBindings);
      if (routeContext) routeContext.turnState = turnState;
    }
    options.onChanged?.(snapshot());
  }

  function observeTargetResponse(routeContext: RouteContext, target: BindingTarget | null | undefined, headers: ResponseHeaders): void {
    bindTarget(routeContext, target);
    const turnState = responseHeader(headers, "x-codex-turn-state");
    if (turnState && target?.targetId) {
      const binding = bindingFromTarget(target, now());
      stateBindings.set(turnState, binding);
      trimBindings(stateBindings);
      if (routeContext) routeContext.turnState = turnState;
    }
    options.onChanged?.(snapshot());
  }

  function setCooldown(accountId: string, durationMs = DEFAULT_COOLDOWN_MS): void {
    if (!accountId) return;
    cooldowns.set(accountId, now() + Math.max(1, Number(durationMs) || DEFAULT_COOLDOWN_MS));
  }

  function clearCooldown(accountId: string): void {
    cooldowns.delete(accountId);
  }

  function releaseQuotaBinding(routeContext: RouteContext | null | undefined, accountId: string): void {
    if (!routeContext || !accountId) return;
    if (routeContext.turnId && turnBindings.get(routeContext.turnId)?.accountId === accountId) {
      turnBindings.delete(routeContext.turnId);
    }
    if (routeContext.turnState && stateBindings.get(routeContext.turnState)?.accountId === accountId) {
      stateBindings.delete(routeContext.turnState);
    }
    releaseSessionReservation(routeContext, accountId);
    options.onChanged?.(snapshot());
  }

  function prune(ttlMs = DEFAULT_TURN_TTL_MS): void {
    const cutoff = now() - Math.max(1, Number(ttlMs) || DEFAULT_TURN_TTL_MS);
    for (const [key, binding] of turnBindings) {
      if (binding.lastSeenAt < cutoff) turnBindings.delete(key);
    }
    for (const [key, binding] of stateBindings) {
      if (binding.lastSeenAt < cutoff) stateBindings.delete(key);
    }
    const configuredSessionTtlMs = Number(getSessionAffinityTtlMs());
    const sessionTtlMs = Number.isFinite(configuredSessionTtlMs) && configuredSessionTtlMs > 0
      ? configuredSessionTtlMs
      : DEFAULT_SESSION_TTL_MS;
    const sessionCutoff = now() - sessionTtlMs;
    for (const [key, binding] of sessionBindings) {
      if (binding.lastSeenAt < sessionCutoff) sessionBindings.delete(key);
    }
    const pendingCutoff = now() - PENDING_SESSION_TTL_MS;
    for (const [key, binding] of pendingSessionBindings) {
      if (binding.lastSeenAt < pendingCutoff) pendingSessionBindings.delete(key);
    }
    for (const [accountId, until] of cooldowns) {
      if (until <= now()) cooldowns.delete(accountId);
    }
  }

  function snapshot(): RoutingSnapshot {
    prune();
    return {
      schemaVersion: 2,
      turns: bindingEntries(turnBindings),
      states: bindingEntries(stateBindings),
      sessions: bindingEntries(sessionBindings)
    };
  }

  return {
    context,
    findBoundAccount,
    findPreferredAccount,
    selectNewAccount,
    beginRequest,
    reserveSession,
    releaseSessionReservation,
    bind,
    bindTarget,
    observeResponse,
    observeTargetResponse,
    setCooldown,
    clearCooldown,
    releaseQuotaBinding,
    prune,
    snapshot,
    cooldowns
  };
}

function bindingFromTarget(target: BindingTarget, lastSeenAt: number): Binding {
  return {
    targetId: target.targetId,
    accountId: target.accountId || "",
    credentialRef: target.credentialRef || "",
    clientModel: target.clientModel || "",
    upstreamModel: target.upstreamModel || "",
    lastSeenAt
  };
}
function bindingMap(entries: BindingEntry[] | undefined): Map<string, Binding> {
  const map = new Map<string, Binding>();
  for (const item of Array.isArray(entries) ? entries.slice(-MAX_BINDINGS_PER_KIND) : []) {
    const key = String(item?.key || "").slice(0, 16 * 1024);
    const accountId = String(item?.accountId || "").slice(0, 512);
    const targetId = String(item?.targetId || (accountId ? BUILTIN_SUBSCRIPTION_TARGET_ID : "")).slice(0, 512);
    const lastSeenAt = Number(item?.lastSeenAt || 0);
    if (key && targetId && Number.isFinite(lastSeenAt) && lastSeenAt > 0) {
      map.set(key, {
        targetId,
        accountId,
        credentialRef: String(item?.credentialRef || "").slice(0, 512),
        clientModel: String(item?.clientModel || "").slice(0, 512),
        upstreamModel: String(item?.upstreamModel || "").slice(0, 512),
        lastSeenAt
      });
    }
  }
  return map;
}
function bindingEntries(map: Map<string, Binding>): BindingEntry[] {
  return Array.from(map, ([key, binding]) => ({
    key,
    targetId: binding.targetId,
    accountId: binding.accountId,
    credentialRef: binding.credentialRef,
    clientModel: binding.clientModel,
    upstreamModel: binding.upstreamModel,
    lastSeenAt: binding.lastSeenAt
  }))
    .sort((left, right) => left.lastSeenAt - right.lastSeenAt)
    .slice(-MAX_BINDINGS_PER_KIND);
}

function trimBindings(map: Map<string, Binding>): void {
  if (map.size <= MAX_BINDINGS_PER_KIND) return;
  const oldest = Array.from(map.entries())
    .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
    .slice(0, map.size - MAX_BINDINGS_PER_KIND);
  for (const [key] of oldest) map.delete(key);
}

export function sessionIdFromHeaders(headers: HeaderRecord): string {
  return (
    headerValue(headers, "session_id")
    || headerValue(headers, "session-id")
    || headerValue(headers, "x-session-id")
  ).slice(0, 512);
}

export function turnIdFromHeaders(headers: HeaderRecord): string {
  const raw = headerValue(headers, "x-codex-turn-metadata");
  if (!raw) return "";
  try {
    const value = JSON.parse(raw);
    const turnId = String(value?.turn_id || "").trim();
    return turnId.slice(0, 512);
  } catch {
    return "";
  }
}

function headerValue(headers: HeaderRecord, name: string): string {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() !== lower) continue;
    const text = Array.isArray(value) ? value[0] : value;
    return String(text || "").slice(0, 16 * 1024);
  }
  return "";
}

function responseHeader(headers: ResponseHeaders, name: string): string {
  if (!headers) return "";
  if (headers instanceof Headers) return String(headers.get(name) || "").slice(0, 16 * 1024);
  return headerValue(headers, name);
}
