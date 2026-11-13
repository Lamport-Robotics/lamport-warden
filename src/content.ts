/**
 * Isolated world, on every page. Carries a signing request from the page-world script to the background
 * worker and draws the prompt. No engine and no history here; the page cannot run code here.
 */
import { HANDSHAKE, HELLO, channelFor, newSecret, type DoneMessage, type DoorsMessage, type ReplyMessage, type RequestMessage } from "./channel.js";
import { prompt } from "./overlay.js";
import type { JudgeReply, ToBackground, WireRequest, WireVerdict } from "./messages.js";

const secret = newSecret();
const channel = channelFor(secret);
const hand = () => window.dispatchEvent(new CustomEvent(HANDSHAKE, { detail: secret }));
// whichever half loads second finds the other: both run before any script of the page. Once the page-world
// half says it has the secret, a hello is never answered again: the next one could be the page asking.
window.addEventListener(channel.ack, () => window.removeEventListener(HELLO, hand), { once: true });
window.addEventListener(HELLO, hand);
hand();

const UNCHECKED: WireVerdict = { level: "confirm", sentence: "Something went wrong while I was reading this request, so I can't tell you what it does.", reasons: ["the check failed."], confirm: { kind: "acknowledge", expect: "I understand" } };

async function ask(req: WireRequest): Promise<WireVerdict> {
  try {
    const r = (await chrome.runtime.sendMessage({ type: "judge", req } satisfies ToBackground)) as JudgeReply | undefined;
    return r && r.ok ? r.verdict : UNCHECKED;
  } catch {
    return UNCHECKED; // the extension was reloaded or turned off under this page
  }
}

/** Requests the owner let through, waiting to hear whether the wallet signed. */
const approved = new Map<string, WireRequest>();
let queue: Promise<void> = Promise.resolve();

const reply = (m: ReplyMessage) => window.dispatchEvent(new CustomEvent(channel.reply, { detail: JSON.stringify(m) }));

window.addEventListener(channel.request, (e) => {
  let m: RequestMessage;
  try { m = JSON.parse(String((e as CustomEvent).detail)); } catch { return; }
  if (!m || typeof m.id !== "string" || !["tx", "msg", "signin", "opaque"].includes(m.kind) || typeof m.bytes !== "string") return;
  const req: WireRequest = { kind: m.kind, bytes: m.bytes, owner: String(m.owner ?? "") };
  // one prompt at a time, in the order the wallet was asked
  queue = queue.then(async () => {
    let ok = false;
    try {
      const verdict = await ask(req);
      ok = verdict.level === "allow" ? true : await prompt(verdict, location.origin);
      if (ok) { approved.set(m.id, req); if (approved.size > 64) approved.delete(approved.keys().next().value!); }
    } catch (err) {
      console.warn("Lamport Warden could not show its prompt", err);
    }
    reply({ id: m.id, ok });
  });
});

window.addEventListener(channel.done, (e) => {
  let m: DoneMessage;
  try { m = JSON.parse(String((e as CustomEvent).detail)); } catch { return; }
  const req = m && typeof m.id === "string" ? approved.get(m.id) : undefined;
  if (!req) return;
  approved.delete(m.id);
  if (m.signed) void chrome.runtime.sendMessage({ type: "signed", req } satisfies ToBackground).catch(() => undefined);
});

window.addEventListener(channel.doors, (e) => {
  let m: DoorsMessage;
  try { m = JSON.parse(String((e as CustomEvent).detail)); } catch { return; }
  if (!m || !Array.isArray(m.unguarded)) return;
  const unguarded = m.unguarded.filter((x) => typeof x === "string").slice(0, 8);
  if (unguarded.length) void chrome.runtime.sendMessage({ type: "doors", unguarded } satisfies ToBackground).catch(() => undefined);
});
