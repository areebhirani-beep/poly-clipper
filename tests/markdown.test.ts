import { describe, expect, it } from "vitest";
import { buildDocument, countWords, fileNameFor, MAX_NAME_BYTES, MAX_NAME_CHARS, normalizeDate, numbered, parseTags, type PageClip } from "../src/markdown.ts";

const clip: PageClip = {
  kind: "article",
  title: "Why Local-First Software Wins",
  url: "https://example.com/post",
  markdown: "Body text.",
  byline: 'Dana "DR" Ruiz',
  siteName: "The Field Notes",
  published: "2026-09-14T08:30:00-05:00",
  wordCount: 2,
};
const at = new Date("2026-10-24T20:00:00Z");

describe("buildDocument", () => {
  it("writes YAML frontmatter that survives quotes and colons", () => {
    const doc = buildDocument(clip, { title: "Local-first: a primer", tags: ["sync", "red:school"], clippedAt: at });
    expect(doc).toBe(
      [
        "---",
        'title: "Local-first: a primer"',
        "source: https://example.com/post",
        'author: "Dana \\"DR\\" Ruiz"',
        'site: "The Field Notes"',
        "published: 2026-09-14",
        "clipped: 2026-10-24T20:00:00.000Z",
        'tags: ["sync", "red:school"]',
        "---",
        "",
        "# Local-first: a primer",
        "",
        "Body text.",
        "",
      ].join("\n"),
    );
  });

  it("does not repeat the title when the body already opens with a heading", () => {
    const doc = buildDocument({ ...clip, markdown: "# Already here\n\nText" }, { title: "T", tags: [], clippedAt: at });
    expect(doc.match(/^# /gm)).toHaveLength(1);
  });

  it("puts a link back to the source under a selection", () => {
    const doc = buildDocument({ ...clip, kind: "selection", markdown: "> quoted" }, { title: "A [draft]", tags: [], clippedAt: at });
    expect(doc.trimEnd().endsWith("Clipped from [A \\[draft\\]](https://example.com/post)")).toBe(true);
    expect(doc).not.toContain("# A");
  });

  it("escapes control characters so the YAML stays valid", () => {
    const doc = buildDocument(clip, { title: "bad\u0007bell\u001b", tags: [], clippedAt: at });
    expect(doc).toContain('title: "bad\\x07bell\\x1b"');
    expect(doc).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });

  it("keeps the publisher's date instead of converting it to UTC", () => {
    expect(normalizeDate("2026-09-14T21:30:00-05:00")).toBe("2026-09-14");
    expect(normalizeDate("2026-01-02")).toBe("2026-01-02");
    expect(normalizeDate("Sep 14, 2026")).toBe("2026-09-14");
  });

  it("drops dates it cannot parse", () => {
    expect(normalizeDate("yesterday-ish")).toBeUndefined();
  });
});

describe("file names", () => {
  it("strips characters that break Poly paths or Finder", () => {
    expect(fileNameFor('React 19: what/why? "Explained"', "article")).toBe("React 19 what why Explained.md");
    expect(fileNameFor("   ", "article")).toBe("Untitled clip.md");
    expect(fileNameFor("...hidden.", "article")).toBe("hidden.md");
  });

  it("marks selections and cuts long titles at a word", () => {
    expect(fileNameFor("Notes", "selection")).toBe("Selection from Notes.md");
    const long = fileNameFor("word ".repeat(60), "article");
    expect(long.length).toBeLessThanOrEqual(MAX_NAME_CHARS + ".md".length);
    expect(long).toMatch(/word\.md$/);
  });

  it("never splits an emoji and keeps CJK names under the byte limit", () => {
    const emoji = fileNameFor("a".repeat(99) + "😀😀", "article");
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    const cjk = fileNameFor("本".repeat(150), "article");
    expect(new TextEncoder().encode(cjk.slice(0, -".md".length)).length).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });

  it("numbers duplicates before the extension", () => {
    expect(numbered("Notes.md", 2)).toBe("Notes (2).md");
  });
});

describe("helpers", () => {
  it("parses tags from free text", () => {
    expect(parseTags("#reading, red:school,  deep work ,reading")).toEqual(["reading", "red:school", "deep-work"]);
  });

  it("counts words in any script", () => {
    expect(countWords("It's a well-known café, 2026.")).toBe(5);
  });
});
