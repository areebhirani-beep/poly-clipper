import { describe, expect, it } from "vitest";
import { Auth, authorizeUrl, OAUTH, parseRedirect, pkceChallenge, SignInRequired, tokensFrom, type Store } from "../src/auth.ts";

function memoryStore(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T,>(k: string) => data.get(k) as T | undefined,
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
  };
}

describe("PKCE and redirects", () => {
  it("matches the RFC 7636 test vector", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("builds the authorize URL with resource and S256", () => {
    const u = new URL(authorizeUrl({ client_id: "c", redirect_uri: "https://id.chromiumapp.org/" }, "CH", "ST"));
    expect(u.origin + u.pathname).toBe(OAUTH.authorize);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ code_challenge_method: "S256", resource: OAUTH.resource, scope: "all", state: "ST" });
  });

  it("rejects mismatched state and reports provider errors", () => {
    expect(parseRedirect("https://id.chromiumapp.org/?code=abc&state=s", "s")).toBe("abc");
    expect(() => parseRedirect("https://id.chromiumapp.org/?code=abc&state=x", "s")).toThrow(/did not match/);
    expect(() => parseRedirect("https://id.chromiumapp.org/?error=access_denied&error_description=User%20cancelled", "s")).toThrow("User cancelled");
  });

  it("keeps the old refresh token when the server doesn't rotate it", () => {
    const t = tokensFrom({ access_token: "a2", expires_in: 60 }, { access_token: "a1", refresh_token: "r1", expires_at: 0 }, 1000);
    expect(t).toEqual({ access_token: "a2", refresh_token: "r1", expires_at: 61_000 });
  });
});

describe("Auth flow", () => {
  function setup() {
    const store = memoryStore();
    const requests: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = init.body instanceof URLSearchParams ? init.body.toString() : String(init.body);
      requests.push({ url, body });
      if (url === OAUTH.register) return Response.json({ client_id: "cid", client_secret: "sec" }, { status: 201 });
      if (url === OAUTH.token) {
        const p = new URLSearchParams(body);
        if (p.get("grant_type") === "refresh_token" && p.get("refresh_token") === "bad") return Response.json({ error: "invalid_grant" }, { status: 400 });
        if (p.get("grant_type") === "refresh_token" && p.get("refresh_token") === "offline") throw new TypeError("Failed to fetch");
        if (p.get("grant_type") === "authorization_code" && p.get("client_id") === "stale") return Response.json({ error: "invalid_client" }, { status: 401 });
        return Response.json({ access_token: `at-${requests.length}`, refresh_token: "rt", expires_in: 3600 });
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    let launched = "";
    const auth = new Auth({
      store,
      fetch: fetchImpl,
      redirectUrl: () => "https://ext.chromiumapp.org/",
      launch: async (url) => {
        launched = url;
        const state = new URL(url).searchParams.get("state");
        return `https://ext.chromiumapp.org/?code=the-code&state=${state}`;
      },
    });
    return { auth, store, requests, launchedUrl: () => launched };
  }

  it("registers once, exchanges the code with the PKCE verifier, and stores tokens", async () => {
    const { auth, store, requests } = setup();
    await auth.signIn();
    expect(requests[0].url).toBe(OAUTH.register);
    expect(JSON.parse(requests[0].body).redirect_uris).toEqual(["https://ext.chromiumapp.org/"]);
    const exchange = new URLSearchParams(requests[1].body);
    expect(exchange.get("code")).toBe("the-code");
    expect(exchange.get("client_secret")).toBe("sec");
    expect(exchange.get("code_verifier")).toMatch(/^[\w-]{43,128}$/);
    expect(await auth.accessToken()).toBe("at-2");
    await auth.signIn();
    expect(requests.filter((r) => r.url === OAUTH.register)).toHaveLength(1);
    expect(store.data.get("client")).toMatchObject({ client_id: "cid" });
  });

  it("refreshes an expired token, and signs out when the refresh is refused", async () => {
    const { auth, store } = setup();
    await auth.signIn();
    store.data.set("tokens", { access_token: "old", refresh_token: "rt", expires_at: Date.now() - 1 });
    expect(await auth.accessToken()).toMatch(/^at-/);
    store.data.set("tokens", { access_token: "old", refresh_token: "bad", expires_at: Date.now() - 1 });
    await expect(auth.accessToken()).rejects.toBeInstanceOf(SignInRequired);
    expect(await auth.isSignedIn()).toBe(false);
  });

  it("stays signed in when the refresh fails because of the network", async () => {
    const { auth, store } = setup();
    await auth.signIn();
    store.data.set("tokens", { access_token: "old", refresh_token: "offline", expires_at: Date.now() - 1 });
    await expect(auth.accessToken()).rejects.toThrow("Failed to fetch");
    expect(await auth.isSignedIn()).toBe(true);
  });

  it("registers a new client when Poly has forgotten the old one", async () => {
    const { auth, store, requests } = setup();
    store.data.set("client", { client_id: "stale", client_secret: "x", redirect_uri: "https://ext.chromiumapp.org/" });
    await auth.signIn();
    expect(requests.filter((r) => r.url === OAUTH.register)).toHaveLength(1);
    expect(store.data.get("client")).toMatchObject({ client_id: "cid" });
    expect(await auth.isSignedIn()).toBe(true);
  });

  it("shares one refresh between concurrent callers", async () => {
    const { auth, store, requests } = setup();
    await auth.signIn();
    store.data.set("tokens", { access_token: "old", refresh_token: "rt", expires_at: Date.now() - 1 });
    await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
    expect(requests.filter((r) => r.body.includes("grant_type=refresh_token"))).toHaveLength(1);
  });
});
