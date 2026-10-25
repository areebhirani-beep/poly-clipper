// End-to-end test: loads the built extension (dist-e2e/) into Chromium,
// points it at a local mock of Poly's MCP server, and drives the real popup
// against real pages. Also writes the README screenshots to docs/.
//
//   npm run e2e

import { chromium, type BrowserContext, type Page, type Worker } from "playwright";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockPoly, TOKEN } from "./mock-poly.ts";

const MCP_PORT = 8977;
const SITE_PORT = 8978;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

// ---- pages to clip

const article = readFileSync("tests/fixtures/article.html", "utf8");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#c7d2fe"/><stop offset="1" stop-color="#fbcfe8"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/></svg>`;

function site(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", SITE);
  if (url.pathname === "/2026/local-first") return res.writeHead(200, { "content-type": "text/html" }).end(article);
  if (url.pathname === "/strict") {
    // Same article behind the CSP GitHub and Google use.
    return res.writeHead(200, { "content-type": "text/html", "content-security-policy": "require-trusted-types-for 'script'; trusted-types 'none'" }).end(article);
  }
  if (url.pathname.startsWith("/img/")) return res.writeHead(200, { "content-type": "image/svg+xml" }).end(svg);
  res.writeHead(404).end();
}

// ---- helpers

async function tabIdFor(worker: Worker, url: string): Promise<number> {
  return worker.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)!.id!, url);
}

async function openPopup(ctx: BrowserContext, extId: string, tabId: number): Promise<Page> {
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 428, height: 720 });
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
  return popup;
}

// ---- run

const poly = mockPoly();
const { files, folders, calls } = poly;
await new Promise<void>((ok) => poly.server.listen(MCP_PORT, "127.0.0.1", ok));
const siteServer = createServer(site);
await new Promise<void>((ok) => siteServer.listen(SITE_PORT, "127.0.0.1", ok));
const ext = resolve("dist-e2e");
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "poly-clipper-")), {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
mkdirSync("docs", { recursive: true });

try {
  const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const extId = new URL(worker.url()).host;

  await test("shows the connect screen when signed out", async () => {
    const page = await ctx.newPage();
    await page.goto(`${SITE}/2026/local-first`);
    const popup = await openPopup(ctx, extId, await tabIdFor(worker, page.url()));
    await popup.getByRole("button", { name: "Connect Poly" }).waitFor();
    await popup.screenshot({ path: "docs/signin.png", clip: { x: 0, y: 0, width: 428, height: 300 } });
    await popup.close();
    await page.close();
  });

  // Signing in goes through poly.app, which the test can't do, so it seeds
  // the token the OAuth flow would have stored.
  await worker.evaluate(
    (token) => chrome.storage.local.set({ tokens: { access_token: token, refresh_token: "r", expires_at: Date.now() + 3_600_000 } }),
    TOKEN,
  );

  const page = await ctx.newPage();
  await page.goto(`${SITE}/2026/local-first?utm_source=newsletter`);
  const tabId = await tabIdFor(worker, page.url());

  await test("reads the article into the popup", async () => {
    const popup = await openPopup(ctx, extId, tabId);
    await popup.locator("#view-form").waitFor();
    assert.equal(await popup.locator("#title").inputValue(), "Why Local-First Software Wins");
    assert.match((await popup.locator("#meta span").allInnerTexts()).join(" · "), /^The Field Notes · Dana Ruiz · \d{3} words · \d min$/);
    assert.equal(await popup.locator('#modes [aria-selected="true"]').innerText(), "Article");
    assert.equal(await popup.locator("#folder").inputValue(), "//Home/Clippings");
    await popup.locator("#tag-input").fill("local-first");
    await popup.locator("#tag-input").press("Enter");
    await popup.locator("#tag-input").fill("sync");
    await popup.locator("#tag-input").press("Enter");
    await popup.locator("#note").fill("Read before the sync design review");
    await popup.locator("#preview summary").click();
    await popup.screenshot({ path: "docs/popup.png" });
    await popup.emulateMedia({ colorScheme: "dark" });
    await popup.screenshot({ path: "docs/popup-dark.png" });
    await popup.emulateMedia({ colorScheme: "light" });

    await popup.locator("#folder").fill("Reading/Web");
    await popup.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
    await popup.locator("#view-done").waitFor();
    assert.equal(await popup.locator("#done-path").innerText(), "//Home/Reading/Web/Why Local-First Software Wins.md");
    assert.match((await popup.locator("#done-open").getAttribute("href"))!, /^https:\/\/poly\.app\/file\//);
    await popup.screenshot({ path: "docs/saved.png", clip: { x: 0, y: 0, width: 428, height: 320 } });
    await popup.close();

    const saved = files.get("//Home/Reading/Web/Why Local-First Software Wins.md")!;
    assert.ok(saved, "file exists in Poly");
    assert.match(saved.text, /^---\ntitle: "Why Local-First Software Wins"\nsource: http:\/\/127\.0\.0\.1:8978\/2026\/local-first\n/);
    assert.match(saved.text, /tags: \["local-first", "sync"\]/);
    assert.match(saved.text, /```ts\nconst doc = Automerge\.merge/);
    assert.match(saved.text, /\| Local-first \| Yes \| Merged on device \|/);
    assert.deepEqual(saved.tags, ["local-first", "sync"]);
    assert.equal(saved.notes, "Read before the sync design review");
    assert.ok(folders.has("//Home/Reading/Web"));
  });

  await test("remembers the folder and tags for next time", async () => {
    const popup = await openPopup(ctx, extId, tabId);
    await popup.locator("#view-form").waitFor();
    assert.equal(await popup.locator("#folder").inputValue(), "//Home/Reading/Web");
    assert.match(await popup.locator("#recent-tags").innerText(), /local-first/);
    await popup.close();
  });

  await test("saving the same page again never overwrites", async () => {
    const popup = await openPopup(ctx, extId, tabId);
    await popup.locator("#view-form").waitFor();
    await popup.locator("#save").click();
    await popup.locator("#view-done").waitFor();
    assert.equal(await popup.locator("#done-path").innerText(), "//Home/Reading/Web/Why Local-First Software Wins (2).md");
    await popup.close();
  });

  await test("clips just the highlighted passage", async () => {
    await page.evaluate(() => {
      const p = document.querySelectorAll("article p");
      const r = document.createRange();
      r.setStart(p[2], 0);
      r.setEnd(p[2], p[2].childNodes.length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
    });
    const popup = await openPopup(ctx, extId, tabId);
    await popup.locator("#view-form").waitFor();
    assert.equal(await popup.locator('#modes [aria-selected="true"]').innerText(), "Selection");
    await popup.locator("#save").click();
    await popup.locator("#view-done").waitFor();
    const path = await popup.locator("#done-path").innerText();
    assert.equal(path, "//Home/Reading/Web/Selection from Why Local-First Software Wins.md");
    const text = files.get(path)!.text;
    assert.match(text, /\n\nThe idea was laid out in the \[Ink & Switch essay\]/);
    assert.match(text, /Clipped from \[Why Local-First Software Wins\]\(http:\/\/127\.0\.0\.1:8978\/2026\/local-first\)\n$/);
    assert.doesNotMatch(text, /What changed/);
    await popup.close();
  });

  await test("works on pages that enforce Trusted Types", async () => {
    const strict = await ctx.newPage();
    const errors: string[] = [];
    strict.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await strict.goto(`${SITE}/strict`);
    const popup = await openPopup(ctx, extId, await tabIdFor(worker, strict.url()));
    await popup.locator("#view-form").waitFor();
    assert.equal(await popup.locator("#title").inputValue(), "Why Local-First Software Wins");
    assert.match(await popup.locator("#preview-body").textContent() ?? "", /## What changed/);
    assert.deepEqual(errors.filter((e) => /TrustedHTML|Trusted Type/i.test(e)), []);
    await popup.close();
    await strict.close();
  });

  await test("saves links as bookmarks", async () => {
    const popup = await openPopup(ctx, extId, tabId);
    await popup.locator("#view-form").waitFor();
    await popup.getByRole("tab", { name: "Link" }).click();
    assert.equal(await popup.locator("#tags-field").isHidden(), true);
    await popup.locator("#save").click();
    await popup.locator("#view-done").waitFor();
    assert.deepEqual(calls.at(-1), ["mkurl", "//Home/Reading/Web", "http://127.0.0.1:8978/2026/local-first"]);
    await popup.close();
  });

  await test("lets Poly download an image from its URL", async () => {
    const popup = await openPopup(ctx, extId, tabId);
    const reply = await popup.evaluate(() =>
      chrome.runtime.sendMessage({
        type: "save",
        req: { kind: "image", src: "http://127.0.0.1:8978/img/cover.jpg", pageUrl: "http://127.0.0.1:8978/2026/local-first", folder: "//Home/Clippings", tags: ["ref"], note: "" },
      }),
    );
    assert.equal(reply.ok, true);
    assert.deepEqual(calls.at(-1), ["wget", "http://127.0.0.1:8978/img/cover.jpg", "-P", "//Home/Clippings", "--tag=ref", "--notes=Saved from http://127.0.0.1:8978/2026/local-first"]);
    await popup.close();
  });

  await test("disables saving on pages Chrome won't let extensions read", async () => {
    const blank = await ctx.newPage();
    await blank.goto("about:blank");
    // Chrome hides restricted tabs' URLs from extensions, so take the newest tab.
    const newest = await worker.evaluate(async () => Math.max(...(await chrome.tabs.query({})).map((t) => t.id!)));
    const popup = await openPopup(ctx, extId, newest);
    await popup.locator("#view-form").waitFor();
    assert.equal(await popup.locator("#modes button").count(), 1);
    assert.equal(await popup.locator("#save").isDisabled(), true);
    await popup.close();
    await blank.close();
  });

  await test("a revoked session sends you back to Connect", async () => {
    await worker.evaluate(() =>
      chrome.storage.local.set({ tokens: { access_token: "revoked", expires_at: Date.now() + 3_600_000 } }),
    );
    const popup = await openPopup(ctx, extId, tabId);
    await popup.locator("#view-form").waitFor();
    await popup.locator("#save").click();
    await popup.getByRole("button", { name: "Connect Poly" }).waitFor();
    assert.match(await popup.locator("#signin-error").innerText(), /session ended/);
    await popup.close();
  });

} finally {
  await ctx.close();
  poly.server.close();
  siteServer.close();
}
