/** The owner's settings, in chrome.storage.local on this machine. */
import { DEFAULT_RPC } from "./defaults.js";

export interface Settings {
  /** Where lookup tables are read from. Empty: never call out; such transactions are shown as partly unread. */
  rpcUrl: string;
  /** Origins allowed to ask for the Privacy Rings key signature. */
  ringSites: string[];
  /** Simulate transactions that call programs the decoder does not read. Off unless turned on: it shows the RPC the transaction. */
  simulate: boolean;
  /** Tell Sentinel which signatures were the owner's own. Off unless turned on: it is the one thing ever sent to Lamport. */
  reportSigned: boolean;
  /** Decoy first (decoy.ts), an experiment: show a site Warden has not seen a decoy's address before the owner's. Off unless turned on. */
  decoyFirst: boolean;
  /** The decoy: an address that holds something and that the owner has no key to. Empty: there is no decoy, whatever `decoyFirst` says. */
  decoyAddress: string;
}

/** The stored keys settingsFrom() reads. */
export const KEYS = ["rpcUrl", "ringSites", "simulate", "reportSigned", "decoyFirst", "decoyAddress"] as const;

export const DEFAULTS: Settings = { rpcUrl: DEFAULT_RPC, ringSites: [], simulate: false, reportSigned: false, decoyFirst: false, decoyAddress: "" };

/** A Solana address as text: 32 to 44 characters of base58. Empty for anything else. */
export const cleanAddress = (input: unknown): string => (typeof input === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.trim()) ? input.trim() : "");

/** Only https, or http on this machine: the RPC's answer decides what Warden says a transaction does. */
export function cleanRpcUrl(input: string): string | null {
  const s = input.trim();
  if (s === "") return "";
  try {
    const u = new URL(s);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol === "https:" || (u.protocol === "http:" && local)) return u.toString();
  } catch { /* not a URL */ }
  return null;
}

export function cleanOrigin(input: string): string | null {
  try {
    const u = new URL(input.trim().includes("://") ? input.trim() : `https://${input.trim()}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch { return null; }
}

export function settingsFrom(stored: Record<string, unknown>): Settings {
  const rpc = typeof stored.rpcUrl === "string" ? cleanRpcUrl(stored.rpcUrl) : null;
  return {
    rpcUrl: rpc ?? DEFAULTS.rpcUrl,
    ringSites: Array.isArray(stored.ringSites) ? stored.ringSites.filter((x): x is string => typeof x === "string") : [],
    simulate: stored.simulate === true,
    reportSigned: stored.reportSigned === true,
    decoyFirst: stored.decoyFirst === true,
    decoyAddress: cleanAddress(stored.decoyAddress),
  };
}
