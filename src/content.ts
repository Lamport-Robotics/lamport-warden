/**
 * Isolated world. Holds the engine, the owner's history (chrome.storage.local, on this machine only) and the
 * prompt. The page cannot run code here.
 */
import "./polyfill.js";
import { HANDSHAKE, HELLO, channelFor, fromBase64, newSecret, type DoneMessage, type ReplyMessage, type RequestMessage } from "./channel.js";
import { judge, recordSigned, type Judged, type Store } from "./judge.js";
import { prompt } from "./overlay.js";
import type { MemoryState } from "../pincer1/daemon/src/warden/index.js";

const secret = newSecret();
const channel = channelFor(secret);
const hand = () => window.dispatchEvent(new CustomEvent(HANDSHAKE, { detail: secret }));
// whichever half loads second finds the other: both run before any script of the page. Once the page-world
// half says it has the secret, a hello is never answered again: the next one could be the page asking.
window.addEventListener(channel.ack, () => window.removeEventListener(HELLO, hand), { once: true });
window.addEventListener(HELLO, hand);
hand();

const store: Store = {
  async load(owner) { const k = `memory:${owner}`; return (await chrome.storage.local.get(k))[k]; },
  async save(owner, state: MemoryState) { await chrome.storage.local.set({ [`memory:${owner}`]: state }); },
  async ringSites() { const v = (await chrome.storage.local.get("ringSites")).ringSites; return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; },
};

/** Requests the owner let through, waiting to hear whether the wallet signed. */
const approved = new Map<string, Judged>();
let queue: Promise<void> = Promise.resolve();

const reply = (m: ReplyMessage) => window.dispatchEvent(new CustomEvent(channel.reply, { detail: JSON.stringify(m) }));

window.addEventListener(channel.request, (e) => {
  let m: RequestMessage;
  try { m = JSON.parse(String((e as CustomEvent).detail)); } catch { return; }
  if (!m || typeof m.id !== "string" || (m.kind !== "tx" && m.kind !== "msg") || typeof m.bytes !== "string") return;
  // one prompt at a time, in the order the wallet was asked
  queue = queue.then(async () => {
    let ok = false;
    try {
      const judged = await judge({ kind: m.kind, bytes: fromBase64(m.bytes), owner: String(m.owner ?? "") }, location.origin, store);
      ok = judged.verdict.level === "allow" ? true : await prompt(judged.verdict, location.origin);
      if (ok) { approved.set(m.id, judged); if (approved.size > 64) approved.delete(approved.keys().next().value!); }
    } catch (err) {
      console.warn("Lamport Warden could not check a request", err);
      ok = await prompt({ level: "confirm", sentence: "Something went wrong while I was reading this request, so I can't tell you what it does.", reasons: ["the check failed."], confirm: { kind: "acknowledge", expect: "I understand" } }, location.origin).catch(() => false);
    }
    reply({ id: m.id, ok });
  });
});

window.addEventListener(channel.done, (e) => {
  let m: DoneMessage;
  try { m = JSON.parse(String((e as CustomEvent).detail)); } catch { return; }
  const judged = m && typeof m.id === "string" ? approved.get(m.id) : undefined;
  if (!judged) return;
  approved.delete(m.id);
  if (m.signed) void recordSigned(judged, store, Math.floor(Date.now() / 1000)).catch((err) => console.warn("Lamport Warden could not save your history", err));
});
