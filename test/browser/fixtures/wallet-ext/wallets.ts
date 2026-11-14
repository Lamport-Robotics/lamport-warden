/**
 * Three stand-in wallets, each put on the page the way the real one does it (read from the shipped Phantom
 * 26.38, Solflare 2.43 and Backpack 0.10 extensions): the same Object.defineProperty calls, the same frozen
 * objects, and registration through the published @wallet-standard/wallet. They sign nothing. Every call that
 * reaches one is recorded in window.__calls, which is how a test knows whether Warden let it through.
 *
 * ?late=1 in the page address makes them arrive 400 ms after the page started, like a wallet whose script is
 * loaded from a tag. ?only=phantom (or solflare, backpack) injects one.
 */
import { registerWallet } from "@wallet-standard/wallet";

const w = window as any;
w.__calls = w.__calls ?? [];
const called = (door: string, method: string) => { w.__calls.push(`${door}.${method}`); };
const ADDRESS = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB"; // fixtures.owner in the tests
const account = Object.freeze({ address: ADDRESS, publicKey: new Uint8Array(32), chains: ["solana:mainnet"], features: [] });
const publicKey = { toBase58: () => ADDRESS, toString: () => ADDRESS };

/** The signing methods of an injected provider, recording under `door`. */
const methods = (door: string) => ({
  signTransaction: async (tx: any) => { called(door, "signTransaction"); return tx; },
  signAllTransactions: async (txs: any[]) => { called(door, "signAllTransactions"); return txs; },
  signAndSendTransaction: async (_tx: any) => { called(door, "signAndSendTransaction"); return { signature: "sig" }; },
  signMessage: async (m: Uint8Array) => { called(door, "signMessage"); return { signature: m }; },
  signIn: async (_input: any) => { called(door, "signIn"); return { address: ADDRESS }; },
  request: async (a: any) => { called(door, `request:${a?.method}`); return "ok"; },
  connect: async () => ({ publicKey }),
});

const features = (door: string) => ({
  "standard:connect": { version: "1.0.0", connect: async () => { called(door, "connect"); return { accounts: [account] }; } },
  "standard:events": { version: "1.0.0", on: () => () => {} },
  "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: async (...inputs: any[]) => { called(door, "signTransaction"); return inputs.map((i) => ({ signedTransaction: i.transaction })); } },
  "solana:signAndSendTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signAndSendTransaction: async (...inputs: any[]) => { called(door, "signAndSendTransaction"); return inputs.map(() => ({ signature: new Uint8Array(64) })); } },
  "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs: any[]) => { called(door, "signMessage"); return inputs.map((i) => ({ signedMessage: i.message, signature: new Uint8Array(64) })); } },
  "solana:signIn": { version: "1.0.0", signIn: async (...inputs: any[]) => { called(door, "signIn"); return inputs.map(() => ({ account, signedMessage: new Uint8Array(1), signature: new Uint8Array(64) })); } },
});

const base = { version: "1.0.0", icon: "data:image/svg+xml;base64,PHN2Zy8+", chains: ["solana:mainnet"] } as const;

function phantom() {
  // the provider: one open object with its methods as own properties, on the window twice
  const provider: any = { isPhantom: true, publicKey, ...methods("solana") };
  Object.defineProperty(window, "solana", { value: provider, writable: false });
  if (!("phantom" in window)) Object.defineProperty(window, "phantom", { value: {}, writable: false });
  Object.defineProperty(w.phantom, "solana", { value: provider, writable: false });
  window.dispatchEvent(new Event("phantom#initialized"));
  // the Wallet Standard wallet: a frozen instance, `features` a getter on the class
  class PhantomWallet {
    readonly version = base.version; readonly name = "FixturePhantom"; readonly icon = base.icon; readonly chains = base.chains;
    #accounts = [account];
    get accounts() { return this.#accounts; }
    get features() { return features("standard:FixturePhantom"); }
    constructor() { Object.freeze(this); }
  }
  registerWallet(new PhantomWallet() as any);
}

function solflare() {
  // the provider: a class instance whose methods are bound own properties, frozen behind a proxy
  class Provider { isSolflare = true; publicKey = publicKey; constructor() { Object.assign(this, methods("solflare")); } }
  const proxy = new Proxy(new Provider(), { deleteProperty: () => true, get: (t: any, k) => t[k] });
  Object.defineProperty(window, "solflare", { value: Object.freeze(proxy), enumerable: true });
  class SolflareWallet {
    readonly version = base.version; readonly name = "FixtureSolflare"; readonly icon = base.icon; readonly chains = base.chains;
    #accounts = [account];
    get accounts() { return this.#accounts; }
    get features() { return features("standard:FixtureSolflare"); }
  }
  registerWallet(new SolflareWallet() as any);
}

function backpack() {
  // a frozen container: its own signing calls forward to the provider under .solana
  const inner: any = { isBackpack: true, publicKey, ...methods("backpack") };
  const box = Object.freeze({ solana: inner, ethereum: Object.freeze({}) });
  const z = new Proxy(box, { get: (t: any, k) => { if (Reflect.has(t, k)) return Reflect.get(t, k); const v = t.solana[k]; return typeof v === "function" ? v.bind(t.solana) : v; } });
  try { Object.defineProperty(window, "backpack", { value: z }); } catch { /* as Backpack does */ }
  registerWallet({ ...base, name: "FixtureBackpack", accounts: [account], features: features("standard:FixtureBackpack") } as any);
}

const params = new URLSearchParams(location.search);
const only = params.get("only");
const inject = () => { for (const [name, f] of [["phantom", phantom], ["solflare", solflare], ["backpack", backpack]] as const) if (!only || only === name) f(); };
if (params.get("none") === "1") { /* a page with Warden and no wallet */ } else if (params.get("late") === "1") setTimeout(inject, 400); else inject();
