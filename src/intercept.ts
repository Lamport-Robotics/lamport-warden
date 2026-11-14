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
 * At both of a wallet's doors, its Wallet Standard wallet and the older object on the window, and only at a
 * door where Warden can also answer for what the wallet says its account is.
 */
export interface DecoyGate {
  /** Asked once for a page, at the first connect through any door: the decoy's address, or null to connect as always. */
  first(): Promise<string | null>;
  /**
   * The site asked the decoy to sign this. Resolves true when that caught it: nothing from this page reaches
   * a wallet again. Resolves false when it passed and the owner chose to go on: their own wallet is then
   * connected. Rejects when the owner chose not to: everything stays as it is.
   */
  asked(req: GuardRequest): Promise<boolean>;
}
/** A door that may be showing a decoy. */
interface Door {
  /** The site passed at another door: this one takes the decoy down and says what the wallet's own state is. */
  aside(): void;
}
/**
 * One page: one decoy and one outcome. Every door of every wallet on the page shows the same decoy or none
 * does; a page caught at one door gets nothing more through any; and when a site passes at one door, the
 * decoy comes down at all of them.
 */
interface DecoyPage {
  gate: DecoyGate;
  first: Promise<string | null> | null;
  caught: boolean;
  passed: boolean;
  /**
   * Above zero while a wallet is being connected for real. A wallet's doors call one another (Phantom's and
   * Backpack's Wallet Standard connect is a call to their injected provider's connect), and a connect that
   * is already the real thing is not answered with a decoy on its way through.
   */
  connecting: number;
  /** The doors showing a decoy now. */
  showing: Set<Door>;
}
const pages = new WeakMap<DecoyGate, DecoyPage>();
function pageOf(gate: DecoyGate): DecoyPage {
  let page = pages.get(gate);
  if (!page) { page = { gate, first: null, caught: false, passed: false, connecting: 0, showing: new Set() }; pages.set(gate, page); }
  return page;
}
/** The page's decoy, asked for once. Nobody to ask is no decoy. */
const firstOf = (page: DecoyPage): Promise<string | null> => (page.first ??= Promise.resolve().then(() => page.gate.first()).catch(() => null));
/** The site passed at `door`: the decoy comes down at every other one. */
function passedAt(page: DecoyPage, door: Door): void {
  page.passed = true;
  page.showing.delete(door);
  for (const other of [...page.showing]) { try { other.aside(); } catch { /* a door that cannot say so is still no longer showing one */ } }
  page.showing.clear();
}
/** Connects a wallet for real, and lets its other doors know that is what is going on. */
async function really<T>(page: DecoyPage, connect: () => T | Promise<T>): Promise<T> {
  page.connecting += 1;
  try { return await connect(); } finally { page.connecting -= 1; }
}

/** Where one Wallet Standard wallet stands on this page. */
interface DecoyState { phase: "new" | "decoy" | "real"; account: { address: string } | null; listeners: Set<AnyFn>; connect: (() => Promise<any>) | null }
/**
 * `front`: puts Warden in front of the wallet's own list of accounts, when it is first needed and not before.
 * A wallet is left exactly as it is until a decoy is in fact about to be shown; false when it will not allow it.
 */
interface DecoyCtx extends Door { page: DecoyPage; state: DecoyState; wallet: any; front: () => boolean }
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

/**
 * Requests the owner has let through that the wallet is still working on, as how many times each may yet be
 * met again. Phantom's and Backpack's Wallet Standard wallets answer a signing call by calling their own
 * injected provider (`this.#provider.signTransaction(...)`), and Warden stands in front of both doors: asked
 * at each, the owner was shown one request twice, and a payment was counted twice.
 *
 * So a request that is on its way to the wallet may be met once more, and is let through without a second
 * question. Once: the wallet passes a request on a single time, and a page that sends a copy of its own
 * through another door is asked about it like any other request.
 *
 * "The same request" is the same kind, the same bytes and the same account. The account matters as much as
 * the bytes: what a transaction does is read from the side of the account that signs it, so the same bytes
 * asked of another account are another question with another answer. A page can make a wallet of its own,
 * have it "asked" to sign a transaction as an account of the page's (which reads as harmless: nothing leaves
 * that account), and then send those bytes to the real wallet. That is not the request that was answered.
 */
const onTheirWay = new WeakMap<Guard, Map<string, object[]>>();
const HEX = "0123456789abcdef";
/** What makes two requests the same one. Null for a request Warden cannot read: that is asked about every time. */
function sameAs(r: GuardRequest): string | null {
  if (r.kind === "opaque" || r.bytes.length === 0) return null;
  let out = `${r.kind}:${r.owner}:`;
  for (const b of r.bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

async function guarded<T>(guard: Guard, reqs: GuardRequest[], call: () => T | Promise<T>): Promise<T> {
  let going = onTheirWay.get(guard);
  if (!going) { going = new Map(); onTheirWay.set(guard, going); }
  const passes = going;
  const keys = reqs.map(sameAs);
  /** null: this one was already answered, at the door the wallet was first asked through */
  const tickets: (Ticket | null)[] = [];
  try {
    for (const [i, r] of reqs.entries()) { // one at a time: the owner reads one request at a time
      const waiting = keys[i] ? passes.get(keys[i]!) : undefined;
      if (waiting?.length) { waiting.shift(); tickets.push(null); continue; }
      tickets.push(await guard(r));
    }
  } catch (e) {
    for (const t of tickets) t?.done(false);
    throw e;
  }
  // each request asked about here may be met once more while the wallet works on it
  const mine: [string, object][] = [];
  keys.forEach((k, i) => { if (k !== null && tickets[i] !== null) mine.push([k, {}]); });
  for (const [k, pass] of mine) { const list = passes.get(k); if (list) list.push(pass); else passes.set(k, [pass]); }
  const settle = () => {
    for (const [k, pass] of mine) {
      const list = passes.get(k);
      if (!list) continue;
      const at = list.indexOf(pass);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) passes.delete(k);
    }
  };
  try {
    const out = await call();
    settle();
    reqs.forEach((r, i) => tickets[i]?.done(true, r.kind === "tx" ? signaturesOf(out, i, reqs.length) : undefined));
    return out;
  } catch (e) {
    settle();
    for (const t of tickets) t?.done(false);
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

/** The account a page says it is asking. */
const named = (i: any) => String(i?.account?.address ?? "");

/**
 * Whose request this is. A page names an account when it asks, and it can name any: one of its own, say, so
 * that a transaction which empties the wallet's account reads as one that leaves "its" account alone. So the
 * page's word is taken only when the wallet lists that account as its own. Otherwise the request is read as
 * the wallet's own account's, which is the only key this wallet could sign with. A wallet that lists nobody
 * is not connected, and the page's word is all there is.
 */
function ownerAt(wallet: any, said: string): string {
  let listed: string[] = [];
  try { listed = Array.from(wallet?.accounts ?? [], (a: any) => String(a?.address ?? "")).filter((a) => a !== ""); } catch { /* a list that cannot be read lists nobody */ }
  return listed.length === 0 || listed.includes(said) ? said : listed[0]!;
}

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
/** The wallet's own list of accounts, as it stands. */
const accountsOf = (wallet: any): unknown => { try { return wallet.accounts ?? []; } catch { return []; } };

/** A Wallet Standard wallet as a door of its page. `front` is asked at most once. */
function standardDoor(gate: DecoyGate, wallet: any, front: (state: DecoyState) => boolean): DecoyCtx {
  const state: DecoyState = { phase: "new", account: null, listeners: new Set(), connect: null };
  let fronted: boolean | undefined;
  return {
    page: pageOf(gate), state, wallet,
    front: () => (fronted ??= front(state)),
    aside: () => { if (state.phase !== "decoy") return; state.phase = "real"; state.account = null; announce(state, accountsOf(wallet)); },
  };
}

/**
 * A signing call, by way of the decoy when the site is still looking at one. The site that asked the decoy
 * for something is either caught, and gets nothing more; or it passed, the owner's own wallet is connected,
 * and the site is told to ask again, because what it built was built for the decoy.
 */
async function viaDecoy<T>(d: DecoyCtx | undefined, reqs: GuardRequest[], run: () => Promise<T>): Promise<T> {
  if (!d) return run();
  const s = d.state, page = d.page;
  if (page.caught) throw new WardenRejected(CAUGHT);
  if (s.phase !== "decoy") return run();
  const address = s.account!.address;
  for (const r of reqs) {
    let caught: boolean;
    try { caught = await page.gate.asked({ ...r, owner: address }); } catch { throw new WardenRejected(); }
    if (caught) { page.caught = true; throw new WardenRejected(CAUGHT); }
  }
  // (two requests may have waited on the one answer: the first through does the rest)
  if ((s.phase as DecoyState["phase"]) === "decoy") {
    passedAt(page, d);
    s.phase = "real";
    s.account = null;
    try {
      const out = await really(page, () => s.connect!());
      announce(s, out?.accounts ?? accountsOf(d.wallet));
    } catch {
      // the owner said no to their own wallet: nothing is connected, and the site hears that too
      announce(s, accountsOf(d.wallet));
    }
  }
  throw new WardenRejected(AGAIN);
}

/** `standard:connect`, answering with the decoy first when the page has one. */
function decoyConnect(feature: any, d: DecoyCtx): any {
  const original = feature?.connect;
  if (typeof original !== "function" || ours.has(original)) return feature;
  const s = d.state, page = d.page;
  s.connect = () => Promise.resolve(original.call(feature));
  const connected = () => { try { return (d.wallet.accounts?.length ?? 0) > 0; } catch { return false; } };
  const fn = async (...inputs: any[]) => {
    if (page.caught) throw new WardenRejected(CAUGHT);
    if (s.phase === "new") {
      if (inputs[0]?.silent === true) {
        // Asked not to prompt. Only a wallet that already trusts this site answers with an account, and a
        // site the wallet has told its address before has nothing to learn from a decoy.
        const out = await really(page, () => original.apply(feature, inputs));
        if (s.phase === "new" && Array.isArray(out?.accounts) && out.accounts.length > 0) s.phase = "real";
        return out;
      }
      // no decoy once the site has passed, while a wallet is being connected for real, or for a wallet this site is already connected to
      if (page.passed || page.connecting > 0 || connected()) s.phase = "real";
      else {
        const address = await firstOf(page);
        const key = address ? fromBase58(address) : null;
        // (asked twice at once, the first answer stands; and the page may have been caught or passed meanwhile)
        // A decoy only when the wallet's list of accounts can be answered for too: a site must not see one address from connect and another in the list.
        if (s.phase === "new") {
          if (!page.passed && !page.caught && address && key && key.length === 32 && d.front()) { s.account = decoyAccount(address, key, d.wallet); s.phase = "decoy"; page.showing.add(d); }
          else s.phase = "real";
        }
      }
    }
    if (page.caught) throw new WardenRejected(CAUGHT);
    // (read afresh: another call may have moved it on while this one was waiting)
    if ((s.phase as DecoyState["phase"]) === "decoy") return { accounts: [s.account] };
    return really(page, () => original.apply(feature, inputs));
  };
  ours.add(fn);
  const out = { ...feature, connect: fn };
  return Object.isFrozen(feature) ? Object.freeze(out) : out;
}

/** `standard:disconnect`: a site that lets go of the decoy lets go of the decoy. The wallet itself was never connected. */
function decoyDisconnect(feature: any, d: DecoyCtx): any {
  const original = feature?.disconnect;
  if (typeof original !== "function" || ours.has(original)) return feature;
  const fn = async (...inputs: any[]) => {
    const s = d.state;
    if (s.phase !== "decoy") return original.apply(feature, inputs);
    s.phase = "new";
    s.account = null;
    d.page.showing.delete(d);
    announce(s, accountsOf(d.wallet));
  };
  ours.add(fn);
  const out = { ...feature, disconnect: fn };
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
function guardFeature(name: string, feature: any, guard: Guard, wallet: any, d?: DecoyCtx): any {
  if (!feature || typeof feature !== "object") return feature;
  if (d && name === "standard:connect") return decoyConnect(feature, d);
  if (d && name === "standard:events") return decoyEvents(feature, d);
  if (d && name === "standard:disconnect") return decoyDisconnect(feature, d);
  const method = name.slice(7); // "solana:signTransaction" -> "signTransaction"
  const original = feature[method];
  if (typeof original !== "function" || ours.has(original)) return feature;
  let fn: AnyFn;
  const tx = (inputs: any[]) => inputs.map((i) => ({ kind: "tx" as const, bytes: toBytes(i?.transaction), owner: ownerAt(wallet, named(i)) }));
  const msg = (inputs: any[]) => inputs.map((i) => ({ kind: "msg" as const, bytes: toBytes(i?.message), owner: ownerAt(wallet, named(i)) }));
  // Sign-in may be called with no input at all: the wallet then signs in to the site it is on. It is the
  // wallet's own account that signs in, whatever address the request carries (that address is in what is read).
  const signin = (inputs: any[]) => (inputs.length ? inputs : [undefined]).map((i) => ({ kind: "signin" as const, bytes: signInBytes(i), owner: ownerAt(wallet, "") }));
  const reqs = name === SIGN_TX || name === SIGN_SEND ? tx : name === SIGN_MSG || name === SIGN_OFFCHAIN ? msg : name === SIGN_IN ? signin : null;
  if (!reqs) return feature;
  fn = (...inputs: any[]) => viaDecoy(d, reqs(inputs), () => guarded(guard, reqs(inputs), () => original.apply(feature, inputs)));
  ours.add(fn);
  // a copy with the feature's own getters still getters: Backpack's `supportedTransactionVersions` is one, and changes when the wallet has finished loading
  const own = Object.getOwnPropertyDescriptors(feature);
  own[method] = { value: fn, writable: true, enumerable: true, configurable: true };
  const out = Object.defineProperties({}, own);
  return Object.isFrozen(feature) ? Object.freeze(out) : out;
}

/** The wallet's features with the signing ones guarded. The same features object always gives the same answer. */
function guardFeatures(features: any, guard: Guard, cache: WeakMap<object, object>, wallet: any, d?: DecoyCtx): any {
  if (!features || typeof features !== "object") return features;
  const cached = cache.get(features);
  if (cached) return cached;
  const out: Record<string, any> = {};
  for (const k of Object.keys(features)) out[k] = guardFeature(k, features[k], guard, wallet, d);
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
  const d: DecoyCtx | undefined = gate ? standardDoor(gate, wallet, () => true) : undefined;
  return standIn(wallet, (prop, value) => {
    if (prop === "features" && value && typeof value === "object") return guardFeatures(value, guard, cache, wallet, d);
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
    if (gate && !decoys.has(wallet)) decoys.set(wallet, standardDoor(gate, wallet, (state) => decoyAccountsInPlace(wallet, state)));
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
      const guardedGet = function (this: any) { return guardFeatures(get.call(this), guard, cache, this, decoys.get(this)); };
      patchedGetters.add(guardedGet);
      if (holder !== wallet && Object.isExtensible(wallet)) Object.defineProperty(wallet, "features", { get: guardedGet, set: desc.set, enumerable: desc.enumerable, configurable: true });
      else if (desc.configurable) Object.defineProperty(holder, "features", { ...desc, get: guardedGet });
      else return false;
    } else if (holder === wallet && (desc.writable || desc.configurable)) {
      Object.defineProperty(wallet, "features", { ...desc, value: guardFeatures(desc.value, guard, cache, wallet, decoys.get(wallet)) });
    } else if (holder !== wallet && Object.isExtensible(wallet)) {
      Object.defineProperty(wallet, "features", { value: guardFeatures(desc.value, guard, cache, wallet, decoys.get(wallet)), writable: true, enumerable: true, configurable: true });
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
        Object.defineProperty(feature, method, { ...d, value: guardFeature(name, feature, guard, wallet)[method] });
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

/**
 * What a provider hands a page as its account is a PublicKey object from the wallet's own copy of
 * @solana/web3.js. Pages read it (`toBase58()`, `toString()`, `toBytes()`) and hand it to their own copy of
 * that library, which takes a key from another copy by its `_bn` field (a big number) and compares two keys
 * with `_bn.eq`. This is a decoy's address in that shape, with no library behind it: the methods a page
 * calls, and a `_bn` that answers what web3.js asks of one.
 */
export function keyLike(bytes: Uint8Array, address: string): any {
  const copy = () => Uint8Array.from(bytes);
  const buffer = () => { const B = (globalThis as any).Buffer; try { return typeof B?.from === "function" ? B.from(bytes) : copy(); } catch { return copy(); } };
  const same = (other: any): boolean => {
    try {
      const theirs = typeof other === "string" ? fromBase58(other) : other && typeof other.toBytes === "function" ? toBytes(other.toBytes()) : other?._bn && typeof other._bn.toArrayLike === "function" ? toBytes(other._bn.toArrayLike(Uint8Array, "be", 32)) : toBytes(other);
      return !!theirs && theirs.length === bytes.length && theirs.every((x, i) => x === bytes[i]);
    } catch { return false; }
  };
  return Object.freeze({
    _bn: numberLike(bytes),
    equals: same,
    toBase58: () => address,
    toString: () => address,
    toJSON: () => address,
    toBytes: copy,
    toBuffer: buffer,
    encode: buffer,
    get [Symbol.toStringTag]() { return `PublicKey(${address})`; },
  });
}

/** The big number of a key, as much of bn.js as web3.js uses on one: its 26-bit words to be compared, and its bytes. */
function numberLike(bytes: Uint8Array): any {
  let value = 0n;
  for (const x of bytes) value = (value << 8n) | BigInt(x);
  const words: number[] = [];
  for (let rest = value; rest > 0n; rest >>= 26n) words.push(Number(rest & 0x3ffffffn));
  if (words.length === 0) words.push(0);
  let lead = 0;
  while (lead < bytes.length && bytes[lead] === 0) lead++;
  const significant = bytes.subarray(lead); // big-endian, no leading zeros; empty for zero
  const ucmp = (o: any): number => {
    if (words.length !== o.length) return words.length > o.length ? 1 : -1;
    for (let i = words.length - 1; i >= 0; i--) { const mine = words[i]! | 0, theirs = o.words[i] | 0; if (mine !== theirs) return mine < theirs ? -1 : 1; }
    return 0;
  };
  const cmp = (o: any): number => (o.negative !== 0 ? 1 : ucmp(o));
  const toArrayLike = (Type: any, endian?: string, length?: number): any => {
    const size = length || Math.max(1, significant.length);
    if (significant.length > size) throw new Error("byte array longer than desired length");
    const out = typeof Type?.allocUnsafe === "function" ? Type.allocUnsafe(size) : new (Type ?? Uint8Array)(size);
    for (let i = 0; i < size; i++) out[i] = 0;
    significant.forEach((x, i) => { if (endian === "le") out[significant.length - 1 - i] = x; else out[size - significant.length + i] = x; });
    return out;
  };
  return Object.freeze({
    negative: 0, words: Object.freeze(words), length: words.length, red: null,
    eq: (o: any) => cmp(o) === 0, cmp, ucmp,
    byteLength: () => significant.length,
    bitLength: () => (value === 0n ? 0 : value.toString(2).length),
    isZero: () => value === 0n, isNeg: () => false,
    toArrayLike, toArray: (endian?: string, length?: number) => toArrayLike(Array, endian, length),
    toBuffer: (endian?: string, length?: number) => toArrayLike((globalThis as any).Buffer ?? Uint8Array, endian, length),
    toString: (base = 10) => value.toString(base), toJSON: () => value.toString(16),
    clone: () => numberLike(bytes),
  });
}

/** Where one injected provider stands on this page. */
interface LegacyDoor extends Door {
  page: DecoyPage;
  phase: "new" | "decoy" | "real";
  address: string;
  /** The decoy as the provider's `publicKey`. */
  key: any | null;
  provider: any;
  /** Connects the wallet itself, the way the page last asked it to. */
  connect: (() => Promise<any>) | null;
  /** Puts Warden in front of `publicKey` and `isConnected`, when a decoy is first to be shown and not before. */
  front: () => boolean;
  /**
   * The listeners that were on the provider when Warden met it. Those are the wallet's own (its Wallet
   * Standard wallet listens to its provider), and are told nothing of a decoy: the wallet's own picture of
   * itself stays true.
   */
  own: Map<string, Set<AnyFn>>;
}
const legacyDoors = new WeakMap<object, LegacyDoor>();
const frontedGetters = new WeakSet<AnyFn>();
const LEGACY_EVENTS = ["connect", "disconnect", "accountChanged"] as const;
/** connect and disconnect: wrapped only where there may be a decoy to show. */
const DECOY_METHODS = ["connect", "disconnect"] as const;

/** An injected provider as a door of its page. */
function legacyDoor(gate: DecoyGate, provider: any, front: (door: LegacyDoor) => boolean): LegacyDoor {
  const own = new Map<string, Set<AnyFn>>(LEGACY_EVENTS.map((event) => [event, new Set<AnyFn>()]));
  const note = () => {
    for (const event of LEGACY_EVENTS) {
      let there: unknown = [];
      try { there = provider.listeners?.(event); } catch { /* none can be read */ }
      if (Array.isArray(there)) for (const f of there) if (typeof f === "function") own.get(event)!.add(f);
    }
  };
  note();
  // A wallet may announce its provider before it has finished listening to it: Phantom dispatches
  // "phantom#initialized", which is when Warden meets the provider, and only then builds the Wallet Standard
  // wallet that listens to it. So what is on the provider once the script that made it has run to its end is
  // the wallet's own too. A page's scripts run later.
  try { void Promise.resolve().then(note); } catch { /* what was there when Warden met it is all that is known */ }
  let fronted: boolean | undefined;
  const door: LegacyDoor = {
    page: pageOf(gate), phase: "new", address: "", key: null, provider, connect: null, own,
    front: () => (fronted ??= front(door)),
    aside: () => { if (door.phase !== "decoy") return; door.phase = "real"; door.key = null; tellPage(door, "disconnect"); },
  };
  legacyDoors.set(provider, door);
  return door;
}

/** Tells the page's listeners on a provider of something, and not the wallet's own. */
function tellPage(door: LegacyDoor, event: string, ...args: unknown[]): void {
  let all: unknown;
  try { all = door.provider.listeners?.(event); } catch { return; }
  if (!Array.isArray(all)) return;
  const own = door.own.get(event);
  for (const listener of all) {
    if (typeof listener !== "function" || own?.has(listener)) continue;
    try { listener.apply(door.provider, args); } catch { /* a listener that throws is its own affair */ }
  }
}
/** How this wallet tells a page which account it has: Phantom hands its listeners the key itself, Backpack an object with the address in it. */
function accountEvent(provider: any, key: any): unknown {
  let backpack = false;
  try { backpack = provider.isBackpack === true; } catch { /* not Backpack */ }
  if (!backpack) return key;
  let address = "";
  try { address = String(key?.toBase58?.() ?? key ?? ""); } catch { /* no address to give */ }
  return { publicKey: address };
}

/**
 * Puts Warden in front of what a provider says its account is, so that it can answer with the decoy while the
 * site is looking at one. Phantom's provider is an open object whose `publicKey` is a getter on its class:
 * that one object gets a getter of its own. Backpack's is frozen, with the getter on its class: the class's
 * getter is replaced, and answers for each provider by its own state. False when neither can be done.
 */
function frontProvider(provider: any, door: LegacyDoor): boolean {
  const one = (name: string, shown: (d: LegacyDoor) => unknown, needed: boolean): boolean => {
    try {
      let holder: any = provider, desc: PropertyDescriptor | undefined;
      for (let depth = 0; holder && holder !== Object.prototype && depth < 8; depth++, holder = Object.getPrototypeOf(holder)) {
        desc = Object.getOwnPropertyDescriptor(holder, name);
        if (desc) break;
      }
      if (!desc) return !needed;
      const through = (d: LegacyDoor | undefined, real: () => unknown) => (d && d.phase === "decoy" ? shown(d) : real());
      if (desc.get) {
        const get = desc.get;
        if (frontedGetters.has(get)) return true;
        let fronted: AnyFn;
        if (holder !== provider && Object.isExtensible(provider)) {
          fronted = function (this: any) { return through(door, () => get.call(this)); };
          Object.defineProperty(provider, name, { get: fronted as () => unknown, set: desc.set, enumerable: desc.enumerable, configurable: true });
        } else if (holder === provider && desc.configurable) {
          fronted = function (this: any) { return through(door, () => get.call(this)); };
          Object.defineProperty(provider, name, { ...desc, get: fronted as () => unknown });
        } else if (holder !== provider && desc.configurable) {
          fronted = function (this: any) { return through(legacyDoors.get(this), () => get.call(this)); };
          Object.defineProperty(holder, name, { ...desc, get: fronted as () => unknown });
        } else return false;
        frontedGetters.add(fronted);
        return true;
      }
      // a plain value the wallet writes to: kept, and read through the decoy
      if (holder === provider && desc.configurable) {
        let real = desc.value;
        Object.defineProperty(provider, name, { get: () => through(door, () => real), set: (v) => { real = v; }, enumerable: desc.enumerable, configurable: true });
        return true;
      }
      if (holder !== provider && Object.isExtensible(provider)) {
        let real: unknown, own = false;
        Object.defineProperty(provider, name, { get(this: any) { return through(door, () => (own ? real : Reflect.get(holder, name, this))); }, set: (v) => { real = v; own = true; }, enumerable: true, configurable: true });
        return true;
      }
      return false;
    } catch { return false; }
  };
  return one("publicKey", (d) => d.key, true) && one("isConnected", () => true, false);
}

/** The provider's connect, answering with the decoy first when the page has one. `real` is the wallet's own, as the page called it. */
async function legacyConnect(door: LegacyDoor, opts: any, real: () => Promise<any>): Promise<any> {
  const page = door.page;
  if (page.caught) throw new WardenRejected(CAUGHT);
  if (door.phase === "new") {
    if (opts?.onlyIfTrusted === true) {
      // Asked not to prompt. A wallet that does not already trust this site refuses, and a site the wallet has
      // told its address before has nothing to learn from a decoy.
      const out = await really(page, real);
      if (door.phase === "new") door.phase = "real";
      return out;
    }
    let connected = false;
    try { connected = door.provider.publicKey != null && door.provider.isConnected !== false; } catch { /* not readable: not connected */ }
    if (page.passed || page.connecting > 0 || connected) door.phase = "real";
    else {
      const address = await firstOf(page);
      const bytes = address ? fromBase58(address) : null;
      if (door.phase === "new") {
        if (!page.passed && !page.caught && address && bytes && bytes.length === 32 && door.front()) { door.address = address; door.key = keyLike(bytes, address); door.phase = "decoy"; page.showing.add(door); }
        else door.phase = "real";
      }
    }
  }
  if (page.caught) throw new WardenRejected(CAUGHT);
  if ((door.phase as LegacyDoor["phase"]) === "decoy") {
    // (a call that asks not to prompt gets the answer and makes no announcement: wallets make such calls themselves)
    if (opts?.onlyIfTrusted !== true) tellPage(door, "connect", accountEvent(door.provider, door.key));
    return { publicKey: door.key };
  }
  return really(page, real);
}

/** A site that lets go of the decoy lets go of the decoy. The wallet itself was never connected. */
async function legacyDisconnect(door: LegacyDoor, real: () => Promise<any>): Promise<any> {
  if (door.phase !== "decoy") return real();
  door.phase = "new";
  door.key = null;
  door.page.showing.delete(door);
  tellPage(door, "disconnect");
}

/** A signing call at an injected provider, by way of the decoy when the site is still looking at one (see viaDecoy). */
async function viaLegacy<T>(door: LegacyDoor | undefined, reqs: GuardRequest[], run: () => Promise<T>): Promise<T> {
  if (!door) return run();
  const page = door.page;
  if (page.caught) throw new WardenRejected(CAUGHT);
  if (door.phase !== "decoy") return run();
  const address = door.address;
  for (const r of reqs) {
    let caught: boolean;
    try { caught = await page.gate.asked({ ...r, owner: address }); } catch { throw new WardenRejected(); }
    if (caught) { page.caught = true; throw new WardenRejected(CAUGHT); }
  }
  if ((door.phase as LegacyDoor["phase"]) === "decoy") {
    passedAt(page, door);
    door.phase = "real";
    door.key = null;
    try {
      await really(page, () => door.connect!());
      // the wallet tells its listeners it is connected; a site that was holding the decoy also needs to hear that the account is another one
      let key: unknown = null;
      try { key = door.provider.publicKey; } catch { /* nothing to tell */ }
      if (key != null) tellPage(door, "accountChanged", accountEvent(door.provider, key));
    } catch {
      // the owner said no to their own wallet: nothing is connected, and the site hears that too
      tellPage(door, "disconnect");
    }
  }
  throw new WardenRejected(AGAIN);
}

/** The guarded version of one provider method. Runs the wallet's own method with the caller's `this`. */
function guardMethod(name: string, original: AnyFn, guard: Guard, self: () => any): AnyFn | null {
  const run = (that: any, args: any[]) => original.apply(that, args);
  const owner = (that: any) => ownerOf(self() ?? that);
  /** The door a call came through: the provider it was called on, or the one the method was taken from when it was called on nothing. */
  const doorOf = (that: any): LegacyDoor | undefined => legacyDoors.get(that && typeof that === "object" ? that : self());
  switch (name) {
    case "signTransaction":
    case "signAndSendTransaction":
      return function (this: any, tx: any, ...rest: any[]) {
        const reqs: GuardRequest[] = [{ kind: "tx", bytes: serializeForGuard(tx), owner: owner(this) }];
        return viaLegacy(doorOf(this), reqs, () => guarded(guard, reqs, () => run(this, [tx, ...rest])));
      };
    case "signAllTransactions":
    case "signAndSendAllTransactions":
      return function (this: any, txs: any[], ...rest: any[]) {
        const reqs: GuardRequest[] = Array.from(txs ?? []).map((tx) => ({ kind: "tx" as const, bytes: serializeForGuard(tx), owner: owner(this) }));
        return viaLegacy(doorOf(this), reqs, () => guarded(guard, reqs, () => run(this, [txs, ...rest])));
      };
    case "signMessage":
    case "signOffchainMessage":
      return function (this: any, message: any, ...rest: any[]) {
        const reqs: GuardRequest[] = [{ kind: "msg", bytes: typeof message === "string" ? new TextEncoder().encode(message) : toBytes(message), owner: owner(this) }];
        return viaLegacy(doorOf(this), reqs, () => guarded(guard, reqs, () => run(this, [message, ...rest])));
      };
    case "signIn":
      return function (this: any, input: any, ...rest: any[]) {
        const reqs: GuardRequest[] = [{ kind: "signin", bytes: signInBytes(input), owner: owner(this) }];
        return viaLegacy(doorOf(this), reqs, () => guarded(guard, reqs, () => run(this, [input, ...rest])));
      };
    case "request":
      return function (this: any, arg: any, ...rest: any[]) {
        const door = doorOf(this);
        const method = arg && typeof arg === "object" && typeof arg.method === "string" ? arg.method : "";
        if (door && method === "connect") {
          door.connect ??= () => Promise.resolve(run(this, [{ method: "connect" }]));
          return legacyConnect(door, arg.params, () => Promise.resolve(run(this, [arg, ...rest])));
        }
        if (door && method === "disconnect") return legacyDisconnect(door, () => Promise.resolve(run(this, [arg, ...rest])));
        const reqs = requestsOf(arg, owner(this));
        return reqs ? viaLegacy(door, reqs, () => guarded(guard, reqs, () => run(this, [arg, ...rest]))) : run(this, [arg, ...rest]);
      };
    case "connect":
      return function (this: any, ...args: any[]) {
        const door = doorOf(this);
        if (!door) return run(this, args);
        door.connect ??= () => Promise.resolve(run(this, []));
        return legacyConnect(door, args[0], () => Promise.resolve(run(this, args)));
      };
    case "disconnect":
      return function (this: any, ...args: any[]) {
        const door = doorOf(this);
        return door ? legacyDisconnect(door, () => Promise.resolve(run(this, args))) : run(this, args);
      };
    default:
      return null;
  }
}

export const PROVIDER_METHODS = ["signTransaction", "signAndSendTransaction", "signAllTransactions", "signAndSendAllTransactions", "signMessage", "signOffchainMessage", "signIn", "request"] as const;

/** A stand-in for an injected provider: for a wallet that assigns its provider, or one whose object cannot be changed. */
export function wrapLegacyProvider<P extends object>(provider: P, guard: Guard, gate?: DecoyGate): P {
  if (!provider || typeof provider !== "object" || isWrapped.has(provider)) return provider;
  const seen = wrapped.get(provider);
  if (seen) return seen as P;
  // a stand-in answers for everything, what the provider says its account is included, so the decoy can always go first here
  let door: LegacyDoor | undefined;
  try { if (gate && typeof (provider as any).connect === "function") door = legacyDoor(gate, provider, () => true); } catch { /* no decoy at a door that cannot be read */ }
  const names: readonly string[] = door ? [...PROVIDER_METHODS, ...DECOY_METHODS] : PROVIDER_METHODS;
  const made = new WeakMap<AnyFn, AnyFn>();
  return standIn(provider, (prop, value) => {
    if (door && door.phase === "decoy") { if (prop === "publicKey") return door.key; if (prop === "isConnected") return true; }
    if (typeof prop !== "string" || typeof value !== "function" || !names.includes(prop)) return undefined;
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
 * With a gate, its connect and disconnect are replaced too, so that a decoy can be shown first; a provider
 * that will not allow that is simply never given one.
 */
export function patchProviderInPlace(provider: any, guard: Guard, gate?: DecoyGate): PatchResult {
  const out: PatchResult = { patched: [], stuck: [] };
  if (!provider || typeof provider !== "object" || isWrapped.has(provider)) return out;
  try { if (gate && !legacyDoors.has(provider) && typeof provider.connect === "function") legacyDoor(gate, provider, (door) => frontProvider(provider, door)); } catch { /* no decoy at a door that cannot be read */ }
  const names: readonly string[] = legacyDoors.has(provider) ? [...PROVIDER_METHODS, ...DECOY_METHODS] : PROVIDER_METHODS;
  for (const name of names) {
    const signing = (PROVIDER_METHODS as readonly string[]).includes(name);
    try {
      // where the method lives: on the object, or on a class prototype
      let holder: any = provider;
      let desc: PropertyDescriptor | undefined;
      for (let depth = 0; holder && holder !== Object.prototype && depth < 8; depth++, holder = Object.getPrototypeOf(holder)) {
        desc = Object.getOwnPropertyDescriptor(holder, name);
        if (desc) break;
      }
      if (!desc || typeof desc.value !== "function") continue; // absent, or an accessor: not something to replace
      if (ours.has(desc.value)) { if (signing) out.patched.push(name); continue; }
      const fn = guardMethod(name, desc.value, guard, () => provider);
      if (!fn) continue;
      ours.add(fn);
      if (holder === provider) {
        if (!desc.configurable && !desc.writable) { if (signing) out.stuck.push(name); continue; }
        Object.defineProperty(provider, name, { ...desc, value: fn });
      } else if (Object.isExtensible(provider)) {
        // an own property on this one object: other instances of the wallet's class are not ours to change
        Object.defineProperty(provider, name, { value: fn, writable: true, configurable: true, enumerable: false });
      } else if (desc.configurable || desc.writable) {
        Object.defineProperty(holder, name, { ...desc, value: fn });
      } else { if (signing) out.stuck.push(name); continue; }
      if (signing) out.patched.push(name);
    } catch { if (signing) out.stuck.push(name); }
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
export function installLegacyHook(win: Record<string, any>, guard: Guard, providers: readonly string[] = PROVIDERS, containers: readonly string[] = CONTAINERS, gate?: DecoyGate): LegacyHook {
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
    const r = patchProviderInPlace(p, guard, gate);
    if (r.stuck.length === 0) { failed.delete(label); return; }
    // frozen: put a stand-in on the holder if the wallet left the property open to that
    try {
      if ("value" in desc && (desc.configurable || desc.writable)) {
        Object.defineProperty(holder, key, { ...desc, value: wrapLegacyProvider(p, guard, gate) });
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
