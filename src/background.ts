// The service worker: owns the Poly session, injects the extractor into
// pages, and handles the right-click menu and the quick-save shortcut.

import { Auth, SignInRequired, type Store } from "./auth.ts";
import { MCP_URL, VERSION } from "./config.ts";
import type { Extracted } from "./extract.ts";
import { McpClient, UnauthorizedError } from "./mcp.ts";
import type { Message, PageInfo, Reply, Settings } from "./messages.ts";
import { DEFAULT_FOLDER, normalizeFolder, Poly, type SaveRequest, type SaveResult } from "./poly.ts";

// Tokens live here. Nothing but the extension's own pages and worker should
// read them, including our extractor running inside web pages.
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

const local: Store = {
  async get<T>(key: string) {
    return (await chrome.storage.local.get(key))[key] as T | undefined;
  },
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
  remove: (key) => chrome.storage.local.remove(key),
};

const auth = new Auth({
  store: local,
  redirectUrl: () => chrome.identity.getRedirectURL(),
  launch: (url) =>
    chrome.identity.launchWebAuthFlow({ url, interactive: true }).then((r) => {
      if (!r) throw new Error("Sign-in window closed.");
      return r;
    }),
});

const mcp = new McpClient({
  url: MCP_URL,
  token: () => auth.accessToken(),
  refresh: () => auth.refresh(),
  clientName: "poly-clipper",
  clientVersion: VERSION,
});

const poly = new Poly(async (args) => mcp.callTool("cli", { args }));

const RECENT_FOLDERS = 6;
const RECENT_TAGS = 12;

async function getSettings(): Promise<Settings> {
  const s = (await chrome.storage.sync.get(["folder", "recentFolders", "recentTags"])) as Partial<Settings>;
  return { folder: s.folder || DEFAULT_FOLDER, recentFolders: s.recentFolders ?? [], recentTags: s.recentTags ?? [] };
}

async function remember(req: SaveRequest) {
  const s = await getSettings();
  const folder = normalizeFolder(req.folder);
  const recentFolders = [folder, ...s.recentFolders.filter((f) => f !== folder)].slice(0, RECENT_FOLDERS);
  const tags = "tags" in req ? req.tags : [];
  const recentTags = [...tags, ...s.recentTags.filter((t) => !tags.includes(t))].slice(0, RECENT_TAGS);
  await chrome.storage.sync.set({ folder, recentFolders, recentTags });
}

async function save(req: SaveRequest): Promise<SaveResult> {
  const result = await poly.save(req);
  // The file is already in Poly; failing to remember the folder must not
  // turn that into an error the user would retry (and duplicate).
  await remember(req).catch(() => undefined);
  return result;
}

// Chrome's PDF viewer reports the PDF's content type on the wrapper document,
// which is how a PDF tab is told apart from an HTML page.
async function inspect(tabId: number, frameId = 0): Promise<PageInfo> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? "";
  const title = tab.title ?? url;
  if (!/^https?:/.test(url)) {
    return { kind: "restricted", url, title, reason: "Chrome doesn't let extensions read this page." };
  }
  try {
    const [{ result: type }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.contentType });
    if (type === "application/pdf") return { kind: "pdf", url, title };
    // A selection inside an iframe (embedded docs, some blogs) lives in that
    // frame, so the right-click menu passes its frame through.
    const target = frameId ? { tabId, frameIds: [frameId] } : { tabId };
    await chrome.scripting.executeScript({ target, files: ["extract.js"] });
    const [{ result }] = await chrome.scripting.executeScript({
      target,
      func: () => (globalThis as any).__polyClip() as Extracted,
    });
    if (!result) throw new Error("Nothing came back from the page.");
    return { kind: "page", page: result };
  } catch (e) {
    if (/\.pdf($|\?)/i.test(url)) return { kind: "pdf", url, title };
    return { kind: "restricted", url, title, reason: (e as Error).message };
  }
}

function needsSignIn(e: unknown): boolean {
  return e instanceof SignInRequired || e instanceof UnauthorizedError;
}

function fail(e: unknown): Reply<never> {
  return { ok: false, error: (e as Error)?.message ?? String(e), signIn: needsSignIn(e) };
}

async function handle(msg: Message): Promise<Reply<unknown>> {
  try {
    switch (msg.type) {
      case "status": {
        // Sign-in opens a window, which closes the popup before the result
        // comes back, so a failure is kept and shown on the next open.
        const { signInError } = await chrome.storage.session.get("signInError");
        if (signInError) await chrome.storage.session.remove("signInError");
        return { ok: true, value: { signedIn: await auth.isSignedIn(), settings: await getSettings(), signInError } };
      }
      case "signIn":
        try {
          await auth.signIn();
        } catch (e) {
          await chrome.storage.session.set({ signInError: (e as Error).message });
          throw e;
        } finally {
          mcp.reset();
          poly.reset();
        }
        return { ok: true, value: true };
      case "signOut":
        await auth.signOut();
        mcp.reset();
        poly.reset();
        return { ok: true, value: true };
      case "inspect":
        return { ok: true, value: await inspect(msg.tabId) };
      case "save":
        return { ok: true, value: await save(msg.req) };
      case "folders":
        return { ok: true, value: await poly.listFolders(msg.parent) };
    }
  } catch (e) {
    return fail(e);
  }
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, reply) => {
  handle(msg).then(reply);
  return true;
});

// ---- Right-click menu and shortcut: save with the remembered folder, then
// confirm with a small toast in the page.

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "page", title: "Save page to Poly", contexts: ["page"] });
    chrome.contextMenus.create({ id: "selection", title: "Save selection to Poly", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "image", title: "Save image to Poly", contexts: ["image"] });
    chrome.contextMenus.create({ id: "link", title: "Save link to Poly", contexts: ["link"] });
  });
});

async function quickSave(tab: chrome.tabs.Tab, kind: "shortcut" | "page" | "selection" | "image" | "link", target?: string, frameId = 0) {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  const { folder } = await getSettings();
  try {
    let req: SaveRequest;
    if (kind === "image") {
      if (!target || !/^https?:/.test(target)) throw new Error("This image has no web address Poly can download.");
      req = { kind: "image", src: target, pageUrl: tab.url ?? "", folder, tags: [], note: "" };
    } else if (kind === "link") {
      if (!target || !/^https?:/.test(target)) throw new Error("Only web links can be saved.");
      req = { kind: "link", url: target, folder };
    } else {
      const info = await inspect(tabId, kind === "selection" ? frameId : 0);
      if (info.kind === "restricted") throw new Error(info.reason);
      if (info.kind === "pdf") req = { kind: "pdf", url: info.url, folder, tags: [], note: "" };
      else {
        // The shortcut saves the selection when there is one, which is what
        // people expect right after highlighting a passage.
        if (kind === "selection" && !info.page.selection) throw new Error("The selection was empty.");
        const clip = kind === "page" ? info.page.article : (info.page.selection ?? info.page.article);
        req = { kind: clip.kind, clip, title: clip.title || "Untitled clip", folder, tags: [], note: "" };
      }
    }
    const res = await save(req);
    await notify(tabId, res.warning ?? `Saved to ${res.path.replace(/^\/\/Home\//, "")}`, res.openUrl, Boolean(res.warning));
  } catch (e) {
    await notify(tabId, needsSignIn(e) ? "Connect Poly from the toolbar button first." : (e as Error).message, undefined, true);
  }
}

// Chrome's own pages can't show a toast, so fall back to a badge on the
// toolbar button, with the message as its tooltip.
async function notify(tabId: number, text: string, link: string | undefined, error: boolean) {
  if (await toast(tabId, text, link, error)) return;
  await chrome.action.setBadgeBackgroundColor({ tabId, color: error ? "#dc2626" : "#16a34a" });
  await chrome.action.setBadgeText({ tabId, text: error ? "!" : "✓" });
  await chrome.action.setTitle({ tabId, title: text });
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
    chrome.action.setTitle({ tabId, title: "Save to Poly" }).catch(() => undefined);
  }, 6000);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  const kind = info.menuItemId as "page" | "selection" | "image" | "link";
  quickSave(tab, kind, kind === "image" ? info.srcUrl : kind === "link" ? info.linkUrl : undefined, info.frameId);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "quick-save") return;
  const active = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (active) quickSave(active, "shortcut");
});

async function toast(tabId: number, text: string, link: string | undefined, error: boolean): Promise<boolean> {
  return chrome.scripting
    .executeScript({
      target: { tabId },
      args: [text, link ?? "", error],
      func: (text: string, link: string, error: boolean) => {
        document.getElementById("poly-clipper-toast")?.remove();
        const host = document.createElement("div");
        host.id = "poly-clipper-toast";
        host.style.cssText = "position:fixed;z-index:2147483647;right:20px;bottom:20px;";
        const root = host.attachShadow({ mode: "closed" });
        // Built with DOM calls only: pages that enforce Trusted Types reject
        // innerHTML even inside a shadow root.
        const style = document.createElement("style");
        style.textContent = `
          .t{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f4f4f5;background:#18181b;
            border:1px solid #2e2e33;border-radius:10px;padding:10px 12px;display:flex;gap:10px;align-items:center;
            box-shadow:0 8px 30px rgba(0,0,0,.25);max-width:360px;animation:in .18s ease-out}
          .d{width:8px;height:8px;border-radius:50%;flex:none;background:${error ? "#f87171" : "#4ade80"}}
          a{color:#a5b4fc;text-decoration:none;white-space:nowrap}a:hover{text-decoration:underline}
          @keyframes in{from{opacity:0;transform:translateY(6px)}}`;
        const box = document.createElement("div");
        box.className = "t";
        box.setAttribute("role", "status");
        const dot = document.createElement("span");
        dot.className = "d";
        const msg = document.createElement("span");
        msg.textContent = text;
        box.append(dot, msg);
        if (link) {
          const a = document.createElement("a");
          a.href = link;
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = "Open";
          box.append(a);
        }
        root.append(style, box);
        document.documentElement.append(host);
        setTimeout(() => host.remove(), error ? 6000 : 3500);
      },
    })
    .then(() => true, () => false);
}
