/**
 * Puts Warden in front of a wallet's signing calls. Pure: no DOM beyond the window passed in, so it runs
 * under test in Node.
 *
 * Two ways a page reaches a wallet:
 *   - Wallet Standard: the wallet registers itself through window events. We re-issue those events with a
 *     register() that wraps each wallet first.
 *   - The older injected provider (window.solana, window.phantom.solana, ...), wrapped where we can.
 *
 * A wrapped call asks the guard first. The guard resolves to let the request through and rejects to stop it.
 * After the wallet answers, the guard is told whether a signature came back.
 */

export interface GuardRequest {
  kind: "tx" | "msg";
  /** tx: the serialized transaction as the wallet was given it. msg: the message bytes. */
  bytes: Uint8Array;
  /** The account asked to sign, base58. Empty when the page did not say. */
  owner: string;
}
export interface Ticket { done(signed: boolean): void }
export type Guard = (req: GuardRequest) => Promise<Ticket>;

export class WardenRejected extends Error {
  constructor(message = "Blocked by Lamport Warden") { super(message); this.name = "WardenRejected"; }
}

type AnyFn = (...args: any[]) => any;
interface StandardWallet { features: Record<string, any>; [k: string]: any }

const SIGN_TX = "solana:signTransaction";
const SIGN_SEND = "solana:signAndSendTransaction";
const SIGN_MSG = "solana:signMessage";

async function guarded<T>(guard: Guard, reqs: GuardRequest[], call: () => Promise<T>): Promise<T> {
  const tickets: Ticket[] = [];
  try {
    for (const r of reqs) tickets.push(await guard(r)); // one at a time: the owner reads one request at a time
  } catch (e) {
    for (const t of tickets) t.done(false);
    throw e;
  }
  try {
    const out = await call();
    for (const t of tickets) t.done(true);
    return out;
  } catch (e) {
    for (const t of tickets) t.done(false);
    throw e;
  }
}

const wrapped = new WeakMap<object, object>();
const isWrapped = new WeakSet<object>();

/** A Wallet Standard wallet whose Solana signing features ask the guard first. Everything else is the wallet's own. */
export function wrapStandardWallet<W extends StandardWallet>(wallet: W, guard: Guard): W {
  if (!wallet || typeof wallet !== "object" || isWrapped.has(wallet)) return wallet;
  const seen = wrapped.get(wallet);
  if (seen) return seen as W;
  const featureCache = new WeakMap<object, object>();
  const wrapFeature = (name: string, feature: any): any => {
    if (!feature || typeof feature !== "object") return feature;
    const cached = featureCache.get(feature);
    if (cached) return cached;
    let out = feature;
    if ((name === SIGN_TX || name === SIGN_SEND) && typeof feature[name.slice(7)] === "function") {
      const method = name.slice(7); // signTransaction / signAndSendTransaction
      out = { ...feature, [method]: (...inputs: any[]) => guarded(guard, inputs.map((i) => ({ kind: "tx" as const, bytes: toBytes(i?.transaction), owner: String(i?.account?.address ?? "") })), () => feature[method](...inputs)) };
    } else if (name === SIGN_MSG && typeof feature.signMessage === "function") {
      out = { ...feature, signMessage: (...inputs: any[]) => guarded(guard, inputs.map((i) => ({ kind: "msg" as const, bytes: toBytes(i?.message), owner: String(i?.account?.address ?? "") })), () => feature.signMessage(...inputs)) };
    }
    featureCache.set(feature, out);
    return out;
  };
  const proxy = new Proxy(wallet, {
    get(target, prop) {
      // the wallet's own getters and private fields must see the wallet as `this`, not the proxy
      const value = Reflect.get(target, prop, target);
      if (prop === "features" && value && typeof value === "object") {
        const features = value as Record<string, any>;
        const out: Record<string, any> = {};
        for (const k of Object.keys(features)) out[k] = wrapFeature(k, features[k]);
        return Object.freeze(out);
      }
      return typeof value === "function" ? (value as AnyFn).bind(target) : value;
    },
  });
  wrapped.set(wallet, proxy);
  isWrapped.add(proxy);
  return proxy as W;
}

function toBytes(x: unknown): Uint8Array {
  if (x instanceof Uint8Array) return x;
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (Array.isArray(x)) return Uint8Array.from(x as number[]);
  return new Uint8Array(0);
}

/** The bytes of a transaction object as an injected provider receives it (web3.js Transaction or VersionedTransaction). */
export function serializeForGuard(tx: any): Uint8Array {
  try {
    if (tx instanceof Uint8Array) return tx;
    if (tx && typeof tx.serialize === "function") {
      const versioned = "version" in tx || (tx.message && typeof tx.message.serialize === "function" && !("instructions" in tx));
      return toBytes(versioned ? tx.serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    }
  } catch { /* a transaction that will not serialize is judged as unreadable */ }
  return new Uint8Array(0);
}

/** The older injected provider: signTransaction, signAllTransactions, signAndSendTransaction, signMessage. */
export function wrapLegacyProvider<P extends object>(provider: P, guard: Guard): P {
  if (!provider || typeof provider !== "object" || isWrapped.has(provider)) return provider;
  const seen = wrapped.get(provider);
  if (seen) return seen as P;
  const owner = (t: any) => { try { return String(t.publicKey?.toBase58?.() ?? t.publicKey?.toString?.() ?? ""); } catch { return ""; } };
  const proxy = new Proxy(provider, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const fn = (value as AnyFn).bind(target);
      if (prop === "signTransaction" || prop === "signAndSendTransaction")
        return (tx: any, ...rest: any[]) => guarded(guard, [{ kind: "tx", bytes: serializeForGuard(tx), owner: owner(target) }], () => fn(tx, ...rest));
      if (prop === "signAllTransactions")
        return (txs: any[], ...rest: any[]) => guarded(guard, (txs ?? []).map((tx) => ({ kind: "tx" as const, bytes: serializeForGuard(tx), owner: owner(target) })), () => fn(txs, ...rest));
      if (prop === "signMessage")
        return (message: any, ...rest: any[]) => guarded(guard, [{ kind: "msg", bytes: toBytes(message), owner: owner(target) }], () => fn(message, ...rest));
      return fn;
    },
  });
  wrapped.set(provider, proxy);
  isWrapped.add(proxy);
  return proxy as P;
}

interface HookWindow {
  addEventListener: Window["addEventListener"];
  dispatchEvent: Window["dispatchEvent"];
  CustomEvent: typeof CustomEvent;
}

/**
 * Wallet Standard: a wallet announces itself with "wallet-standard:register-wallet" (detail = a callback that
 * takes the app's register API), and an app announces itself with "wallet-standard:app-ready" (detail = that
 * API). Both events are stopped and issued again with a register() that wraps every wallet. Must be installed
 * before the page's own scripts run.
 */
export function installStandardHook(win: HookWindow, guard: Guard): void {
  const add = win.addEventListener.bind(win);
  const dispatch = win.dispatchEvent.bind(win);
  const ours = new WeakSet<Event>();
  const wrapApi = (api: any) => Object.freeze({ register: (...wallets: any[]) => api.register(...wallets.map((w) => wrapStandardWallet(w, guard))) });
  const reissue = (type: string, detail: unknown) => {
    const ev = new win.CustomEvent(type, { detail, bubbles: false, cancelable: false, composed: false });
    ours.add(ev);
    dispatch(ev);
  };
  add("wallet-standard:app-ready", (e: Event) => {
    if (ours.has(e)) return;
    const api = (e as CustomEvent).detail;
    if (!api || typeof api.register !== "function") return;
    e.stopImmediatePropagation();
    reissue("wallet-standard:app-ready", wrapApi(api));
  }, true);
  add("wallet-standard:register-wallet", (e: Event) => {
    if (ours.has(e)) return;
    const callback = (e as CustomEvent).detail;
    if (typeof callback !== "function") return;
    e.stopImmediatePropagation();
    reissue("wallet-standard:register-wallet", (api: any) => callback(wrapApi(api)));
  }, true);
}

/**
 * Older injected providers. A wallet assigns its provider to a global; the assignment is caught and the
 * wrapped provider is what the page reads back. Best effort: a wallet that defines its global as
 * non-configurable before this runs is left alone.
 */
export function installLegacyHook(win: Record<string, any>, guard: Guard, names: string[] = ["solana", "solflare", "backpack"]): void {
  for (const name of names) {
    try {
      let current = win[name] && typeof win[name] === "object" ? wrapLegacyProvider(win[name], guard) : win[name];
      Object.defineProperty(win, name, {
        configurable: true,
        enumerable: true,
        get: () => current,
        set: (v) => { current = v && typeof v === "object" ? wrapLegacyProvider(v, guard) : v; },
      });
    } catch { /* not ours to redefine */ }
  }
  // window.phantom = { solana, ethereum, ... }
  try {
    const wrapPhantom = (p: any) => {
      if (!p || typeof p !== "object") return p;
      try {
        let inner = p.solana && typeof p.solana === "object" ? wrapLegacyProvider(p.solana, guard) : p.solana;
        Object.defineProperty(p, "solana", { configurable: true, enumerable: true, get: () => inner, set: (v) => { inner = v && typeof v === "object" ? wrapLegacyProvider(v, guard) : v; } });
      } catch { /* frozen: leave it */ }
      return p;
    };
    let phantom = wrapPhantom(win.phantom);
    Object.defineProperty(win, "phantom", { configurable: true, enumerable: true, get: () => phantom, set: (v) => { phantom = wrapPhantom(v); } });
  } catch { /* not ours to redefine */ }
}
