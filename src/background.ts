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
import { PASSED_ON_WORDS, decoyVerdict, judgeDecoy, readHoldings, type Decoy } from "./decoy.js";
import type { DecoyAskedReply, DecoyFirstReply } from "./messages.js";
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
const holdings = new Map<string, { at: number; held: Pick<Decoy, "lamports" | "tokens"> | null }>();

/** The decoy this page is to be shown first, or null: a site that already passed, Lamport's own pages, and any page when it is off. */
async function decoyFor(origin: string, url: string, frameId: number | undefined): Promise<Decoy | null> {
  if (frameId !== 0) return null;
  const s = await settings();
  const web = origin.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!s.decoyFirst || !s.decoyAddress || !web || origin === ARMING_ORIGIN) return null;
  const passed = (await chrome.storage.local.get(PASSED))[PASSED];
  if (passed && typeof passed === "object" && Object.hasOwn(passed as object, await markOf(origin))) return null;
  const kept = holdings.get(s.decoyAddress);
  if (!kept || Date.now() - kept.at > 600_000) holdings.set(s.decoyAddress, { at: Date.now(), held: await readHoldings(s.decoyAddress, s.rpcUrl, plainFetch) });
  return { address: s.decoyAddress, ...(holdings.get(s.decoyAddress)!.held ?? {}) };
}

/** The page asked the decoy to sign `req`. A site that passes is remembered, and is not shown a decoy again. */
async function decoyAsked(req: WireRequest, origin: string, url: string, frameId: number | undefined): Promise<DecoyAskedReply> {
  const decoy = await decoyFor(origin, url, frameId);
  if (!decoy || req.owner !== decoy.address) return { ok: false };
  let finding = PASSED_ON_WORDS;
  if (req.kind === "tx") {
    const bytes = fromBase64(req.bytes);
    let tables = {};
    try { tables = await reader.forMessage(splitTransaction(bytes).messageBytes, (await settings()).rpcUrl); } catch { /* read without them */ }
    finding = judgeDecoy(bytes, decoy, tables);
  }
  if (!finding.caught) {
    const stored = (await chrome.storage.local.get(PASSED))[PASSED];
    const passed: Record<string, string> = stored && typeof stored === "object" ? { ...(stored as Record<string, string>) } : {};
    passed[await markOf(origin)] = new Date().toISOString().slice(0, 10);
    // the newest five hundred: a record of the sites a wallet has used is not something to keep growing
    const keep = Object.entries(passed).sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, 500);
    await chrome.storage.local.set({ [PASSED]: Object.fromEntries(keep) });
  }
  const v = decoyVerdict(finding, decoy);
  return { ok: true, caught: finding.caught, verdict: { level: v.level, sentence: v.sentence, reasons: v.reasons, confirm: undefined } };
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

chrome.runtime.onMessage.addListener((message: ToBackground, sender, sendResponse: (r: JudgeReply | PageAnswer | DecoyFirstReply | DecoyAskedReply) => void) => {
  // only this extension's own content scripts, and the site is the one the browser says the tab is on
  if (sender.id !== chrome.runtime.id || !sender.tab) return false;
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : "");
  if (message?.type === "doors") { if (Array.isArray(message.unguarded)) void noteDoors(message.unguarded.filter((x) => typeof x === "string").slice(0, 8)).catch(() => undefined); return false; }
  if (message?.type === "sentinel") {
    sentinelPage(message.ask, origin, sender.frameId).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "decoy-first") {
    decoyFor(origin, sender.url ?? "", sender.frameId).then((d) => sendResponse({ address: d ? d.address : null }), () => sendResponse({ address: null }));
    return true;
  }
  if (!message || !valid(message.req)) return false;
  if (message.type === "decoy-asked") {
    decoyAsked(message.req, origin, sender.url ?? "", sender.frameId).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
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
