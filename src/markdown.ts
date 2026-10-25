// Turns an extracted page into the Markdown file that lands in Poly, and picks
// a file name that is safe for Poly paths and for Finder once it syncs down.

export interface PageClip {
  kind: "article" | "selection";
  title: string;
  url: string;
  markdown: string;
  byline?: string;
  siteName?: string;
  published?: string;
  excerpt?: string;
  leadImage?: string;
  wordCount: number;
}

export interface DocOptions {
  title: string;
  tags: string[];
  clippedAt: Date;
}

// YAML needs quoting for anything with a colon, a leading symbol, or quotes.
// Double-quoted scalars with escaped backslashes and quotes cover all of it.
function yamlString(value: string): string {
  const escaped = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // Raw control characters are invalid even inside a quoted YAML string.
    .replace(/[\u0000-\u001f\u007f\u0085]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return `"${escaped}"`;
}

// Sites publish dates in every format. Keep only what parses, as YYYY-MM-DD.
// An ISO date is taken as written: converting "2026-09-14T21:30-05:00" to UTC
// would file it under the 15th.
export function normalizeDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const iso = raw.trim().match(/^\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function buildDocument(clip: PageClip, opts: DocOptions): string {
  const lines = ["---", `title: ${yamlString(opts.title)}`, `source: ${clip.url}`];
  if (clip.byline) lines.push(`author: ${yamlString(clip.byline)}`);
  if (clip.siteName) lines.push(`site: ${yamlString(clip.siteName)}`);
  const published = normalizeDate(clip.published);
  if (published) lines.push(`published: ${published}`);
  lines.push(`clipped: ${opts.clippedAt.toISOString()}`);
  if (opts.tags.length) lines.push(`tags: [${opts.tags.map(yamlString).join(", ")}]`);
  lines.push("---", "");

  const body = clip.markdown.trim();
  if (clip.kind === "selection") {
    // A highlight without its source is useless six months later, so the
    // link back sits right under the quote as well as in the frontmatter.
    lines.push(body, "", `Clipped from [${escapeLinkText(opts.title)}](${clip.url})`);
  } else {
    // Readability usually drops the page's own h1, so put the title back
    // unless the body already opens with a heading.
    if (!/^#\s/.test(body)) lines.push(`# ${opts.title.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim()}`, "");
    lines.push(body);
  }
  return lines.join("\n") + "\n";
}

function escapeLinkText(text: string): string {
  return text.replace(/([\[\]\\])/g, "\\$1");
}

export const MAX_NAME_CHARS = 100;
// macOS and most file systems cap a name at 255 bytes; 100 CJK characters
// are about 300. Leave room for " (20).md".
export const MAX_NAME_BYTES = 230;

// Poly paths use "/" as the separator, and Finder rejects ":" once files
// sync to the desktop app, so both go along with the other characters that
// break on some platform. Long titles are cut at a word boundary.
export function fileNameFor(title: string, kind: PageClip["kind"]): string {
  let base = title
    .replace(/[\\/:*?"<>|#\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (!base) base = "Untitled clip";
  if (kind === "selection") base = `Selection from ${base}`;
  return `${truncate(base)}.md`;
}

// Cuts by grapheme so an emoji or accented letter is never split in half,
// preferring a word boundary when one is close to the limit.
function truncate(base: string): string {
  const bytes = (t: string) => new TextEncoder().encode(t).length;
  if (base.length <= MAX_NAME_CHARS && bytes(base) <= MAX_NAME_BYTES) return base;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(base)].map((g) => g.segment);
  let cut = "";
  for (const g of graphemes) {
    if (cut.length + g.length > MAX_NAME_CHARS || bytes(cut + g) > MAX_NAME_BYTES) break;
    cut += g;
  }
  const space = cut.lastIndexOf(" ");
  return (space > cut.length * 0.6 ? cut.slice(0, space) : cut).replace(/[. ]+$/, "");
}

// "Notes.md" -> "Notes (2).md".
export function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

const WORDS_PER_MINUTE = 230;

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

export function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

// Tags arrive from a free-text input. Commas and newlines separate tags and
// spaces inside one become dashes. Poly accepts color prefixes like
// "red:school", so the colon stays.
export function parseTags(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[,\n]/)) {
    const t = raw.trim().replace(/^#/, "").replace(/\s+/g, "-");
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
