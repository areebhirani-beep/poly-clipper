import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { cleanUrl, extract, selectionNode } from "../src/extract.ts";

const html = readFileSync(new URL("./fixtures/article.html", import.meta.url), "utf8");
const URL_ = "https://fieldnotes.example/2026/local-first?utm_source=newsletter&id=7";

function page() {
  return new JSDOM(html, { url: URL_ }).window;
}

describe("extract", () => {
  const { article, selection, readerable } = extract(page().document, URL_);

  it("reads the article metadata", () => {
    expect(readerable).toBe(true);
    expect(selection).toBeNull();
    expect(article).toMatchObject({
      kind: "article",
      title: "Why Local-First Software Wins",
      url: "https://fieldnotes.example/2026/local-first?id=7",
      siteName: "The Field Notes",
      leadImage: "https://fieldnotes.example/img/cover.jpg",
    });
    expect(article.byline).toMatch(/Dana Ruiz/);
    expect(article.published).toMatch(/^2026-09-14/);
  });

  it("converts to clean Markdown with absolute links, real images, tables and fenced code", () => {
    const md = article.markdown;
    expect(md).toContain("## What changed");
    expect(md).toContain("[Ink & Switch essay](https://fieldnotes.example/papers/local-first?utm_source=feed)");
    expect(md).toContain("![Sync diagram](https://fieldnotes.example/img/diagram.png)");
    expect(md).toMatch(/\| Approach \| Offline \| Conflicts \|\n\| -+ \| -+ \| -+ \|/);
    expect(md).toContain("```ts\nconst doc = Automerge.merge(local, remote);");
    expect(md).not.toMatch(/Subscribe|Privacy|data:image/);
    expect(md).not.toMatch(/\n{3,}/);
    expect(article.wordCount).toBeGreaterThan(250);
  });

  it("turns the current selection into its own clip", () => {
    const win = page();
    const paras = win.document.querySelectorAll("article p");
    const range = win.document.createRange();
    range.setStart(paras[2], 0);
    range.setEnd(paras[3], paras[3].childNodes.length);
    win.getSelection()!.addRange(range);
    const sel = selectionNode(win as unknown as Window);
    const out = extract(win.document, URL_, sel);
    expect(out.selection?.kind).toBe("selection");
    expect(out.selection?.markdown).toMatch(/^The idea was laid out in the \[Ink & Switch essay\]\(https:\/\/fieldnotes\.example\/papers/);
    expect(out.selection?.markdown).toContain("A lot has changed since then");
    expect(out.article.kind).toBe("article");
  });

  it("falls back to the main content on pages that aren't articles", () => {
    const win = new JSDOM(
      `<title>Dashboard</title><nav>Menu</nav><main><h2>Orders</h2><p>3 open</p></main><footer>Footer</footer>`,
      { url: "https://app.example/dash" },
    ).window;
    const out = extract(win.document, "https://app.example/dash");
    expect(out.readerable).toBe(false);
    expect(out.article.markdown).toBe("## Orders\n\n3 open");
  });

  it("never keeps links that could run code", () => {
    const win = new JSDOM(
      `<title>T</title><main><p>Text <a href="JavaScript:alert(1)">one</a> <a href="data:text/html,x">two</a> <a href="mailto:a@b.c">mail</a> <a href="#s">anchor</a> and enough words to count.</p></main>`,
      { url: "https://ex.com/p" },
    ).window;
    const md = extract(win.document, "https://ex.com/p").article.markdown;
    expect(md).toBe("Text one two [mail](mailto:a@b.c) anchor and enough words to count.");
  });

  it("strips tracking parameters only", () => {
    expect(cleanUrl("https://a.com/x?utm_medium=e&fbclid=1&q=keep#frag")).toBe("https://a.com/x?q=keep#frag");
  });
});
