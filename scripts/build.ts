// Bundles the extension into dist/ (release) or dist-e2e/ (pointed at the
// local mock server used by scripts/e2e.ts).
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const e2e = process.argv.includes("--e2e");
const out = e2e ? "dist-e2e" : "dist";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const mcpUrl = e2e ? "http://127.0.0.1:8977/mcp" : "https://mcp.poly.app/mcp";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync("public", out, { recursive: true });

const define = { __MCP_URL__: JSON.stringify(mcpUrl), __VERSION__: JSON.stringify(pkg.version) };
await build({
  entryPoints: { background: "src/background.ts", popup: "src/popup.ts" },
  outdir: out,
  bundle: true,
  format: "esm",
  target: "chrome120",
  define,
  minify: !e2e,
  legalComments: "none",
});
// Injected with chrome.scripting, so it must be a classic script.
await build({
  entryPoints: { extract: "src/page-entry.ts" },
  outdir: out,
  bundle: true,
  format: "iife",
  target: "chrome120",
  define,
  minify: !e2e,
  legalComments: "none",
});

const manifest = {
  manifest_version: 3,
  name: "Poly Clipper",
  short_name: "Poly Clipper",
  version: pkg.version,
  description: "Save articles, highlights, images, links and PDFs to your Poly drive. Unofficial; uses Poly's public MCP server.",
  action: { default_popup: "popup.html", default_title: "Save to Poly", default_icon: { 16: "icons/16.png", 32: "icons/32.png" } },
  icons: { 16: "icons/16.png", 32: "icons/32.png", 48: "icons/48.png", 128: "icons/128.png" },
  background: { service_worker: "background.js", type: "module" },
  permissions: ["activeTab", "scripting", "storage", "identity", "contextMenus"],
  host_permissions: ["https://poly.app/*", "https://mcp.poly.app/*", ...(e2e ? ["http://127.0.0.1:8977/*", "http://127.0.0.1:8978/*"] : [])],
  commands: {
    _execute_action: { suggested_key: { default: "Alt+Shift+S" }, description: "Open the clipper" },
    "quick-save": { suggested_key: { default: "Alt+Shift+D" }, description: "Save this page (or the selection) without opening the clipper" },
  },
  minimum_chrome_version: "120",
};
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
console.log(`built ${out}/ (MCP ${mcpUrl})`);
