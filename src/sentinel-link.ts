/**
 * What the Sentinel page and the extension say to each other, and what the extension keeps of it.
 *
 * Sentinel runs on a server, so it cannot tell a payment the owner made from one a thief made with the same
 * key. The owner can let Warden tell it: "this signature came through my browser, and I let it through".
 * For that the Sentinel page hands the extension one token per wallet. The token can do that one thing.
 *
 * Only the Sentinel page is listened to, and only in its top frame. Nothing here decides what is sent or
 * where: that is report.ts, and the address it sends to is fixed in defaults.ts.
 *
 * No engine in this file: the content script on every page imports it.
 */

export interface SentinelLink { token: string; linkedAt: number }

export const LINK_PREFIX = "sentinelLink:";
export const linkKey = (wallet: string): string => `${LINK_PREFIX}${wallet}`;

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function linkFrom(stored: unknown): SentinelLink | undefined {
  const s = stored as Partial<SentinelLink> | null;
  return s && typeof s.token === "string" && TOKEN.test(s.token) && typeof s.linkedAt === "number" ? { token: s.token, linkedAt: s.linkedAt } : undefined;
}

/** What the page may ask. */
export type PageAsk = { type: "hello" } | { type: "link"; wallet: string; token: string } | { type: "unlink"; wallet: string };
/** What it is told. `linked` lists the wallets this browser reports for; a token is never handed back. */
export type PageAnswer =
  | { ok: true; type: "hello"; version: string; reporting: boolean; linked: string[] }
  | { ok: true; type: "link" | "unlink"; wallet: string }
  | { ok: false };

/** Reads a message from the page. Null for anything that is not one of the three asks, exactly. */
export function readPageAsk(data: unknown): PageAsk | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type === "hello") return { type: "hello" };
  if (typeof d.wallet !== "string" || !ADDRESS.test(d.wallet)) return null;
  if (d.type === "unlink") return { type: "unlink", wallet: d.wallet };
  if (d.type === "link" && typeof d.token === "string" && TOKEN.test(d.token)) return { type: "link", wallet: d.wallet, token: d.token };
  return null;
}

/** Whether a message about Sentinel is listened to: the Sentinel page's own address, in the tab's top frame. */
export const fromSentinelPage = (origin: string, frameId: number | undefined, armingOrigin: string): boolean => origin === armingOrigin && frameId === 0;

/** The names the two sides post under: the page asks with one, the extension answers with the other. */
export const PAGE_ASKS = "sentinelAsks";
export const WARDEN_ANSWERS = "wardenSentinel";
