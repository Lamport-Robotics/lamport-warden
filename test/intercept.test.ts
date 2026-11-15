import { describe, it, expect } from "vitest";
import { WardenRejected, fromBase58, installLegacyHook, installStandardHook, messageToTransaction, patchProviderInPlace, patchStandardWalletInPlace, requestsOf, serializeForGuard, wrapLegacyProvider, wrapStandardWallet, type Guard, type GuardRequest } from "../src/intercept.js";

/** A guard that records what it was asked and what it was told afterwards. */
function recorder(decide: (r: GuardRequest) => boolean = () => true) {
  const asked: GuardRequest[] = [];
  const done: boolean[] = [];
  const guard: Guard = async (r) => { asked.push(r); if (!decide(r)) throw new WardenRejected(); return { done: (s) => { done.push(s); } }; };
  return { guard, asked, done };
}

const account = { address: "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB" };

/** A wallet the way real ones are written: a class with private state behind getters. */
class FakeWallet {
  #calls: string[] = [];
  #accounts = [account];
  readonly version = "1.0.0";
  readonly name = "Fake";
  fail = false;
  get accounts() { return this.#accounts; }
  get calls() { return this.#calls; }
  get features() {
    return {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: this.#accounts }) },
      "solana:signTransaction": { version: "1.0.0", signTransaction: async (...inputs: any[]) => { this.#calls.push("signTransaction"); if (this.fail) throw new Error("user rejected"); return inputs.map((i) => ({ signedTransaction: i.transaction })); } },
      "solana:signAndSendTransaction": { version: "1.0.0", signAndSendTransaction: async (...inputs: any[]) => { this.#calls.push("signAndSendTransaction"); return inputs.map(() => ({ signature: new Uint8Array(64) })); } },
      "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs: any[]) => { this.#calls.push("signMessage"); return inputs.map((i) => ({ signedMessage: i.message, signature: new Uint8Array(64) })); } },
    };
  }
}

describe("wrapping a Wallet Standard wallet", () => {
  it("asks the guard before a transaction reaches the wallet, and reports that it was signed", async () => {
    const w = new FakeWallet(), r = recorder();
    const wrapped = wrapStandardWallet(w as any, r.guard);
    const tx = Uint8Array.from([1, 2, 3]);
    const out = await wrapped.features["solana:signTransaction"].signTransaction({ account, transaction: tx, chain: "solana:mainnet" });
    expect(r.asked).toEqual([{ kind: "tx", bytes: tx, owner: account.address }]);
    expect(w.calls).toEqual(["signTransaction"]);
    // (the wallet was handed Warden's own copy of the bytes, not the page's array: see "what the wallet is handed")
    expect([...out[0].signedTransaction]).toEqual([...tx]);
    expect(out[0].signedTransaction).not.toBe(tx);
    expect(r.done).toEqual([true]);
  });

  it("never lets a refused request reach the wallet", async () => {
    const w = new FakeWallet(), r = recorder(() => false);
    const wrapped = wrapStandardWallet(w as any, r.guard);
    await expect(wrapped.features["solana:signAndSendTransaction"].signAndSendTransaction({ account, transaction: new Uint8Array(4) })).rejects.toBeInstanceOf(WardenRejected);
    await expect(wrapped.features["solana:signMessage"].signMessage({ account, message: new Uint8Array(4) })).rejects.toBeInstanceOf(WardenRejected);
    expect(w.calls).toEqual([]);
    expect(r.done).toEqual([]);
  });

  it("checks every transaction of a batch, and stops the whole batch on one refusal", async () => {
    const w = new FakeWallet();
    let n = 0;
    const r = recorder(() => ++n < 2);
    const wrapped = wrapStandardWallet(w as any, r.guard);
    await expect(wrapped.features["solana:signTransaction"].signTransaction({ account, transaction: Uint8Array.of(1) }, { account, transaction: Uint8Array.of(2) })).rejects.toBeInstanceOf(WardenRejected);
    expect(r.asked).toHaveLength(2);
    expect(w.calls).toEqual([]);
    expect(r.done).toEqual([false]); // the one already let through is told nothing was signed
  });

  it("reports no signature when the wallet itself declines", async () => {
    const w = new FakeWallet(), r = recorder();
    w.fail = true;
    const wrapped = wrapStandardWallet(w as any, r.guard);
    await expect(wrapped.features["solana:signTransaction"].signTransaction({ account, transaction: Uint8Array.of(1) })).rejects.toThrow("user rejected");
    expect(r.done).toEqual([false]);
  });

  it("guards messages, and leaves everything else exactly as the wallet made it", async () => {
    const w = new FakeWallet(), r = recorder();
    const wrapped = wrapStandardWallet(w as any, r.guard);
    const message = new TextEncoder().encode("hello");
    await wrapped.features["solana:signMessage"].signMessage({ account, message });
    expect(r.asked).toEqual([{ kind: "msg", bytes: message, owner: account.address }]);
    expect(wrapped.name).toBe("Fake");
    expect(wrapped.accounts).toEqual([account]);           // a getter over a private field still works through the wrapper
    expect(Object.keys(wrapped.features)).toEqual(Object.keys(w.features));
    expect((await wrapped.features["standard:connect"].connect()).accounts).toEqual([account]);
    expect(wrapStandardWallet(w as any, r.guard)).toBe(wrapped); // one wrapper per wallet
    expect(wrapStandardWallet(wrapped, r.guard)).toBe(wrapped);  // never wrapped twice
  });
});

/** A window as far as the hooks need one. */
function fakeWindow() {
  const w = new EventTarget() as EventTarget & { CustomEvent: typeof CustomEvent };
  w.CustomEvent = CustomEvent;
  return w as unknown as Window & { CustomEvent: typeof CustomEvent };
}

/** Wallets as the three real ones are built (see test/browser for the real ones themselves). */
const sign = (calls: string[]) => ({ "solana:signTransaction": { version: "1.0.0", signTransaction: async (...i: any[]) => { calls.push("signTransaction"); return i.map((x) => ({ signedTransaction: x.transaction })); } }, "solana:signMessage": { version: "1.0.0", signMessage: async (...i: any[]) => { calls.push("signMessage"); return i; } }, "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) } });
/** Phantom: a frozen instance, `features` a getter on the class that builds a new object each time. */
const phantomLike = () => { class PhantomLike { #calls: string[] = []; readonly name = "Phantom"; constructor() { Object.freeze(this); } get calls() { return this.#calls; } get features() { return sign(this.#calls); } } return new PhantomLike(); }; // a class per page: the getter on it is what gets replaced
/** Solflare: an open instance with the same kind of getter. */
class SolflareLike { #calls: string[] = []; readonly name = "Solflare"; get calls() { return this.#calls; } get features() { return sign(this.#calls); } }
/** Backpack: `features` is an own, writable property. */
const backpackLike = () => { const calls: string[] = []; return { name: "Backpack", calls, features: sign(calls) }; };

/** An app as @wallet-standard/app writes it: listen for wallets, then announce yourself. */
function app(win: Window) {
  const registered: any[] = [];
  const api = Object.freeze({ register: (...ws: any[]) => { for (const w of ws) if (!registered.includes(w)) registered.push(w); return () => {}; } });
  win.addEventListener("wallet-standard:register-wallet", (e) => (e as CustomEvent).detail(api));
  win.dispatchEvent(new UnstoppableEvent("wallet-standard:app-ready", api));
  return registered;
}
/** A wallet as @wallet-standard/wallet writes it: announce yourself, then listen for apps. */
function announce(win: Window, wallet: object) {
  const callback = ({ register }: any) => register(wallet);
  win.dispatchEvent(new UnstoppableEvent("wallet-standard:register-wallet", callback));
  win.addEventListener("wallet-standard:app-ready", (e) => callback((e as CustomEvent).detail));
}

/**
 * The events as @wallet-standard/wallet and @wallet-standard/app publish them: they refuse to be stopped.
 * (The published classes also override stopPropagation; Node's own stopImmediatePropagation calls that one,
 * which a browser's does not, so it is left out here. test/browser runs the real classes in Chromium.)
 */
class UnstoppableEvent extends Event {
  #detail: unknown;
  get detail() { return this.#detail; }
  constructor(type: string, detail: unknown) { super(type, { bubbles: false, cancelable: false, composed: false }); this.#detail = detail; }
  override preventDefault(): never { throw new Error("preventDefault cannot be called"); }
  override stopImmediatePropagation(): never { throw new Error("stopImmediatePropagation cannot be called"); }
}

describe("the Wallet Standard hook", () => {
  const makers: [string, () => any][] = [["Phantom", phantomLike], ["Solflare", () => new SolflareLike()], ["Backpack", backpackLike]];
  // every order the three scripts can load in: the wallet's, Warden's, the page's app
  const orders: [string, (win: Window, w: object, guard: Guard) => any[]][] = [
    ["Warden, wallet, app", (win, w, g) => { installStandardHook(win as any, g); announce(win, w); return app(win); }],
    ["wallet, Warden, app", (win, w, g) => { announce(win, w); installStandardHook(win as any, g); return app(win); }],
    ["Warden, app, wallet", (win, w, g) => { installStandardHook(win as any, g); const r = app(win); announce(win, w); return r; }],
  ];
  for (const [walletName, make] of makers) {
    for (const [orderName, run] of orders) {
      it(`guards ${walletName} in place (${orderName})`, async () => {
        const win = fakeWindow(), r = recorder(), w = make();
        const registered = run(win, w, r.guard);
        expect(registered).toEqual([w]);   // once, and the wallet's own object: nothing was swapped or doubled
        expect(registered[0]).toBe(w);
        await registered[0].features["solana:signTransaction"].signTransaction({ account, transaction: Uint8Array.of(9) });
        await w.features["solana:signMessage"].signMessage({ account, message: Uint8Array.of(8) }); // by a reference the page kept from before
        expect(r.asked.map((a) => [a.kind, a.bytes[0]])).toEqual([["tx", 9], ["msg", 8]]);
        expect(w.calls).toEqual(["signTransaction", "signMessage"]);
        expect(r.done).toEqual([true, true]);
        expect((await w.features["standard:connect"].connect()).accounts).toEqual([account]);
      });
    }
  }

  it("asks once per request however many times the wallet is met", async () => {
    const win = fakeWindow(), r = recorder(), w = new SolflareLike();
    const hook = installStandardHook(win as any, r.guard);
    announce(win, w);
    app(win); app(win); // two libraries on one page
    announce(win, w);
    await w.features["solana:signTransaction"].signTransaction({ account, transaction: Uint8Array.of(1) });
    expect(r.asked).toHaveLength(1);
    expect(hook.seen()).toEqual({ wallets: 1, standIns: 0 });
  });

  it("gives the app a stand-in for a wallet frozen through and through, when that wallet loads after Warden", async () => {
    const win = fakeWindow(), r = recorder();
    const calls: string[] = [];
    const w = Object.freeze({ name: "Frozen", features: Object.freeze({ "solana:signTransaction": Object.freeze({ version: "1.0.0", signTransaction: async (...i: any[]) => { calls.push("sign"); return i; } }) }) });
    const hook = installStandardHook(win as any, r.guard);
    const registered = app(win);
    announce(win, w);
    expect(registered).toHaveLength(1);
    expect(registered[0]).not.toBe(w);
    expect(registered[0].name).toBe("Frozen");
    await registered[0].features["solana:signTransaction"].signTransaction({ account, transaction: Uint8Array.of(1) });
    expect(r.asked).toHaveLength(1);
    expect(calls).toEqual(["sign"]);
    expect(hook.seen()).toEqual({ wallets: 1, standIns: 1 });
  });

  it("guards a frozen wallet in place when the methods inside its features are still open", async () => {
    const r = recorder(), calls: string[] = [];
    const w = Object.freeze({ name: "HalfFrozen", features: Object.freeze({ "solana:signMessage": { version: "1.0.0", signMessage: async (...i: any[]) => { calls.push("msg"); return i; } } }) });
    expect(patchStandardWalletInPlace(w, r.guard)).toBe(true);
    await w.features["solana:signMessage"].signMessage({ account, message: Uint8Array.of(1) });
    expect(r.asked).toHaveLength(1);
    expect(patchStandardWalletInPlace(w, r.guard)).toBe(true);
    await w.features["solana:signMessage"].signMessage({ account, message: Uint8Array.of(1) });
    expect(r.asked).toHaveLength(2); // still once per request
  });

  it("stand-in: a frozen wallet whose features are its own frozen property reads through unchanged", async () => {
    const r = recorder();
    const calls: string[] = [];
    const w = Object.freeze({ name: "Frozen", accounts: Object.freeze([account]), features: Object.freeze({ "solana:signTransaction": Object.freeze({ version: "1.0.0", signTransaction: async (...i: any[]) => { calls.push("sign"); return i; } }), "solana:signOffchainMessage": Object.freeze({ version: "1.0.0", signOffchainMessage: async (...i: any[]) => { calls.push("offchain"); return i; } }) }) });
    const wrapped = wrapStandardWallet(w as any, r.guard);
    await wrapped.features["solana:signTransaction"].signTransaction({ account, transaction: Uint8Array.of(1) });
    await wrapped.features["solana:signOffchainMessage"].signOffchainMessage({ account, message: Uint8Array.of(2) });
    expect(r.asked.map((a) => a.kind)).toEqual(["tx", "msg"]);
    expect(calls).toEqual(["sign", "offchain"]);
    expect(wrapped.name).toBe("Frozen");
    expect(Object.keys(wrapped)).toEqual(["name", "accounts", "features"]);
  });
});

describe("older injected providers", () => {
  const provider = () => {
    const calls: string[] = [];
    return {
      calls,
      isPhantom: true,
      publicKey: { toBase58: () => account.address },
      signTransaction: async (tx: any) => { calls.push("signTransaction"); return tx; },
      signAllTransactions: async (txs: any[]) => { calls.push("signAllTransactions"); return txs; },
      signAndSendTransaction: async (_tx: any) => { calls.push("signAndSendTransaction"); return { signature: "sig" }; },
      signMessage: async (m: Uint8Array) => { calls.push("signMessage"); return { signature: m }; },
      connect: async () => ({ publicKey: "pk" }),
    };
  };
  const legacyTx = (b: number) => ({ instructions: [], serialize: (opts: any) => { if (!opts || opts.requireAllSignatures !== false) throw new Error("needs signatures"); return Uint8Array.of(b); } });
  const versionedTx = (b: number) => ({ version: 0, message: { serialize: () => Uint8Array.of(0) }, serialize: () => Uint8Array.of(b) });

  it("guards every signing method with the bytes of the transaction", async () => {
    const p = provider(), r = recorder();
    const w = wrapLegacyProvider(p, r.guard);
    await w.signTransaction(legacyTx(1));
    await w.signAllTransactions([legacyTx(2), versionedTx(3)]);
    await w.signAndSendTransaction(versionedTx(4));
    await w.signMessage(Uint8Array.of(5));
    expect(r.asked.map((a) => [a.kind, a.bytes[0], a.owner])).toEqual([["tx", 1, account.address], ["tx", 2, account.address], ["tx", 3, account.address], ["tx", 4, account.address], ["msg", 5, account.address]]);
    expect(p.calls).toEqual(["signTransaction", "signAllTransactions", "signAndSendTransaction", "signMessage"]);
    expect(w.isPhantom).toBe(true);
    expect(await w.connect()).toEqual({ publicKey: "pk" });
  });

  it("stops a refused request, and judges an unserializable transaction as unreadable", async () => {
    const p = provider(), r = recorder(() => false);
    const w = wrapLegacyProvider(p, r.guard);
    await expect(w.signAllTransactions([legacyTx(1), legacyTx(2)])).rejects.toBeInstanceOf(WardenRejected);
    expect(p.calls).toEqual([]);
    expect(serializeForGuard({ serialize: () => { throw new Error("no"); } })).toEqual(new Uint8Array(0));
    expect(serializeForGuard(null)).toEqual(new Uint8Array(0));
  });

  /** Phantom: one object, own arrow-function methods, put on the window with defineProperty. */
  const injectPhantom = (win: Record<string, any>) => {
    const p = provider();
    Object.defineProperty(win, "solana", { value: p, writable: false });
    if (!("phantom" in win)) Object.defineProperty(win, "phantom", { value: {}, writable: false });
    Object.defineProperty(win.phantom, "solana", { value: p, writable: false });
    return p;
  };
  /** Solflare: a class instance whose methods are bound own properties, frozen behind a proxy. */
  const injectSolflare = (win: Record<string, any>, descriptor: PropertyDescriptor = { enumerable: true }) => {
    const p = provider();
    const frozen = Object.freeze(new Proxy(p, { deleteProperty: () => true, get: (t: any, k) => t[k] }));
    Object.defineProperty(win, "solflare", { ...descriptor, value: frozen });
    return p;
  };
  /** Backpack: a frozen container whose signing calls forward to the provider under .solana. */
  const injectBackpack = (win: Record<string, any>) => {
    const inner = provider();
    const box: any = { solana: inner, ethereum: { untouched: true } };
    const z = new Proxy(Object.freeze(box), { get: (t: any, k) => { if (Reflect.has(t, k)) return Reflect.get(t, k); const v = t.solana[k]; return typeof v === "function" ? v.bind(t.solana) : v; } });
    Object.defineProperty(win, "backpack", { value: z });
    return inner;
  };

  it("defines nothing on the window before a wallet does", () => {
    const win: Record<string, any> = {};
    installLegacyHook(win, recorder().guard).sweep();
    expect(Object.keys(win)).toEqual([]);
    expect("solana" in win).toBe(false);
    expect("phantom" in win).toBe(false);
  });

  it("guards Phantom's provider where it stands, whichever of the two loaded first", async () => {
    for (const walletFirst of [true, false]) {
      const r = recorder(), win: Record<string, any> = {};
      let p: ReturnType<typeof provider>;
      if (walletFirst) { p = injectPhantom(win); installLegacyHook(win, r.guard); }
      else { const hook = installLegacyHook(win, r.guard); p = injectPhantom(win); hook.sweep(); }
      expect(win.solana).toBe(p);                 // the wallet's own object, not a copy
      expect(win.solana).toBe(win.phantom.solana);
      await win.solana.signMessage(Uint8Array.of(1));
      await win.phantom.solana.signTransaction(legacyTx(2));
      const detached = win.solana.signAndSendTransaction; // a page that copied the method out
      await detached(versionedTx(3));
      expect(r.asked.map((a) => [a.kind, a.bytes[0], a.owner])).toEqual([["msg", 1, account.address], ["tx", 2, account.address], ["tx", 3, account.address]]);
      expect(p.calls).toEqual(["signMessage", "signTransaction", "signAndSendTransaction"]);
    }
  });

  it("guards a frozen provider with a stand-in when the wallet left the global open, and says so when it did not", async () => {
    const r = recorder(), win: Record<string, any> = {};
    const hook = installLegacyHook(win, r.guard);
    const p = injectSolflare(win, { enumerable: true, configurable: true });
    hook.sweep();
    await win.solflare.signTransaction(legacyTx(7));
    expect(r.asked.map((a) => a.bytes[0])).toEqual([7]);
    expect(p.calls).toEqual(["signTransaction"]);
    expect(win.solflare.isPhantom).toBe(true); // everything else reads through
    expect(hook.unguarded()).toEqual([]);

    const r2 = recorder(), win2: Record<string, any> = {};
    const hook2 = installLegacyHook(win2, r2.guard);
    injectSolflare(win2); // as Solflare ships: not configurable, not writable, frozen
    hook2.sweep();
    await win2.solflare.signTransaction(legacyTx(8));
    expect(r2.asked).toEqual([]);
    expect(hook2.unguarded()).toEqual(["solflare"]); // known, and reported, not silently missed
  });

  it("guards Backpack through the provider its frozen container forwards to", async () => {
    const r = recorder(), win: Record<string, any> = {};
    const hook = installLegacyHook(win, r.guard);
    const inner = injectBackpack(win);
    hook.sweep();
    await win.backpack.signMessage(Uint8Array.of(4));
    await win.backpack.solana.signTransaction(legacyTx(5));
    expect(r.asked.map((a) => a.bytes[0])).toEqual([4, 5]);
    expect(inner.calls).toEqual(["signMessage", "signTransaction"]);
    expect(win.backpack.ethereum).toEqual({ untouched: true });
    expect(hook.unguarded()).toEqual([]);
  });

  it("guards a method that lives on the wallet's class, without touching the class", async () => {
    const r = recorder();
    class P { calls: string[] = []; publicKey = { toBase58: () => account.address }; async signTransaction(tx: any) { this.calls.push("signTransaction"); return tx; } }
    const a = new P(), b = new P();
    expect(patchProviderInPlace(a, r.guard)).toEqual({ patched: ["signTransaction"], stuck: [] });
    await a.signTransaction(legacyTx(1));
    await b.signTransaction(legacyTx(2));
    expect(r.asked.map((x) => x.bytes[0])).toEqual([1]);
    expect(a.calls).toEqual(["signTransaction"]);
    expect(patchProviderInPlace(a, r.guard).patched).toEqual(["signTransaction"]); // twice is once
    await a.signTransaction(legacyTx(3));
    expect(r.asked).toHaveLength(2);
  });

  it("guards the generic request door, and lets everything that is not signing straight through", async () => {
    const r = recorder(), win: Record<string, any> = {};
    const seen: any[] = [];
    const p = { publicKey: { toBase58: () => account.address }, request: async (a: any) => { seen.push(a.method); return "ok"; } };
    Object.defineProperty(win, "solana", { value: p, writable: false });
    installLegacyHook(win, r.guard);
    // a legacy message: one signer, then enough bytes to be a message
    const message = Uint8Array.of(1, 0, 1, 2, ...new Array(40).fill(7));
    const b58 = (b: Uint8Array) => { let n = 0n; for (const x of b) n = n * 256n + BigInt(x); let o = ""; const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; while (n > 0n) { o = A[Number(n % 58n)] + o; n /= 58n; } for (const x of b) { if (x !== 0) break; o = "1" + o; } return o; };
    await win.solana.request({ method: "connect" });
    await win.solana.request({ method: "signAndSendTransaction", params: { message: b58(message) } });
    await win.solana.request({ method: "signMessage", params: { message: Uint8Array.of(9, 9), display: "hex" } });
    await win.solana.request({ method: "signTransaction", params: { somethingElse: true } });
    expect(seen).toEqual(["connect", "signAndSendTransaction", "signMessage", "signTransaction"]);
    expect(r.asked.map((a) => a.kind)).toEqual(["tx", "msg", "opaque"]);
    expect(r.asked[0]!.bytes).toEqual(messageToTransaction(message));
    expect(r.asked[0]!.bytes.length).toBe(1 + 64 + message.length);
    expect(r.asked[0]!.owner).toBe(account.address);
    expect(requestsOf({ method: "signIn", params: {} }, "")?.[0]?.kind).toBe("signin");
    expect(requestsOf({ method: "disconnect" }, "")).toBeNull();
  });

  it("reads a sign-in request through every door: the feature, the provider's method and its request call", async () => {
    const r = recorder();
    const seen: string[] = [];
    const wallet = { name: "W", features: { "solana:signIn": { version: "1.0.0", signIn: async (...i: any[]) => { seen.push("feature"); return i; } } } };
    expect(patchStandardWalletInPlace(wallet, r.guard)).toBe(true);
    await wallet.features["solana:signIn"].signIn({ domain: "a.example", address: account.address, statement: "hi", nonce: "n1", ignored: 5 });
    await wallet.features["solana:signIn"].signIn();
    const p = { publicKey: { toBase58: () => account.address }, signIn: async (_i: any) => { seen.push("method"); return {}; }, request: async (_a: any) => { seen.push("request"); return {}; } };
    patchProviderInPlace(p, r.guard);
    await p.signIn({ domain: "b.example" });
    await p.request({ method: "signIn", params: { domain: "c.example", statement: "s" } });
    const read = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));
    expect(r.asked.map((a) => a.kind)).toEqual(["signin", "signin", "signin", "signin"]);
    expect(r.asked.map((a) => read(a.bytes))).toEqual([{ domain: "a.example", address: account.address, statement: "hi" }, {}, { domain: "b.example" }, { domain: "c.example", statement: "s" }]);
    // it is the wallet's own account that signs in: this wallet lists nobody, and the provider says who it is
    expect(r.asked.map((a) => a.owner)).toEqual(["", "", account.address, account.address]);
    expect(seen).toEqual(["feature", "feature", "method", "request"]);
  });

  it("decodes base58 and builds the empty-signature form of each message version", () => {
    expect(fromBase58("11")).toEqual(Uint8Array.of(0, 0));
    expect(fromBase58("2NEpo7TZRRrLZSi2U")).toEqual(new TextEncoder().encode("Hello World!"));
    expect(fromBase58("0OIl")).toBeNull();
    const v0 = Uint8Array.of(0x80, 2, 0, 1, 5, 5, 5);
    expect(messageToTransaction(v0).length).toBe(1 + 128 + v0.length);
    expect(messageToTransaction(v0)[0]).toBe(2);
    const v1 = Uint8Array.of(0x81, 1, 0, 0, 9, 9);
    expect(messageToTransaction(v1)).toEqual(Uint8Array.of(0x81, 1, 0, 0, 9, 9, ...new Array(64).fill(0)));
  });
});

describe("a wallet whose Wallet Standard door answers by calling its own injected provider", () => {
  // Phantom 26.38 and Backpack 0.10 are written this way (read from the shipped extensions): the feature
  // rebuilds the transaction and calls `this.#provider.signTransaction(...)`, a public method Warden also guards.
  const txOf = (bytes: Uint8Array) => ({ version: 0, message: { serialize: () => Uint8Array.of(0) }, serialize: () => bytes });
  function both(decide?: (r: GuardRequest) => boolean, alter: (b: Uint8Array) => Uint8Array = (b) => b) {
    const r = recorder(decide);
    const calls: string[] = [];
    let hold: Promise<void> | null = null;
    const provider: any = {
      isPhantom: true,
      publicKey: { toBase58: () => account.address },
      signTransaction: async (t: any) => { calls.push("provider.signTransaction"); if (hold) await hold; return t; },
      signAllTransactions: async (ts: any[]) => { calls.push("provider.signAllTransactions"); return ts; },
      signAndSendTransaction: async (_t: any) => { calls.push("provider.signAndSendTransaction"); return { signature: "sig" }; },
      signMessage: async (_m: Uint8Array) => { calls.push("provider.signMessage"); return { signature: new Uint8Array(64) }; },
    };
    const wallet: any = {
      name: "Nested", version: "1.0.0", accounts: [account],
      features: {
        "solana:signTransaction": { version: "1.0.0", signTransaction: async (...inputs: any[]) => (inputs.length === 1
          ? [{ signedTransaction: (await provider.signTransaction(txOf(alter(inputs[0].transaction)))).serialize() }]
          : (await provider.signAllTransactions(inputs.map((i) => txOf(i.transaction)))).map((t: any) => ({ signedTransaction: t.serialize() }))) },
        "solana:signAndSendTransaction": { version: "1.0.0", signAndSendTransaction: async (...inputs: any[]) => { const out = []; for (const i of inputs) { await provider.signAndSendTransaction(txOf(i.transaction)); out.push({ signature: new Uint8Array(64) }); } return out; } },
        "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs: any[]) => { const out = []; for (const i of inputs) { const { signature } = await provider.signMessage(i.message); out.push({ signedMessage: i.message, signature }); } return out; } },
      },
    };
    const win: Record<string, any> = { solana: provider };
    installLegacyHook(win, r.guard);
    expect(patchStandardWalletInPlace(wallet, r.guard)).toBe(true);
    return { r, calls, wallet, win, holdFor: (p: Promise<void>) => { hold = p; } };
  }

  it("asks once, at the door the site used, and reports once that it was signed", async () => {
    const { r, calls, wallet } = both();
    await wallet.features["solana:signTransaction"].signTransaction({ account, transaction: Uint8Array.of(1, 2, 3) });
    await wallet.features["solana:signAndSendTransaction"].signAndSendTransaction({ account, transaction: Uint8Array.of(4, 5) });
    await wallet.features["solana:signMessage"].signMessage({ account, message: Uint8Array.of(9) });
    expect(r.asked.map((a) => [a.kind, [...a.bytes]])).toEqual([["tx", [1, 2, 3]], ["tx", [4, 5]], ["msg", [9]]]);
    expect(r.done).toEqual([true, true, true]);
    // and every one of them reached the wallet's provider
    expect(calls).toEqual(["provider.signTransaction", "provider.signAndSendTransaction", "provider.signMessage"]);
  });

  it("asks once for each transaction of a batch the wallet hands on as a batch", async () => {
    const { r, calls, wallet } = both();
    await wallet.features["solana:signTransaction"].signTransaction({ account, transaction: Uint8Array.of(1) }, { account, transaction: Uint8Array.of(2) }, { account, transaction: Uint8Array.of(1) });
    expect(r.asked.map((a) => [...a.bytes])).toEqual([[1], [2], [1]]);
    expect(calls).toEqual(["provider.signAllTransactions"]);
    expect(r.done).toEqual([true, true, true]);
  });

  it("asks again when what reaches the provider is not what the owner was shown", async () => {
    // a wallet (or something standing in it) that hands on different bytes has made a different request
    const { r, wallet } = both(undefined, (b) => Uint8Array.of(...b, 7));
    await wallet.features["solana:signTransaction"].signTransaction({ account, transaction: Uint8Array.of(1, 2, 3) });
    expect(r.asked.map((a) => [...a.bytes])).toEqual([[1, 2, 3], [1, 2, 3, 7]]);
  });

  it("still asks about a copy the page sends through the other door itself", async () => {
    const { r, calls, wallet, win, holdFor } = both();
    let release!: () => void;
    holdFor(new Promise<void>((done) => { release = done; }));
    const first = wallet.features["solana:signTransaction"].signTransaction({ account, transaction: Uint8Array.of(1, 2, 3) });
    await new Promise((done) => setTimeout(done, 5));
    // the wallet is working on it (its own window is open, say): one question so far, and the wallet handed it on once
    expect(r.asked).toHaveLength(1);
    expect(calls).toEqual(["provider.signTransaction"]);
    // the page now sends the same bytes straight to the provider: that is a second request, and it is asked about
    const copy = win.solana.signTransaction(txOf(Uint8Array.of(1, 2, 3)));
    await new Promise((done) => setTimeout(done, 5));
    expect(r.asked).toHaveLength(2);
    release();
    await Promise.all([first, copy]);
    expect(r.done).toEqual([true, true]);
  });

  it("asks afresh once the wallet has answered: the same bytes later are a new request", async () => {
    const { r, wallet, win } = both();
    await wallet.features["solana:signMessage"].signMessage({ account, message: Uint8Array.of(9) });
    await win.solana.signMessage(Uint8Array.of(9));
    await wallet.features["solana:signMessage"].signMessage({ account, message: Uint8Array.of(9) });
    expect(r.asked).toHaveLength(3);
  });

  it("and a request refused at the first door never reaches the second, or the wallet", async () => {
    const { r, calls, wallet } = both(() => false);
    await expect(wallet.features["solana:signTransaction"].signTransaction({ account, transaction: Uint8Array.of(1) })).rejects.toBeInstanceOf(WardenRejected);
    expect(r.asked).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("asks at both doors about a request it cannot read: nothing says two of those are the same", async () => {
    const r = recorder();
    const provider: any = { publicKey: { toBase58: () => account.address }, signTransaction: async (t: any) => t };
    const wallet: any = { name: "Nested", version: "1.0.0", accounts: [account], features: { "solana:signTransaction": { version: "1.0.0", signTransaction: async (..._inputs: any[]) => { await provider.signTransaction({ serialize: () => { throw new Error("cannot"); } }); return [{ signedTransaction: new Uint8Array(0) }]; } } } };
    installLegacyHook({ solana: provider }, r.guard);
    patchStandardWalletInPlace(wallet, r.guard);
    await wallet.features["solana:signTransaction"].signTransaction({ account, transaction: new Uint8Array(0) });
    expect(r.asked.map((a) => a.kind)).toEqual(["tx", "tx"]);
    expect(r.asked.every((a) => a.bytes.length === 0)).toBe(true);
  });
});

describe("whose request it is", () => {
  const OWNER = account.address, ATTACKER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
  const txOf = (bytes: Uint8Array) => ({ version: 0, message: { serialize: () => Uint8Array.of(0) }, serialize: () => bytes });
  /** The real wallet: connected as OWNER at both doors, its Wallet Standard door answering by calling its provider (as Phantom's and Backpack's do). */
  function real(guard: Guard) {
    const calls: string[] = [];
    const provider: any = { isPhantom: true, publicKey: { toBase58: () => OWNER }, signTransaction: async (t: any) => { calls.push("phantom.signTransaction"); return t; }, signMessage: async () => { calls.push("phantom.signMessage"); return { signature: new Uint8Array(64) }; } };
    const wallet: any = { name: "Real", version: "1.0.0", accounts: [account], features: { "solana:signTransaction": { version: "1.0.0", signTransaction: async (...i: any[]) => { await provider.signTransaction(txOf(i[0].transaction)); return i.map((x) => ({ signedTransaction: x.transaction })); } } } };
    const win: Record<string, any> = { solana: provider };
    installLegacyHook(win, guard);
    expect(patchStandardWalletInPlace(wallet, guard)).toBe(true);
    return { calls, wallet, win };
  }
  /** A guard that answers as the worker does for a transaction that empties OWNER: harmless when read as anybody else, refused when read as OWNER. */
  function reading() {
    const asked: string[] = [];
    const guard: Guard = async (r) => { asked.push(r.owner); if (r.owner === OWNER) throw new WardenRejected(); return { done() {} }; };
    return { guard, asked };
  }
  const DRAIN = Uint8Array.of(9, 9, 9);

  it("does not let a request answered for one account through for another: a wallet the page made cannot open the way to the real one", async () => {
    const g = reading(), r = real(g.guard);
    // the page makes a wallet of its own, and has it "asked" to sign the drain as an account of the page's; it never answers
    const fake: any = { name: "Fake", version: "1.0.0", accounts: [{ address: ATTACKER }], features: { "solana:signTransaction": { version: "1.0.0", signTransaction: () => new Promise(() => {}) } } };
    expect(patchStandardWalletInPlace(fake, g.guard)).toBe(true);
    void fake.features["solana:signTransaction"].signTransaction({ account: { address: ATTACKER }, transaction: DRAIN });
    await new Promise((done) => setTimeout(done, 5));
    expect(g.asked).toEqual([ATTACKER]); // read as the page's account: nothing leaves it
    // then the same bytes, straight to the real wallet's provider
    await expect(r.win.solana.signTransaction(txOf(DRAIN))).rejects.toBeInstanceOf(WardenRejected);
    expect(g.asked).toEqual([ATTACKER, OWNER]); // asked about, as the account that would sign
    expect(r.calls).toEqual([]);
  });

  it("reads a request as the wallet's own account when the page names one the wallet does not have", async () => {
    const g = reading(), r = real(g.guard);
    // Phantom's signTransaction does not check the account it is handed; its provider signs with the wallet's key
    await expect(r.wallet.features["solana:signTransaction"].signTransaction({ account: { address: ATTACKER }, transaction: DRAIN })).rejects.toBeInstanceOf(WardenRejected);
    expect(g.asked).toEqual([OWNER]);
    expect(r.calls).toEqual([]);
  });

  it("still asks once when the wallet hands on a request for its own account, whatever the page called it", async () => {
    const asked: GuardRequest[] = [];
    const r = real(async (q) => { asked.push(q); return { done() {} }; });
    await r.wallet.features["solana:signTransaction"].signTransaction({ account: { address: ATTACKER }, transaction: Uint8Array.of(1, 2) });
    await r.wallet.features["solana:signTransaction"].signTransaction({ account, transaction: Uint8Array.of(3, 4) });
    expect(asked.map((a) => [a.owner, [...a.bytes]])).toEqual([[OWNER, [1, 2]], [OWNER, [3, 4]]]);
    expect(r.calls).toEqual(["phantom.signTransaction", "phantom.signTransaction"]);
  });

  it("takes the page's word for an account the wallet lists, and when the wallet lists nobody", async () => {
    const second = { address: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2" };
    for (const [accounts, said, read] of [[[account, second], second.address, second.address], [[account, second], ATTACKER, OWNER], [[], ATTACKER, ATTACKER], [[], "", ""]] as const) {
      const asked: GuardRequest[] = [];
      const wallet: any = { name: "W", version: "1.0.0", accounts, features: { "solana:signMessage": { version: "1.0.0", signMessage: async (...i: any[]) => i.map((x) => ({ signedMessage: x.message, signature: new Uint8Array(64) })) } } };
      patchStandardWalletInPlace(wallet, async (q) => { asked.push(q); return { done() {} }; });
      await wallet.features["solana:signMessage"].signMessage({ account: said ? { address: said } : undefined, message: Uint8Array.of(1) });
      expect(asked.map((a) => a.owner)).toEqual([read]);
    }
  });

  it("keeps a feature's own getters as getters: what a wallet says it supports can change after it has loaded", async () => {
    let versions: unknown[] = ["legacy", 0];
    const wallet: any = { name: "W", version: "1.0.0", accounts: [account], features: { "solana:signTransaction": { version: "1.0.0", get supportedTransactionVersions() { return versions; }, signTransaction: async (...i: any[]) => i.map((x) => ({ signedTransaction: x.transaction })) } } };
    patchStandardWalletInPlace(wallet, async () => ({ done() {} }));
    expect(wallet.features["solana:signTransaction"].supportedTransactionVersions).toEqual(["legacy", 0]);
    versions = ["legacy", 0, 1];
    expect(wallet.features["solana:signTransaction"].supportedTransactionVersions).toEqual(["legacy", 0, 1]);
    expect(Object.keys(wallet.features["solana:signTransaction"]).sort()).toEqual(["signTransaction", "supportedTransactionVersions", "version"]);
  });
});

describe("what the wallet is handed is what was read", () => {
  /** A guard that takes a moment, as an owner reading a prompt does, and records what it was shown. */
  function slow() {
    const judged: number[][] = [];
    const guard: Guard = async (r) => { judged.push([...r.bytes]); await new Promise((d) => setTimeout(d, 5)); return { done() {} }; };
    return { guard, judged };
  }
  const HARMLESS = [1, 1, 1], DRAIN = [9, 9, 9];

  it("at the Wallet Standard door: a page that writes other bytes into its array while the owner is asked changes nothing", async () => {
    const g = slow(), got: number[][] = [];
    const wallet: any = { name: "W", version: "1.0.0", accounts: [account], features: {
      "solana:signTransaction": { version: "1.0.0", signTransaction: async (...i: any[]) => { for (const x of i) got.push([...x.transaction]); return i.map((x) => ({ signedTransaction: x.transaction })); } },
      "solana:signMessage": { version: "1.0.0", signMessage: async (...i: any[]) => { for (const x of i) got.push([...x.message]); return i.map((x) => ({ signedMessage: x.message, signature: new Uint8Array(64) })); } },
    } };
    patchStandardWalletInPlace(wallet, g.guard);
    // the same array, written over straight after asking
    const input = { account, transaction: Uint8Array.from(HARMLESS) };
    const first = wallet.features["solana:signTransaction"].signTransaction(input);
    input.transaction.set(DRAIN);
    await first;
    // another array put in its place
    const second: any = { account, transaction: Uint8Array.from(HARMLESS) };
    const swapped = wallet.features["solana:signTransaction"].signTransaction(second);
    second.transaction = Uint8Array.from(DRAIN);
    await swapped;
    // a field that answers differently each time it is read
    let reads = 0;
    const sly: any = { account, get transaction() { return Uint8Array.from(reads++ === 0 ? HARMLESS : DRAIN); } };
    await wallet.features["solana:signTransaction"].signTransaction(sly);
    // and a message
    const words = { account, message: Uint8Array.from(HARMLESS) };
    const said = wallet.features["solana:signMessage"].signMessage(words);
    words.message.set(DRAIN);
    await said;
    expect(g.judged).toEqual([HARMLESS, HARMLESS, HARMLESS, HARMLESS]);
    expect(got).toEqual(g.judged);
  });

  it("at the Wallet Standard door: a sign-in whose fields are changed while the owner is asked is the one that was read", async () => {
    const seen: any[] = [], got: any[] = [];
    const guard: Guard = async (r) => { seen.push(JSON.parse(new TextDecoder().decode(r.bytes))); await new Promise((d) => setTimeout(d, 5)); return { done() {} }; };
    const wallet: any = { name: "W", version: "1.0.0", accounts: [account], features: { "solana:signIn": { version: "1.0.0", signIn: async (...i: any[]) => { got.push({ ...i[0] }); return []; } } } };
    patchStandardWalletInPlace(wallet, guard);
    const input: any = { domain: "shop.example", statement: "Sign in" };
    const p = wallet.features["solana:signIn"].signIn(input);
    input.domain = "bank.example";
    await p;
    expect(seen).toEqual([{ domain: "shop.example", statement: "Sign in" }]);
    expect(got).toEqual([{ domain: "shop.example", statement: "Sign in" }]);
  });

  it("at the older door: bytes, a message, a list and a request() call are Warden's own copies by the time the wallet has them", async () => {
    const g = slow(), got: number[][] = [];
    const provider: any = {
      publicKey: { toBase58: () => account.address },
      signTransaction: async (t: any) => { got.push([...t]); return t; },
      signAllTransactions: async (ts: any[]) => { for (const t of ts) got.push([...t]); return ts; },
      signMessage: async (m: Uint8Array) => { got.push([...m]); return { signature: new Uint8Array(64) }; },
      request: async (a: any) => { got.push([...fromBase58(a.params.message)!]); return "ok"; },
    };
    const win: Record<string, any> = { solana: provider };
    installLegacyHook(win, g.guard);
    const bytes = Uint8Array.from(HARMLESS);
    const one = win.solana.signTransaction(bytes);
    bytes.set(DRAIN);
    await one;
    const list = [Uint8Array.from(HARMLESS)];
    const all = win.solana.signAllTransactions(list);
    list.push(Uint8Array.from(DRAIN)); // slipped in after the list was read
    list[0]!.set(DRAIN);
    await all;
    const words = Uint8Array.from(HARMLESS);
    const said = win.solana.signMessage(words);
    words.set(DRAIN);
    await said;
    expect(got).toEqual([HARMLESS, HARMLESS, HARMLESS]);
    // request(): the message of a transaction as text, in an object of the page's
    const message = Uint8Array.of(1, 0, 1, 1, ...new Uint8Array(40)), other = Uint8Array.of(1, 0, 1, 2, ...new Uint8Array(40));
    const b58 = (b: Uint8Array) => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); let out = ""; const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; } return out; };
    const arg: any = { method: "signTransaction", params: { message: b58(message) } };
    const asked = win.solana.request(arg);
    arg.params.message = b58(other);
    arg.params = { message: b58(other) };
    await asked;
    expect(got.at(-1)).toEqual([...message]);
  });

  it("at the older door: a transaction object is read again when it is handed on, and the owner is asked about what it says then", async () => {
    // an honest object says the same thing each time: one question
    const honest = slow(), calls: string[] = [];
    const provider = () => ({ publicKey: { toBase58: () => account.address }, signTransaction: async (t: any) => { calls.push("signTransaction"); return t; } });
    const a: Record<string, any> = { solana: provider() };
    installLegacyHook(a, honest.guard);
    await a.solana.signTransaction({ version: 0, message: { serialize: () => Uint8Array.of(0) }, serialize: () => Uint8Array.from(HARMLESS) });
    expect(honest.judged).toEqual([HARMLESS]);
    // one that changes once it has been read: the owner is asked again, about what it now says
    const changed = slow();
    const b: Record<string, any> = { solana: provider() };
    installLegacyHook(b, changed.guard);
    let n = 0;
    await b.solana.signTransaction({ version: 0, message: { serialize: () => Uint8Array.of(0) }, serialize: () => Uint8Array.from(n++ === 0 ? HARMLESS : DRAIN) });
    expect(changed.judged).toEqual([HARMLESS, DRAIN]);
    // one that never says the same thing twice is refused, and never reaches the wallet
    const restless = slow();
    const c: Record<string, any> = { solana: provider() };
    installLegacyHook(c, restless.guard);
    calls.length = 0;
    let m = 0;
    const refused = await c.solana.signTransaction({ version: 0, message: { serialize: () => Uint8Array.of(0) }, serialize: () => Uint8Array.of(m++) }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(WardenRejected);
    expect((refused as Error).message).toBe("Blocked by Lamport Warden: this request kept changing while it was being read");
    expect(calls).toEqual([]);
  });
});

describe("every door that signs", () => {
  /** A provider with Backpack's methods and their arguments, read from the shipped 0.10.221: all on its class, the object frozen. */
  function backpack(guard: Guard) {
    const calls: string[] = [];
    class Provider {
      constructor() { Object.freeze(this); }
      get isBackpack() { return true; }
      get publicKey() { return { toBase58: () => account.address }; }
      async send(tx: any, _signers?: any, _options?: any, _connection?: any, _account?: any) { calls.push("send"); return "hash"; }
      async sendAndConfirm(tx: any, _signers?: any, _options?: any, _connection?: any, _account?: any) { calls.push("sendAndConfirm"); return { signature: "hash" }; }
      async sendAll(_list: any[]) { calls.push("sendAll"); return []; }
      async signAndSendTransaction(tx: any, options?: any) { return this.sendAndConfirm(tx, [], options); }
      async signTransaction(tx: any, _account?: any) { calls.push("signTransaction"); return tx; }
      async signMessage(_m: any, _account?: any) { calls.push("signMessage"); return { signature: new Uint8Array(64) }; }
    }
    const inner: any = new Provider();
    const win: Record<string, any> = { backpack: Object.freeze({ solana: inner }) };
    const hook = installLegacyHook(win, guard);
    return { calls, door: win.backpack.solana as any, hook };
  }
  const txOf = (bytes: number[]) => ({ version: 0, message: { serialize: () => Uint8Array.of(0) }, serialize: () => Uint8Array.from(bytes) });

  it("asks before Backpack's own ways of signing and sending: send, sendAndConfirm and sendAll", async () => {
    const r = recorder((q) => q.bytes[0] !== 9), b = backpack(r.guard);
    expect(b.hook.unguarded()).toEqual([]);
    await b.door.send(txOf([1]), []);
    await b.door.sendAndConfirm(txOf([2]), []);
    await b.door.sendAll([{ tx: txOf([3]), signers: [] }, { tx: txOf([4]) }]);
    expect(r.asked.map((a) => [a.kind, [...a.bytes], a.owner])).toEqual([["tx", [1], account.address], ["tx", [2], account.address], ["tx", [3], account.address], ["tx", [4], account.address]]);
    expect(b.calls).toEqual(["send", "sendAndConfirm", "sendAll"]);
    // refused, none of them reaches the wallet
    for (const ask of [() => b.door.send(txOf([9])), () => b.door.sendAndConfirm(txOf([9])), () => b.door.sendAll([{ tx: txOf([9]) }])]) await expect(ask()).rejects.toBeInstanceOf(WardenRejected);
    expect(b.calls).toEqual(["send", "sendAndConfirm", "sendAll"]);
  });

  it("asks once when Backpack's signAndSendTransaction hands the request to its own sendAndConfirm", async () => {
    const r = recorder(), b = backpack(r.guard);
    await b.door.signAndSendTransaction(txOf([5]));
    expect(r.asked).toHaveLength(1);
    expect(b.calls).toEqual(["sendAndConfirm"]);
  });

  it("reads a request from the side of the account Backpack is told to sign with", async () => {
    // Backpack's methods take the account as an argument: a transaction that leaves the active account alone can empty that one
    const second = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
    const r = recorder(), b = backpack(r.guard);
    await b.door.signTransaction(txOf([1]), { toBase58: () => second });
    await b.door.signTransaction(txOf([2]), second);
    await b.door.signMessage(Uint8Array.of(3), { toBase58: () => second });
    await b.door.send(txOf([4]), [], undefined, undefined, { toBase58: () => second });
    await b.door.signTransaction(txOf([5]));
    await b.door.signTransaction(txOf([6]), "not an account");
    expect(r.asked.map((a) => a.owner)).toEqual([second, second, second, second, account.address, account.address]);
  });

  it("leaves another wallet's `send` alone: there it may be an older way of making any request", async () => {
    const r = recorder(), calls: any[] = [];
    const provider: any = { publicKey: { toBase58: () => account.address }, send: async (method: string, params: unknown) => { calls.push([method, params]); return "ok"; }, signMessage: async () => ({ signature: new Uint8Array(64) }) };
    const win: Record<string, any> = { solana: provider };
    installLegacyHook(win, r.guard);
    expect(await win.solana.send("getBalance", ["x"])).toBe("ok");
    expect(calls).toEqual([["getBalance", ["x"]]]);
    expect(r.asked).toEqual([]);
  });
});

describe("what is read is what there is: forms a request can come in", () => {
  const read = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

  it("reads a sign-in field that is not text as the text a wallet would make of it, and hands the wallet that text", async () => {
    const seen: any[] = [], got: any[] = [];
    const guard: Guard = async (q) => { seen.push(read(q.bytes)); return { done() {} }; };
    const wallet: any = { name: "W", version: "1.0.0", accounts: [account], features: { "solana:signIn": { version: "1.0.0", signIn: async (...i: any[]) => { got.push(i[0]); return []; } } } };
    patchStandardWalletInPlace(wallet, guard);
    // a list, and a String object: neither is text, and either could be taken for a domain by a wallet
    await wallet.features["solana:signIn"].signIn({ domain: ["other-site.example"], statement: "Sign in" });
    await wallet.features["solana:signIn"].signIn({ domain: new String("other-site.example"), statement: "Sign in" });
    expect(seen).toEqual([{ domain: "other-site.example", statement: "Sign in" }, { domain: "other-site.example", statement: "Sign in" }]);
    expect(got.map((g) => g.domain)).toEqual(["other-site.example", "other-site.example"]);
    // and the same through a provider's method and its request() call
    const p: any = { publicKey: { toBase58: () => account.address }, signIn: async (i: any) => { got.push(i); return {}; }, request: async (a: any) => { got.push(a.params); return {}; } };
    patchProviderInPlace(p, guard);
    await p.signIn({ domain: ["bank.example"] });
    await p.request({ method: "signIn", params: { domain: ["bank.example"] } });
    expect(seen.slice(2)).toEqual([{ domain: "bank.example" }, { domain: "bank.example" }]);
    expect(got.slice(2).map((g) => g.domain)).toEqual(["bank.example", "bank.example"]);
  });

  it("reads a message given as a list of numbers, and one given as text, and hands each on as it read it", async () => {
    const r = recorder(), got: any[] = [];
    const provider: any = { publicKey: { toBase58: () => account.address }, signMessage: async (m: any) => { got.push(m); return { signature: new Uint8Array(64) }; }, signOffchainMessage: async (m: any) => { got.push(m); return {}; } };
    const win: Record<string, any> = { solana: provider };
    installLegacyHook(win, r.guard);
    await win.solana.signMessage([104, 105]);
    await win.solana.signMessage("hi");
    // the off-chain form, as Backpack takes it: an object with the message as text among other fields
    await win.solana.signOffchainMessage({ messageVersion: 1, account, requiredSigners: [Uint8Array.of(1)], message: "hi" });
    expect(r.asked.map((a) => [...a.bytes])).toEqual([[104, 105], [104, 105], [104, 105]]);
    expect([...got[0]]).toEqual([104, 105]);
    expect(got[1]).toBe("hi");
    expect(got[2].message).toBe("hi");
    expect(got[2].messageVersion).toBe(1);
    // and at the Wallet Standard door, where Backpack's off-chain message is text too
    const had: any[] = [];
    const wallet: any = { name: "W", version: "1.0.0", accounts: [account], features: { "solana:signOffchainMessage": { version: "1.0.0", signOffchainMessage: async (...i: any[]) => { had.push(i[0]); return []; } } } };
    patchStandardWalletInPlace(wallet, r.guard);
    await wallet.features["solana:signOffchainMessage"].signOffchainMessage({ account, messageVersion: 1, requiredSigners: [], message: "hi" });
    expect([...r.asked.at(-1)!.bytes]).toEqual([104, 105]);
    expect(had[0].message).toBe("hi");
  });

  it("keeps a list a list in a request() call, and reads the method once", async () => {
    const r = recorder(), got: any[] = [];
    const provider: any = { publicKey: { toBase58: () => account.address }, request: async (a: any) => { got.push(a); return "ok"; } };
    patchProviderInPlace(provider, r.guard);
    await provider.request({ method: "signMessage", params: [Uint8Array.of(1, 2), "utf8"] });
    expect(Array.isArray(got[0].params)).toBe(true);
    // a method that says one thing when Warden looks and another when the wallet does
    let n = 0;
    const sly = { get method() { return n++ === 0 ? "getAccounts" : "signTransaction"; }, params: {} };
    await provider.request(sly);
    expect(got[1].method).toBe("getAccounts");
    expect(got[1]).not.toBe(sly);
  });

  it("hands the wallet its own account object for the account the request was read as", async () => {
    const got: any[] = [];
    const mine = Object.freeze({ address: account.address, publicKey: new Uint8Array(32) });
    const wallet: any = { name: "W", version: "1.0.0", accounts: [mine], features: { "solana:signTransaction": { version: "1.0.0", signTransaction: async (...i: any[]) => { got.push(i[0].account); return i.map((x) => ({ signedTransaction: x.transaction })); } } } };
    const r = recorder();
    patchStandardWalletInPlace(wallet, r.guard);
    // an account object of the page's that says the right address now and can say another later
    const theirs = { address: account.address };
    const p = wallet.features["solana:signTransaction"].signTransaction({ account: theirs, transaction: Uint8Array.of(1) });
    theirs.address = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
    await p;
    await wallet.features["solana:signTransaction"].signTransaction({ account: { address: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T" }, transaction: Uint8Array.of(2) });
    expect(got[0]).toBe(mine);
    expect(got[1]).toBe(mine);
    expect(r.asked.map((a) => a.owner)).toEqual([account.address, account.address]);
  });
});

