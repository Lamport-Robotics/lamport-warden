import { describe, it, expect } from "vitest";
import { WardenRejected, installLegacyHook, installStandardHook, serializeForGuard, wrapLegacyProvider, wrapStandardWallet, type Guard, type GuardRequest } from "../src/intercept.js";

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

describe("the Wallet Standard hook", () => {
  it("wraps a wallet that announces itself to an app that is already listening", async () => {
    const win = fakeWindow(), r = recorder(), w = new FakeWallet();
    installStandardHook(win, r.guard); // first, as at document_start
    const registered: any[] = [];
    const api = { register: (...ws: any[]) => { registered.push(...ws); return () => {}; } };
    win.addEventListener("wallet-standard:register-wallet", (e) => (e as CustomEvent).detail(api)); // the app
    win.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (a: any) => a.register(w) })); // the wallet
    expect(registered).toHaveLength(1);
    expect(registered[0]).not.toBe(w);
    await registered[0].features["solana:signTransaction"].signTransaction({ account, transaction: Uint8Array.of(9) });
    expect(r.asked).toHaveLength(1);
    expect(w.calls).toEqual(["signTransaction"]);
  });

  it("wraps a wallet that answers an app's ready call", async () => {
    const win = fakeWindow(), r = recorder(), w = new FakeWallet();
    installStandardHook(win, r.guard);
    win.addEventListener("wallet-standard:app-ready", (e) => (e as CustomEvent).detail.register(w)); // the wallet
    const registered: any[] = [];
    win.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register: (...ws: any[]) => { registered.push(...ws); return () => {}; } } })); // the app
    expect(registered).toHaveLength(1);
    expect(registered[0]).not.toBe(w);
    await registered[0].features["solana:signMessage"].signMessage({ account, message: Uint8Array.of(1) });
    expect(r.asked[0]!.kind).toBe("msg");
  });

  it("hands each listener the wrapped form once, never the wallet itself", () => {
    const win = fakeWindow(), r = recorder(), w = new FakeWallet();
    installStandardHook(win, r.guard);
    let seen = 0;
    const got: any[] = [];
    win.addEventListener("wallet-standard:register-wallet", (e) => { seen++; (e as CustomEvent).detail({ register: (x: any) => { got.push(x); return () => {}; } }); });
    win.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (a: any) => a.register(w) }));
    expect(seen).toBe(1);
    expect(got).toHaveLength(1);
    expect(got[0]).not.toBe(w);
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

  it("wraps a provider however the wallet puts it on the page", async () => {
    const r = recorder();
    const win: Record<string, any> = { backpack: provider() }; // already there when we load
    installLegacyHook(win, r.guard);
    win.solana = provider();                                    // assigned later
    win.phantom = { solana: provider(), ethereum: { untouched: true } };
    await win.solana.signMessage(Uint8Array.of(1));
    await win.phantom.solana.signMessage(Uint8Array.of(2));
    await win.backpack.signMessage(Uint8Array.of(3));
    expect(r.asked.map((a) => a.bytes[0])).toEqual([1, 2, 3]);
    expect(win.phantom.ethereum).toEqual({ untouched: true });
    win.solana = undefined;
    expect(win.solana).toBeUndefined();
  });
});
