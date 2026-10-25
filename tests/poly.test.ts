import { describe, expect, it } from "vitest";
import type { PageClip } from "../src/markdown.ts";
import { flagValues } from "./flags.ts";
import { findPolyUrl, folderChain, normalizeFolder, parseFolderNames, Poly, PolyError } from "../src/poly.ts";

// A fake of the MCP `cli` tool that keeps a tiny in-memory file tree and
// answers the way the real CLI does: an error result for missing parents and
// for --no-clobber on an existing file.
function fakePoly() {
  const folders = new Set(["//Home"]);
  const files = new Map<string, string>();
  const calls: string[][] = [];
  const parent = (p: string) => p.slice(0, p.lastIndexOf("/"));
  const cli = async (args: string[]) => {
    calls.push(args);
    const [cmd, sub] = args;
    if (cmd === "mkdir") {
      const p = args[1];
      if (folders.has(p)) return { isError: true, text: `Error: ${p} already exists` };
      if (!folders.has(parent(p))) return { isError: true, text: `Error: parent of ${p} not found` };
      folders.add(p);
      return { isError: false, text: "" };
    }
    if (cmd === "file" && sub === "write") {
      const p = args[2];
      if (!folders.has(parent(p))) return { isError: true, text: "Error: parent folder does not exist" };
      if (files.has(p) && args.includes("--no-clobber")) return { isError: true, text: `Error: ${p} already exists` };
      files.set(p, flagValues(args, "--text")[0]);
      return { isError: false, text: "" };
    }
    if (cmd === "file" && sub === "show") return { isError: false, text: JSON.stringify({ url: `https://poly.app/file/${files.size}` }) };
    if (cmd === "file" && sub === "update") {
      flagValues(args, "--tag");
      flagValues(args, "--notes");
      return { isError: false, text: "" };
    }
    if (cmd === "wget" || cmd === "mkurl") return { isError: false, text: "Saved https://poly.app/file/xyz" };
    if (cmd === "ls") return { isError: false, text: JSON.stringify({ entries: [{ name: "Reading", type: "folder" }, { name: "a.md", type: "file" }] }) };
    return { isError: true, text: `unknown command ${cmd}` };
  };
  return { cli, folders, files, calls };
}

const clip: PageClip = { kind: "article", title: "Hello", url: "https://ex.com/a", markdown: "Body", wordCount: 1 };
const now = () => new Date("2026-10-24T20:00:00Z");

describe("folders", () => {
  it("normalizes what people type", () => {
    expect(normalizeFolder("Clippings")).toBe("//Home/Clippings");
    expect(normalizeFolder("/Reading/2026/")).toBe("//Home/Reading/2026");
    expect(normalizeFolder("//shared/team//notes")).toBe("//shared/team/notes");
    expect(normalizeFolder("  ")).toBe("//Home/Clippings");
  });

  it("creates every missing level but never the root", () => {
    expect(folderChain("//Home/Reading/2026")).toEqual(["//Home/Reading", "//Home/Reading/2026"]);
    expect(folderChain("//shared/team/notes")).toEqual(["//shared/team/notes"]);
    expect(folderChain("//Home")).toEqual([]);
  });
});

describe("saving an article", () => {
  it("creates the folder, writes Markdown, then tags it and returns the link", async () => {
    const fake = fakePoly();
    const poly = new Poly(fake.cli, now);
    const res = await poly.save({ kind: "article", clip, title: "Hello", folder: "Reading/Web", tags: ["x"], note: "for later" });
    expect(res).toEqual({ path: "//Home/Reading/Web/Hello.md", openUrl: "https://poly.app/file/1" });
    expect(fake.files.get("//Home/Reading/Web/Hello.md")).toContain("source: https://ex.com/a");
    expect(fake.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["mkdir //Home/Reading", "mkdir //Home/Reading/Web", "file write", "file update", "file show"]);
    expect(fake.calls[3]).toEqual(["file", "update", "//Home/Reading/Web/Hello.md", "--tag=x", "--notes=for later"]);
  });

  it("never overwrites: a second clip of the same page gets a number", async () => {
    const fake = fakePoly();
    const poly = new Poly(fake.cli, now);
    const req = { kind: "article" as const, clip, title: "Hello", folder: "//Home/Clippings", tags: [], note: "" };
    await poly.save(req);
    const second = await poly.save(req);
    expect(second.path).toBe("//Home/Clippings/Hello (2).md");
    expect(fake.files.size).toBe(2);
  });

  it("treats an existing folder as fine and skips update when there is nothing to set", async () => {
    const fake = fakePoly();
    fake.folders.add("//Home/Clippings");
    await new Poly(fake.cli, now).save({ kind: "article", clip, title: "Hello", folder: "//Home/Clippings", tags: [], note: " " });
    expect(fake.calls.some((c) => c[0] === "file" && c[1] === "update")).toBe(false);
  });

  it("surfaces Poly's own error text", async () => {
    const poly = new Poly(async () => ({ isError: true, text: "Error: storage quota exceeded" }), now);
    await expect(poly.save({ kind: "article", clip, title: "Hello", folder: "//Home/X", tags: [], note: "" })).rejects.toThrow(
      new PolyError("Error: storage quota exceeded"),
    );
  });
});

describe("when things go wrong", () => {
  it("a missing parent is not a name clash: it recreates the folder once", async () => {
    const fake = fakePoly();
    const poly = new Poly(fake.cli, now);
    const req = { kind: "article" as const, clip, title: "Hello", folder: "//Home/Gone", tags: [], note: "" };
    await poly.save(req);
    fake.folders.delete("//Home/Gone"); // deleted in Poly while cached here
    const res = await poly.save(req);
    expect(res.path).toBe("//Home/Gone/Hello (2).md");
    // Hello.md (missing parent), Hello.md again (exists), Hello (2).md.
    expect(fake.calls.filter((c) => c[1] === "write")).toHaveLength(4);
  });

  it("a folder that can't be created is an error, not success", async () => {
    const fake = fakePoly();
    const poly = new Poly(fake.cli, now);
    await expect(poly.save({ kind: "article", clip, title: "Hello", folder: "//shared/missing/x", tags: [], note: "" })).rejects.toThrow(/not found/);
  });

  it("forgets cached folders on reset (sign-in as someone else)", async () => {
    const fake = fakePoly();
    const poly = new Poly(fake.cli, now);
    await poly.ensureFolder("//Home/A");
    poly.reset();
    await poly.ensureFolder("//Home/A");
    expect(fake.calls.filter((c) => c[0] === "mkdir")).toHaveLength(2);
  });

  it("returns success with a warning when only the tags fail", async () => {
    const fake = fakePoly();
    const cli = async (args: string[]) => (args[1] === "update" ? { isError: true, text: "Error: tag service down" } : fake.cli(args));
    const res = await new Poly(cli, now).save({ kind: "article", clip, title: "Hello", folder: "//Home/C", tags: ["t"], note: "" });
    expect(res.path).toBe("//Home/C/Hello.md");
    expect(res.warning).toMatch(/tag service down/);
  });

  it("keeps values that start with a dash attached to their flag", async () => {
    const fake = fakePoly();
    const res = await new Poly(fake.cli, now).save({ kind: "article", clip, title: "Hello", folder: "//Home/D", tags: ["-x"], note: "- bullet note" });
    expect(res.warning).toBeUndefined();
    expect(fake.files.get("//Home/D/Hello.md")).toMatch(/^---\n/);
    expect(fake.calls.find((c) => c[1] === "update")).toEqual(["file", "update", "//Home/D/Hello.md", "--tag=-x", "--notes=- bullet note"]);
  });
});

describe("images, PDFs and links", () => {
  it("lets Poly download images and PDFs itself, with tags and the source page in notes", async () => {
    const fake = fakePoly();
    const poly = new Poly(fake.cli, now);
    await poly.save({ kind: "image", src: "https://ex.com/a.jpg", pageUrl: "https://ex.com/page", folder: "//Home/Clippings", tags: ["ref"], note: "" });
    expect(fake.calls.at(-1)).toEqual(["wget", "https://ex.com/a.jpg", "-P", "//Home/Clippings", "--tag=ref", "--notes=Saved from https://ex.com/page"]);
    await poly.save({ kind: "pdf", url: "https://ex.com/p.pdf", folder: "//Home/Clippings", tags: [], note: "" });
    expect(fake.calls.at(-1)).toEqual(["wget", "https://ex.com/p.pdf", "-P", "//Home/Clippings"]);
  });

  it("saves links as Poly bookmark files", async () => {
    const fake = fakePoly();
    const res = await new Poly(fake.cli, now).save({ kind: "link", url: "https://ex.com", folder: "Links" });
    expect(fake.calls.at(-1)).toEqual(["mkurl", "//Home/Links", "https://ex.com"]);
    expect(res.openUrl).toBe("https://poly.app/file/xyz");
  });
});

describe("reading CLI output", () => {
  it("finds folders in JSON listings of different shapes", () => {
    expect(parseFolderNames(JSON.stringify({ entries: [{ name: "B", type: "folder" }, { name: "A", is_dir: true }, { name: "c.md" }] }))).toEqual(["A", "B"]);
    expect(parseFolderNames(JSON.stringify([{ name: "Docs/" }]))).toEqual(["Docs"]);
    expect(parseFolderNames("not json")).toEqual([]);
  });

  it("finds Poly links in output", () => {
    expect(findPolyUrl('{"web_url":"https://poly.app/file/abc123"}')).toBe("https://poly.app/file/abc123");
    expect(findPolyUrl("nothing here")).toBeUndefined();
  });
});
