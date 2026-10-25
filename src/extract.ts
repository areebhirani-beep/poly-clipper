// Runs inside the page (injected by the extension) and in tests under jsdom.
// Readability finds the article, Turndown converts it to Markdown.

import { Readability, isProbablyReaderable } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { countWords, type PageClip } from "./markdown.ts";

export interface Extracted {
  article: PageClip;
  selection: PageClip | null;
  // False for pages Readability doesn't think are articles (apps, search
  // results). The popup then suggests saving the link instead.
  readerable: boolean;
}

const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|mc_cid|mc_eid|igshid|ref_src|_hsenc|_hsmi|mkt_tok)$/i;

// Strip analytics parameters so the saved source link is the one you'd share.
export function cleanUrl(href: string): string {
  try {
    const u = new URL(href);
    for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return href;
  }
}

function turndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    hr: "---",
  });
  td.use(gfm);
  td.remove(["script", "style", "noscript", "iframe", "button", "form", "template"]);
  // Images with no usable source (tracking pixels, unloaded lazy images)
  // would otherwise become "![]()" noise.
  td.addRule("dropEmptyImages", {
    filter: (node) => node.nodeName === "IMG" && !(node as HTMLImageElement).getAttribute("src"),
    replacement: () => "",
  });
  return td;
}

// Lazy-loading sites keep the real URL in data attributes until scrolled.
// Promote it, then make every link and image absolute so the Markdown works
// outside the page it came from.
function absolutize(root: Element, base: string) {
  for (const img of root.querySelectorAll("img")) {
    const lazy = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-lazy-src");
    const src = img.getAttribute("src");
    if (lazy && (!src || src.startsWith("data:"))) img.setAttribute("src", lazy);
    const final = img.getAttribute("src");
    const abs = final ? resolve(final, base) : "";
    if (/^https?:/i.test(abs)) img.setAttribute("src", abs);
    else img.removeAttribute("src");
  }
  // Only web and mail links survive. In-page anchors, javascript:, data:
  // and anything else is unwrapped to plain text, so a saved note can never
  // carry a link that runs code.
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href")!.trim();
    const abs = href.startsWith("#") ? "" : resolve(href, base);
    if (/^(https?|mailto):/i.test(abs)) a.setAttribute("href", abs);
    else a.replaceWith(...Array.from(a.childNodes));
  }
}

function resolve(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function meta(doc: Document, ...names: string[]): string | undefined {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
    const v = el?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return undefined;
}

function tidy(md: string): string {
  return md.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").trim();
}

// Returns the selected content as a detached element, or null. Nodes are
// cloned rather than serialized to an HTML string, because pages that enforce
// Trusted Types (GitHub, Google) reject innerHTML assignments.
export function selectionNode(win: Window): Element | null {
  const sel = win.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const box = win.document.createElement("div");
  for (let i = 0; i < sel.rangeCount; i++) box.appendChild(sel.getRangeAt(i).cloneContents());
  return box.textContent?.trim() ? box : null;
}

export function extract(doc: Document, url: string, selection: Element | null = null): Extracted {
  const td = turndown();
  const base = doc.baseURI || url;
  const source = cleanUrl(url);
  const readerable = isProbablyReaderable(doc);
  // The serializer hands back the article element itself instead of an HTML
  // string, for the same Trusted Types reason as above.
  // keepClasses preserves "language-ts" on code blocks, which Turndown needs
  // to label fenced code.
  const parsed = new Readability<Element>(doc.cloneNode(true) as Document, {
    charThreshold: 300,
    keepClasses: true,
    serializer: (el) => el as Element,
  }).parse();

  const title = (parsed?.title || meta(doc, "og:title") || doc.title || "").trim();
  const common = {
    title,
    url: source,
    byline: parsed?.byline?.trim() || meta(doc, "author", "article:author") || undefined,
    siteName: parsed?.siteName?.trim() || meta(doc, "og:site_name") || hostOf(source),
    published: parsed?.publishedTime || meta(doc, "article:published_time", "datePublished", "date") || undefined,
    excerpt: parsed?.excerpt?.trim() || meta(doc, "og:description", "description") || undefined,
    leadImage: (() => {
      const img = meta(doc, "og:image", "twitter:image");
      return img ? resolve(img, base) : undefined;
    })(),
  };

  // Readability always returns its best guess, even on an app page where
  // the guess includes the menus. Trust it only when the page reads like an
  // article or the guess holds real text.
  let html: Element;
  if (parsed?.content && (readerable || (parsed.length ?? 0) > 500)) {
    html = parsed.content;
  } else {
    // Not an article (a dashboard, a search page). Fall back to the main
    // region without the site chrome, so the clip still holds the text.
    html = (doc.querySelector("main, [role=main], article") || doc.body).cloneNode(true) as Element;
    for (const el of html.querySelectorAll("nav, header, footer, aside, [role=navigation], [aria-hidden=true]")) el.remove();
  }
  absolutize(html, base);
  const article: PageClip = {
    ...common,
    kind: "article",
    markdown: tidy(td.turndown(html as HTMLElement)),
    wordCount: countWords(html.textContent || ""),
  };

  let picked: PageClip | null = null;
  if (selection) {
    absolutize(selection, base);
    picked = {
      ...common,
      kind: "selection",
      markdown: tidy(td.turndown(selection as HTMLElement)),
      wordCount: countWords(selection.textContent || ""),
    };
  }
  return { article, selection: picked, readerable };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
