/**
 * Three stand-in wallets, each put on the page the way the real one does it (read from the shipped Phantom
 * 26.38, Solflare 2.43 and Backpack 0.10 extensions): the same Object.defineProperty calls, the same frozen
 * objects, and registration through the published @wallet-standard/wallet. They sign nothing. Every call that
 * reaches one is recorded in window.__calls, which is how a test knows whether Warden let it through.
 *
 * ?late=1 in the page address makes them arrive 400 ms after the page started, like a wallet whose script is
 * loaded from a tag. ?only=phantom (or solflare, backpack) injects one. ?fresh=1 is a site none of them has
 * met: nobody is connected until the page connects, as on a real first visit. Without it they stand as on a
 * site the wallet already trusts, connected from the start.
 */
import { registerWallet } from "@wallet-standard/wallet";

const w = window as any;
w.__calls = w.__calls ?? [];
/** Above zero while a wallet's Wallet Standard code is calling its own injected provider: that is the wallet's own business, and not recorded. */
let inside = 0;
const called = (door: string, method: string) => { if (!inside) w.__calls.push(`${door}.${method}`); };
/**
 * Phantom's and Backpack's Wallet Standard wallets answer by calling their own injected provider's public
 * methods (`await this.#provider.signTransaction(VersionedTransaction.deserialize(transaction))`), looked up
 * at the moment of the call: so what they call is whatever stands there, Warden's guard included.
 */
const handOn = async <T>(call: () => Promise<T>): Promise<T> => { inside += 1; try { return await call(); } finally { inside -= 1; } };
const txObject = (bytes: Uint8Array) => ({ version: 0, message: { serialize: () => new Uint8Array(1) }, serialize: () => bytes });
const ADDRESS = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB"; // fixtures.owner in the tests
const account = Object.freeze({ address: ADDRESS, publicKey: new Uint8Array(32), chains: ["solana:mainnet"], features: [] });
const publicKey = { toBase58: () => ADDRESS, toString: () => ADDRESS, toBytes: () => new Uint8Array(32) };
const params = new URLSearchParams(location.search);
const fresh = params.get("fresh") === "1";

type Fn = (...a: any[]) => any;
/** As much of an event emitter as the real providers have: the listeners are kept where a page cannot reach them. */
class Emitter {
  #l = new Map<string, [Fn, unknown][]>();
  on(e: string, f: Fn, ctx?: unknown) { this.#l.set(e, [...(this.#l.get(e) ?? []), [f, ctx]]); return this; }
  addListener(e: string, f: Fn, ctx?: unknown) { return this.on(e, f, ctx); }
  off(e: string, f: Fn) { this.#l.set(e, (this.#l.get(e) ?? []).filter(([x]) => x !== f)); return this; }
  removeListener(e: string, f: Fn) { return this.off(e, f); }
  emit(e: string, ...a: unknown[]) { for (const [f, ctx] of [...(this.#l.get(e) ?? [])]) f.apply(ctx ?? this, a); return true; }
  listeners(e: string) { return (this.#l.get(e) ?? []).map(([f]) => f); }
}

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

const features = (door: string, provider?: any) => ({
  "standard:connect": { version: "1.0.0", connect: async () => { called(door, "connect"); return { accounts: [account] }; } },
  "standard:events": { version: "1.0.0", on: () => () => {} },
  "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: async (...inputs: any[]) => {
    called(door, "signTransaction");
    if (provider) await handOn(() => (inputs.length === 1 ? provider.signTransaction(txObject(inputs[0].transaction)) : provider.signAllTransactions(inputs.map((i) => txObject(i.transaction)))));
    return inputs.map((i) => ({ signedTransaction: i.transaction }));
  } },
  "solana:signAndSendTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signAndSendTransaction: async (...inputs: any[]) => {
    called(door, "signAndSendTransaction");
    if (provider) for (const i of inputs) await handOn(() => provider.signAndSendTransaction(txObject(i.transaction)));
    return inputs.map(() => ({ signature: new Uint8Array(64) }));
  } },
  "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs: any[]) => {
    called(door, "signMessage");
    if (provider) for (const i of inputs) await handOn(() => provider.signMessage(i.message));
    return inputs.map((i) => ({ signedMessage: i.message, signature: new Uint8Array(64) }));
  } },
  "solana:signIn": { version: "1.0.0", signIn: async (...inputs: any[]) => {
    called(door, "signIn");
    if (provider) for (const i of inputs.length ? inputs : [undefined]) await handOn(() => provider.signIn(i ? { ...i } : i));
    return inputs.map(() => ({ account, signedMessage: new Uint8Array(1), signature: new Uint8Array(64) }));
  } },
});

const base = { version: "1.0.0", icon: "data:image/svg+xml;base64,PHN2Zy8+", chains: ["solana:mainnet"] } as const;

/**
 * A Wallet Standard wallet that follows its provider, as Phantom's and Backpack's do: it listens to the
 * provider's events and takes its account from the provider's `publicKey`, and its connect and disconnect
 * are calls to the provider's own.
 */
function following(door: string, provider: any) {
  let current: any = null, listeners: Fn[] = [];
  const tell = () => { for (const l of [...listeners]) l({ accounts: current ? [current] : [] }); };
  const connected = () => {
    const address = provider.publicKey?.toBase58();
    if (!address || current?.address === address) return;
    current = address === ADDRESS ? account : Object.freeze({ address, publicKey: provider.publicKey.toBytes(), chains: ["solana:mainnet"], features: [] });
    tell();
  };
  const disconnected = () => { if (current) { current = null; tell(); } };
  provider.on("connect", connected);
  provider.on("disconnect", disconnected);
  provider.on("accountChanged", () => (provider.publicKey ? connected() : disconnected()));
  connected();
  return {
    accounts: () => (current ? [current] : []),
    features: () => ({
      ...features(door, provider),
      "standard:connect": { version: "1.0.0", connect: async ({ silent }: { silent?: boolean } = {}) => { called(door, "connect"); if (!current) await handOn(() => provider.connect(silent ? { onlyIfTrusted: true } : undefined)); connected(); return { accounts: current ? [current] : [] }; } },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => { called(door, "disconnect"); await handOn(() => provider.disconnect()); } },
      "standard:events": { version: "1.0.0", on: (_e: string, l: Fn) => { listeners.push(l); return () => { listeners = listeners.filter((x) => x !== l); }; } },
    }),
  };
}

function phantom() {
  // The provider (Phantom 26.38): one open object, on the window twice. Its methods are its own properties;
  // `publicKey` and `isConnected` are getters on a class above it, and the event emitter is above that.
  class Base extends Emitter {
    _publicKey: any = fresh ? null : publicKey;
    get publicKey() { return this._publicKey; }
    get isConnected() { return this._publicKey !== null; }
  }
  class Provider extends Base {
    isPhantom = true;
    constructor() {
      super();
      Object.assign(this, methods("solana"), {
        connect: async (o?: { onlyIfTrusted?: boolean }) => { if (o?.onlyIfTrusted && this._publicKey === null) throw new Error("User rejected the request."); called("solana", "connect"); this._publicKey = publicKey; this.emit("connect", this._publicKey); return { publicKey: this._publicKey }; },
        disconnect: async () => { called("solana", "disconnect"); this._publicKey = null; this.emit("disconnect"); },
      });
    }
  }
  const provider: any = new Provider();
  Object.defineProperty(window, "solana", { value: provider, writable: false });
  if (!("phantom" in window)) Object.defineProperty(window, "phantom", { value: {}, writable: false });
  Object.defineProperty(w.phantom, "solana", { value: provider, writable: false });
  // announced before its Wallet Standard wallet exists, which is the order Phantom does it in
  window.dispatchEvent(new Event("phantom#initialized"));
  // the Wallet Standard wallet: a frozen instance, `accounts` and `features` getters on the class
  const state = following("standard:FixturePhantom", provider);
  class PhantomWallet {
    readonly version = base.version; readonly name = "FixturePhantom"; readonly icon = base.icon; readonly chains = base.chains;
    get accounts() { return state.accounts(); }
    get features() { return state.features(); }
    constructor() { Object.freeze(this); }
  }
  registerWallet(new PhantomWallet() as any);
}

function solflare() {
  // the provider: a class instance whose methods are bound own properties, frozen behind a proxy
  class Provider { isSolflare = true; publicKey = publicKey; constructor() { Object.assign(this, methods("solflare")); } }
  const proxy = new Proxy(new Provider(), { deleteProperty: () => true, get: (t: any, k) => t[k] });
  Object.defineProperty(window, "solflare", { value: Object.freeze(proxy), enumerable: true });
  const door = "standard:FixtureSolflare";
  let listeners: Fn[] = [];
  class SolflareWallet {
    readonly version = base.version; readonly name = "FixtureSolflare"; readonly icon = base.icon; readonly chains = base.chains;
    #accounts: unknown[] = fresh ? [] : [account];
    get accounts() { return this.#accounts; }
    get features() {
      return {
        ...features(door),
        "standard:connect": { version: "1.0.0", connect: async ({ silent }: { silent?: boolean } = {}) => { called(door, "connect"); if (!this.#accounts.length && !silent) { this.#accounts = [account]; for (const l of [...listeners]) l({ accounts: this.#accounts }); } return { accounts: this.#accounts }; } },
        "standard:events": { version: "1.0.0", on: (_e: string, l: Fn) => { listeners.push(l); return () => { listeners = listeners.filter((x) => x !== l); }; } },
      };
    }
  }
  registerWallet(new SolflareWallet() as any);
}

function backpack() {
  // The provider (Backpack 0.10): a frozen object with nothing of its own. Its methods, and the `publicKey`
  // and `isConnected` getters, are on its class; the key is in a private field; and it tells its listeners
  // the address in an object. The frozen container on the window forwards to it.
  class Inner extends Emitter {
    #key: any = fresh ? null : publicKey;
    constructor() { super(); Object.freeze(this); }
    get isBackpack() { return true; }
    get publicKey() { return this.#key; }
    get isConnected() { return this.#key !== null; }
    async connect(o?: { onlyIfTrusted?: boolean }) { if (o?.onlyIfTrusted && this.#key === null) throw new Error("not trusted"); called("backpack", "connect"); this.#key = publicKey; this.emit("connect", { publicKey: ADDRESS }); return { publicKey: this.#key }; }
    async disconnect() { called("backpack", "disconnect"); this.#key = null; this.emit("disconnect"); }
  }
  for (const [name, f] of Object.entries(methods("backpack"))) if (name !== "connect") Object.defineProperty(Inner.prototype, name, { value: f, writable: true, configurable: true });
  const inner: any = new Inner();
  const box = Object.freeze({ solana: inner, ethereum: Object.freeze({}) });
  const z = new Proxy(box, { get: (t: any, k) => { if (Reflect.has(t, k)) return Reflect.get(t, k); const v = t.solana[k]; return typeof v === "function" ? v.bind(t.solana) : v; } });
  try { Object.defineProperty(window, "backpack", { value: z }); } catch { /* as Backpack does */ }
  // the Wallet Standard wallet: an open object of plain properties, with `accounts` a getter
  const state = following("standard:FixtureBackpack", inner);
  registerWallet({ ...base, name: "FixtureBackpack", get accounts() { return state.accounts(); }, features: state.features() } as any);
}

const only = params.get("only");
const inject = () => { for (const [name, f] of [["phantom", phantom], ["solflare", solflare], ["backpack", backpack]] as const) if (!only || only === name) f(); };
if (params.get("none") === "1") { /* a page with Warden and no wallet */ } else if (params.get("late") === "1") setTimeout(inject, 400); else inject();
