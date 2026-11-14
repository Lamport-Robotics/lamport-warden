/**
 * Puts Warden in front of a wallet's signing calls. Pure: no DOM beyond the window passed in, so it runs
 * under test in Node. Everything here was shaped against the real Phantom, Solflare and Backpack extensions
 * (test/browser), not against what a wallet "should" do.
 *
 * Two ways a page reaches a wallet:
 *   - Wallet Standard: the wallet registers itself through window events. Warden listens as one more app,
 *     and replaces the signing features on the wallet's own object.
 *   - The older injected provider (window.solana, window.phantom.solana, window.solflare, window.backpack).
 *     Wallets put these in place with Object.defineProperty, never by assignment, so there is no setter to
 *     catch. The provider's own signing methods are replaced where it stands, which also keeps
 *     `window.solana === window.phantom.solana` true. Nothing is defined on the window ahead of the wallet:
 *     a page that tests `"solana" in window` must get the same answer with Warden as without it.
 *
 * A wrapped call asks the guard first. The guard resolves to let the request through and rejects to stop it.
 * After the wallet answers, the guard is told whether a signature came back.
 */

export interface GuardRequest {
  /**
   * tx: a serialized transaction. msg: the bytes of a message. signin: a Sign In With Solana request, its
   * fields as UTF-8 JSON (the wallet writes the message itself). opaque: a signing request in a form Warden
   * does not read (bytes are empty).
   */
  kind: "tx" | "msg" | "signin" | "opaque";
  bytes: Uint8Array;
  /** The account asked to sign, base58. Empty when the page did not say. */
  owner: string;
}
export interface Ticket {
  /**
   * @param signatures when a transaction was signed: the signatures the wallet's answer carries, in the
   *   transaction's own order (the first is the one the chain knows the transaction by)
   */
  done(signed: boolean, signatures?: Uint8Array[]): void;
}
export type Guard = (req: GuardRequest) => Promise<Ticket>;

export class WardenRejected extends Error {
  code = 4001; // EIP-1193 "user rejected", which Solana wallets and adapters also read
  constructor(message = "Blocked by Lamport Warden") { super(message); this.name = "WardenRejected"; }
}

type AnyFn = (...args: any[]) => any;

/**
 * Decoy first (decoy.ts): a site Warden has not seen is handed a decoy's address when it asks a wallet to
 * connect, and what it then asks the decoy to sign says whether the owner's own wallet should ever meet it.
 * Wallet Standard wallets only, and only one whose list of accounts Warden can stand in front of.
 */
export interface DecoyGate {
  /** Asked once for each wallet, at its first connect on this page: the decoy's address, or null to connect as always. */
  first(): Promise<string | null>;
  /**
   * The site asked the decoy to sign this. Resolves true when that caught it: nothing from this page reaches
   * the wallet again. Resolves false when it passed and the owner chose to go on: their own wallet is then
   * connected. Rejects when the owner chose not to: everything stays as it is.
   */
  asked(req: GuardRequest): Promise<boolean>;
}
/** Where one wallet stands on this page. */
interface DecoyState { phase: "new" | "decoy" | "real" | "caught"; account: { address: string } | null; listeners: Set<AnyFn>; connect: (() => Promise<any>) | null }
/**
 * `front`: puts Warden in front of the wallet's own list of accounts, when it is first needed and not before.
 * A wallet is left exactly as it is until a decoy is in fact about to be shown; false when it will not allow it.
 */
interface DecoyCtx { gate: DecoyGate; state: DecoyState; wallet: any; front: () => boolean }
const decoys = new WeakMap<object, DecoyCtx>();
const CAUGHT = "Blocked by Lamport Warden: this site tried to rob a decoy wallet";
const AGAIN = "Lamport Warden checked this site with a decoy first. Your own wallet is connected now: ask again.";

const SIGN_TX = "solana:signTransaction";
const SIGN_SEND = "solana:signAndSendTransaction";
const SIGN_MSG = "solana:signMessage";
const SIGN_OFFCHAIN = "solana:signOffchainMessage";
const SIGN_IN = "solana:signIn";

/** The fields of a sign-in request that decide what is signed, as bytes. Anything else the wallet adds itself. */
export function signInBytes(input: any): Uint8Array {
  const pick: Record<string, string> = {};
  if (input && typeof input === "object") {
    for (const k of ["domain", "address", "statement", "uri", "chainId"]) if (typeof input[k] === "string") pick[k] = input[k].slice(0, 2000);
  }
  return new TextEncoder().encode(JSON.stringify(pick));
}

async function guarded<T>(guard: Guard, reqs: GuardRequest[], call: () => T | Promise<T>): Promise<T> {
  const tickets: Ticket[] = [];
  try {
    for (const r of reqs) tickets.push(await guard(r)); // one at a time: the owner reads one request at a time
  } catch (e) {
    for (const t of tickets) t.done(false);
    throw e;
  }
  try {
    const out = await call();
    reqs.forEach((r, i) => tickets[i]!.done(true, r.kind === "tx" ? signaturesOf(out, i, reqs.length) : undefined));
    return out;
  } catch (e) {
    for (const t of tickets) t.done(false);
    throw e;
  }
}

function toBytes(x: unknown): Uint8Array {
  if (x instanceof Uint8Array) return x;
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (Array.isArray(x)) return Uint8Array.from(x as number[]);
  // a Uint8Array from another frame or realm, or what JSON made of one
  if (x && typeof x === "object" && typeof (x as any).length === "number") { try { return Uint8Array.from(x as ArrayLike<number>); } catch { /* not bytes */ } }
  return new Uint8Array(0);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 to bytes; null for anything that is not base58. */
export function fromBase58(s: string): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0 || s.length > 8192) return null;
  const out: number[] = [];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < out.length; i++) { carry += out[i]! * 58; out[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { out.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch !== "1") break; out.push(0); }
  return Uint8Array.from(out.reverse());
}

export function toBase58(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) { carry += digits[i]! << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const b of bytes) { if (b !== 0) break; out += "1"; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]!];
  return out;
}

/** The signature slots of a serialized transaction, in order. Empty when the bytes are not one. */
export function signaturesInTransaction(tx: Uint8Array): Uint8Array[] {
  if (tx.length < 66) return [];
  if (tx[0] === 0x81) { // version 1: the signatures follow the message
    const n = tx[1]!;
    if (n === 0 || n > 12 || tx.length <= 64 * n) return [];
    return Array.from({ length: n }, (_, i) => Uint8Array.from(tx.subarray(tx.length - 64 * (n - i), tx.length - 64 * (n - i - 1))));
  }
  const n = tx[0]!;
  if (n === 0 || n > 12 || tx.length < 1 + 64 * n) return [];
  return Array.from({ length: n }, (_, i) => Uint8Array.from(tx.subarray(1 + 64 * i, 65 + 64 * i)));
}

/**
 * What a wallet handed back for one of the transactions it was asked to sign, as signatures. Wallets answer
 * in several shapes: a signed transaction (bytes, or an object that serializes), a signature (bytes, or
 * base58), one per request in an array, or one object for the lot. Anything else gives none: this only ever
 * feeds a check that the owner's own key signed, never a decision.
 */
export function signaturesOf(out: any, index: number, count: number): Uint8Array[] {
  try {
    let item = Array.isArray(out) ? out[index] : out;
    if (!Array.isArray(out) && out && typeof out === "object" && Array.isArray(out.signatures) && typeof out.serialize !== "function") item = out.signatures[index];
    else if (!Array.isArray(out) && count > 1) return [];
    const one = (v: any): Uint8Array[] => {
      if (typeof v === "string") { const b = fromBase58(v); return b && b.length === 64 ? [b] : []; }
      if (v instanceof Uint8Array || ArrayBuffer.isView(v)) { const b = toBytes(v); return b.length === 64 ? [Uint8Array.from(b)] : signaturesInTransaction(b); }
      return [];
    };
    if (!item) return [];
    if (typeof item === "string" || item instanceof Uint8Array || ArrayBuffer.isView(item)) return one(item);
    if (typeof item !== "object") return [];
    if (item.signedTransaction !== undefined) return one(item.signedTransaction);
    if (typeof item.serialize === "function") return signaturesInTransaction(serializeForGuard(item));
    if (item.signature !== undefined) return one(item.signature);
  } catch { /* an answer that cannot be read proves nothing */ }
  return [];
}

/**
 * A wallet's `request` call carries the message of a transaction, not the transaction. This puts empty
 * signature slots around it so it is judged like any other.
 */
export function messageToTransaction(message: Uint8Array): Uint8Array {
  if (message.length < 4) return new Uint8Array(0);
  if (message[0] === 0x81) { // version 1: the signatures follow the message
    const n = message[1]!;
    const out = new Uint8Array(message.length + 64 * n);
    out.set(message, 0);
    return out;
  }
  const n = message[0]! & 0x80 ? message[1]! : message[0]!; // v0 has a version byte before the header
  if (n > 127) return new Uint8Array(0);
  const out = new Uint8Array(1 + 64 * n + message.length);
  out[0] = n;
  out.set(message, 1 + 64 * n);
  return out;
}

/** The bytes of a transaction object as an injected provider receives it (web3.js Transaction or VersionedTransaction). */
export function serializeForGuard(tx: any): Uint8Array {
  try {
    if (tx instanceof Uint8Array || ArrayBuffer.isView(tx)) return toBytes(tx);
    if (tx && typeof tx.serialize === "function") {
      const versioned = "version" in tx || (tx.message && typeof tx.message.serialize === "function" && !("instructions" in tx));
      return toBytes(versioned ? tx.serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    }
  } catch { /* a transaction that will not serialize is judged as unreadable */ }
  return new Uint8Array(0);
}

/** Functions Warden put in place of a wallet's own. */
const ours = new WeakSet<AnyFn>();

// ── a stand-in that looks like the wallet's object and answers like it ──

const wrapped = new WeakMap<object, object>();
const isWrapped = new WeakSet<object>();

/**
 * A proxy over an empty object that forwards everything to `real`, except the properties `override` answers.
 * The empty target matters: Solflare and Backpack freeze their objects, and a proxy over a frozen object may
 * not return anything but the frozen values. Methods run with the real object as `this`, so private fields
 * and bound state keep working.
 */
function standIn<T extends object>(real: T, override: (prop: PropertyKey, value: unknown) => unknown): T {
  const bound = new WeakMap<AnyFn, AnyFn>();
  const read = (prop: PropertyKey): unknown => {
    const value = Reflect.get(real, prop, real);
    const over = override(prop, value);
    if (over !== undefined) return over;
    if (typeof value !== "function") return value;
    let b = bound.get(value as AnyFn);
    if (!b) { b = (value as AnyFn).bind(real); bound.set(value as AnyFn, b!); }
    return b;
  };
  const proxy = new Proxy({} as T, {
    get: (_t, prop) => read(prop),
    set: (_t, prop, v) => Reflect.set(real, prop, v, real),
    has: (_t, prop) => Reflect.has(real, prop),
    deleteProperty: (_t, prop) => Reflect.deleteProperty(real, prop),
    ownKeys: () => Reflect.ownKeys(real),
    getOwnPropertyDescriptor: (_t, prop) => {
      const d = Reflect.getOwnPropertyDescriptor(real, prop);
      if (!d) return undefined;
      // reported as configurable: the empty target has no such property, and a proxy may not say otherwise
      return "value" in d ? { value: read(prop), writable: d.writable, enumerable: d.enumerable, configurable: true } : { get: d.get, set: d.set, enumerable: d.enumerable, configurable: true };
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(real),
    // applied to the real object; a proxy may only confirm a definition its own target could hold
    defineProperty: (_t, prop, d) => { try { Object.defineProperty(real, prop, d); } catch { return false; } return d.configurable === true; },
  });
  wrapped.set(real, proxy);
  isWrapped.add(proxy);
  return proxy;
}

// ── Wallet Standard ──

interface StandardWallet { features: Record<string, any>; [k: string]: any }

const account = (i: any) => String(i?.account?.address ?? "");

/** The decoy as a Wallet Standard account of this wallet: its address, and the chains and features the wallet's own accounts have. */
function decoyAccount(address: string, publicKey: Uint8Array, wallet: any): { address: string } {
  let chains: string[] = [], features: string[] = [];
  try { chains = [...(wallet.chains ?? [])].filter((c: unknown): c is string => typeof c === "string" && c.startsWith("solana:")); } catch { /* none said */ }
  try { features = Object.keys(wallet.features ?? {}).filter((f) => f.startsWith("solana:")); } catch { /* none said */ }
  return Object.freeze({ address, publicKey, chains: Object.freeze(chains.length ? chains : ["solana:mainnet"]), features: Object.freeze(features) });
}

/** Tells everyone who asked to hear of a change which accounts the wallet has now. */
function announce(state: DecoyState, accounts: unknown): void {
  for (const listener of [...state.listeners]) { try { listener({ accounts }); } catch { /* a listener that throws is its own affair */ } }
}

/**
 * A signing call, by way of the decoy when the site is still looking at one. The site that asked the decoy
 * for something is either caught, and gets nothing more; or it passed, the owner's own wallet is connected,
 * and the site is told to ask again, because what it built was built for the decoy.
 */
async function viaDecoy<T>(d: DecoyCtx | undefined, reqs: GuardRequest[], run: () => Promise<T>): Promise<T> {
  if (!d) return run();
  const s = d.state;
  if (s.phase === "caught") throw new WardenRejected(CAUGHT);
  if (s.phase !== "decoy") return run();
  for (const r of reqs) {
    let caught: boolean;
    try { caught = await d.gate.asked({ ...r, owner: s.account!.address }); } catch { throw new WardenRejected(); }
    if (caught) { s.phase = "caught"; throw new WardenRejected(CAUGHT); }
  }
  s.phase = "real";
  try {
    const out = await s.connect?.();
    announce(s, out?.accounts ?? d.wallet.accounts);
  } catch { /* the owner said no to their own wallet: nothing is connected, and the site hears that the request did not go through */ }
  throw new WardenRejected(AGAIN);
}

/** `standard:connect`, answering with the decoy first when the gate says so. */
function decoyConnect(feature: any, d: DecoyCtx): any {
  const original = feature?.connect;
  if (typeof original !== "function" || ours.has(original)) return feature;
  const s = d.state;
  s.connect = () => Promise.resolve(original.call(feature));
  const fn = async (...inputs: any[]) => {
    if (s.phase === "caught") throw new WardenRejected(CAUGHT);
    if (s.phase === "new") {
      let address: string | null = null;
      try { address = await d.gate.first(); } catch { /* nobody to ask: connect as always */ }
      const key = address ? fromBase58(address) : null;
      // (asked twice at once, the first answer stands)
      // A decoy only when the wallet's list of accounts can be answered for too: a site must not see one address from connect and another in the list.
      if (s.phase === "new") { if (address && key && key.length === 32 && d.front()) { s.account = decoyAccount(address, key, d.wallet); s.phase = "decoy"; } else s.phase = "real"; }
    }
    // (read afresh: another call may have moved it on while this one was waiting)
    const phase = s.phase as DecoyState["phase"];
    if (phase === "decoy") return { accounts: [s.account] };
    if (phase === "caught") throw new WardenRejected(CAUGHT);
    return original.apply(feature, inputs);
  };
  ours.add(fn);
  const out = { ...feature, connect: fn };
  return Object.isFrozen(feature) ? Object.freeze(out) : out;
}

/** `standard:events`, remembering who wants to hear of a change of accounts: they are told when the owner's own wallet takes the decoy's place. */
function decoyEvents(feature: any, d: DecoyCtx): any {
  const original = feature?.on;
  if (typeof original !== "function" || ours.has(original)) return feature;
  const fn = (event: string, listener: AnyFn) => {
    const mine = event === "change" && typeof listener === "function";
    if (mine) d.state.listeners.add(listener);
    const off = original.call(feature, event, listener);
    return () => { if (mine) d.state.listeners.delete(listener); try { off?.(); } catch { /* already off */ } };
  };
  ours.add(fn);
  const out = { ...feature, on: fn };
  return Object.isFrozen(feature) ? Object.freeze(out) : out;
}

/** One Solana signing feature with its method asking the guard first; any other feature as it is. */
function guardFeature(name: string, feature: any, guard: Guard, d?: DecoyCtx): any {
  if (!feature || typeof feature !== "object") return feature;
  if (d && name === "standard:connect") return decoyConnect(feature, d);
  if (d && name === "standard:events") return decoyEvents(feature, d);
  const method = name.slice(7); // "solana:signTransaction" -> "signTransaction"
  const original = feature[method];
  if (typeof original !== "function" || ours.has(original)) return feature;
  let fn: AnyFn;
  const tx = (inputs: any[]) => inputs.map((i) => ({ kind: "tx" as const, bytes: toBytes(i?.transaction), owner: account(i) }));
  const msg = (inputs: any[]) => inputs.map((i) => ({ kind: "msg" as const, bytes: toBytes(i?.message), owner: account(i) }));
  // sign-in may be called with no input at all: the wallet then signs in to the site it is on
  const signin = (inputs: any[]) => (inputs.length ? inputs : [undefined]).map((i) => ({ kind: "signin" as const, bytes: signInBytes(i), owner: typeof i?.address === "string" ? i.address : "" }));
  const reqs = name === SIGN_TX || name === SIGN_SEND ? tx : name === SIGN_MSG || name === SIGN_OFFCHAIN ? msg : name === SIGN_IN ? signin : null;
  if (!reqs) return feature;
  fn = (...inputs: any[]) => viaDecoy(d, reqs(inputs), () => guarded(guard, reqs(inputs), () => original.apply(feature, inputs)));
  ours.add(fn);
  const out = { ...feature, [method]: fn };
  return Object.isFrozen(feature) ? Object.freeze(out) : out;
}

/** The wallet's features with the signing ones guarded. The same features object always gives the same answer. */
function guardFeatures(features: any, guard: Guard, cache: WeakMap<object, object>, d?: DecoyCtx): any {
  if (!features || typeof features !== "object") return features;
  const cached = cache.get(features);
  if (cached) return cached;
  const out: Record<string, any> = {};
  for (const k of Object.keys(features)) out[k] = guardFeature(k, features[k], guard, d);
  const done = Object.isFrozen(features) ? Object.freeze(out) : out;
  cache.set(features, done);
  cache.set(done, done); // handed back to us, it is already guarded
  return done;
}

/** A stand-in for a Wallet Standard wallet: used when the wallet's own object cannot be changed. */
export function wrapStandardWallet<W extends StandardWallet>(wallet: W, guard: Guard, gate?: DecoyGate): W {
  if (!wallet || typeof wallet !== "object" || isWrapped.has(wallet)) return wallet;
  const seen = wrapped.get(wallet);
  if (seen) return seen as W;
  const cache = new WeakMap<object, object>();
  // a stand-in answers for everything, the list of accounts included, so the decoy can always go first here
  const d: DecoyCtx | undefined = gate ? { gate, state: { phase: "new", account: null, listeners: new Set(), connect: null }, wallet, front: () => true } : undefined;
  return standIn(wallet, (prop, value) => {
    if (prop === "features" && value && typeof value === "object") return guardFeatures(value, guard, cache, d);
    if (prop === "accounts" && d && d.state.phase === "decoy") return Object.freeze([d.state.account]);
    return undefined;
  });
}

/**
 * Puts Warden in front of a wallet's own list of accounts, so that it can answer with the decoy while the
 * site is looking at one. Done at the moment a decoy is first to be shown, never before: with the experiment
 * off, no wallet's list is touched. False when the wallet's object will not let it: that wallet then never
 * gets a decoy, because a site would see one address from `connect` and another in the list.
 */
function decoyAccountsInPlace(wallet: any, state: DecoyState): boolean {
  try {
    let holder: any = wallet, desc: PropertyDescriptor | undefined;
    for (let depth = 0; holder && holder !== Object.prototype && depth < 8; depth++, holder = Object.getPrototypeOf(holder)) {
      desc = Object.getOwnPropertyDescriptor(holder, "accounts");
      if (desc) break;
    }
    if (!desc) return false;
    const shown = (real: unknown) => (state.phase === "decoy" ? Object.freeze([state.account]) : real);
    if (desc.get) {
      const get = desc.get;
      // a getter on the wallet's class: this one wallet gets its own, in front of it
      if (holder !== wallet && Object.isExtensible(wallet)) Object.defineProperty(wallet, "accounts", { get(this: any) { return shown(get.call(this)); }, set: desc.set, enumerable: desc.enumerable, configurable: true });
      else if (holder === wallet && desc.configurable) Object.defineProperty(wallet, "accounts", { ...desc, get(this: any) { return shown(get.call(this)); } });
      // a frozen wallet (Phantom's is): the getter on its class is the only place left, and answers for each wallet of that class by its own state
      else if (holder !== wallet && desc.configurable) {
        if (!patchedGetters.has(get)) {
          const fronted = function (this: any) { const st = decoys.get(this)?.state; return st && st.phase === "decoy" ? Object.freeze([st.account]) : get.call(this); };
          patchedGetters.add(fronted);
          Object.defineProperty(holder, "accounts", { ...desc, get: fronted });
        }
      } else return false;
      return true;
    }
    // a plain value the wallet writes to: kept, and read through the decoy
    if (holder === wallet && desc.configurable) {
      let real = desc.value;
      Object.defineProperty(wallet, "accounts", { get: () => shown(real), set: (v) => { real = v; }, enumerable: desc.enumerable, configurable: true });
      return true;
    }
    if (holder !== wallet && Object.isExtensible(wallet)) {
      let real: unknown, own = false;
      Object.defineProperty(wallet, "accounts", { get(this: any) { return shown(own ? real : Reflect.get(holder, "accounts", this)); }, set: (v) => { real = v; own = true; }, enumerable: true, configurable: true });
      return true;
    }
    return false;
  } catch { return false; }
}

const patchedWallets = new WeakSet<object>();
const patchedGetters = new WeakSet<AnyFn>();

/**
 * Guards a Wallet Standard wallet where it stands, so the object the page holds is the wallet's own and it does
 * not matter who registered it with whom, or when. Returns false when the wallet's object cannot be changed.
 *
 *   - Phantom: a frozen instance whose `features` is a getter on its class.  The getter is replaced.
 *   - Solflare: an open instance with the same getter.                       It gets an own getter.
 *   - Backpack: `features` is an own, writable property.                     Its value is replaced.
 */
export function patchStandardWalletInPlace(wallet: any, guard: Guard, gate?: DecoyGate): boolean {
  if (!wallet || typeof wallet !== "object") return false;
  if (patchedWallets.has(wallet) || isWrapped.has(wallet)) return true;
  try {
    if (gate && !decoys.has(wallet)) {
      const state: DecoyState = { phase: "new", account: null, listeners: new Set(), connect: null };
      let fronted: boolean | undefined;
      decoys.set(wallet, { gate, state, wallet, front: () => (fronted ??= decoyAccountsInPlace(wallet, state)) });
    }
    let holder: any = wallet;
    let desc: PropertyDescriptor | undefined;
    for (let depth = 0; holder && holder !== Object.prototype && depth < 8; depth++, holder = Object.getPrototypeOf(holder)) {
      desc = Object.getOwnPropertyDescriptor(holder, "features");
      if (desc) break;
    }
    if (!desc) return false;
    const cache = new WeakMap<object, object>();
    if (desc.get) {
      const get = desc.get;
      if (patchedGetters.has(get)) { patchedWallets.add(wallet); return true; } // another instance of a class already done
      const guardedGet = function (this: any) { return guardFeatures(get.call(this), guard, cache, decoys.get(this)); };
      patchedGetters.add(guardedGet);
      if (holder !== wallet && Object.isExtensible(wallet)) Object.defineProperty(wallet, "features", { get: guardedGet, set: desc.set, enumerable: desc.enumerable, configurable: true });
      else if (desc.configurable) Object.defineProperty(holder, "features", { ...desc, get: guardedGet });
      else return false;
    } else if (holder === wallet && (desc.writable || desc.configurable)) {
      Object.defineProperty(wallet, "features", { ...desc, value: guardFeatures(desc.value, guard, cache, decoys.get(wallet)) });
    } else if (holder !== wallet && Object.isExtensible(wallet)) {
      Object.defineProperty(wallet, "features", { value: guardFeatures(desc.value, guard, cache, decoys.get(wallet)), writable: true, enumerable: true, configurable: true });
    } else {
      // a frozen wallet with frozen features: the methods inside may still be open
      const features = desc.value;
      if (!features || typeof features !== "object") return false;
      for (const name of [SIGN_TX, SIGN_SEND, SIGN_MSG, SIGN_OFFCHAIN, SIGN_IN]) {
        const feature = features[name];
        const method = name.slice(7);
        if (!feature || typeof feature[method] !== "function" || ours.has(feature[method])) continue;
        const d = Object.getOwnPropertyDescriptor(feature, method);
        if (!d || !(d.writable || d.configurable)) return false;
        Object.defineProperty(feature, method, { ...d, value: guardFeature(name, feature, guard)[method] });
      }
    }
    patchedWallets.add(wallet);
    return true;
  } catch { return false; }
}

interface HookWindow {
  addEventListener: Window["addEventListener"];
  dispatchEvent: Window["dispatchEvent"];
  CustomEvent: typeof CustomEvent;
  Event?: typeof Event;
}

export interface StandardHook {
  /** How many wallets Warden has seen register, and how many of those it could only guard with a stand-in. */
  seen(): { wallets: number; standIns: number };
}

/**
 * Wallet Standard. A wallet announces itself with "wallet-standard:register-wallet" (detail = a callback that
 * takes an app's register API) and listens for "wallet-standard:app-ready" (detail = that API). Warden joins as
 * one more app: it hears every wallet, whenever it loads, and guards the wallet's own object in place. Nothing
 * is stopped or replaced, so the page's app gets the same object it would have got.
 *
 * On a window, listeners run in the order they were added, capture or not, and a wallet's script can run
 * before this one. That is why the wallet is changed and not the event.
 *
 * Only a wallet whose object cannot be changed gets the older treatment: its event is stopped and issued
 * again with a register() that hands the app a stand-in. That works when this listener was added before the
 * wallet's, which is the case for a wallet that loads after Warden.
 */
export function installStandardHook(win: HookWindow, guard: Guard, gate?: DecoyGate): StandardHook {
  const add = win.addEventListener.bind(win);
  const dispatch = win.dispatchEvent.bind(win);
  // RegisterWalletEvent and AppReadyEvent override stopImmediatePropagation to throw; the native one still works
  const nativeStop = (win.Event ?? Event).prototype.stopImmediatePropagation;
  const stop = (e: Event) => { try { nativeStop.call(e); } catch { /* cannot be stopped: it goes through as it is */ } };
  const mine = new WeakSet<Event>();
  const all = new Set<object>();
  const stuck = new Set<object>();
  /** Guards what it can in place and remembers the rest. */
  const meet = (...wallets: any[]) => {
    for (const w of wallets) {
      if (!w || typeof w !== "object" || isWrapped.has(w)) continue;
      all.add(w);
      if (patchStandardWalletInPlace(w, guard, gate)) stuck.delete(w); else stuck.add(w);
    }
    return () => {};
  };
  const ourApi = Object.freeze({ register: meet });
  const standInApi = (api: any) => Object.freeze({ register: (...wallets: any[]) => api.register(...wallets.map((w) => (stuck.has(w) ? wrapStandardWallet(w, guard, gate) : w))) });
  const issue = (type: string, detail: unknown) => {
    const ev = new win.CustomEvent(type, { detail, bubbles: false, cancelable: false, composed: false });
    mine.add(ev);
    dispatch(ev);
  };
  // a wallet announcing itself: meet it first, then let the event go on to the apps
  add("wallet-standard:register-wallet", (e: Event) => {
    if (mine.has(e)) return;
    const callback = (e as CustomEvent).detail;
    if (typeof callback !== "function") return;
    const before = stuck.size;
    try { callback(ourApi); } catch { /* a wallet that fails here fails for every app */ }
    if (stuck.size > before) { stop(e); issue("wallet-standard:register-wallet", (api: any) => callback(standInApi(api))); }
  }, true);
  // an app announcing itself: only a wallet we could not change needs the app to be handed a stand-in
  add("wallet-standard:app-ready", (e: Event) => {
    if (mine.has(e) || stuck.size === 0) return;
    const api = (e as CustomEvent).detail;
    if (!api || typeof api.register !== "function") return;
    stop(e);
    issue("wallet-standard:app-ready", standInApi(api));
  }, true);
  // wallets that loaded before this script are waiting for an app: be one
  issue("wallet-standard:app-ready", ourApi);
  return { seen: () => ({ wallets: all.size, standIns: stuck.size }) };
}

// ── the injected provider ──

const ownerOf = (p: any): string => { try { return String(p?.publicKey?.toBase58?.() ?? p?.publicKey?.toString?.() ?? ""); } catch { return ""; } };

/** What `provider.request({ method, params })` asks to have signed, or null when it is not a signing call. */
export function requestsOf(arg: any, owner: string): GuardRequest[] | null {
  const method = arg && typeof arg === "object" ? arg.method : undefined;
  if (typeof method !== "string" || !/^sign/i.test(method)) return null;
  const params = arg.params ?? {};
  if (/^signIn$/i.test(method)) return [{ kind: "signin", bytes: signInBytes(params), owner }];
  const opaque: GuardRequest[] = [{ kind: "opaque", bytes: new Uint8Array(0), owner }];
  const asMessageBytes = (m: unknown): Uint8Array | null => {
    const raw = typeof m === "string" ? fromBase58(m) : toBytes(m);
    return raw && raw.length ? raw : null;
  };
  if (/message$/i.test(method)) {
    const b = typeof params.message === "string" ? new TextEncoder().encode(params.message) : toBytes(params.message);
    return b.length ? [{ kind: "msg", bytes: b, owner }] : opaque;
  }
  // signTransaction / signAndSendTransaction: params.message is the base58 message; signAllTransactions: an array
  const list = Array.isArray(params.message) ? params.message : params.message !== undefined ? [params.message] : Array.isArray(params.transactions) ? params.transactions : params.transaction !== undefined ? [params.transaction] : [];
  if (list.length === 0) return opaque;
  const out: GuardRequest[] = [];
  for (const m of list) {
    const msg = asMessageBytes(m);
    const tx = msg ? messageToTransaction(msg) : new Uint8Array(0);
    out.push(tx.length ? { kind: "tx", bytes: tx, owner } : { kind: "opaque", bytes: new Uint8Array(0), owner });
  }
  return out;
}

/** The guarded version of one provider method. `call` runs the wallet's own method with the caller's `this`. */
function guardMethod(name: string, original: AnyFn, guard: Guard, self: () => any): AnyFn | null {
  const run = (that: any, args: any[]) => original.apply(that, args);
  switch (name) {
    case "signTransaction":
    case "signAndSendTransaction":
      return function (this: any, tx: any, ...rest: any[]) { return guarded(guard, [{ kind: "tx", bytes: serializeForGuard(tx), owner: ownerOf(self() ?? this) }], () => run(this, [tx, ...rest])); };
    case "signAllTransactions":
    case "signAndSendAllTransactions":
      return function (this: any, txs: any[], ...rest: any[]) { return guarded(guard, Array.from(txs ?? []).map((tx) => ({ kind: "tx" as const, bytes: serializeForGuard(tx), owner: ownerOf(self() ?? this) })), () => run(this, [txs, ...rest])); };
    case "signMessage":
    case "signOffchainMessage":
      return function (this: any, message: any, ...rest: any[]) { return guarded(guard, [{ kind: "msg", bytes: typeof message === "string" ? new TextEncoder().encode(message) : toBytes(message), owner: ownerOf(self() ?? this) }], () => run(this, [message, ...rest])); };
    case "signIn":
      return function (this: any, input: any, ...rest: any[]) { return guarded(guard, [{ kind: "signin", bytes: signInBytes(input), owner: ownerOf(self() ?? this) }], () => run(this, [input, ...rest])); };
    case "request":
      return function (this: any, arg: any, ...rest: any[]) {
        const reqs = requestsOf(arg, ownerOf(self() ?? this));
        return reqs ? guarded(guard, reqs, () => run(this, [arg, ...rest])) : run(this, [arg, ...rest]);
      };
    default:
      return null;
  }
}

export const PROVIDER_METHODS = ["signTransaction", "signAndSendTransaction", "signAllTransactions", "signAndSendAllTransactions", "signMessage", "signOffchainMessage", "signIn", "request"] as const;

/** A stand-in for an injected provider: for a wallet that assigns its provider, or one whose object cannot be changed. */
export function wrapLegacyProvider<P extends object>(provider: P, guard: Guard): P {
  if (!provider || typeof provider !== "object" || isWrapped.has(provider)) return provider;
  const seen = wrapped.get(provider);
  if (seen) return seen as P;
  const made = new WeakMap<AnyFn, AnyFn>();
  return standIn(provider, (prop, value) => {
    if (typeof prop !== "string" || typeof value !== "function" || !(PROVIDER_METHODS as readonly string[]).includes(prop)) return undefined;
    if (ours.has(value as AnyFn)) return undefined; // already guarded where it stands
    let fn = made.get(value as AnyFn);
    if (!fn) {
      const g = guardMethod(prop, value as AnyFn, guard, () => provider);
      if (!g) return undefined;
      fn = function (...args: any[]) { return g.apply(provider, args); };
      made.set(value as AnyFn, fn);
    }
    return fn;
  });
}

export interface PatchResult {
  /** Methods now guarded on the provider itself. */
  patched: string[];
  /** Signing methods the provider has that could not be replaced (a frozen object). */
  stuck: string[];
}

/**
 * Replaces the provider's signing methods where they stand. Works on Phantom's provider (own, writable
 * functions). A frozen provider (Solflare) reports its methods as stuck; the caller then tries a stand-in.
 */
export function patchProviderInPlace(provider: any, guard: Guard): PatchResult {
  const out: PatchResult = { patched: [], stuck: [] };
  if (!provider || typeof provider !== "object" || isWrapped.has(provider)) return out;
  for (const name of PROVIDER_METHODS) {
    try {
      // where the method lives: on the object, or on a class prototype
      let holder: any = provider;
      let desc: PropertyDescriptor | undefined;
      for (let depth = 0; holder && holder !== Object.prototype && depth < 8; depth++, holder = Object.getPrototypeOf(holder)) {
        desc = Object.getOwnPropertyDescriptor(holder, name);
        if (desc) break;
      }
      if (!desc || typeof desc.value !== "function") continue; // absent, or an accessor: not something to replace
      if (ours.has(desc.value)) { out.patched.push(name); continue; }
      const fn = guardMethod(name, desc.value, guard, () => provider);
      if (!fn) continue;
      ours.add(fn);
      if (holder === provider) {
        if (!desc.configurable && !desc.writable) { out.stuck.push(name); continue; }
        Object.defineProperty(provider, name, { ...desc, value: fn });
      } else if (Object.isExtensible(provider)) {
        // an own property on this one object: other instances of the wallet's class are not ours to change
        Object.defineProperty(provider, name, { value: fn, writable: true, configurable: true, enumerable: false });
      } else if (desc.configurable || desc.writable) {
        Object.defineProperty(holder, name, { ...desc, value: fn });
      } else { out.stuck.push(name); continue; }
      out.patched.push(name);
    } catch { out.stuck.push(name); }
  }
  return out;
}

/**
 * Where wallets put a Solana provider. PROVIDERS hold one themselves; CONTAINERS are objects for several
 * chains, and only their `.solana` is looked at, so an Ethereum provider is never mistaken for a Solana one.
 * Checked against the real extensions: Phantom, Solflare, Backpack. The others are by their documentation.
 */
const PROVIDERS = ["solana", "solflare", "backpack", "glowSolana", "braveSolana", "coinbaseSolana"] as const;
const CONTAINERS = ["phantom", "backpack", "okxwallet", "trustwallet", "bitkeep", "magicEden", "exodus"] as const;

export interface LegacyHook {
  /** Looks at the window again and guards any provider that appeared since. Cheap; call it often. */
  sweep(): void;
  /** Globals that hold a signing provider Warden could not get in front of. */
  unguarded(): string[];
}

/**
 * Finds injected providers and guards them: in place where the wallet's object allows it, with a stand-in on
 * the window where the object is frozen but the global can still be redefined. Defines nothing on the window
 * until a wallet has. Call sweep() whenever a wallet may have arrived.
 */
export function installLegacyHook(win: Record<string, any>, guard: Guard, providers: readonly string[] = PROVIDERS, containers: readonly string[] = CONTAINERS): LegacyHook {
  const done = new WeakSet<object>();
  const failed = new Set<string>();
  const guardOne = (holder: any, key: string, label: string) => {
    let desc: PropertyDescriptor | undefined;
    try { desc = Object.getOwnPropertyDescriptor(holder, key); } catch { return; }
    if (!desc) return;
    // a getter on the window is read once: a wallet's own getter returns its provider, a page's could do anything
    let p: any;
    try { p = "value" in desc ? desc.value : holder[key]; } catch { return; }
    if (!p || typeof p !== "object" || done.has(p) || isWrapped.has(p)) return;
    done.add(p);
    if (!PROVIDER_METHODS.some((m) => { try { return typeof p[m] === "function"; } catch { return false; } })) return;
    const r = patchProviderInPlace(p, guard);
    if (r.stuck.length === 0) { failed.delete(label); return; }
    // frozen: put a stand-in on the holder if the wallet left the property open to that
    try {
      if ("value" in desc && (desc.configurable || desc.writable)) {
        Object.defineProperty(holder, key, { ...desc, value: wrapLegacyProvider(p, guard) });
        failed.delete(label);
        return;
      }
    } catch { /* not ours to redefine */ }
    // a frozen container whose methods forward to an inner provider guarded above (Backpack) is covered by it
    const covered = r.stuck.every((m) => { try { const inner = p.solana?.[m]; return typeof inner === "function" && isOurs(inner); } catch { return false; } });
    if (covered) failed.delete(label); else failed.add(label);
  };
  const sweep = () => {
    // phantom.solana, backpack.solana, okxwallet.solana, ...: the provider a container forwards to comes first
    for (const name of containers) {
      let c: any;
      try { const d = Object.getOwnPropertyDescriptor(win, name); c = d && "value" in d ? d.value : undefined; } catch { continue; }
      if (c && typeof c === "object") guardOne(c, "solana", `${name}.solana`); // every time: the wallet may fill it in later
    }
    for (const name of providers) guardOne(win, name, name);
  };
  sweep();
  return { sweep, unguarded: () => [...failed] };
}

/** True for a function Warden put in place of a wallet's own (or a bound copy the wallet made of it later). */
export function isOurs(fn: unknown): boolean {
  return typeof fn === "function" && ours.has(fn as AnyFn);
}
