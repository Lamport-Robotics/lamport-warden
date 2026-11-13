/**
 * How the two halves of the extension talk. The page-world script (inpage) wraps the wallets; the
 * isolated-world script (content) holds the engine, the owner's history and the prompt. They share only
 * the DOM, which the page can also touch, so the channel is built to keep the page out of it:
 *
 *   - Both scripts run at document_start, before any script of the page. The content script makes a random
 *     secret and hands it over in a synchronous event. Nothing of the page is running yet to hear it.
 *   - The page-world script acknowledges on a name derived from the secret, and from then on the content
 *     script never repeats the secret, so a page that says hello later learns nothing. The page-world script
 *     also swallows any later handshake event before a page listener could see it.
 *   - Every later event name is derived from that secret. The page cannot listen for or dispatch an event
 *     whose name it does not know.
 *   - Each side keeps its own untouched references to addEventListener and dispatchEvent, taken before the
 *     page could replace them.
 *
 * This keeps a hostile page from approving its own request or teaching Warden to trust an address. It does
 * not make the extension a security boundary: a page can still talk to a wallet in ways Warden never sees.
 */
export const HANDSHAKE = "lamport-warden:handshake";
export const HELLO = "lamport-warden:hello";

export interface Channel {
  /** inpage -> content, once: "the secret arrived". After it the content script stops answering hellos. */
  ack: string;
  /** inpage -> content: {id, kind, bytes (base64), owner} */
  request: string;
  /** content -> inpage: {id, ok} */
  reply: string;
  /** inpage -> content: {id, signed, sigs?} */
  done: string;
  /** inpage -> content: {unguarded}: the wallet doors on this page Warden could not get in front of */
  doors: string;
}

export function channelFor(secret: string): Channel {
  return { ack: `lw:${secret}:a`, request: `lw:${secret}:q`, reply: `lw:${secret}:r`, done: `lw:${secret}:d`, doors: `lw:${secret}:o` };
}

export function newSecret(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export const toBase64 = (b: Uint8Array): string => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
export const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface RequestMessage { id: string; kind: "tx" | "msg" | "signin" | "opaque"; bytes: string; owner: string }
export interface DoorsMessage { unguarded: string[] }
export interface ReplyMessage { id: string; ok: boolean }
/** `sigs`: for a signed transaction, the signatures in the wallet's answer, base64, first one first. */
export interface DoneMessage { id: string; signed: boolean; sigs?: string[] }
