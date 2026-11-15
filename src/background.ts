/**
 * The background worker. Holds the engine, the owner's history (chrome.storage.local, on this machine only)
 * and the calls to the RPC (lookup tables, and a wallet's rescue setup when the Sentinel page needs it). The content script on each page only draws the prompt.
 *
 * It keeps nothing between messages that it could not lose: the browser stops an idle worker after half a
 * minute, and a wallet's own prompt can stay open longer than that.
 */
import "./polyfill.js";
import { fromBase64 } from "./channel.js";
import { ARMING_ORIGIN } from "./defaults.js";
import { judge, recordSigned, type Judged, type Sources, type Store } from "./judge.js";
import { reportOwnSignature } from "./report.js";
import { LINK_PREFIX, fromSentinelPage, linkFrom, linkKey, readPageAsk, type PageAnswer } from "./sentinel-link.js";
import { TableReader, readAccount } from "./rpc.js";
import { configAddress, vaultOfConfig } from "./sentinel.js";
import { LAMPORT_DECOYS, decoyVerdict, judgeCall, pickDecoy, readHoldings, type AskedOf, type Decoy } from "./decoy.js";
import type { DecoyAskedReply, DecoyFirstReply, Noted } from "./messages.js";
import { KEYS, settingsFrom } from "./settings.js";
import { Simulator } from "./simulate.js";
import type { JudgeReply, ToBackground, WireRequest } from "./messages.js";
import type { MemoryState } from "../pincer1/daemon/src/warden/index.js";
import { splitTransaction } from "../pincer1/daemon/src/tx/parse.js";

const store: Store = {
  async load(owner) { const k = `memory:${owner}`; return (await chrome.storage.local.get(k))[k]; },
  async save(owner, state: MemoryState) { await chrome.storage.local.set({ [`memory:${owner}`]: state }); },
  async ringSites() { return (await settings()).ringSites; },
  async sentinel(owner) { const k = `sentinel:${owner}`; return (await chrome.storage.local.get(k))[k]; },
  async saveSentinel(owner, state) { const k = `sentinel:${owner}`; if (state === null) await chrome.storage.local.remove(k); else await chrome.storage.local.set({ [k]: state }); },
};
const settings = async () => settingsFrom(await chrome.storage.local.get([...KEYS]));
// no cookies, no cache, no referrer: the RPC gets the question and nothing about where it came from
const plainFetch: ConstructorParameters<typeof TableReader>[0] = (url, init) => fetch(url, { ...init, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
const reader = new TableReader(plainFetch);
const simulator = new Simulator(plainFetch);
const sources: Sources = {
  tables: async (messageBytes) => reader.forMessage(messageBytes, (await settings()).rpcUrl),
  simulate: async (txBytes, messageBytes, owner, tables) => {
    const s = await settings();
    // off, or no RPC to ask: nothing is sent, and nothing is said about it
    if (!s.simulate || !s.rpcUrl) return null;
    return simulator.run(txBytes, messageBytes, owner, tables, s.rpcUrl);
  },
  // only for approvals handed over by the Sentinel page when this browser remembers no setup (judge.ts)
  sentinelVault: async (owner) => {
    const { rpcUrl } = await settings();
    if (!rpcUrl) return null;
    return vaultOfConfig(await readAccount(configAddress(owner), rpcUrl, plainFetch), owner);
  },
};
/** For recording a signed send: the same reading of the request, without asking the RPC to run it again. */
const withoutSimulation: Sources = { tables: sources.tables, sentinelVault: sources.sentinelVault };

const valid = (r: any): r is WireRequest => !!r && ["tx", "msg", "signin", "opaque"].includes(r.kind) && typeof r.bytes === "string" && r.bytes.length < 200_000 && typeof r.owner === "string" && r.owner.length <= 64;

/** Doors that could not be guarded, with the day each was last seen: shown on the settings page, written at most once a day each. */
async function noteDoors(names: string[]): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const stored = (await chrome.storage.local.get("unguarded")).unguarded;
  const seen: Record<string, string> = stored && typeof stored === "object" ? { ...(stored as Record<string, string>) } : {};
  let changed = false;
  for (const n of names) if (/^[A-Za-z0-9_.]{1,40}$/.test(n) && seen[n] !== today) { seen[n] = today; changed = true; }
  if (changed) await chrome.storage.local.set({ unguarded: seen });
}
const decode = (r: WireRequest) => ({ kind: r.kind, bytes: fromBase64(r.bytes), owner: r.owner });

/**
 * After a transaction the owner let through came back signed: tell Sentinel it was theirs, if they turned
 * that on and linked this wallet. report.ts decides whether the wallet's answer proves it.
 */
async function tellSentinel(judged: Judged, txBytes: Uint8Array, sigs: string[]): Promise<void> {
  if (judged.kind !== "tx" || !judged.owner || !judged.verdict.parsed || judged.verdict.level === "block" || sigs.length === 0) return;
  let messageBytes: Uint8Array;
  try { messageBytes = splitTransaction(txBytes).messageBytes; } catch { return; }
  await reportOwnSignature({
    enabled: async () => (await settings()).reportSigned,
    link: async (owner) => linkFrom((await chrome.storage.local.get(linkKey(owner)))[linkKey(owner)]),
    fetch: (url, init) => fetch(url, init),
  }, judged.owner, { messageBytes, signers: judged.verdict.parsed.signers }, sigs.map(fromBase64));
}

// ---- decoy first (decoy.ts): an experiment, off unless the owner turned it on and named a decoy

const PASSED = "decoyPassed";
/**
 * A site that passed is kept as a mark worked out from its address and a number made up for this browser,
 * not as the address itself: the list is not something that can be read as a list of sites. (Somebody who
 * had this browser's storage could still test whether a given site is on it.)
 */
async function markOf(origin: string): Promise<string> {
  let salt = (await chrome.storage.local.get("decoySalt")).decoySalt;
  if (typeof salt !== "string" || salt.length < 32) {
    salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
    await chrome.storage.local.set({ decoySalt: salt });
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}\n${origin}`)));
  return Array.from(digest.subarray(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
}
/** What a decoy held when it was last asked about, for ten minutes: the RPC is asked about the decoy, never about the owner. */
const holdings = new Map<string, { at: number; held: Promise<Pick<Decoy, "lamports" | "tokens"> | null> }>();
function heldBy(address: string, rpcUrl: string): Promise<Pick<Decoy, "lamports" | "tokens"> | null> {
  const kept = holdings.get(address);
  if (kept && Date.now() - kept.at <= 600_000) return kept.held;
  // (a reading that failed is not kept: the next question asks the RPC again)
  const held = readHoldings(address, rpcUrl, plainFetch).catch(() => null).then((h) => { if (h === null) holdings.delete(address); return h; });
  holdings.set(address, { at: Date.now(), held });
  return held;
}

/** Sites that were caught asking a decoy for what only a thief asks: kept like the ones that passed, as marks with the day. */
const CAUGHT_SITES = "decoyCaught";
async function marks(list: string): Promise<Record<string, string>> {
  const stored = (await chrome.storage.local.get(list))[list];
  return stored && typeof stored === "object" ? { ...(stored as Record<string, string>) } : {};
}
/** Adds a site's mark to a list, with today's date. The newest five hundred: a record of sites is not something to keep growing. */
async function keep(list: string, mark: string): Promise<void> {
  const all = await marks(list);
  all[mark] = new Date().toISOString().slice(0, 10);
  const newest = Object.entries(all).sort((x, y) => (x[1] < y[1] ? 1 : -1)).slice(0, 500);
  await chrome.storage.local.set({ [list]: Object.fromEntries(newest) });
}

/**
 * Where a page stands with the decoy. "none": it is not shown one (the experiment is off, there is no decoy,
 * it is not a web page's top frame, or it is Lamport's own). "passed": the owner has gone on with their own
 * wallet on this site before. "decoy": it is shown this one; `caughtOn` is the day it was caught, if it was.
 */
type Standing = { kind: "none" } | { kind: "passed" } | { kind: "decoy"; address: string; mark: string; caughtOn: string | null; rpcUrl: string };
async function standing(origin: string, frameId: number | undefined): Promise<Standing> {
  if (frameId !== 0) return { kind: "none" };
  const s = await settings();
  const web = origin.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!s.decoyFirst || !web || origin === ARMING_ORIGIN) return { kind: "none" };
  if (!s.decoyAddress && LAMPORT_DECOYS.length === 0) return { kind: "none" }; // nothing to show: no mark of the site is made either
  const mark = await markOf(origin);
  if (Object.hasOwn(await marks(PASSED), mark)) return { kind: "passed" };
  const address = pickDecoy(s.decoyAddress, LAMPORT_DECOYS, mark);
  if (!address) return { kind: "none" };
  const caught = (await marks(CAUGHT_SITES))[mark];
  return { kind: "decoy", address, mark, caughtOn: typeof caught === "string" ? caught : null, rpcUrl: s.rpcUrl };
}

/** May this page be shown a decoy, and which? Answered at once: what the decoy holds is read meanwhile, for when it is asked for something. */
async function decoyFirst(origin: string, frameId: number | undefined): Promise<DecoyFirstReply> {
  const at = await standing(origin, frameId);
  if (at.kind !== "decoy") return { address: null };
  void heldBy(at.address, at.rpcUrl);
  return { address: at.address, caughtOn: at.caughtOn };
}

/** How many requests of one call are read. A sweep of many accounts shows what it is in its first few. */
const MOST_READ = 16;

/**
 * The page asked the decoy to sign these, in one call. One answer for all of them. Nothing is recorded of a
 * site that passes here: that waits for the owner to choose to go on ("decoy-passed"). A catch is recorded at
 * once, because it does not depend on anybody's choice.
 */
async function decoyAsked(reqs: WireRequest[], total: number, origin: string, frameId: number | undefined): Promise<DecoyAskedReply> {
  const at = await standing(origin, frameId);
  if (at.kind === "none") return { ok: false };
  // the owner has gone on with this site already (in another tab, say): this door follows, with nothing more to ask
  if (at.kind === "passed") return { ok: true, caught: false, verdict: null };
  if (reqs.length === 0 || reqs.some((r) => r.owner !== at.address)) return { ok: false };
  const decoy: Decoy = { address: at.address, ...((await heldBy(at.address, at.rpcUrl)) ?? {}) };
  const asks: AskedOf[] = [];
  for (const req of reqs.slice(0, MOST_READ)) {
    if (req.kind === "tx") {
      const bytes = fromBase64(req.bytes);
      let tables = {};
      try { tables = await reader.forMessage(splitTransaction(bytes).messageBytes, at.rpcUrl); } catch { /* read without them */ }
      asks.push({ kind: "tx", bytes, tables });
    } else asks.push({ kind: req.kind === "opaque" ? "unread" : "words" });
  }
  const beyond = Math.max(total, reqs.length) - asks.length;
  let found = judgeCall(asks, decoy);
  // "More than it holds is a price" is only so of what it holds now. What a decoy holds is kept for ten
  // minutes, and a decoy is somebody's live wallet: a thief that read the balance a moment ago may be
  // asking for all of a balance that has grown since. So it is read again before that is believed.
  if (found.above && !found.caught) {
    holdings.delete(at.address);
    const now = await heldBy(at.address, at.rpcUrl);
    if (now) { decoy.lamports = now.lamports; decoy.tokens = now.tokens; found = judgeCall(asks, decoy); }
  }
  const finding = { ...found, unread: found.unread || beyond > 0 };
  if (finding.caught) await keep(CAUGHT_SITES, at.mark);
  const v = decoyVerdict(finding, decoy, { caughtOn: at.caughtOn, read: asks.length, beyond });
  return { ok: true, caught: finding.caught, verdict: { level: v.level, sentence: v.sentence, reasons: v.reasons, confirm: v.confirm } };
}

/**
 * The owner chose to go on with their own wallet on this site: it is not shown a decoy again. A site that
 * was caught is gone on with only by an owner who typed that they understood (`sure`); otherwise nothing is
 * written, and the answer says why. This is asked afresh each time: a tab that was open before the site was
 * caught in another does not know it was.
 */
async function decoyPassed(sure: boolean, origin: string, frameId: number | undefined): Promise<Noted> {
  const at = await standing(origin, frameId);
  if (at.kind === "passed") return { noted: true };
  if (at.kind !== "decoy") return { noted: false };
  if (at.caughtOn && !sure) return { noted: false, caughtOn: at.caughtOn };
  await keep(PASSED, at.mark);
  return { noted: true };
}

/** The Sentinel page asked something. Only that page's top frame is answered. */
async function sentinelPage(ask: unknown, origin: string, frameId: number | undefined): Promise<PageAnswer> {
  const a = readPageAsk(ask);
  if (!a || !fromSentinelPage(origin, frameId, ARMING_ORIGIN)) return { ok: false };
  if (a.type === "link") { await chrome.storage.local.set({ [linkKey(a.wallet)]: { token: a.token, linkedAt: Math.floor(Date.now() / 1000) } }); return { ok: true, type: "link", wallet: a.wallet }; }
  if (a.type === "unlink") { await chrome.storage.local.remove(linkKey(a.wallet)); return { ok: true, type: "unlink", wallet: a.wallet }; }
  const all = await chrome.storage.local.get(null);
  const linked = Object.keys(all).filter((k) => k.startsWith(LINK_PREFIX) && linkFrom(all[k])).map((k) => k.slice(LINK_PREFIX.length)).sort();
  return { ok: true, type: "hello", version: chrome.runtime.getManifest().version, reporting: settingsFrom(all).reportSigned, linked };
}

chrome.runtime.onMessage.addListener((message: ToBackground, sender, sendResponse: (r: JudgeReply | PageAnswer | DecoyFirstReply | DecoyAskedReply | Noted) => void) => {
  // only this extension's own content scripts, and the site is the one the browser says the tab is on
  if (sender.id !== chrome.runtime.id || !sender.tab) return false;
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : "");
  if (message?.type === "doors") { if (Array.isArray(message.unguarded)) void noteDoors(message.unguarded.filter((x) => typeof x === "string").slice(0, 8)).catch(() => undefined); return false; }
  if (message?.type === "sentinel") {
    sentinelPage(message.ask, origin, sender.frameId).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "decoy-first") {
    decoyFirst(origin, sender.frameId).then(sendResponse, () => sendResponse({ address: null }));
    return true;
  }
  if (message?.type === "decoy-passed") {
    decoyPassed(message.sure === true, origin, sender.frameId).then(sendResponse, () => sendResponse({ noted: false }));
    return true;
  }
  if (message?.type === "decoy-asked") {
    const reqs = Array.isArray(message.reqs) ? message.reqs.filter(valid).slice(0, 32) : [];
    if (!Array.isArray(message.reqs) || reqs.length !== Math.min(message.reqs.length, 32)) { sendResponse({ ok: false }); return false; }
    decoyAsked(reqs, typeof message.total === "number" && message.total > 0 ? Math.floor(message.total) : reqs.length, origin, sender.frameId).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (!message || !valid(message.req)) return false;
  if (message.type === "judge") {
    judge(decode(message.req), origin, store, sources)
      .then(({ verdict }) => sendResponse({ ok: true, verdict: { level: verdict.level, sentence: verdict.sentence, reasons: verdict.reasons, confirm: verdict.confirm } }))
      .catch((err) => { console.warn("Lamport Warden could not check a request", err); sendResponse({ ok: false }); });
    return true; // the answer comes later
  }
  if (message.type === "signed") {
    // judged again from the bytes: the verdict that let it through may have been made by a worker that is gone
    const req = decode(message.req);
    const sigs = Array.isArray(message.sigs) ? message.sigs.filter((x) => typeof x === "string" && x.length <= 100).slice(0, 12) : [];
    judge(req, origin, store, withoutSimulation)
      .then(async (judged) => {
        await recordSigned(judged, store, Math.floor(Date.now() / 1000));
        await tellSentinel(judged, req.bytes, sigs).catch(() => undefined);
      })
      .catch((err) => console.warn("Lamport Warden could not save your history", err));
  }
  return false;
});

chrome.action?.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });

// A new install opens Warden's own settings page, once, with a few words on what it now does and a link to
// the practice page. The page is part of the extension: opening it asks nothing of the network. An update
// opens nothing.
chrome.runtime.onInstalled?.addListener((details) => {
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("options.html?welcome=1") }).catch(() => undefined);
});
