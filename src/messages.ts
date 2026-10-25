import type { Extracted } from "./extract.ts";
import type { SaveRequest } from "./poly.ts";

export type PageInfo =
  | { kind: "page"; page: Extracted }
  | { kind: "pdf"; url: string; title: string }
  | { kind: "restricted"; url: string; title: string; reason: string };

export type Message =
  | { type: "status" }
  | { type: "signIn" }
  | { type: "signOut" }
  | { type: "inspect"; tabId: number }
  | { type: "save"; req: SaveRequest }
  | { type: "folders"; parent: string };

export interface Settings {
  folder: string;
  recentFolders: string[];
  recentTags: string[];
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string; signIn?: boolean };

