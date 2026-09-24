import { guardedFetch } from "./upstream-ip-guard.ts";
import http, { type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LoginStartResult, LoginStatus } from "../shared/contracts/accounts";

const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_ORIGINATOR = "codex_cli_rs";
const LOGIN_HOST = "localhost";
const LOGIN_PORT = 1455;

interface TokenSet { access_token?: string; refresh_token?: string; id_token?: string }
interface LoginSession { redirect_uri: string; code_verifier: string; status: LoginStatus["status"]; error?: string | null }
interface AccountRecord extends Record<string, unknown> { id: string; name: string }
interface AuthStore {
  saveLoginSession: (session: Record<string, unknown>) => unknown;
  getLoginSession: (id: string) => LoginSession | null;
  updateLoginSession: (id: string, status: string, error: string | null) => unknown;
  saveAccount: (account: Record<string, unknown>) => AccountRecord;
  listAccounts: () => AccountRecord[];
  addAppLog: (entry: Record<string, unknown>) => unknown;
}

interface AuthService {
  startLogin: () => Promise<LoginStartResult & { authUrl: string }>;
  completeCallback: (params: URLSearchParams) => Promise<AccountRecord>;
  loginStatus: (loginId: string) => LoginStatus & { error?: string | null };
  cancelLogin: (loginId: string) => { cancelled: boolean };
  stop: () => Promise<void>;
}

export function createAuthService(
  store: AuthStore,
  _ensureGatewayStarted: () => Promise<unknown>,
  refreshAccountUsage?: (id: string) => Promise<AccountRecord>
): AuthService {
  let loginServer: Server | null = null;

  async function startLogin(): Promise<LoginStartResult & { authUrl: string }> {
    const redirectUri = await ensureLoginServer();
    const pkce = generatePkce();
    const state = generateState();
    store.saveLoginSession({
      id: state,
      code_verifier: pkce.codeVerifier,
      redirect_uri: redirectUri,
      status: "pending"
    });
    return {
      loginId: state,
      authUrl: buildAuthorizeUrl({
        issuer: DEFAULT_ISSUER,
        clientId: DEFAULT_CLIENT_ID,
        redirectUri,
        codeChallenge: pkce.codeChallenge,
        state
      })
    };
  }

  async function ensureLoginServer(): Promise<string> {
    if (loginServer) return loginRedirectUri();
    loginServer = http.createServer((req, res) => handleLoginServerRequest(req, res));
    try {
      const server = loginServer;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(LOGIN_PORT, LOGIN_HOST, resolve);
      });
    } catch (error) {
      loginServer = null;
      throw new Error(`启动登录回调服务失败（${loginRedirectUri()}）：${errorMessage(error)}`);
    }
    return loginRedirectUri();
  }

  async function handleLoginServerRequest(req: http.IncomingMessage, res: ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url || "/", loginRedirectUri());
    if (req.method !== "GET" || parsedUrl.pathname !== "/auth/callback") {
      return sendHtml(res, 404, "Codexia", "未找到登录回调地址。");
    }
    try {
      await completeCallback(parsedUrl.searchParams);
      return sendHtml(res, 200, "登录成功", "账号已保存，可以关闭这个浏览器页面并回到 Codexia。");
    } catch (error) {
      return sendHtml(res, 500, "登录失败", errorMessage(error));
    }
  }

  async function completeCallback(params: URLSearchParams): Promise<AccountRecord> {
    const state = String(params.get("state") || "").trim();
    const code = String(params.get("code") || "").trim();
    const oauthError = String(params.get("error") || "").trim();
    const session = state ? store.getLoginSession(state) : null;
    if (!state || !session) throw new Error("登录回调已过期或 state 不匹配");
    if (session.status !== "pending") throw new Error(session.status === "cancelled" ? "登录授权已取消" : "登录回调已处理或已过期");
    if (oauthError) {
      const message = String(params.get("error_description") || oauthError);
      store.updateLoginSession(state, "failed", message);
      throw new Error(message);
    }
    if (!code) throw new Error("登录回调缺少授权码");
    try {
      const tokens = await exchangeCodeForTokens({
        issuer: DEFAULT_ISSUER,
        clientId: DEFAULT_CLIENT_ID,
        redirectUri: session.redirect_uri,
        codeVerifier: session.code_verifier,
        code
      });
      if (store.getLoginSession(state)?.status !== "pending") throw new Error("登录授权已取消");
      const account = accountFromTokens(tokens);
      const saved = store.saveAccount(account);
      if (refreshAccountUsage) {
        try {
          const refreshed = await refreshAccountUsage(saved.id);
          store.addAppLog({
            scope: "usage",
            action: "refresh-account",
            status: "success",
            message: `浏览器认证后已刷新额度：${refreshed.name}`
          });
        } catch (error) {
          store.addAppLog({
            level: "error",
            scope: "usage",
            action: "refresh-account",
            status: "failed",
            message: `浏览器认证后刷新额度失败：${saved.name}: ${errorMessage(error)}`
          });
        }
      }
      store.updateLoginSession(state, "success", null);
      return store.listAccounts().find((item) => item.id === saved.id) || saved;
    } catch (error) {
      if (store.getLoginSession(state)?.status === "pending") {
        store.updateLoginSession(state, "failed", errorMessage(error));
      }
      throw error;
    }
  }

  function loginStatus(loginId: string): LoginStatus & { error?: string | null } {
    const session = store.getLoginSession(loginId);
    return session
      ? { status: session.status, error: session.error || null }
      : { status: "unknown", error: null };
  }

  function cancelLogin(loginId: string): { cancelled: boolean } {
    const session = store.getLoginSession(loginId);
    if (!session || session.status !== "pending") return { cancelled: false };
    store.updateLoginSession(loginId, "cancelled", null);
    return { cancelled: true };
  }

  async function stop(): Promise<void> {
    if (!loginServer) return;
    const closing = loginServer;
    loginServer = null;
    await new Promise<void>((resolve, reject) => closing.close((error) => error ? reject(error) : resolve()));
  }

  return { startLogin, completeCallback, loginStatus, cancelLogin, stop };
}

export function loginRedirectUri(): string {
  return `http://${LOGIN_HOST}:${LOGIN_PORT}/auth/callback`;
}

function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64Url(randomBytes(64));
  const digest = createHash("sha256").update(codeVerifier).digest();
  return { codeVerifier, codeChallenge: base64Url(digest) };
}

function generateState(): string {
  return base64Url(randomBytes(32));
}

export function buildAuthorizeUrl({ issuer, clientId, redirectUri, codeChallenge, state }: {
  issuer: string; clientId: string; redirectUri: string; codeChallenge: string; state: string;
}): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: DEFAULT_ORIGINATOR
  });
  return `${issuer}/oauth/authorize?${query.toString()}`;
}

function sendHtml(res: ServerResponse, status: number, title: string, message: string): void {
  const body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:Arial,sans-serif;padding:32px"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></body>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  } as Record<string, string>)[char] || char);
}

async function exchangeCodeForTokens({ issuer, clientId, redirectUri, codeVerifier, code }: {
  issuer: string; clientId: string; redirectUri: string; codeVerifier: string; code: string;
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier
  });
  const resp = await guardedFetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000)
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`token exchange failed: ${resp.status} ${text.slice(0, 240)}`);
  return JSON.parse(text);
}

export function accountFromTokens(tokens: TokenSet): Record<string, unknown> {
  const claims = decodeJwtPayload(tokens.id_token || tokens.access_token) || {};
  const auth = claims["https://api.openai.com/auth"] || {};
  const chatgptAccountId = normalizeScopedId(auth.chatgpt_account_id || claims.chatgpt_account_id, "cgpt=");
  const workspaceId = normalizeScopedId(claims.workspace_id || auth.workspace_id, "ws=") || chatgptAccountId;
  const subject = claims.sub || chatgptAccountId || workspaceId || claims.email || randomUUID();
  return {
    id: stableId([subject, chatgptAccountId, workspaceId].filter(Boolean).join("|")),
    name: claims.email || subject,
    email: claims.email || "",
    access_token: tokens.access_token || "",
    refresh_token: tokens.refresh_token || "",
    id_token: tokens.id_token || "",
    last_refresh: new Date().toISOString(),
    account_id: chatgptAccountId || "",
    workspace_id: workspaceId || "",
    status: "active",
    enabled: true,
    priority: 100,
    subscription_plan: auth.chatgpt_plan_type || "",
    subscription_expires_at: toEpoch(auth.chatgpt_subscription_active_until),
    note: "browser login"
  };
}

export function subscriptionFromTokens(tokens: TokenSet): { subscription_plan: string; subscription_expires_at: number | null } {
  const access = decodeJwtPayload(tokens.access_token)?.["https://api.openai.com/auth"] || {};
  const identity = decodeJwtPayload(tokens.id_token)?.["https://api.openai.com/auth"] || {};
  const auth = { ...access, ...identity };
  return {
    subscription_plan: auth.chatgpt_plan_type || "",
    subscription_expires_at: toEpoch(auth.chatgpt_subscription_active_until)
  };
}

function decodeJwtPayload(token: string | undefined): Record<string, any> | null {
  if (!token || !token.includes(".")) return null;
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function normalizeScopedId(value: unknown, marker: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const suffix = raw.includes("::") ? raw.split("::").pop() || "" : raw;
  const part = suffix.split("|").find((item) => item.startsWith(marker));
  if (part) return part.slice(marker.length).trim();
  if (raw.includes("::") || raw.includes("|") || raw.includes("=")) return "";
  return raw;
}

function toEpoch(value: unknown): number | null {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
