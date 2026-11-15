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
      // (a field that is there and is not text has not been read: it is made text before this is asked, see ownSignIn)
      else if (input[k] !== undefined && input[k] !== null) pick[k] = "";
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
const onTheirWay = new WeakMap<Guard, Map<string, { hops: number }[]>>();
/**
 * How many doors past the one it was asked at a request may be met. Backpack's Wallet Standard wallet calls its
 * provider's signAndSendTransaction, which calls its own sendAndConfirm: two. Past that it is asked about
 * again, so that a page cannot ride one answered request through door after door.
 */
const MOST_HOPS = 2;
/** The doors a request may be met at on its second hop: Backpack's own names for sending, which its other methods call. Nothing else calls on from a second door. */
const SECOND_HOP = new Set(["send", "sendAndConfirm"]);
const HEX = "0123456789abcdef";
/** What makes two requests the same one. Null for a request Warden cannot read: that is asked about every time. */
function sameAs(r: GuardRequest): string | null {
  if (r.kind === "opaque" || r.bytes.length === 0) return null;
  let out = `${r.kind}:${r.owner}:`;
  for (const b of r.bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

/** What was read does not say what the request says now: it is to be read again, as it now is. */
class ReadAgain extends Error { constructor(public reqs: GuardRequest[]) { super("read again"); } }
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const sameRequests = (a: GuardRequest[], b: GuardRequest[]): boolean => a.length === b.length && a.every((r, i) => r.kind === b[i]!.kind && r.owner === b[i]!.owner && sameBytes(r.bytes, b[i]!.bytes));

/**
 * `again`: reads the request once more at the moment it is about to be handed to the wallet, for a request
 * that is an object of the page's and not plain data (see `readingAgain`). `via`: the name of the provider
 * method this came in through, when it came in through one.
 */
async function guarded<T>(guard: Guard, reqs: GuardRequest[], call: () => T | Promise<T>, again?: () => GuardRequest[], via = ""): Promise<T> {
  let going = onTheirWay.get(guard);
  if (!going) { going = new Map(); onTheirWay.set(guard, going); }
  const passes = going;
  const keys = reqs.map(sameAs);
  /** null: this one was already answered, at the door the wallet was first asked through */
  const tickets: (Ticket | null)[] = [];
  /** How many doors this request has come through already: 0 for one asked about here. */
  const hops: number[] = [];
  try {
    for (const [i, r] of reqs.entries()) { // one at a time: the owner reads one request at a time
      // (a pass for a first hop is taken at any door; one for a second hop only where a wallet's own code goes on to)
      const waiting = keys[i] ? passes.get(keys[i]!) : undefined;
      const at = waiting ? waiting.findIndex((pass) => pass.hops === 1 || SECOND_HOP.has(via)) : -1;
      if (waiting && at >= 0) { hops.push(waiting.splice(at, 1)[0]!.hops); tickets.push(null); continue; }
      hops.push(0);
      tickets.push(await guard(r));
    }
  } catch (e) {
    for (const t of tickets) t?.done(false);
    throw e;
  }
  if (again) {
    const now = again();
    if (!sameRequests(now, reqs)) { for (const t of tickets) t?.done(false); throw new ReadAgain(now); }
  }
  // each request that came this far may be met once more while the wallet works on it, up to MOST_HOPS doors on
  const mine: [string, { hops: number }][] = [];
  keys.forEach((k, i) => { if (k !== null && hops[i]! < MOST_HOPS) mine.push([k, { hops: hops[i]! + 1 }]); });
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

/**
 * What the wallet is handed is what Warden read. A page keeps hold of whatever it passes in: it can write
 * other bytes into the same array, or change a field, while the owner is still being asked. So a request
 * that is plain data (bytes, text, an object of fields) is copied before it is read, and the copy is what
 * goes on to the wallet. The page has nothing that points at the copy.
 */
const isBytes = (x: unknown): boolean => x instanceof Uint8Array || ArrayBuffer.isView(x) || x instanceof ArrayBuffer;
const ownBytes = (x: unknown): Uint8Array => Uint8Array.from(toBytes(x));
/**
 * A message as it was handed over, read once. Text stays text (Backpack's off-chain message is text) and
 * bytes, in whatever form they came, become Warden's own array of them. An object that carries a message
 * among other fields (the off-chain form) is copied field by field.
 */
function ownMessage(m: any): any {
  if (typeof m === "string") return m;
  if (isBytes(m) || Array.isArray(m)) return ownBytes(m);
  if (!m || typeof m !== "object") return m;
  const copy = ownFields(m);
  if ("message" in copy && typeof copy.message !== "string") copy.message = ownBytes(copy.message);
  return copy;
}
/** The bytes that a message, as ownMessage left it, asks to have signed. */
function messageBytes(m: any): Uint8Array {
  if (typeof m === "string") return new TextEncoder().encode(m);
  if (isBytes(m)) return toBytes(m);
  if (m && typeof m === "object" && "message" in m) return typeof m.message === "string" ? new TextEncoder().encode(m.message) : toBytes(m.message);
  return new Uint8Array(0);
}
/** A Wallet Standard input with each of its fields read once, and its bytes Warden's own. */
function ownInput(i: any, field: "transaction" | "message"): any {
  if (!i || typeof i !== "object") return i;
  const copy = { ...i };
  if (field in copy) copy[field] = field === "message" ? ownMessage(copy[field]) : ownBytes(copy[field]);
  return copy;
}
/** An object of plain fields, or a list, with each of its entries read once and any bytes among them Warden's own. */
function ownFields(i: any): any {
  if (!i || typeof i !== "object" || isBytes(i)) return i;
  const own = (x: unknown) => (isBytes(x) ? ownBytes(x) : Array.isArray(x) ? x.map((y: unknown) => (isBytes(y) ? ownBytes(y) : y)) : x);
  if (Array.isArray(i)) return i.map(own);
  const copy = { ...i };
  for (const k of Object.keys(copy)) copy[k] = own(copy[k]);
  return copy;
}
/** The fields of a sign-in request that decide what is signed. */
const SIGN_IN_FIELDS = ["domain", "address", "statement", "uri", "chainId"] as const;
/**
 * A sign-in request with each field read once. A deciding field that is there and is not text is made text,
 * here, once: a wallet that would have taken `["other-site.example"]` for a domain is handed the text that
 * Warden read, and a field cannot be one thing to Warden and another to the wallet.
 */
function ownSignIn(i: any): any {
  if (!i || typeof i !== "object") return i;
  const copy = ownFields(i);
  for (const k of SIGN_IN_FIELDS) { if (copy[k] !== undefined && copy[k] !== null && typeof copy[k] !== "string") { try { copy[k] = String(copy[k]); } catch { copy[k] = ""; } } }
  return copy;
}
/**
 * A transaction handed to an injected provider is an object of the page's, and what it says when the wallet
 * asks it is the page's to decide: it cannot be copied without the wallet's own library. It is read again
 * at the moment it is handed on; if it says something else by then, that is what the owner is asked about,
 * and a request that will not hold still is refused. (An object written to answer differently the third
 * time, when the wallet asks, is not caught by this. The README says so.)
 */
async function readingAgain<T>(guard: Guard, read: () => GuardRequest[], call: () => T | Promise<T>, via = ""): Promise<T> {
  let reqs = read();
  for (let round = 0; round < 3; round++) {
    try { return await guarded(guard, reqs, call, read, via); } catch (e) { if (!(e instanceof ReadAgain)) throw e; reqs = e.reqs; }
  }
  throw new WardenRejected("Blocked by Lamport Warden: this request kept changing while it was being read");
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

/**
 * The accounts that must sign a serialized transaction, base58: the first keys of its message. Null when it is
 * not in a form read here (version 1, or not a transaction).
 */
export function signersIn(tx: Uint8Array): string[] | null {
  try {
    if (tx.length < 70 || tx[0] === 0x81) return null;
    const slots = tx[0]!;
    if (slots === 0 || slots > 127) return null;
    let at = 1 + 64 * slots;
    if (tx[at]! & 0x80) at += 1; // version 0 has a version byte before the header
    const required = tx[at]!;
    at += 3;
    let count = tx[at]!;
    at += 1;
    if (count & 0x80) { count = (count & 0x7f) | (tx[at]! << 7); at += 1; }
    if (required === 0 || required > count || tx.length < at + 32 * required) return null;
    return Array.from({ length: required }, (_, i) => toBase58(tx.subarray(at + 32 * i, at + 32 * (i + 1))));
  } catch { return null; }
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

/** One Solana signing feature with its method asking the guard first; any other feature as it is. */
function guardFeature(name: string, feature: any, guard: Guard, wallet: any): any {
  if (!feature || typeof feature !== "object") return feature;
  const method = name.slice(7); // "solana:signTransaction" -> "signTransaction"
  const original = feature[method];
  if (typeof original !== "function" || ours.has(original)) return feature;
  /**
   * An input copied (see ownInput), with whose request it is settled once: `owner` is the account it is read
   * as, and the account handed on to the wallet is the wallet's own object for that account, where it lists
   * one. What a page's account object says cannot differ between Warden's reading and the wallet's.
   */
  const settled = (i: any, field: "transaction" | "message"): { input: any; owner: string } => {
    const input = ownInput(i, field);
    const said = named(input); // read once: an account object of the page's can say one address now and another later
    const owner = ownerAt(wallet, said);
    // (an account the wallet does not list is handed on as the page gave it: a wallet that checks refuses it, as
    // it always did, and one that does not check signs as its own, which is the side this was read from)
    if (input && typeof input === "object" && owner && owner === said) {
      let listed: any;
      try { listed = Array.from(wallet?.accounts ?? []).find((a: any) => a?.address === owner); } catch { /* a list that cannot be read lists nobody */ }
      if (listed) input.account = listed;
    }
    return { input, owner };
  };
  let fn: AnyFn;
  if (name === SIGN_TX || name === SIGN_SEND) fn = (...inputs: any[]) => { const mine = inputs.map((i) => settled(i, "transaction")); return guarded(guard, mine.map((m) => ({ kind: "tx" as const, bytes: toBytes(m.input?.transaction), owner: m.owner })), () => original.apply(feature, mine.map((m) => m.input))); };
  else if (name === SIGN_MSG || name === SIGN_OFFCHAIN) fn = (...inputs: any[]) => { const mine = inputs.map((i) => settled(i, "message")); return guarded(guard, mine.map((m) => ({ kind: "msg" as const, bytes: messageBytes(m.input?.message), owner: m.owner })), () => original.apply(feature, mine.map((m) => m.input))); };
  // Sign-in may be called with no input at all: the wallet then signs in to the site it is on. It is the
  // wallet's own account that signs in, whatever address the request carries (that address is in what is read).
  else if (name === SIGN_IN) fn = (...inputs: any[]) => { const mine = inputs.map(ownSignIn); return guarded(guard, (mine.length ? mine : [undefined]).map((i) => ({ kind: "signin" as const, bytes: signInBytes(i), owner: ownerAt(wallet, "") })), () => original.apply(feature, mine)); };
  else return feature;
  ours.add(fn);
  // a copy with the feature's own getters still getters: Backpack's `supportedTransactionVersions` is one, and changes when the wallet has finished loading
  const own = Object.getOwnPropertyDescriptors(feature);
  own[method] = { value: fn, writable: true, enumerable: true, configurable: true };
  const out = Object.defineProperties({}, own);
  return Object.isFrozen(feature) ? Object.freeze(out) : out;
}

/** The wallet's features with the signing ones guarded. The same features object always gives the same answer. */
function guardFeatures(features: any, guard: Guard, cache: WeakMap<object, object>, wallet: any): any {
  if (!features || typeof features !== "object") return features;
  const cached = cache.get(features);
  if (cached) return cached;
  const out: Record<string, any> = {};
  for (const k of Object.keys(features)) out[k] = guardFeature(k, features[k], guard, wallet);
  const done = Object.isFrozen(features) ? Object.freeze(out) : out;
  cache.set(features, done);
  cache.set(done, done); // handed back to us, it is already guarded
  return done;
}

/** A stand-in for a Wallet Standard wallet: used when the wallet's own object cannot be changed. */
export function wrapStandardWallet<W extends StandardWallet>(wallet: W, guard: Guard): W {
  if (!wallet || typeof wallet !== "object" || isWrapped.has(wallet)) return wallet;
  const seen = wrapped.get(wallet);
  if (seen) return seen as W;
  const cache = new WeakMap<object, object>();
  return standIn(wallet, (prop, value) => (prop === "features" && value && typeof value === "object" ? guardFeatures(value, guard, cache, wallet) : undefined));
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
export function patchStandardWalletInPlace(wallet: any, guard: Guard): boolean {
  if (!wallet || typeof wallet !== "object") return false;
  if (patchedWallets.has(wallet) || isWrapped.has(wallet)) return true;
  try {
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
      const guardedGet = function (this: any) { return guardFeatures(get.call(this), guard, cache, this); };
      patchedGetters.add(guardedGet);
      if (holder !== wallet && Object.isExtensible(wallet)) Object.defineProperty(wallet, "features", { get: guardedGet, set: desc.set, enumerable: desc.enumerable, configurable: true });
      else if (desc.configurable) Object.defineProperty(holder, "features", { ...desc, get: guardedGet });
      else return false;
    } else if (holder === wallet && (desc.writable || desc.configurable)) {
      Object.defineProperty(wallet, "features", { ...desc, value: guardFeatures(desc.value, guard, cache, wallet) });
    } else if (holder !== wallet && Object.isExtensible(wallet)) {
      Object.defineProperty(wallet, "features", { value: guardFeatures(desc.value, guard, cache, wallet), writable: true, enumerable: true, configurable: true });
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
export function installStandardHook(win: HookWindow, guard: Guard): StandardHook {
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
      if (patchStandardWalletInPlace(w, guard)) stuck.delete(w); else stuck.add(w);
    }
    return () => {};
  };
  const ourApi = Object.freeze({ register: meet });
  const standInApi = (api: any) => Object.freeze({ register: (...wallets: any[]) => api.register(...wallets.map((w) => (stuck.has(w) ? wrapStandardWallet(w, guard) : w))) });
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
  const owner = (that: any) => ownerOf(self() ?? that);
  /**
   * Whose side a request is read from. The provider's own account, always. Backpack's methods also take the
   * account to sign with as an argument, and then the request is read from that account's side as well: both.
   * Which wallet this is is not asked of the provider (a page can make any provider say it is Backpack, and
   * Phantom, which ignores the argument, would then have its request read from a side it does not sign from).
   * Read from both sides, whichever account the wallet signs with has been read.
   */
  /**
   * An account named in a call, read once and the way Backpack reads one (text as it is; bytes as the key they
   * are; anything else by its toBase58()). `said` is the address when it is one. `handOn` is what goes to the
   * wallet in the argument's place: the text that was read, so that the wallet reads what Warden read and not
   * the page's object a second time; and for an object that names no account, its other fields as they were
   * at this one look.
   */
  const accountIn = (x: unknown): { said: string | null; handOn: unknown } => {
    if (x === undefined || x === null) return { said: null, handOn: x };
    const address = (t: string) => (fromBase58(t)?.length === 32 ? t : null);
    if (typeof x === "string") return { said: address(x), handOn: x };
    if (typeof x !== "object" && typeof x !== "function") return { said: null, handOn: x };
    try {
      if (isBytes(x)) { const bytes = ownBytes(x); const text = bytes.length === 32 ? toBase58(bytes) : null; return { said: text, handOn: text ?? bytes }; }
      const read = (x as any).toBase58;
      if (typeof read === "function") { const text = String(read.call(x)); return { said: address(text), handOn: text }; }
      // It names no account at this look. What goes on is its other fields, each read once, and no toBase58
      // at all: a second look at the page's own object could find one there.
      const rest: Record<string, unknown> = {};
      for (const k of Object.keys(x as object)) if (k !== "toBase58") rest[k] = (x as any)[k];
      return { said: null, handOn: rest };
    } catch { return { said: null, handOn: undefined }; }
  };
  /**
   * Whose side a request is read from. The provider's own account, and when another account is named in the
   * call (Backpack's methods take the account to sign with as an argument), that one's as well. Which wallet
   * this is is not asked of the provider: a page can make any provider say it is Backpack, and Phantom, which
   * ignores the argument, would then have its request read from a side it does not sign from. Read from both
   * sides, whichever account the wallet signs with has been read.
   */
  const sides = (that: any, named: string | null): string[] => { const own = owner(that); return named && named !== own ? [own, named] : [own]; };
  /**
   * Of two sides, the ones that sign. A transaction says which accounts must sign it. An account that is not
   * among them authorises nothing in it, so reading it from that side says only that it is not that account's
   * to sign, which would refuse an honest request made of the other account. When the signers cannot be read,
   * or neither side is one, both sides are read.
   */
  const signing = (who: string[], bytes: Uint8Array): string[] => {
    if (who.length < 2) return who;
    const signers = signersIn(bytes);
    const are = signers ? who.filter((w) => signers.includes(w)) : [];
    return are.length ? are : who;
  };
  /** A transaction as bytes is Warden's own copy from here on; as an object it is the page's, and is read again when handed on. */
  const txOf = (tx: any, who: string[]): { mine: any; read: () => GuardRequest[] } => {
    if (isBytes(tx)) { const mine = ownBytes(tx); return { mine, read: () => signing(who, mine).map((w) => ({ kind: "tx" as const, bytes: mine, owner: w })) }; }
    return { mine: tx, read: () => { const bytes = serializeForGuard(tx); return signing(who, bytes).map((w) => ({ kind: "tx" as const, bytes, owner: w })); } };
  };
  /** The arguments after the first, with the one that names an account replaced by what was read of it. */
  const withAccount = (rest: any[], at: number, handOn: unknown): any[] => { if (rest.length <= at) return rest; const out = rest.slice(); out[at] = handOn; return out; };
  switch (name) {
    case "signTransaction":
    case "signAndSendTransaction":
      return function (this: any, tx: any, ...rest: any[]) {
        // (Backpack: signTransaction(tx, account, ...); its signAndSendTransaction takes options there, which are not an account)
        const account = name === "signTransaction" ? accountIn(rest[0]) : null;
        const one = txOf(tx, sides(this, account?.said ?? null));
        const args = account ? withAccount(rest, 0, account.handOn) : rest;
        return readingAgain(guard, () => one.read(), () => run(this, [one.mine, ...args]), name);
      };
    case "send":
    case "sendAndConfirm":
      // Backpack's own: (tx, signers, options, connection, account). They sign and send, like signAndSendTransaction.
      // Another wallet's `send` may be an older way of making any request by name, so a call whose first
      // argument is plain text or a number is left as it is: nothing signs one of those. Anything else is
      // taken for a transaction, whatever it looks like at this moment; what cannot be read as one is refused.
      return function (this: any, tx: any, ...rest: any[]) {
        if (tx === null || (typeof tx !== "object" && typeof tx !== "function")) return run(this, [tx, ...rest]);
        const account = accountIn(rest[3]);
        const one = txOf(tx, sides(this, account.said));
        return readingAgain(guard, () => one.read(), () => run(this, [one.mine, ...withAccount(rest, 3, account.handOn)]), name);
      };
    case "signAllTransactions":
    case "signAndSendAllTransactions":
    case "sendAll":
      return function (this: any, txs: any[], ...rest: any[]) {
        // sendAll takes a list of { tx, signers }; anything under that name that is not a list is left as it is
        if (name === "sendAll" && !Array.isArray(txs)) return run(this, [txs, ...rest]);
        // (the list itself is copied too: nothing can be added to it after it was read)
        const account = name === "sendAll" ? null : accountIn(rest[0]);
        const who = sides(this, account?.said ?? null);
        const all = Array.from(txs ?? []).map((entry) => {
          if (name === "sendAll" && entry && typeof entry === "object" && !isBytes(entry) && "tx" in entry) { const copy = { ...entry }; const t = txOf(copy.tx, who); copy.tx = t.mine; return { mine: copy, read: t.read }; }
          return txOf(entry, who);
        });
        const args = account ? withAccount(rest, 0, account.handOn) : rest;
        return readingAgain(guard, () => all.flatMap((t) => t.read()), () => run(this, [all.map((t) => t.mine), ...args]), name);
      };
    case "signMessage":
    case "signOffchainMessage":
      return function (this: any, message: any, ...rest: any[]) {
        const mine = ownMessage(message);
        const bytes = messageBytes(mine);
        // (signMessage's second argument is how to show the message on most wallets, and the account on Backpack: text either way)
        const account = name === "signMessage" ? accountIn(rest[0]) : null;
        const args = account ? withAccount(rest, 0, account.handOn) : rest;
        return guarded(guard, sides(this, account?.said ?? null).map((w) => ({ kind: "msg" as const, bytes, owner: w })), () => run(this, [mine, ...args]));
      };
    case "signIn":
      return function (this: any, input: any, ...rest: any[]) {
        const mine = ownSignIn(input);
        return guarded(guard, [{ kind: "signin", bytes: signInBytes(mine), owner: owner(this) }], () => run(this, [mine, ...rest]));
      };
    case "request":
      return function (this: any, arg: any, ...rest: any[]) {
        // read once: what is decided on here is what the wallet is handed, whether or not it is a signing call
        const mine = arg && typeof arg === "object" && !Array.isArray(arg) ? { ...arg } : arg;
        if (requestsOf(mine, "") === null) return run(this, [mine, ...rest]);
        mine.params = /^signIn$/i.test(String(mine.method)) ? ownSignIn(mine.params) : ownFields(mine.params);
        const reqs = requestsOf(mine, owner(this));
        return reqs ? guarded(guard, reqs, () => run(this, [mine, ...rest])) : run(this, [mine, ...rest]);
      };
    default:
      return null;
  }
}

export const PROVIDER_METHODS = ["signTransaction", "signAndSendTransaction", "signAllTransactions", "signAndSendAllTransactions", "signMessage", "signOffchainMessage", "signIn", "request", "send", "sendAndConfirm", "sendAll"] as const;

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
