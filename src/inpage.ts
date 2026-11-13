/**
 * Page world. Runs at document_start, before the page's own scripts: wraps every Solana wallet the page can
 * reach, and asks the isolated-world half before a signing call goes through. No engine and no history here.
 */
import { HANDSHAKE, HELLO, channelFor, toBase64, type Channel, type ReplyMessage } from "./channel.js";
import { WardenRejected, installLegacyHook, installStandardHook, type Guard } from "./intercept.js";

// our own references, taken before the page can replace them
const add = window.addEventListener.bind(window);
const dispatch = window.dispatchEvent.bind(window);
const CE = window.CustomEvent;
const randomId = () => { const b = new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); };

let channel: Channel | null = null;
const waiting = new Map<string, (ok: boolean) => void>();

add(HANDSHAKE, (e) => {
  // this listener was added before any page script ran, so it is first in line: no page listener ever sees a handshake
  e.stopImmediatePropagation();
  if (channel) return; // the first one wins: it came before any page script could run
  const secret = (e as CustomEvent).detail;
  if (typeof secret !== "string" || secret.length < 32) return;
  channel = channelFor(secret);
  dispatch(new CE(channel.ack));
  add(channel.reply, (r) => {
    let m: ReplyMessage;
    try { m = JSON.parse(String((r as CustomEvent).detail)); } catch { return; }
    const resolve = m && typeof m.id === "string" ? waiting.get(m.id) : undefined;
    if (!resolve) return;
    waiting.delete(m.id);
    resolve(m.ok === true);
  });
}, true);
dispatch(new CE(HELLO));

const guard: Guard = async (req) => {
  // without the other half there is nobody to ask: the wallet's own prompt is all the owner gets
  if (!channel) return { done() {} };
  const ch = channel;
  const id = randomId();
  const ok = await new Promise<boolean>((resolve) => {
    waiting.set(id, resolve);
    dispatch(new CE(ch.request, { detail: JSON.stringify({ id, kind: req.kind, bytes: toBase64(req.bytes), owner: req.owner }) }));
  });
  if (!ok) throw new WardenRejected();
  return { done: (signed) => { dispatch(new CE(ch.done, { detail: JSON.stringify({ id, signed }) })); } };
};

installStandardHook(window, guard);
installLegacyHook(window as unknown as Record<string, any>, guard);
