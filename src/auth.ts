// Signs in to Poly's MCP server with OAuth 2.1: dynamic client registration
// and PKCE, using the endpoints from poly.app/.well-known/oauth-authorization-server.
// The extension registers itself once, with its chrome.identity redirect URL,
// and never sees the user's Poly password.

export const OAUTH = {
  register: "https://poly.app/api/oauth/register",
  authorize: "https://poly.app/api/oauth/authorize",
  token: "https://poly.app/api/oauth/token",
  revoke: "https://poly.app/api/oauth/revoke",
  resource: "https://mcp.poly.app/mcp",
  scope: "all",
};

export interface Client {
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
}

// An error answer from Poly's OAuth endpoints, with the OAuth error code
// ("invalid_grant", "invalid_client") when Poly sent one.
export class OAuthError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
  }
}

const CLIENT_GONE = new Set(["invalid_client", "unauthorized_client"]);

export class SignInRequired extends Error {
  constructor() {
    super("Connect your Poly account first.");
  }
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function authorizeUrl(client: Client, challenge: string, state: string): string {
  const u = new URL(OAUTH.authorize);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: OAUTH.scope,
    state,
    resource: OAUTH.resource,
  }).toString();
  return u.toString();
}

// Returns the authorization code, or throws with the provider's reason.
export function parseRedirect(redirect: string, expectedState: string): string {
  const u = new URL(redirect);
  const params = u.searchParams.has("code") || u.searchParams.has("error") ? u.searchParams : new URLSearchParams(u.hash.slice(1));
  const error = params.get("error");
  if (error) throw new OAuthError(params.get("error_description") || `Poly sign-in failed (${error})`, error);
  if (params.get("state") !== expectedState) throw new Error("Sign-in response did not match the request. Try again.");
  const code = params.get("code");
  if (!code) throw new Error("Poly did not return an authorization code.");
  return code;
}

// Used when the token response leaves out expires_in (seconds).
const DEFAULT_TOKEN_TTL = 3600;

export function tokensFrom(json: any, previous?: Tokens, now = Date.now()): Tokens {
  if (!json?.access_token) throw new Error(json?.error_description || json?.error || "Poly did not return a token.");
  const ttl = Number(json.expires_in) > 0 ? Number(json.expires_in) : DEFAULT_TOKEN_TTL;
  return {
    access_token: json.access_token,
    // Refresh tokens may or may not rotate; keep the old one if none came back.
    refresh_token: json.refresh_token ?? previous?.refresh_token,
    expires_at: now + ttl * 1000,
  };
}

export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface AuthDeps {
  store: Store;
  redirectUrl: () => string;
  launch: (url: string) => Promise<string>; // resolves with the final redirect URL
  fetch?: typeof fetch;
}

export class Auth {
  private refreshing: Promise<string | null> | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: AuthDeps) {
    this.fetchImpl = deps.fetch ?? fetch.bind(globalThis);
  }

  async isSignedIn(): Promise<boolean> {
    return Boolean(await this.deps.store.get<Tokens>("tokens"));
  }

  async signIn(retry = true): Promise<void> {
    const client = await this.client();
    const verifier = randomString(48);
    const state = randomString(16);
    try {
      const redirect = await this.deps.launch(authorizeUrl(client, await pkceChallenge(verifier), state));
      const code = parseRedirect(redirect, state);
      const json = await this.tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: client.redirect_uri,
        code_verifier: verifier,
        ...credentials(client),
        resource: OAUTH.resource,
      });
      await this.deps.store.set("tokens", tokensFrom(json));
    } catch (e) {
      // Poly forgot the registered client (expired or cleaned up). Register
      // a fresh one and try once more instead of failing forever.
      if (e instanceof OAuthError && e.code && CLIENT_GONE.has(e.code)) {
        await this.deps.store.remove("client");
        if (retry) return this.signIn(false);
      }
      throw e;
    }
  }

  async accessToken(): Promise<string> {
    const tokens = await this.deps.store.get<Tokens>("tokens");
    if (!tokens) throw new SignInRequired();
    if (tokens.expires_at - 60_000 > Date.now()) return tokens.access_token;
    const fresh = await this.refresh();
    if (!fresh) throw new SignInRequired();
    return fresh;
  }

  // Concurrent callers share one refresh so a rotating refresh token isn't
  // spent twice.
  refresh(): Promise<string | null> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  async signOut(): Promise<void> {
    const tokens = await this.deps.store.get<Tokens>("tokens");
    const client = await this.deps.store.get<Client>("client");
    await this.deps.store.remove("tokens");
    if (tokens?.refresh_token && client) {
      await this.fetchImpl(OAUTH.revoke, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.refresh_token, token_type_hint: "refresh_token", ...credentials(client) }),
      }).catch(() => undefined);
    }
  }

  private async doRefresh(): Promise<string | null> {
    const tokens = await this.deps.store.get<Tokens>("tokens");
    const client = await this.deps.store.get<Client>("client");
    if (!tokens?.refresh_token || !client) {
      await this.deps.store.remove("tokens");
      return null;
    }
    try {
      const json = await this.tokenRequest({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        ...credentials(client),
        resource: OAUTH.resource,
      });
      const next = tokensFrom(json, tokens);
      await this.deps.store.set("tokens", next);
      return next.access_token;
    } catch (e) {
      // Only a refusal from Poly ends the session. Being offline, a DNS
      // failure or a 5xx keeps the refresh token for the next try.
      if (e instanceof OAuthError && (e.code === "invalid_grant" || (e.code && CLIENT_GONE.has(e.code)) || e.status === 401)) {
        await this.deps.store.remove("tokens");
        if (e.code && CLIENT_GONE.has(e.code)) await this.deps.store.remove("client");
        return null;
      }
      throw e;
    }
  }

  // Registration is cached. If the extension ID changes (an unpacked copy
  // loaded from a new folder) the redirect URL changes too, so register again.
  private async client(): Promise<Client> {
    const redirect_uri = this.deps.redirectUrl();
    const cached = await this.deps.store.get<Client>("client");
    if (cached?.redirect_uri === redirect_uri) return cached;
    const res = await this.fetchImpl(OAUTH.register, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Poly Clipper",
        redirect_uris: [redirect_uri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
        scope: OAUTH.scope,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.client_id) throw new Error(json.error_description || `Poly registration failed (${res.status})`);
    const client: Client = { client_id: json.client_id, client_secret: json.client_secret, redirect_uri };
    await this.deps.store.set("client", client);
    return client;
  }

  private async tokenRequest(params: Record<string, string>): Promise<any> {
    const res = await this.fetchImpl(OAUTH.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new OAuthError(json.error_description || json.error || `Poly token request failed (${res.status})`, json.error, res.status);
    return json;
  }
}

function credentials(client: Client): Record<string, string> {
  return client.client_secret ? { client_id: client.client_id, client_secret: client.client_secret } : { client_id: client.client_id };
}
