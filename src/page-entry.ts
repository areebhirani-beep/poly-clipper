// Bundled to extract.js and injected into the tab on demand.
import { extract, selectionNode } from "./extract.ts";

(globalThis as any).__polyClip = () => extract(document, location.href, selectionNode(window));
