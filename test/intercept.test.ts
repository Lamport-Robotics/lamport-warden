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
    expect(out[0].signedTransaction).toBe(tx);
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
    expect(r.asked.map((a) => a.owner)).toEqual([account.address, "", account.address, account.address]);
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
