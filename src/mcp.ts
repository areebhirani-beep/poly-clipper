// A minimal Model Context Protocol client over streamable HTTP, which is the
// transport Poly's hosted server speaks (https://mcp.poly.app/mcp). It only
// does what the clipper needs: initialize once, then call tools.

export const PROTOCOL_VERSION = "2025-06-18";

export interface ToolResult {
  text: string;
  isError: boolean;
}

export class McpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class UnauthorizedError extends McpError {}

export interface McpOptions {
  url: string;
  // Returns a valid access token, refreshing it if needed.
  token: () => Promise<string>;
  // Called once on a 401. Returns a new token, or null to give up.
  refresh: () => Promise<string | null>;
  clientName: string;
  clientVersion: string;
  fetch?: typeof fetch;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: any;
  error?: { code: number; message: string };
}

export class McpClient {
  private session: string | undefined;
  private ready: Promise<void> | undefined;
  private nextId = 1;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: McpOptions) {
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    await this.init();
    let res: RpcResponse;
    try {
      res = await this.rpc("tools/call", { name, arguments: args });
    } catch (e) {
      // Servers drop sessions on deploys; the spec answers that with a 404,
      // and the fix is a fresh initialize.
      if (!(e instanceof McpError) || e.status !== 404) throw e;
      this.reset();
      await this.init();
      res = await this.rpc("tools/call", { name, arguments: args });
    }
    if (res.error) throw new McpError(res.error.message);
    const content: any[] = res.result?.content ?? [];
    const text = content
      .filter((c) => c?.type === "text")
      .map((c) => c.text as string)
      .join("\n");
    return { text, isError: Boolean(res.result?.isError) };
  }

  reset() {
    this.session = undefined;
    this.ready = undefined;
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      const res = await this.rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.opts.clientName, version: this.opts.clientVersion },
      });
      if (res.error) throw new McpError(`initialize failed: ${res.error.message}`);
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    })().catch((e) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  private async rpc(method: string, params: unknown): Promise<RpcResponse> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });
    const msg = await readResponse(res, id);
    if (!msg) throw new McpError(`No response to ${method}`);
    return msg;
  }

  private async post(body: unknown, retried = false): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${await this.opts.token()}`,
    };
    if (this.session) {
      headers["Mcp-Session-Id"] = this.session;
      headers["MCP-Protocol-Version"] = PROTOCOL_VERSION;
    }
    const res = await this.fetchImpl(this.opts.url, { method: "POST", headers, body: JSON.stringify(body) });
    if (res.status === 401) {
      if (!retried && (await this.opts.refresh())) return this.post(body, true);
      throw new UnauthorizedError("Poly rejected the sign-in. Connect again.", 401);
    }
    if (!res.ok && res.status !== 202) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new McpError(`Poly returned ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    return res;
  }
}

// A streamable HTTP server may answer with plain JSON or with an SSE stream
// that carries the response (and possibly notifications first).
export async function readResponse(res: Response, id: number): Promise<RpcResponse | undefined> {
  if (res.status === 202) return undefined;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const data = await res.json();
    const list: RpcResponse[] = Array.isArray(data) ? data : [data];
    return list.find((m) => m.id === id);
  }
  if (type.includes("text/event-stream")) {
    const text = await res.text();
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data) as RpcResponse;
        if (msg.id === id) return msg;
      } catch {
        // Ignore keep-alives and malformed events.
      }
    }
    return undefined;
  }
  throw new McpError(`Unexpected response type "${type}" from Poly`, res.status);
}
