// Replaced at build time by scripts/build.ts. The e2e build points the
// extension at a local mock of Poly's MCP server; the release build uses the
// real one.
declare const __MCP_URL__: string;
declare const __VERSION__: string;

export const MCP_URL = __MCP_URL__;
export const VERSION = __VERSION__;
