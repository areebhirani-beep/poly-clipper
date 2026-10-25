import { describe, expect, it } from "vitest";
import { McpClient, PROTOCOL_VERSION, UnauthorizedError } from "../src/mcp.ts";

const client = { url: "x", clientName: "test", clientVersion: "0" };

type Handler = (body: any, headers: Record<string, string>) => Response;

function server(handler: Handler) {
  const seen: { body: any; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body));
    seen.push({ body, headers });
    return handler(body, headers);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const json = (data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", ...headers } });
const sse = (data: unknown) =>
  new Response(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: ${JSON.stringify(data)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

function standard(answer: (body: any) => Response): Handler {
  return (body) => {
    if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: PROTOCOL_VERSION } }, { "mcp-session-id": "s1" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return answer(body);
  };
}

describe("McpClient", () => {
  it("initializes once, keeps the session, and reads JSON results", async () => {
    const { fetchImpl, seen } = server(standard((b) => json({ jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: "ok" }] } })));
    const c = new McpClient({ ...client, token: async () => "T", refresh: async () => null, fetch: fetchImpl });
    expect(await c.callTool("cli", { args: ["ls"] })).toEqual({ text: "ok", isError: false });
    await c.callTool("cli", { args: ["ls"] });
    expect(seen.map((s) => s.body.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
    expect(seen[2].headers["Mcp-Session-Id"]).toBe("s1");
    expect(seen[2].headers.Authorization).toBe("Bearer T");
    expect(seen[2].headers["MCP-Protocol-Version"]).toBe(PROTOCOL_VERSION);
    expect(seen[2].body.params).toEqual({ name: "cli", arguments: { args: ["ls"] } });
  });

  it("reads results delivered over an SSE stream and keeps tool errors as data", async () => {
    const { fetchImpl } = server(standard((b) => sse({ jsonrpc: "2.0", id: b.id, result: { isError: true, content: [{ type: "text", text: "no such folder" }] } })));
    const c = new McpClient({ ...client, token: async () => "T", refresh: async () => null, fetch: fetchImpl });
    expect(await c.callTool("cli", { args: [] })).toEqual({ text: "no such folder", isError: true });
  });

  it("refreshes the token once on a 401 and retries", async () => {
    let token = "old";
    const { fetchImpl, seen } = server((b, h) =>
      h.Authorization === "Bearer old" ? new Response("expired", { status: 401 }) : standard((x) => json({ jsonrpc: "2.0", id: x.id, result: { content: [] } }))(b, h),
    );
    const c = new McpClient({ ...client, token: async () => token, refresh: async () => (token = "new"), fetch: fetchImpl });
    await c.callTool("cli", { args: [] });
    expect(seen.filter((s) => s.headers.Authorization === "Bearer new").length).toBe(3);
  });

  it("gives up with UnauthorizedError when the refresh fails", async () => {
    const { fetchImpl } = server(() => new Response("no", { status: 401 }));
    const c = new McpClient({ ...client, token: async () => "T", refresh: async () => null, fetch: fetchImpl });
    await expect(c.callTool("cli", { args: [] })).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("starts a new session when the server forgets the old one", async () => {
    let session = 0;
    let dropped = false;
    const { fetchImpl, seen } = server((b, h) => {
      if (b.method === "initialize") return json({ jsonrpc: "2.0", id: b.id, result: {} }, { "mcp-session-id": `s${++session}` });
      if (b.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (h["Mcp-Session-Id"] === "s1" && !dropped) {
        dropped = true;
        return new Response("Session not found", { status: 404 });
      }
      return json({ jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: h["Mcp-Session-Id"] }] } });
    });
    const c = new McpClient({ ...client, token: async () => "T", refresh: async () => null, fetch: fetchImpl });
    expect((await c.callTool("cli", { args: [] })).text).toBe("s2");
    expect(seen.filter((s) => s.body.method === "initialize")).toHaveLength(2);
  });
});
