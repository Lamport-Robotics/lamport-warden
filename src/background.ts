/**
 * The background worker. Holds the engine, the owner's history (chrome.storage.local, on this machine only)
 * and the one network call (lookup tables). The content script on each page only draws the prompt.
 *
 * It keeps nothing between messages that it could not lose: the browser stops an idle worker after half a
 * minute, and a wallet's own prompt can stay open longer than that.
 */
import "./polyfill.js";
import { fromBase64 } from "./channel.js";
import { judge, recordSigned, type Store } from "./judge.js";
import { TableReader } from "./rpc.js";
import { settingsFrom } from "./settings.js";
import type { JudgeReply, ToBackground, WireRequest } from "./messages.js";
import type { MemoryState } from "../pincer1/daemon/src/warden/index.js";

const store: Store = {
  async load(owner) { const k = `memory:${owner}`; return (await chrome.storage.local.get(k))[k]; },
  async save(owner, state: MemoryState) { await chrome.storage.local.set({ [`memory:${owner}`]: state }); },
  async ringSites() { return settingsFrom(await chrome.storage.local.get(["rpcUrl", "ringSites"])).ringSites; },
};
const reader = new TableReader((url, init) => fetch(url, { ...init, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" }));
const tables = async (messageBytes: Uint8Array) => reader.forMessage(messageBytes, settingsFrom(await chrome.storage.local.get(["rpcUrl", "ringSites"])).rpcUrl);

const valid = (r: any): r is WireRequest => !!r && (r.kind === "tx" || r.kind === "msg" || r.kind === "opaque") && typeof r.bytes === "string" && r.bytes.length < 200_000 && typeof r.owner === "string" && r.owner.length <= 64;
const decode = (r: WireRequest) => ({ kind: r.kind, bytes: fromBase64(r.bytes), owner: r.owner });

chrome.runtime.onMessage.addListener((message: ToBackground, sender, sendResponse: (r: JudgeReply) => void) => {
  // only this extension's own content scripts, and the site is the one the browser says the tab is on
  if (sender.id !== chrome.runtime.id || !sender.tab) return false;
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : "");
  if (!message || !valid(message.req)) return false;
  if (message.type === "judge") {
    judge(decode(message.req), origin, store, tables)
      .then(({ verdict }) => sendResponse({ ok: true, verdict: { level: verdict.level, sentence: verdict.sentence, reasons: verdict.reasons, confirm: verdict.confirm } }))
      .catch((err) => { console.warn("Lamport Warden could not check a request", err); sendResponse({ ok: false }); });
    return true; // the answer comes later
  }
  if (message.type === "signed") {
    // judged again from the bytes: the verdict that let it through may have been made by a worker that is gone
    judge(decode(message.req), origin, store, tables)
      .then((judged) => recordSigned(judged, store, Math.floor(Date.now() / 1000)))
      .catch((err) => console.warn("Lamport Warden could not save your history", err));
  }
  return false;
});

chrome.action?.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
