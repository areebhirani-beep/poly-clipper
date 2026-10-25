// Everything the clipper does in Poly goes through the MCP `cli` tool, which
// takes the same arguments as the desktop `poly` command. Arguments travel as
// an array, so titles with spaces and quotes need no shell escaping.

import type { ToolResult } from "./mcp.ts";
import { buildDocument, fileNameFor, numbered, type PageClip } from "./markdown.ts";

export type Cli = (args: string[]) => Promise<ToolResult>;

export class PolyError extends Error {}

export const DEFAULT_FOLDER = "//Home/Clippings";

export type SaveRequest =
  | { kind: "article" | "selection"; clip: PageClip; title: string; folder: string; tags: string[]; note: string }
  | { kind: "image"; src: string; pageUrl: string; folder: string; tags: string[]; note: string }
  | { kind: "pdf"; url: string; folder: string; tags: string[]; note: string }
  | { kind: "link"; url: string; folder: string };

export interface SaveResult {
  path: string;
  openUrl?: string;
  // Set when the file was saved but a follow-up step (tags, notes) failed.
  // The save itself succeeded, so retrying would only make a duplicate.
  warning?: string;
}

// "//Home/Reading/2026" -> ["//Home/Reading", "//Home/Reading/2026"].
// The root ("//Home", "//shared/team") always exists and is never created.
export function folderChain(folder: string): string[] {
  const clean = normalizeFolder(folder);
  const parts = clean.slice(2).split("/");
  const rootLen = parts[0] === "shared" ? 2 : 1;
  const chain: string[] = [];
  for (let i = rootLen + 1; i <= parts.length; i++) chain.push("//" + parts.slice(0, i).join("/"));
  return chain;
}

// Accepts "Clippings", "/Clippings", "//Home/Clippings/" and returns the
// canonical "//Home/Clippings".
export function normalizeFolder(input: string): string {
  let f = input.trim().replace(/\/+$/, "");
  if (!f) return DEFAULT_FOLDER;
  if (!f.startsWith("//")) f = `//Home/${f.replace(/^\/+/, "")}`;
  return f.replace(/(?<!^)\/{2,}/g, "/");
}

// Kept narrow on purpose: "parent folder does not exist" must not read as
// "this name is taken".
const EXISTS = /already exists|file exists|exists already|clobber/i;
const MISSING = /not found|does not exist|doesn't exist|no such/i;

// Past this many "Title (n).md" files, something is clipping in a loop.
const MAX_COPIES = 20;

export class Poly {
  private known = new Set<string>();

  constructor(private readonly cli: Cli, private readonly now: () => Date = () => new Date()) {}

  // Folders known to exist belong to one account; forget them on sign-in
  // changes and whenever Poly says a parent is missing.
  reset() {
    this.known.clear();
  }

  async run(args: string[]): Promise<string> {
    const res = await this.cli(args);
    if (res.isError) throw new PolyError(res.text.trim() || `Poly could not run ${args[0]}.`);
    return res.text;
  }

  // Creates each missing level of the folder. "Already exists" is success;
  // anything else stops with Poly's own message.
  async ensureFolder(folder: string): Promise<void> {
    for (const level of folderChain(folder)) {
      if (this.known.has(level)) continue;
      const res = await this.cli(["mkdir", level]);
      if (res.isError && !EXISTS.test(res.text)) throw new PolyError(res.text.trim() || `Poly could not create ${level}.`);
      this.known.add(level);
    }
  }

  async listFolders(parent: string): Promise<string[]> {
    const res = await this.cli(["ls", normalizeFolder(parent), "--output", "json"]);
    if (res.isError) return [];
    return parseFolderNames(res.text).map((n) => `${normalizeFolder(parent)}/${n}`);
  }

  async save(req: SaveRequest): Promise<SaveResult> {
    const folder = normalizeFolder(req.folder);
    await this.ensureFolder(folder);

    if (req.kind === "link") {
      const out = await this.run(["mkurl", folder, req.url]);
      return { path: folder, openUrl: findPolyUrl(out) };
    }

    if (req.kind === "image" || req.kind === "pdf") {
      const url = req.kind === "image" ? req.src : req.url;
      const notes = [req.note.trim(), req.kind === "image" ? `Saved from ${req.pageUrl}` : ""].filter(Boolean).join("\n\n");
      const args = ["wget", url, "-P", folder, ...tagArgs(req.tags)];
      if (notes) args.push(`--notes=${notes}`);
      const out = await this.run(args);
      return { path: folder, openUrl: findPolyUrl(out) };
    }

    const doc = buildDocument(req.clip, { title: req.title, tags: req.tags, clippedAt: this.now() });
    const name = fileNameFor(req.title, req.kind);
    const path = await this.writeUnique(folder, name, doc);

    const meta = [...tagArgs(req.tags)];
    if (req.note.trim()) meta.push(`--notes=${req.note.trim()}`);
    let warning: string | undefined;
    if (meta.length) {
      try {
        await this.run(["file", "update", path, ...meta]);
      } catch (e) {
        warning = `Saved, but the tags and note were not added: ${(e as Error).message}`;
      }
    }

    let openUrl: string | undefined;
    try {
      openUrl = findPolyUrl(await this.run(["file", "show", path, "--output", "json"]));
    } catch {
      // The file is saved; a missing link only hides the "Open" button.
    }
    return { path, openUrl, warning };
  }

  private async writeUnique(folder: string, name: string, doc: string): Promise<string> {
    let n = 1;
    let recreated = false;
    while (n <= MAX_COPIES) {
      const path = `${folder}/${n === 1 ? name : numbered(name, n)}`;
      // "--text=" keeps the value attached: the document starts with "---",
      // which a strict argument parser would otherwise read as a flag.
      const res = await this.cli(["file", "write", path, `--text=${doc}`, "--no-clobber"]);
      if (!res.isError) return path;
      if (MISSING.test(res.text) && !recreated) {
        // The folder was deleted since it was cached. Make it again, once.
        recreated = true;
        this.reset();
        await this.ensureFolder(folder);
      } else if (EXISTS.test(res.text)) {
        n++;
      } else {
        throw new PolyError(res.text.trim() || "Poly could not write the file.");
      }
    }
    throw new PolyError(`${folder} already has ${MAX_COPIES} copies of ${name}.`);
  }
}

function tagArgs(tags: string[]): string[] {
  return tags.map((t) => `--tag=${t}`);
}

// The CLI's JSON output shape isn't documented, so read it defensively:
// any array of entries, or an object holding one, where an entry looks like
// a folder by its type, kind, mime type or trailing slash.
export function parseFolderNames(text: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const entries = findArray(data);
  const names: string[] = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const name = String(r.name ?? r.filename ?? r.title ?? "");
    const kind = String(r.type ?? r.kind ?? r.mime_type ?? r.mimeType ?? "").toLowerCase();
    const isDir = r.is_dir === true || r.isDir === true || r.is_folder === true || /dir|folder/.test(kind) || name.endsWith("/");
    if (name && isDir) names.push(name.replace(/\/$/, ""));
  }
  return names.sort((a, b) => a.localeCompare(b));
}

function findArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const v of Object.values(data)) {
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

export function findPolyUrl(text: string): string | undefined {
  return text.match(/https:\/\/(?:[\w-]+\.)?poly\.app\/[^\s"'<>)]+/)?.[0];
}
