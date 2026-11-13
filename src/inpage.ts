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
  return { done: (signed, signatures) => { dispatch(new CE(ch.done, { detail: JSON.stringify({ id, signed, ...(signed && signatures?.length ? { sigs: signatures.slice(0, 12).map(toBase64) } : {}) }) })); } };
};

installStandardHook(window, guard);

// Injected providers arrive whenever the wallet's own script runs: at document_start beside this one, or later
// from a script tag. There is no event for it, so the window is looked at again at every moment a page script
// could be about to run or a person could be about to click: while the document is parsed (the observer's
// callback runs before the next parser-inserted script does), on the load events, on every pointer and key
// press before the page's own handlers, and on a slow timer.
const legacy = installLegacyHook(window as unknown as Record<string, any>, guard);
let told = "";
const sweep = () => {
  try { legacy.sweep(); } catch { /* a page that booby-traps its globals only loses the guard on them */ }
  // a door that could not be guarded is not kept quiet: the settings page lists it
  try {
    const unguarded = legacy.unguarded();
    const now = unguarded.join(",");
    if (channel && now !== told) { told = now; if (unguarded.length) dispatch(new CE(channel.doors, { detail: JSON.stringify({ unguarded }) })); }
  } catch { /* nothing to tell */ }
};
try {
  const parsing = new MutationObserver(sweep);
  parsing.observe(document, { childList: true, subtree: true });
  add("load", () => { sweep(); setTimeout(() => parsing.disconnect(), 5000); }, { once: true });
} catch { /* no observer: the events and the timer still run */ }
for (const type of ["phantom#initialized", "DOMContentLoaded", "pointerdown", "keydown", "touchstart", "focus"]) add(type, sweep, true);
let ticks = 0;
const timer = setInterval(() => { sweep(); if (++ticks === 100) { clearInterval(timer); setInterval(sweep, 2000); } }, 100);
(timer as { unref?: () => void }).unref?.(); // under test in Node: do not hold the process open
