/**
 * Isolated world, on every page. Carries a signing request from the page-world script to the background
 * worker and draws the prompt. No engine and no history here; the page cannot run code here.
 */
import { HANDSHAKE, HELLO, channelFor, newSecret, type DoneMessage, type DoorsMessage, type ReplyMessage, type RequestMessage } from "./channel.js";
import { ARMING_ORIGIN } from "./defaults.js";
import { notice, prompt } from "./overlay.js";
import { PAGE_ASKS, WARDEN_ANSWERS, readPageAsk, type PageAnswer } from "./sentinel-link.js";
import type { DecoyAskedReply, DecoyFirstReply, JudgeReply, Noted, ToBackground, WireRequest, WireVerdict } from "./messages.js";

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

/** Decoy first: what this frame knows of it. */
let caughtHere = false;
/** The day this site was caught before, when the worker says it was. */
let caughtBefore: string | null = null;
let showing: { remove(): void } | null = null;
const takeDown = () => { showing?.remove(); showing = null; };
const CAUGHT_BEFORE = (day: string): WireVerdict => ({ level: "confirm", sentence: `This site tried to rob a decoy wallet on ${day}. Go on only if you are sure of this site: your own wallet is then connected to it.`, reasons: ["it was caught asking a decoy for what only a thief asks.", "a thief that was caught once can behave the next time."], confirm: { kind: "acknowledge", expect: "I understand" } });
/** Tells the worker the owner goes on with this site. False when it would not write that down: the site was caught, and the owner has not typed that they understand. */
async function goOn(sure: boolean): Promise<Noted> {
  try { return ((await chrome.runtime.sendMessage({ type: "decoy-passed", sure } satisfies ToBackground)) as Noted | undefined) ?? { noted: false }; } catch { return { noted: false }; }
}
/** The owner pressed "use my wallet here": the decoy comes down and their own wallet is connected in its place. */
async function useMine(): Promise<void> {
  if (caughtHere) return;
  // a site that was caught once is not gone on with at a press, and it may have been caught in another tab since this one was opened
  let sure = false;
  if (caughtBefore !== null) { if (!(await prompt(CAUGHT_BEFORE(caughtBefore), location.origin)) || caughtHere) return; sure = true; }
  let noted = await goOn(sure);
  if (!noted.noted && typeof noted.caughtOn === "string" && !sure) {
    caughtBefore = noted.caughtOn;
    if (!(await prompt(CAUGHT_BEFORE(caughtBefore), location.origin)) || caughtHere) return;
    noted = await goOn(true);
  }
  if (!noted.noted) return; // nothing was written down: the decoy stays where it is
  takeDown();
  window.dispatchEvent(new CustomEvent(channel.own));
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
  // Decoy first (decoy.ts). Whether this page is shown a decoy is the worker's to say; the top frame only.
  if (m.decoy === "first") {
    const none = () => reply({ id: m.id, ok: false });
    if (window.top !== window) { none(); return; }
    // (an extension that was reloaded under this page throws here: the page is then connected as always, and never left waiting)
    try {
      chrome.runtime.sendMessage({ type: "decoy-first" } satisfies ToBackground).then((r: DecoyFirstReply | undefined) => {
        if (!r || typeof r.address !== "string") { none(); return; }
        caughtBefore = typeof r.caughtOn === "string" ? r.caughtOn : null;
        reply({ id: m.id, ok: true, address: r.address });
      }, none);
    } catch { none(); }
    return;
  }
  // A decoy has begun to show on this page, or has stopped. The owner is told while it shows, and can end it.
  if (m.decoy === "showing") {
    if (window.top !== window || caughtHere) return;
    const shown = String(m.owner ?? ""), brief = shown.length > 8 ? `${shown.slice(0, 4)}…${shown.slice(-4)}` : shown;
    takeDown();
    showing = notice({
      warn: caughtBefore !== null,
      text: caughtBefore !== null
        ? `This site tried to rob a decoy wallet on ${caughtBefore}. It is being shown a decoy (${brief}) again, not your wallet.`
        : `This site is being shown a decoy wallet (${brief}), not yours. If it asks the decoy for anything, I will tell you what.`,
      button: "Use my wallet here",
      onPress: () => { void useMine(); },
    });
    return;
  }
  if (m.decoy === "gone") { takeDown(); return; }
  // The page asked the decoy to sign something. The worker says whether that was a robbery; the owner is
  // shown which, and for a site that passed chooses whether to go on with their own wallet.
  if (m.decoy === "asked") {
    queue = queue.then(async () => {
      try {
        // a page that was caught is not asked about again, and its owner is not shown "this one is all right" after "this is a thief"
        if (caughtHere) { reply({ id: m.id, ok: true, caught: true }); return; }
        const more = (Array.isArray(m.more) ? m.more : []).filter((x) => x && ["tx", "msg", "signin", "opaque"].includes(x.kind) && typeof x.bytes === "string").slice(0, 31);
        const reqs: WireRequest[] = [req, ...more.map((x) => ({ kind: x.kind as WireRequest["kind"], bytes: x.bytes, owner: req.owner }))];
        const total = typeof m.total === "number" && m.total > reqs.length ? m.total : reqs.length;
        const r = (await chrome.runtime.sendMessage({ type: "decoy-asked", reqs, total } satisfies ToBackground)) as DecoyAskedReply | undefined;
        if (!r || !r.ok) { reply({ id: m.id, ok: false }); return; }
        if (r.caught) {
          caughtHere = true;
          takeDown();
          if (r.verdict) await prompt(r.verdict, location.origin);
          reply({ id: m.id, ok: true, caught: true });
          return;
        }
        // (no verdict: this site has passed already, in another tab say, and there is nothing more to ask)
        let go = r.verdict ? await prompt(r.verdict, location.origin) : true;
        // only now is the site remembered as one the owner went on with; typed past a warning, that is said too
        if (go && r.verdict) go = (await goOn(r.verdict.level === "confirm")).noted;
        if (go) takeDown();
        reply({ id: m.id, ok: go, caught: false });
      } catch { reply({ id: m.id, ok: false }); }
    });
    return;
  }
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
  const sigs = Array.isArray(m.sigs) ? m.sigs.filter((x) => typeof x === "string" && x.length <= 100).slice(0, 12) : undefined;
  if (m.signed) void chrome.runtime.sendMessage({ type: "signed", req, ...(sigs?.length ? { sigs } : {}) } satisfies ToBackground).catch(() => undefined);
});

window.addEventListener(channel.doors, (e) => {
  let m: DoorsMessage;
  try { m = JSON.parse(String((e as CustomEvent).detail)); } catch { return; }
  if (!m || !Array.isArray(m.unguarded)) return;
  const unguarded = m.unguarded.filter((x) => typeof x === "string").slice(0, 8);
  if (unguarded.length) void chrome.runtime.sendMessage({ type: "doors", unguarded } satisfies ToBackground).catch(() => undefined);
});

// The Sentinel page, and no other, may hand over the token a wallet reports with, and ask which wallets are
// linked. Top frame only. The background worker checks the page's address again: this script only carries.
if (location.origin === ARMING_ORIGIN && window.top === window) {
  const answer = (a: PageAnswer) => window.postMessage({ [WARDEN_ANSWERS]: a }, ARMING_ORIGIN);
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== ARMING_ORIGIN) return;
    const ask = readPageAsk((e.data as Record<string, unknown> | null)?.[PAGE_ASKS]);
    if (!ask) return;
    chrome.runtime.sendMessage({ type: "sentinel", ask } satisfies ToBackground).then((a: PageAnswer | undefined) => answer(a ?? { ok: false }), () => answer({ ok: false }));
  });
}
