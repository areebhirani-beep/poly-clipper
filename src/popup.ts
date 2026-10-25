import { buildDocument, parseTags, readingMinutes, type PageClip } from "./markdown.ts";
import type { Message, PageInfo, Reply, Settings } from "./messages.ts";
import { normalizeFolder, type SaveRequest, type SaveResult } from "./poly.ts";

type Mode = "article" | "selection" | "pdf" | "link";

const PREVIEW_CHARS = 6000;
const RECENT_TAGS_SHOWN = 8;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

class ReplyError extends Error {
  constructor(message: string, readonly signIn = false) {
    super(message);
  }
}

async function send<T>(msg: Message): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(msg)) as Reply<T>;
  if (!reply) throw new ReplyError("The extension restarted. Close and reopen this window.");
  if (!reply.ok) throw new ReplyError(reply.error, reply.signIn);
  return reply.value;
}

const needsSignIn = (e: unknown) => e instanceof ReplyError && e.signIn;

function show(view: "loading" | "signin" | "form" | "done") {
  for (const v of ["loading", "signin", "form", "done"]) $(`view-${v}`).hidden = v !== view;
}

const state = {
  info: undefined as PageInfo | undefined,
  mode: "article" as Mode,
  tags: [] as string[],
  settings: undefined as Settings | undefined,
  saving: false,
};

// Opened as a tab with ?tab=<id> (used by the end-to-end test), the popup
// targets that tab instead of the active one.
async function targetTab(): Promise<number> {
  const param = new URLSearchParams(location.search).get("tab");
  if (param) return Number(param);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab.id!;
}

async function start() {
  if (new URLSearchParams(location.search).has("tab")) document.body.classList.add("tab");
  $("save-kbd").textContent = /Mac/.test(navigator.userAgent) ? "⌘↵" : "Ctrl+↵";
  const status = await send<{ signedIn: boolean; settings: Settings; signInError?: string }>({ type: "status" });
  state.settings = status.settings;
  if (!status.signedIn) return showSignIn(status.signInError);
  $("account").hidden = false;
  state.info = await send<PageInfo>({ type: "inspect", tabId: await targetTab() });
  renderForm();
}

function showSignIn(error?: string) {
  $("account").hidden = true;
  const err = $("signin-error");
  err.hidden = !error;
  err.textContent = error ?? "";
  show("signin");
}

function modesFor(info: PageInfo): { mode: Mode; label: string; enabled: boolean }[] {
  if (info.kind === "pdf") return [{ mode: "pdf", label: "PDF", enabled: true }, { mode: "link", label: "Link", enabled: true }];
  if (info.kind === "restricted") return [{ mode: "link", label: "Link", enabled: /^https?:/.test(info.url) }];
  return [
    { mode: "article", label: "Article", enabled: true },
    { mode: "selection", label: "Selection", enabled: info.page.selection !== null },
    { mode: "link", label: "Link", enabled: true },
  ];
}

function renderForm() {
  const info = state.info!;
  const modes = modesFor(info);
  // Open on the selection when there is one; that's what was just highlighted.
  const preferred = info.kind === "page" && info.page.selection ? "selection" : modes.find((m) => m.enabled)?.mode;
  state.mode = preferred ?? "link";

  const seg = $("modes");
  seg.replaceChildren(
    ...modes.map((m) => {
      const b = document.createElement("button");
      b.type = "button";
      b.role = "tab";
      b.textContent = m.label;
      b.disabled = !m.enabled;
      b.dataset.mode = m.mode;
      b.addEventListener("click", () => setMode(m.mode));
      return b;
    }),
  );

  const folder = $<HTMLInputElement>("folder");
  folder.value = state.settings!.folder;
  renderChips("recent-folders", state.settings!.recentFolders.filter((f) => f !== folder.value), (f) => (folder.value = f));
  renderTags();

  if (info.kind === "page") {
    $<HTMLInputElement>("title").value = info.page.article.title || "Untitled clip";
    const img = $<HTMLImageElement>("thumb");
    if (info.page.article.leadImage) {
      img.src = info.page.article.leadImage;
      img.onerror = () => (img.hidden = true);
      img.hidden = false;
    }
  } else {
    $<HTMLInputElement>("title").value = info.title;
  }
  setMode(state.mode);
  show("form");
  $<HTMLButtonElement>("save").disabled = !modes.some((m) => m.enabled);
}

function setMode(mode: Mode) {
  state.mode = mode;
  for (const b of $("modes").querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.mode === mode));
  const info = state.info!;
  const clip = currentClip();
  const meta: string[] = [];
  let notice = "";

  if (info.kind === "page") {
    const a = info.page.article;
    if (a.siteName) meta.push(a.siteName);
    if (a.byline && a.byline !== a.siteName) meta.push(a.byline);
    if (clip) meta.push(`${clip.wordCount.toLocaleString()} words`, `${readingMinutes(clip.wordCount)} min`);
    if (mode === "article" && !info.page.readerable) {
      notice = "This page doesn't look like an article, so the clip may include menus or app text. Link saves just the address.";
    }
  } else if (info.kind === "pdf") {
    meta.push(new URL(info.url).hostname.replace(/^www\./, ""), "PDF");
    if (mode === "pdf") notice = "Poly downloads the PDF itself and indexes its text, so it shows up in search.";
  } else {
    notice = info.reason;
  }
  if (mode === "link") notice = "Saves a bookmark file that opens this page. Tags and notes aren't available for links.";

  // Each item stays on one line so "1 min" never splits across lines.
  $("meta").replaceChildren(...meta.map((m) => Object.assign(document.createElement("span"), { textContent: m })));
  const excerpt = info.kind === "page" && mode === "article" ? info.page.article.excerpt : undefined;
  $("excerpt").hidden = !excerpt;
  $("excerpt").textContent = excerpt ?? "";
  $("notice").hidden = !notice;
  $("notice").textContent = notice;
  $("tags-field").hidden = $("recent-tags").hidden = $("note-field").hidden = mode === "link";
  $("title").toggleAttribute("readonly", mode !== "article" && mode !== "selection");
  updatePreview();
}

function currentClip(): PageClip | null {
  const info = state.info;
  if (info?.kind !== "page") return null;
  if (state.mode === "article") return info.page.article;
  if (state.mode === "selection") return info.page.selection;
  return null;
}

function updatePreview() {
  const clip = currentClip();
  $("preview").hidden = !clip;
  if (!clip) return;
  const doc = buildDocument(clip, { title: title(), tags: state.tags, clippedAt: new Date() });
  $("preview-size").textContent = `${(new Blob([doc]).size / 1024).toFixed(1)} KB`;
  $("preview-body").textContent = doc.length > PREVIEW_CHARS ? `${doc.slice(0, PREVIEW_CHARS)}\n\n[preview truncated; the full text is saved]` : doc;
}

function title(): string {
  return $<HTMLInputElement>("title").value.trim() || "Untitled clip";
}

// ---- tags

function renderTags() {
  const box = $("tags");
  const input = $<HTMLInputElement>("tag-input");
  box.replaceChildren(
    ...state.tags.map((t) => {
      const chip = document.createElement("span");
      chip.className = "tag";
      chip.textContent = t;
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.setAttribute("aria-label", `Remove ${t}`);
      x.addEventListener("click", () => {
        state.tags = state.tags.filter((v) => v !== t);
        renderTags();
      });
      chip.append(x);
      return chip;
    }),
    input,
  );
  renderChips("recent-tags", state.settings!.recentTags.filter((t) => !state.tags.includes(t)).slice(0, RECENT_TAGS_SHOWN), addTags);
  updatePreview();
}

function addTags(raw: string) {
  for (const t of parseTags(raw)) if (!state.tags.includes(t)) state.tags.push(t);
  renderTags();
}

function renderChips(id: string, values: string[], pick: (v: string) => void) {
  $(id).replaceChildren(
    ...values.map((v) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = v.replace(/^\/\/Home\//, "");
      b.title = v;
      b.addEventListener("click", () => pick(v));
      return b;
    }),
  );
}

// ---- saving

function request(): SaveRequest {
  const info = state.info!;
  const folder = normalizeFolder($<HTMLInputElement>("folder").value);
  const tags = [...new Set([...state.tags, ...parseTags($<HTMLInputElement>("tag-input").value)])];
  const note = $<HTMLTextAreaElement>("note").value;
  const url = info.kind === "page" ? info.page.article.url : info.url;
  if (state.mode === "link") return { kind: "link", url, folder };
  if (state.mode === "pdf") return { kind: "pdf", url, folder, tags, note };
  return { kind: state.mode, clip: currentClip()!, title: title(), folder, tags, note };
}

async function save() {
  if (state.saving || $("view-form").hidden) return;
  const button = $<HTMLButtonElement>("save");
  const err = $("save-error");
  state.saving = true;
  button.disabled = true;
  $("save-label").textContent = "Saving…";
  err.hidden = true;
  try {
    const res = await send<SaveResult>({ type: "save", req: request() });
    $("done-path").textContent = res.path;
    $("done-warning").hidden = !res.warning;
    $("done-warning").textContent = res.warning ?? "";
    const open = $<HTMLAnchorElement>("done-open");
    open.hidden = !res.openUrl;
    if (res.openUrl) open.href = res.openUrl;
    show("done");
    (res.openUrl ? open : $("done-close")).focus();
  } catch (e) {
    if (needsSignIn(e)) return showSignIn("Your Poly session ended. Connect again to save.");
    err.textContent = (e as Error).message;
    err.hidden = false;
  } finally {
    state.saving = false;
    button.disabled = false;
    $("save-label").textContent = "Save to Poly";
  }
}

// ---- events

$("save").addEventListener("click", save);
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    save();
  }
});
$("title").addEventListener("input", updatePreview);
$("tag-input").addEventListener("keydown", (e) => {
  const input = e.target as HTMLInputElement;
  if ((e.key === "Enter" || e.key === ",") && !e.metaKey && !e.ctrlKey && input.value.trim()) {
    e.preventDefault();
    addTags(input.value);
    input.value = "";
  } else if (e.key === "Backspace" && !input.value && state.tags.length) {
    state.tags.pop();
    renderTags();
  }
});
$("tag-input").addEventListener("blur", (e) => {
  const input = e.target as HTMLInputElement;
  if (input.value.trim()) {
    addTags(input.value);
    input.value = "";
  }
});
$("tags").addEventListener("click", () => $("tag-input").focus());

let foldersLoaded = false;
$("folder").addEventListener("focus", async () => {
  if (foldersLoaded) return;
  foldersLoaded = true;
  try {
    const folders = await send<string[]>({ type: "folders", parent: "//Home" });
    $("folder-options").replaceChildren(
      ...folders.map((f) => Object.assign(document.createElement("option"), { value: f })),
    );
  } catch {
    foldersLoaded = false;
  }
});

$("signin").addEventListener("click", async () => {
  const b = $<HTMLButtonElement>("signin");
  b.disabled = true;
  try {
    await send({ type: "signIn" });
    show("loading");
    await start();
  } catch (e) {
    showSignIn((e as Error).message);
  } finally {
    b.disabled = false;
  }
});
$("account").addEventListener("click", async () => {
  await send({ type: "signOut" });
  showSignIn();
});
$("done-close").addEventListener("click", () => window.close());

start().catch((e) => {
  if (needsSignIn(e)) return showSignIn();
  show("form");
  $("save-error").textContent = (e as Error).message;
  $("save-error").hidden = false;
  $<HTMLButtonElement>("save").disabled = true;
});
