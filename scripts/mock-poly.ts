// A stand-in for mcp.poly.app used by the end-to-end test. It speaks the same
// streamable-HTTP MCP, answers some calls as JSON and some as SSE (the real
// server may use either), and keeps an in-memory file tree so the test can
// check what would have landed in Poly.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { flagValues } from "../tests/flags.ts";

export const TOKEN = "e2e-token";

interface File {
  text: string;
  tags: string[];
  notes?: string;
}

export function mockPoly() {
  const folders = new Set(["//Home", "//Home/Projects", "//Home/Reading"]);
  const files = new Map<string, File>();
  const calls: string[][] = [];
  const sessions = new Set<string>();
  const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/"));

  function cli(args: string[]): { text: string; isError?: boolean } {
    calls.push(args);
    const flag = (name: string) => flagValues(args, name);
    const [cmd, sub] = args;
    if (cmd === "mkdir") {
      if (folders.has(args[1])) return { isError: true, text: `Error: '${args[1]}' already exists` };
      if (!folders.has(parentOf(args[1]))) return { isError: true, text: "Error: parent folder not found" };
      folders.add(args[1]);
      return { text: `Created ${args[1]}` };
    }
    if (cmd === "ls") {
      const dir = args[1];
      const entries = [...folders].filter((f) => parentOf(f) === dir).map((f) => ({ name: f.slice(dir.length + 1), type: "folder" }));
      return { text: JSON.stringify({ entries }) };
    }
    if (cmd === "file" && sub === "write") {
      const path = args[2];
      if (!folders.has(parentOf(path))) return { isError: true, text: "Error: parent folder does not exist" };
      if (files.has(path) && args.includes("--no-clobber")) return { isError: true, text: `Error: '${path}' already exists` };
      files.set(path, { text: flag("--text")[0], tags: [] });
      return { text: `Wrote ${path}` };
    }
    if (cmd === "file" && sub === "update") {
      const f = files.get(args[2]);
      if (!f) return { isError: true, text: "Error: not found" };
      f.tags.push(...flag("--tag"));
      f.notes = flag("--notes")[0] ?? f.notes;
      return { text: "Updated" };
    }
    if (cmd === "file" && sub === "show") {
      return { text: JSON.stringify({ path: args[2], web_url: `https://poly.app/file/${encodeURIComponent(args[2])}` }) };
    }
    if (cmd === "wget") {
      const url = args[1];
      const dir = flag("-P")[0];
      const path = `${dir}/${decodeURIComponent(new URL(url).pathname.split("/").pop() || "download")}`;
      files.set(path, { text: `<bytes of ${url}>`, tags: flag("--tag"), notes: flag("--notes")[0] });
      return { text: `Saved ${path} https://poly.app/file/w1` };
    }
    if (cmd === "mkurl") {
      const path = `${args[1]}/${new URL(args[2]).hostname}.webloc`;
      files.set(path, { text: args[2], tags: [] });
      return { text: `Created ${path}` };
    }
    return { isError: true, text: `Unknown command: ${args.join(" ")}` };
  }

  let sse = false;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "www-authenticate": "Bearer" }).end("Access token missing");
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body);
    if (msg.method === "initialize") {
      const id = `s${sessions.size + 1}`;
      sessions.add(id);
      const result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mock-poly" } };
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": id }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      return;
    }
    if (!sessions.has(String(req.headers["mcp-session-id"]))) {
      res.writeHead(404).end("Session not found");
      return;
    }
    if (msg.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    if (msg.method !== "tools/call" || msg.params.name !== "cli") {
      res.writeHead(400).end(`Unexpected ${msg.method}`);
      return;
    }
    let out: { text: string; isError?: boolean };
    try {
      out = cli(msg.params.arguments.args);
    } catch (e) {
      out = { isError: true, text: (e as Error).message };
    }
    const reply = { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: out.text }], isError: Boolean(out.isError) } };
    sse = !sse;
    if (sse) res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
    else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => res.writeHead(500).end(String(e)));
  });
  return { server, folders, files, calls };
}
