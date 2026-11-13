/**
 * The background worker. Holds the engine, the owner's history (chrome.storage.local, on this machine only)
 * and the one network call (lookup tables). The content script on each page only draws the prompt.
 *
 * It keeps nothing between messages that it could not lose: the browser stops an idle worker after half a
 * minute, and a wallet's own prompt can stay open longer than that.
 */
import "./polyfill.js";
import { fromBase64 } from "./channel.js";
import { judge, recordSigned, type Sources, type Store } from "./judge.js";
import { TableReader } from "./rpc.js";
import { KEYS, settingsFrom } from "./settings.js";
import { Simulator } from "./simulate.js";
import type { JudgeReply, ToBackground, WireRequest } from "./messages.js";
import type { MemoryState } from "../pincer1/daemon/src/warden/index.js";

const store: Store = {
  async load(owner) { const k = `memory:${owner}`; return (await chrome.storage.local.get(k))[k]; },
  async save(owner, state: MemoryState) { await chrome.storage.local.set({ [`memory:${owner}`]: state }); },
  async ringSites() { return (await settings()).ringSites; },
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
};
/** For recording a signed send: the same reading of the request, without asking the RPC to run it again. */
const withoutSimulation: Sources = { tables: sources.tables };

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

chrome.runtime.onMessage.addListener((message: ToBackground, sender, sendResponse: (r: JudgeReply) => void) => {
  // only this extension's own content scripts, and the site is the one the browser says the tab is on
  if (sender.id !== chrome.runtime.id || !sender.tab) return false;
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : "");
  if (message?.type === "doors") { if (Array.isArray(message.unguarded)) void noteDoors(message.unguarded.filter((x) => typeof x === "string").slice(0, 8)).catch(() => undefined); return false; }
  if (!message || !valid(message.req)) return false;
  if (message.type === "judge") {
    judge(decode(message.req), origin, store, sources)
      .then(({ verdict }) => sendResponse({ ok: true, verdict: { level: verdict.level, sentence: verdict.sentence, reasons: verdict.reasons, confirm: verdict.confirm } }))
      .catch((err) => { console.warn("Lamport Warden could not check a request", err); sendResponse({ ok: false }); });
    return true; // the answer comes later
  }
  if (message.type === "signed") {
    // judged again from the bytes: the verdict that let it through may have been made by a worker that is gone
    judge(decode(message.req), origin, store, withoutSimulation)
      .then((judged) => recordSigned(judged, store, Math.floor(Date.now() / 1000)))
      .catch((err) => console.warn("Lamport Warden could not save your history", err));
  }
  return false;
});

chrome.action?.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
