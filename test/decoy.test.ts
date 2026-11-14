/**
 * Decoy first: what catches a site, and how a wallet is stood in for while the site is looking at a decoy.
 *
 * (The whole of it in a browser, on an ordinary site in front of wallets built like the real ones, is
 * test/browser/decoy.test.ts.)
 */
import "../src/polyfill.js";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { decoyVerdict, judgeDecoy, readHoldings, type Decoy } from "../src/decoy.js";
import { WardenRejected, installLegacyHook, installStandardHook, keyLike, patchStandardWalletInPlace, wrapStandardWallet, type DecoyGate, type Guard, type GuardRequest } from "../src/intercept.js";
import { cleanAddress, settingsFrom } from "../src/settings.js";
import type { FetchLike } from "../src/rpc.js";

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const THIEF = key(9), SHOP = key(8);
const ata = (owner: PublicKey, mint = USDC) => PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN.toBytes(), mint.toBytes()], ASSOCIATED)[0];
/**
 * The decoy of these tests: a hash of some words, walked forward to the nearest point on the curve, so that it
 * looks like any wallet's address and there is no key it was made from. It "holds" 310 SOL and 40,000 USDC.
 */
const hashed = Uint8Array.from(createHash("sha256").update("a decoy for Lamport Warden's tests").digest());
while (!PublicKey.isOnCurve(hashed)) hashed[31] = (hashed[31]! + 1) & 0xff;
const DECOY = new PublicKey(hashed);
const BAIT: Decoy = { address: DECOY.toBase58(), lamports: 310_000_000_000n, tokens: [{ mint: USDC.toBase58(), account: ata(DECOY).toBase58(), amount: 40_000_000_000n, decimals: 6 }] };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const tx = (payer: PublicKey, ...ix: TransactionInstruction[]) => new Uint8Array(new Transaction({ feePayer: payer, recentBlockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" }).add(...ix).serialize({ requireAllSignatures: false, verifySignatures: false }));
const sol = (from: PublicKey, to: PublicKey, lamports: bigint) => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
const usdc = (from: PublicKey, to: PublicKey, units: bigint) => new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: ata(from), isSigner: false, isWritable: true }, { pubkey: USDC, isSigner: false, isWritable: false }, { pubkey: ata(to), isSigner: false, isWritable: true }, { pubkey: from, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([12]), u64(units), Buffer.from([6])]) });
const approve = (from: PublicKey, to: PublicKey, units: bigint) => new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: ata(from), isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: false }, { pubkey: from, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([4]), u64(units)]) });
const setAuthority = (from: PublicKey, to: PublicKey) => new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: ata(from), isSigner: false, isWritable: true }, { pubkey: from, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([6, 2, 1]), to.toBuffer()]) });
/** What a thief that looked the decoy up asks it for: all but a little of the SOL, and all of the USDC. */
const everything = (victim: PublicKey) => tx(victim, sol(victim, THIEF, 309_990_000_000n), usdc(victim, THIEF, 40_000_000_000n));

describe("what a site asks a decoy for says what the site is", () => {
  it("catches the site that asks for everything, and says what it asked for", () => {
    const found = judgeDecoy(everything(DECOY), BAIT);
    expect(found).toEqual({ caught: true, asked: ["send out 309.99 SOL, of the 310 SOL it holds and 40,000 USDC, all it holds"], to: null });
    const v = decoyVerdict(found, BAIT);
    expect(v.level).toBe("block");
    expect(v.sentence).toBe("This site tried to rob a wallet that is not yours. I showed it a decoy before your own wallet, and it asked the decoy to send out 309.99 SOL, of the 310 SOL it holds and 40,000 USDC, all it holds.");
    expect(v.reasons).toEqual([
      "your wallet was never connected to this site, and the site has not seen your address.",
      "nothing was taken: nobody here holds the decoy's key, so nothing it is asked to sign can be signed.",
      "I will pass nothing from this page to your wallet. Close it.",
    ]);
  });

  it("catches nearly all of one thing, a sweep of several, and any handing over of power", () => {
    const caught = (bytes: Uint8Array, decoy: Decoy = BAIT) => judgeDecoy(bytes, decoy);
    // nearly all the SOL, to one address: the amount is the balance, which no visitor chose
    expect(caught(tx(DECOY, sol(DECOY, THIEF, 300_000_000_000n)))).toEqual({ caught: true, asked: ["send out 300 SOL, of the 310 SOL it holds"], to: THIEF.toBase58() });
    // all of a token
    expect(caught(tx(DECOY, usdc(DECOY, THIEF, 40_000_000_000n)))).toMatchObject({ caught: true, asked: ["send out 40,000 USDC, all it holds"] });
    // Two different things at once and nothing else is a sweep, whatever the amounts, and whether or not
    // anything is known of what the decoy holds.
    const bare: Decoy = { address: BAIT.address };
    expect(caught(tx(DECOY, sol(DECOY, THIEF, 1_000_000_000n), usdc(DECOY, THIEF, 5_000_000n)), bare)).toEqual({ caught: true, asked: ["send out 1 SOL and 5 USDC"], to: null });
    // letting somebody spend, and handing an account over: caught with nothing sent at all
    expect(caught(tx(DECOY, approve(DECOY, THIEF, 0xffff_ffff_ffff_ffffn)), bare)).toEqual({ caught: true, asked: [`let ${short(THIEF.toBase58())} spend its tokens, without limit`], to: THIEF.toBase58() });
    expect(caught(tx(DECOY, approve(DECOY, THIEF, 5n)), bare).asked).toEqual([`let ${short(THIEF.toBase58())} spend its tokens`]);
    expect(caught(tx(DECOY, setAuthority(DECOY, THIEF)), bare)).toEqual({ caught: true, asked: [`hand ${short(THIEF.toBase58())} control of one of its token accounts`], to: THIEF.toBase58() });
    const both = decoyVerdict(caught(tx(DECOY, approve(DECOY, THIEF, 0xffff_ffff_ffff_ffffn), sol(DECOY, THIEF, 309_000_000_000n))), BAIT);
    expect(both.sentence).toBe(`This site tried to rob a wallet that is not yours. I showed it a decoy before your own wallet, and it asked the decoy to let ${short(THIEF.toBase58())} spend its tokens, without limit, and send out 309 SOL, of the 310 SOL it holds, to ${short(THIEF.toBase58())}.`);
  });

  it("lets an ordinary site pass: a payment somebody chose, a swap, and anything that is not a request of the decoy", () => {
    const passed = { caught: false, asked: [], to: null };
    // a shop asking for half a SOL, of 310
    expect(judgeDecoy(tx(DECOY, sol(DECOY, SHOP, 500_000_000n)), BAIT)).toEqual(passed);
    // 25 USDC of 40,000
    expect(judgeDecoy(tx(DECOY, usdc(DECOY, SHOP, 25_000_000n)), BAIT)).toEqual(passed);
    // With nothing known of what the decoy holds, one thing sent once catches nobody: it might be a payment.
    expect(judgeDecoy(tx(DECOY, sol(DECOY, THIEF, 300_000_000_000n)), { address: BAIT.address })).toEqual(passed);
    // A program Warden does not read in the transaction: a swap looks like this, and so could a thief's own
    // program. The decoy does not settle it; the site passes, and Warden reads what it asks of the real wallet.
    const swap = new TransactionInstruction({ programId: key(77), keys: [{ pubkey: DECOY, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) });
    expect(judgeDecoy(tx(DECOY, sol(DECOY, key(78), 309_000_000_000n), swap), BAIT)).toEqual(passed);
    // a transaction somebody else signs asks nothing of the decoy
    expect(judgeDecoy(everything(key(5)), BAIT)).toEqual(passed);
    // and bytes that are no transaction at all
    expect(judgeDecoy(Uint8Array.from([1, 2, 3]), BAIT)).toEqual(passed);
    const v = decoyVerdict(passed, BAIT);
    expect(v).toEqual({ level: "explain", sentence: `I showed this site a decoy wallet (${short(BAIT.address)}) before yours, and what it asked the decoy to sign is not a robbery. Continue to connect your own wallet; the site will then ask again, and I will read that request like any other.`, reasons: [] });
  });

  it("asks the RPC what a decoy holds, about the decoy and nothing else", async () => {
    const asked: any[] = [];
    const rpc: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body);
      asked.push(body);
      if (body.method === "getBalance") return { ok: true, json: async () => ({ result: { value: 310_000_000_000 } }) };
      const token = body.params[1].programId === TOKEN.toBase58();
      return { ok: true, json: async () => ({ result: { value: token ? [
        { pubkey: ata(DECOY).toBase58(), account: { data: { parsed: { info: { mint: USDC.toBase58(), tokenAmount: { amount: "40000000000", decimals: 6 } } } } } },
        { pubkey: key(40).toBase58(), account: { data: { parsed: { info: { mint: key(41).toBase58(), tokenAmount: { amount: "0", decimals: 0 } } } } } },
      ] : [] } }) };
    };
    expect(await readHoldings(BAIT.address, "https://rpc.example", rpc)).toEqual({ lamports: 310_000_000_000n, tokens: [{ mint: USDC.toBase58(), account: ata(DECOY).toBase58(), amount: 40_000_000_000n, decimals: 6 }] });
    expect(asked.map((a) => [a.method, a.params[0]])).toEqual([["getBalance", BAIT.address], ["getTokenAccountsByOwner", BAIT.address], ["getTokenAccountsByOwner", BAIT.address]]);
    // an RPC that is off, or cannot be reached, or does not answer the question: nothing is known, and nothing is made up
    expect(await readHoldings(BAIT.address, "", rpc)).toBeNull();
    expect(await readHoldings(BAIT.address, "https://rpc.example", async () => { throw new Error("offline"); })).toBeNull();
    expect(await readHoldings(BAIT.address, "https://rpc.example", async () => ({ ok: true, json: async () => ({ result: {} }) }))).toBeNull();
  });

  it("is off until it is turned on, and has no decoy until one is named", () => {
    expect(settingsFrom({})).toMatchObject({ decoyFirst: false, decoyAddress: "" });
    expect(settingsFrom({ decoyFirst: true, decoyAddress: ` ${BAIT.address} ` })).toMatchObject({ decoyFirst: true, decoyAddress: BAIT.address });
    for (const bad of ["nonsense", "0x1234", 5, null, "l".repeat(40)]) expect(settingsFrom({ decoyFirst: true, decoyAddress: bad }).decoyAddress, String(bad)).toBe("");
    expect(settingsFrom({ decoyFirst: "yes" }).decoyFirst).toBe(false);
  });
});

// ---- the wallet, stood in for

const real = Object.freeze({ address: key(1).toBase58(), publicKey: key(1).toBytes(), chains: ["solana:mainnet"], features: ["solana:signTransaction"] });
/** What a wallet was asked, in order. */
interface Calls { calls: string[] }
const features = (w: Calls & { set(accounts: unknown[]): void; listeners: ((c: any) => void)[] }) => ({
  "standard:connect": { version: "1.0.0", connect: async () => { w.calls.push("connect"); w.set([real]); for (const l of w.listeners) l({ accounts: [real] }); return { accounts: [real] }; } },
  "standard:events": { version: "1.0.0", on: (_e: string, l: (c: any) => void) => { w.listeners.push(l); return () => { w.listeners.splice(w.listeners.indexOf(l), 1); }; } },
  "solana:signTransaction": { version: "1.0.0", signTransaction: async (...i: any[]) => { w.calls.push("signTransaction"); return i.map((x) => ({ signedTransaction: x.transaction })); } },
  "solana:signMessage": { version: "1.0.0", signMessage: async (...i: any[]) => { w.calls.push("signMessage"); return i.map((x) => ({ signedMessage: x.message, signature: new Uint8Array(64) })); } },
});
/** Wallets as the three real ones are built (test/intercept.test.ts): what differs is where `accounts` and `features` live, and what may be changed. */
const shapes: [string, () => any][] = [
  // Phantom: a frozen instance, everything a getter on its class
  ["a frozen wallet with getters on its class", () => { class P { #calls: string[] = []; #accounts: unknown[] = []; #l: any[] = []; readonly name = "P"; readonly chains = ["solana:mainnet"]; constructor() { Object.freeze(this); } get calls() { return this.#calls; } get accounts() { return this.#accounts; } get features() { return features({ calls: this.#calls, listeners: this.#l, set: (a) => { this.#accounts = a; } }); } } return new P(); }],
  // Solflare: an open instance with the same getters
  ["an open wallet with getters on its class", () => { class S { #calls: string[] = []; #accounts: unknown[] = []; #l: any[] = []; readonly name = "S"; readonly chains = ["solana:mainnet"]; get calls() { return this.#calls; } get accounts() { return this.#accounts; } get features() { return features({ calls: this.#calls, listeners: this.#l, set: (a) => { this.#accounts = a; } }); } } return new S(); }],
  // Backpack, and the practice wallet: plain properties the wallet writes to
  ["a wallet of plain properties", () => { const w: any = { name: "B", chains: ["solana:mainnet"], calls: [] as string[], accounts: [] as unknown[], listeners: [] as any[] }; w.features = features({ calls: w.calls, listeners: w.listeners, set: (a) => { w.accounts = a; } }); return w; }],
];
function fakeWindow() {
  const w = new EventTarget() as EventTarget & { CustomEvent: typeof CustomEvent };
  w.CustomEvent = CustomEvent;
  return w as unknown as Window & { CustomEvent: typeof CustomEvent };
}
/** Warden first, then the wallet announces itself, then the site's app finds it: what the site holds is returned. */
function meet(wallet: object, guard: Guard, gate: DecoyGate): any {
  const win = fakeWindow();
  installStandardHook(win as any, guard, gate);
  const callback = ({ register }: any) => register(wallet);
  win.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
  win.addEventListener("wallet-standard:app-ready", (e) => callback((e as CustomEvent).detail));
  const registered: any[] = [];
  const api = Object.freeze({ register: (...ws: any[]) => { registered.push(...ws); return () => {}; } });
  win.addEventListener("wallet-standard:register-wallet", (e) => (e as CustomEvent).detail(api));
  win.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  return registered[0];
}
function gateOf(first: string | null | Error, verdict: "caught" | "pass" | "declined" = "caught") {
  const asked: GuardRequest[] = [];
  let firsts = 0;
  const gate: DecoyGate = {
    first: async () => { firsts += 1; if (first instanceof Error) throw first; return first; },
    asked: async (r) => { asked.push(r); if (verdict === "declined") throw new WardenRejected(); return verdict === "caught"; },
  };
  return { gate, asked, firsts: () => firsts };
}
const guardOf = () => { const asked: GuardRequest[] = []; const guard: Guard = async (r) => { asked.push(r); return { done() {} }; }; return { guard, asked }; };
const BYTES = everything(DECOY);

describe.each(shapes)("a decoy in front of %s", (_name, make) => {
  it("answers the site's connect with the decoy, and a site that asks the decoy for everything never reaches the wallet", async () => {
    const wallet = make(), g = guardOf(), d = gateOf(BAIT.address, "caught");
    const site = meet(wallet, g.guard, d.gate);
    const { accounts } = await site.features["standard:connect"].connect();
    // the site is handed the decoy: its address, as an account of this wallet
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ address: BAIT.address, chains: ["solana:mainnet"] });
    expect(Buffer.from(accounts[0].publicKey).equals(DECOY.toBuffer())).toBe(true);
    expect(site.accounts.map((a: any) => a.address)).toEqual([BAIT.address]);
    expect(wallet.calls).toEqual([]); // the wallet itself was not connected: the site has not seen its address
    // asked again, the answer is the same and the question is not put twice
    await site.features["standard:connect"].connect();
    expect(d.firsts()).toBe(1);

    // the site asks the decoy to sign everything away
    const stopped = await site.features["solana:signTransaction"].signTransaction({ account: accounts[0], chain: "solana:mainnet", transaction: BYTES }).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(WardenRejected);
    expect((stopped as Error).message).toBe("Blocked by Lamport Warden: this site tried to rob a decoy wallet");
    expect(d.asked).toEqual([{ kind: "tx", bytes: BYTES, owner: BAIT.address }]);
    // Caught: nothing from this page reaches the wallet again. Not a connect, not a request to sign, and the
    // ordinary guard is never even asked.
    for (const again of [() => site.features["standard:connect"].connect(), () => site.features["solana:signTransaction"].signTransaction({ account: real, chain: "solana:mainnet", transaction: BYTES }), () => site.features["solana:signMessage"].signMessage({ account: real, message: Uint8Array.of(1) })]) {
      expect(await again().catch((e: unknown) => e)).toBeInstanceOf(WardenRejected);
    }
    expect(wallet.calls).toEqual([]);
    expect(g.asked).toEqual([]);
    expect(d.asked).toHaveLength(1);
  });

  it("brings the owner's own wallet in when the site passes, tells the site of the change, and has it ask again", async () => {
    const wallet = make(), g = guardOf(), d = gateOf(BAIT.address, "pass");
    const site = meet(wallet, g.guard, d.gate);
    const changes: string[][] = [];
    site.features["standard:events"].on("change", (c: any) => { changes.push(c.accounts.map((a: any) => a.address)); });
    const { accounts } = await site.features["standard:connect"].connect();
    const pay = tx(DECOY, sol(DECOY, SHOP, 500_000_000n));
    const first = await site.features["solana:signTransaction"].signTransaction({ account: accounts[0], chain: "solana:mainnet", transaction: pay }).catch((e: unknown) => e);
    // what it built was built for the decoy: it is told to ask again, of the wallet that is there now
    expect(first).toBeInstanceOf(WardenRejected);
    expect((first as Error).message).toBe("Lamport Warden checked this site with a decoy first. Your own wallet is connected now: ask again.");
    expect(wallet.calls).toEqual(["connect"]);
    expect(changes.at(-1)).toEqual([real.address]);
    expect(site.accounts.map((a: any) => a.address)).toEqual([real.address]);
    // from here on it is a wallet like any other, with Warden reading each request
    const again = tx(key(1), sol(key(1), SHOP, 500_000_000n));
    await site.features["solana:signTransaction"].signTransaction({ account: real, chain: "solana:mainnet", transaction: again });
    expect(wallet.calls).toEqual(["connect", "signTransaction"]);
    expect(g.asked).toEqual([{ kind: "tx", bytes: again, owner: real.address }]);
    expect(d.asked).toHaveLength(1);
    expect((await site.features["standard:connect"].connect()).accounts).toEqual([real]);
  });

  it("stays as it is when the owner chooses not to go on, and takes a message for what it is", async () => {
    const wallet = make(), g = guardOf(), d = gateOf(BAIT.address, "declined");
    const site = meet(wallet, g.guard, d.gate);
    const { accounts } = await site.features["standard:connect"].connect();
    expect(await site.features["solana:signMessage"].signMessage({ account: accounts[0], message: Uint8Array.of(7) }).catch((e: unknown) => e)).toBeInstanceOf(WardenRejected);
    // the question was put (a message asked of the decoy), the owner said no, and the site still holds the decoy
    expect(d.asked).toEqual([{ kind: "msg", bytes: Uint8Array.of(7), owner: BAIT.address }]);
    expect(wallet.calls).toEqual([]);
    expect(site.accounts.map((a: any) => a.address)).toEqual([BAIT.address]);
  });

  it("connects as always when there is no decoy for this page, or nobody to ask", async () => {
    for (const none of [null, new Error("no channel"), "not an address"]) {
      const wallet = make(), g = guardOf(), d = gateOf(none);
      const site = meet(wallet, g.guard, d.gate);
      expect((await site.features["standard:connect"].connect()).accounts).toEqual([real]);
      expect(wallet.calls).toEqual(["connect"]);
      await site.features["solana:signTransaction"].signTransaction({ account: real, chain: "solana:mainnet", transaction: BYTES });
      expect(wallet.calls).toEqual(["connect", "signTransaction"]);
      expect(d.asked).toEqual([]);
      expect(g.asked).toHaveLength(1);
    }
  });
});

describe("a wallet that will not let anyone answer for its accounts", () => {
  it("is never given a decoy: a site must not see one address from connect and another in the list", async () => {
    // everything locked: the list of accounts is a fixed value on a frozen object (and says nobody is connected)
    const calls: string[] = [];
    const locked: any = { name: "L", chains: ["solana:mainnet"], calls, accounts: Object.freeze([]) };
    locked.features = features({ calls, listeners: [], set: () => undefined });
    Object.freeze(locked);
    const g = guardOf(), d = gateOf(BAIT.address);
    const site = meet(locked, g.guard, d.gate);
    expect((await site.features["standard:connect"].connect()).accounts).toEqual([real]);
    expect(calls).toEqual(["connect"]);
    expect(site.accounts).toEqual([]);
    expect(d.asked).toEqual([]);
  });

  it("and no wallet's list of accounts is touched until a decoy is in fact about to be shown", async () => {
    for (const [, make] of shapes) {
      const wallet = make();
      const before = Object.getOwnPropertyDescriptor(wallet, "accounts") ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(wallet), "accounts");
      const site = meet(wallet, guardOf().guard, gateOf(null).gate);
      await site.features["standard:connect"].connect();
      const after = Object.getOwnPropertyDescriptor(wallet, "accounts") ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(wallet), "accounts");
      // the experiment is off for this page: the class's own getter is the one still there, and a plain property is still a plain property
      expect(after!.get).toBe(before!.get);
      expect("value" in after!).toBe("value" in before!);
    }
  });

  it("but a stand-in answers for everything, so there the decoy can go first", async () => {
    const calls: string[] = [];
    const locked: any = { name: "L", chains: ["solana:mainnet"], calls, accounts: Object.freeze([]) };
    locked.features = features({ calls, listeners: [], set: () => undefined });
    Object.freeze(locked);
    const g = guardOf(), d = gateOf(BAIT.address, "caught");
    const site = wrapStandardWallet(locked, g.guard, d.gate);
    const { accounts } = await site.features["standard:connect"].connect();
    expect(accounts[0].address).toBe(BAIT.address);
    expect(site.accounts.map((a: any) => a.address)).toEqual([BAIT.address]);
    expect(locked.accounts).toEqual([]); // the wallet's own object is as it was
    expect(calls).toEqual([]);
  });
});

// ---- the older door: the object a wallet puts on the window

describe("a decoy's address as the key an injected provider hands a page", () => {
  const zero = new Uint8Array(32), high = new Uint8Array(32).fill(255), led = Uint8Array.from([0, 0, 0, 7, ...new Uint8Array(28).fill(9)]);
  it.each([["the decoy", DECOY.toBytes()], ["all zeros (the system program)", zero], ["all ones", high], ["leading zeros", led]])("is taken by the page's own web3.js for the same key: %s", (_name, bytes) => {
    const theirs = new PublicKey(bytes), mine = keyLike(bytes, theirs.toBase58());
    // what a page reads
    expect(mine.toBase58()).toBe(theirs.toBase58());
    expect(String(mine)).toBe(theirs.toBase58());
    expect(JSON.stringify({ k: mine })).toBe(JSON.stringify({ k: theirs }));
    expect([...mine.toBytes()]).toEqual([...theirs.toBytes()]);
    expect(Buffer.isBuffer(mine.toBuffer()) && mine.toBuffer().equals(theirs.toBuffer())).toBe(true);
    // what web3.js does with a key from another copy of itself: takes its number, and compares by it
    expect(new PublicKey(mine).toBase58()).toBe(theirs.toBase58());
    expect(new PublicKey(mine).equals(theirs)).toBe(true);
    expect(theirs.equals(mine)).toBe(true);
    expect(mine.equals(theirs)).toBe(true);
    expect(mine.equals(theirs.toBase58())).toBe(true);
    expect(key(77).equals(mine)).toBe(false);
    expect(mine.equals(key(77))).toBe(false);
    // the number itself is laid out as bn.js lays one out
    const bn = (theirs as any)._bn;
    expect(mine._bn.length).toBe(bn.length);
    expect([...mine._bn.words]).toEqual([...bn.words].slice(0, bn.length));
    expect(mine._bn.byteLength()).toBe(bn.byteLength());
    expect(mine._bn.toString(16)).toBe(bn.toString(16));
    expect([...mine._bn.toArrayLike(Buffer, "be", 32)]).toEqual([...bn.toArrayLike(Buffer, "be", 32)]);
    expect([...mine._bn.toArrayLike(Buffer, "le", 32)]).toEqual([...bn.toArrayLike(Buffer, "le", 32)]);
    expect(bn.eq(mine._bn) && mine._bn.eq(bn)).toBe(true);
  });

  it("builds the same transaction as the real key does", () => {
    const mine = keyLike(DECOY.toBytes(), DECOY.toBase58());
    const built = new Transaction({ feePayer: mine, recentBlockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" }).add(SystemProgram.transfer({ fromPubkey: mine, toPubkey: THIEF, lamports: 309_990_000_000n }), usdc(DECOY, THIEF, 40_000_000_000n));
    expect(Buffer.from(built.serialize({ requireAllSignatures: false, verifySignatures: false })).equals(Buffer.from(everything(DECOY)))).toBe(true);
  });
});

type Fn = (...a: any[]) => any;
/** As much of an event emitter as a provider has: Phantom's and Backpack's keep their listeners where a page cannot reach. */
class Emitter {
  #l = new Map<string, Fn[]>();
  on(e: string, f: Fn) { this.#l.set(e, [...(this.#l.get(e) ?? []), f]); return this; }
  addListener(e: string, f: Fn) { return this.on(e, f); }
  off(e: string, f: Fn) { this.#l.set(e, (this.#l.get(e) ?? []).filter((x) => x !== f)); return this; }
  emit(e: string, ...a: unknown[]) { for (const f of [...(this.#l.get(e) ?? [])]) f.apply(this, a); return true; }
  listeners(e: string) { return [...(this.#l.get(e) ?? [])]; }
}
const OWNER_KEY = key(1);
interface Made { provider: any; calls: string[]; trust(): void; said: (k: unknown) => unknown }
/** Injected providers as the real ones are built (read from the shipped Phantom 26.38 and Backpack 0.10), and a plain one. */
const providers: [string, () => Made][] = [
  // Phantom: an open object; its methods are its own properties, `publicKey` and `isConnected` getters on a class above it
  ["a provider like Phantom's", () => {
    const calls: string[] = []; let trusted = false;
    class Base extends Emitter { _publicKey: PublicKey | null = null; get publicKey() { return this._publicKey; } get isConnected() { return this._publicKey !== null; } }
    class P extends Base {
      isPhantom = true;
      #connect = async (o?: any) => { if (o?.onlyIfTrusted && !trusted) throw new Error("not trusted"); calls.push("connect"); this._publicKey = OWNER_KEY; this.emit("connect", this._publicKey); return { publicKey: this._publicKey }; };
      connect = async (o?: any) => this.#connect(o);
      disconnect = async () => { calls.push("disconnect"); this._publicKey = null; this.emit("disconnect"); };
      signTransaction = async (t: any) => { calls.push("signTransaction"); return t; };
      signAllTransactions = async (t: any[]) => { calls.push("signAllTransactions"); return t; };
      signMessage = async (_m: Uint8Array) => { calls.push("signMessage"); return { signature: new Uint8Array(64) }; };
      request = async (a: any) => { if (a?.method === "connect") return this.#connect(a.params); calls.push(`request:${a?.method}`); return "ok"; };
    }
    return { provider: new P(), calls, trust: () => { trusted = true; }, said: (k) => k };
  }],
  // Backpack: a frozen object; everything is on its class, the key in a private field, and it tells its listeners the address in an object
  ["a provider like Backpack's", () => {
    const calls: string[] = []; let trusted = false;
    class B extends Emitter {
      #key: PublicKey | null = null;
      constructor() { super(); Object.freeze(this); }
      get isBackpack() { return true; }
      get publicKey() { return this.#key; }
      get isConnected() { return this.#key !== null; }
      async connect(o?: any) { if (o?.onlyIfTrusted && !trusted) throw new Error("not trusted"); calls.push("connect"); this.#key = OWNER_KEY; this.emit("connect", { publicKey: OWNER_KEY.toBase58() }); return { publicKey: this.#key }; }
      async disconnect() { calls.push("disconnect"); this.#key = null; this.emit("disconnect"); }
      async signTransaction(t: any) { calls.push("signTransaction"); return t; }
      async signAllTransactions(t: any[]) { calls.push("signAllTransactions"); return t; }
      async signMessage(_m: Uint8Array) { calls.push("signMessage"); return { signature: new Uint8Array(64) }; }
    }
    return { provider: new B(), calls, trust: () => { trusted = true; }, said: (k: any) => ({ publicKey: k.toBase58() }) };
  }],
  // a wallet that keeps its key in a plain property it writes to
  ["a provider of plain properties", () => {
    const calls: string[] = []; let trusted = false;
    const e = new Emitter();
    const p: any = {
      publicKey: null, isConnected: false,
      on: (ev: string, f: Fn) => e.on(ev, f), off: (ev: string, f: Fn) => e.off(ev, f), listeners: (ev: string) => e.listeners(ev),
      connect: async (o?: any) => { if (o?.onlyIfTrusted && !trusted) throw new Error("not trusted"); calls.push("connect"); p.publicKey = OWNER_KEY; p.isConnected = true; e.emit("connect", OWNER_KEY); return { publicKey: OWNER_KEY }; },
      disconnect: async () => { calls.push("disconnect"); p.publicKey = null; p.isConnected = false; e.emit("disconnect"); },
      signTransaction: async (t: any) => { calls.push("signTransaction"); return t; },
      signMessage: async (_m: Uint8Array) => { calls.push("signMessage"); return { signature: new Uint8Array(64) }; },
    };
    return { provider: p, calls, trust: () => { trusted = true; }, said: (k) => k };
  }],
];
/** A transaction object as a page hands one to a provider, built by the page's own web3.js for whatever key it was given. */
const asked = (payer: any, ...ix: TransactionInstruction[]) => new Transaction({ feePayer: payer, recentBlockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" }).add(...ix);
/** The wallet's own listeners are put on first (as its Wallet Standard wallet does when it is made); then Warden meets it; then the page listens. */
async function onWindow(m: Made, guard: Guard, gate: DecoyGate) {
  const own: unknown[][] = [], heard: unknown[][] = [];
  m.provider.on("connect", (...a: unknown[]) => own.push(["connect", ...a]));
  const win: Record<string, any> = { solana: m.provider };
  installLegacyHook(win, guard, ["solana"], [], gate);
  // Phantom announces its provider, which is when Warden meets it, before its Wallet Standard wallet has begun listening to it
  for (const ev of ["disconnect", "accountChanged"]) m.provider.on(ev, (...a: unknown[]) => own.push([ev, ...a]));
  await Promise.resolve(); // the wallet's script has run to its end; the page's scripts come after
  for (const ev of ["connect", "disconnect", "accountChanged"]) win.solana.on(ev, (...a: unknown[]) => heard.push([ev, ...a]));
  return { site: win.solana as any, own, heard };
}

describe.each(providers)("a decoy in front of %s", (_name, make) => {
  it("answers connect with the decoy, and a site that asks the decoy for everything never reaches the wallet", async () => {
    const m = make(), g = guardOf(), d = gateOf(BAIT.address, "caught");
    const { site, own, heard } = await onWindow(m, g.guard, d.gate);
    const out = await site.connect();
    // the site is handed the decoy: by connect, by what the provider says its account is, and by the event
    expect(out.publicKey.toBase58()).toBe(BAIT.address);
    expect(site.publicKey.toBase58()).toBe(BAIT.address);
    expect(site.isConnected).toBe(true);
    expect(new PublicKey(site.publicKey.toBytes()).equals(DECOY)).toBe(true);
    expect(heard).toHaveLength(1);
    expect(heard[0]![0]).toBe("connect");
    expect(JSON.stringify(heard[0]![1])).toBe(JSON.stringify(m.said(DECOY)));
    // the wallet itself was not connected, and its own listeners were told nothing
    expect(m.calls).toEqual([]);
    expect(own).toEqual([]);
    await site.connect();
    expect(d.firsts()).toBe(1);

    // the site builds its robbery for the key it was handed, with its own web3.js
    const stopped = await site.signTransaction(asked(out.publicKey, sol(DECOY, THIEF, 309_990_000_000n), usdc(DECOY, THIEF, 40_000_000_000n))).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(WardenRejected);
    expect((stopped as Error).message).toBe("Blocked by Lamport Warden: this site tried to rob a decoy wallet");
    expect(d.asked.map((a) => ({ ...a, bytes: [...a.bytes] }))).toEqual([{ kind: "tx", bytes: [...BYTES], owner: BAIT.address }]);
    // caught: nothing more from this page reaches the wallet, and the ordinary guard is never asked
    for (const again of [() => site.connect(), () => site.connect({ onlyIfTrusted: true }), () => site.signMessage(Uint8Array.of(1)), () => site.signTransaction(asked(OWNER_KEY, sol(OWNER_KEY, THIEF, 1n)))]) {
      expect(await again().catch((e: unknown) => e)).toBeInstanceOf(WardenRejected);
    }
    expect(m.calls).toEqual([]);
    expect(g.asked).toEqual([]);
    expect(d.asked).toHaveLength(1);
  });

  it("brings the owner's own wallet in when the site passes, tells the site the account changed, and has it ask again", async () => {
    const m = make(), g = guardOf(), d = gateOf(BAIT.address, "pass");
    const { site, heard } = await onWindow(m, g.guard, d.gate);
    const out = await site.connect();
    const first = await site.signTransaction(asked(out.publicKey, sol(DECOY, SHOP, 500_000_000n))).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(WardenRejected);
    expect((first as Error).message).toBe("Lamport Warden checked this site with a decoy first. Your own wallet is connected now: ask again.");
    expect(m.calls).toEqual(["connect"]);
    expect(site.publicKey.toBase58()).toBe(OWNER_KEY.toBase58());
    // the wallet said it connected, and the site was also told its account is another one now
    expect(heard.map((h) => h[0])).toEqual(["connect", "connect", "accountChanged"]);
    expect(JSON.stringify(heard[2]![1])).toBe(JSON.stringify(m.said(OWNER_KEY)));
    // from here on it is a wallet like any other, with Warden reading each request
    const again = asked(OWNER_KEY, sol(OWNER_KEY, SHOP, 500_000_000n));
    await site.signTransaction(again);
    expect(m.calls).toEqual(["connect", "signTransaction"]);
    expect(g.asked.map((a) => ({ ...a, bytes: [...a.bytes] }))).toEqual([{ kind: "tx", bytes: [...tx(OWNER_KEY, sol(OWNER_KEY, SHOP, 500_000_000n))], owner: OWNER_KEY.toBase58() }]);
    expect(d.asked).toHaveLength(1);
    expect((await site.connect()).publicKey.toBase58()).toBe(OWNER_KEY.toBase58());
  });

  it("leaves a site the wallet already trusts as it is, and shows a decoy to one it does not", async () => {
    // trusted: a connect that asks not to prompt is answered by the wallet, and that site is never shown a decoy
    const t = make(), dt = gateOf(BAIT.address);
    t.trust();
    const trusted = (await onWindow(t, guardOf().guard, dt.gate)).site;
    expect((await trusted.connect({ onlyIfTrusted: true })).publicKey.toBase58()).toBe(OWNER_KEY.toBase58());
    expect((await trusted.connect()).publicKey.toBase58()).toBe(OWNER_KEY.toBase58());
    expect(dt.firsts()).toBe(0);
    // not trusted: the wallet refuses as it always does, and the connect that follows is answered with the decoy
    const u = make(), du = gateOf(BAIT.address);
    const unknown = (await onWindow(u, guardOf().guard, du.gate)).site;
    expect(await unknown.connect({ onlyIfTrusted: true }).catch((e: Error) => e.message)).toBe("not trusted");
    expect((await unknown.connect()).publicKey.toBase58()).toBe(BAIT.address);
    expect(u.calls).toEqual([]);
  });

  it("lets go of the decoy when the site disconnects, without touching the wallet", async () => {
    const m = make(), d = gateOf(BAIT.address);
    const { site, heard, own } = await onWindow(m, guardOf().guard, d.gate);
    await site.connect();
    await site.disconnect();
    expect(site.publicKey).toBeNull();
    expect(site.isConnected).toBe(false);
    expect(heard.map((h) => h[0])).toEqual(["connect", "disconnect"]);
    expect(m.calls).toEqual([]);
    expect(own).toEqual([]);
    // connecting again shows the same decoy, and the question is not put twice
    expect((await site.connect()).publicKey.toBase58()).toBe(BAIT.address);
    expect(d.firsts()).toBe(1);
  });

  it("connects as always when there is no decoy for this page, and touches nothing of the provider's until one is to be shown", async () => {
    const where = (p: any) => { for (let h = p, i = 0; h && i < 6; h = Object.getPrototypeOf(h), i++) { const x = Object.getOwnPropertyDescriptor(h, "publicKey"); if (x) return [i, x.get ?? "value"] as const; } return null; };
    for (const none of [null, new Error("no channel"), "not an address"]) {
      const m = make(), g = guardOf(), d = gateOf(none);
      const before = where(m.provider);
      const { site } = await onWindow(m, g.guard, d.gate);
      expect((await site.connect()).publicKey.toBase58()).toBe(OWNER_KEY.toBase58());
      expect(m.calls).toEqual(["connect"]);
      expect(where(m.provider)).toEqual(before);
      await site.signMessage(Uint8Array.of(5));
      expect(d.asked).toEqual([]);
      expect(g.asked).toHaveLength(1);
    }
  });
});

describe("the older door, where it differs from wallet to wallet", () => {
  it("answers a connect made through request() with the decoy too", async () => {
    const m = providers[0]![1](), d = gateOf(BAIT.address, "caught");
    const { site } = await onWindow(m, guardOf().guard, d.gate);
    expect((await site.request({ method: "connect" })).publicKey.toBase58()).toBe(BAIT.address);
    expect(site.publicKey.toBase58()).toBe(BAIT.address);
    expect(m.calls).toEqual([]);
    expect(await site.signAllTransactions([asked(site.publicKey, sol(DECOY, THIEF, 309_990_000_000n), usdc(DECOY, THIEF, 40_000_000_000n))]).catch((e: unknown) => e)).toBeInstanceOf(WardenRejected);
    expect(d.asked.map((a) => ({ ...a, bytes: [...a.bytes] }))).toEqual([{ kind: "tx", bytes: [...BYTES], owner: BAIT.address }]);
  });

  it("gives no decoy at a provider that is already connected: the site has its address already", async () => {
    const m = providers[0]![1](), d = gateOf(BAIT.address);
    await m.provider.connect();
    const { site } = await onWindow(m, guardOf().guard, d.gate);
    expect((await site.connect()).publicKey.toBase58()).toBe(OWNER_KEY.toBase58());
    expect(d.firsts()).toBe(0);
  });

  it("gives no decoy at a provider that will not let anyone answer for its account", async () => {
    // its methods can be replaced, its key is a fixed property: connect would say one thing and the provider another
    const calls: string[] = [];
    const locked: any = { connect: async () => { calls.push("connect"); return { publicKey: OWNER_KEY }; }, signMessage: async () => ({ signature: new Uint8Array(64) }) };
    Object.defineProperty(locked, "publicKey", { value: null, writable: true, configurable: false });
    const win: Record<string, any> = { solana: locked }, d = gateOf(BAIT.address);
    installLegacyHook(win, guardOf().guard, ["solana"], [], d.gate);
    expect((await win.solana.connect()).publicKey.toBase58()).toBe(OWNER_KEY.toBase58());
    expect(calls).toEqual(["connect"]);
    expect(win.solana.publicKey).toBeNull();
  });

  it("but a stand-in answers for everything, so there the decoy can go first", async () => {
    // frozen through and through, on a window that lets its place be taken: the site is handed a stand-in
    const calls: string[] = [];
    const frozen: any = Object.freeze({ publicKey: null, connect: async () => { calls.push("connect"); return { publicKey: OWNER_KEY }; }, signMessage: async () => { calls.push("signMessage"); return { signature: new Uint8Array(64) }; } });
    const win: Record<string, any> = { solana: frozen }, d = gateOf(BAIT.address, "caught");
    installLegacyHook(win, guardOf().guard, ["solana"], [], d.gate);
    expect(win.solana).not.toBe(frozen);
    expect((await win.solana.connect()).publicKey.toBase58()).toBe(BAIT.address);
    expect(win.solana.publicKey.toBase58()).toBe(BAIT.address);
    expect(frozen.publicKey).toBeNull(); // the wallet's own object is as it was
    expect(await win.solana.signMessage(Uint8Array.of(1)).catch((e: unknown) => e)).toBeInstanceOf(WardenRejected);
    expect(calls).toEqual([]);
  });
});

describe("one page, one decoy, one outcome: every door of every wallet", () => {
  /** A wallet with both doors, its Wallet Standard connect and signing a call to its own provider, as Phantom's and Backpack's are. */
  function wallet(guard: Guard, gate: DecoyGate) {
    const m = providers[0]![1]();
    const listeners: Fn[] = [];
    let accounts: unknown[] = [];
    const account = () => Object.freeze({ address: OWNER_KEY.toBase58(), publicKey: OWNER_KEY.toBytes(), chains: ["solana:mainnet"], features: [] });
    m.provider.on("connect", () => { accounts = [account()]; for (const l of listeners) l({ accounts }); });
    m.provider.on("disconnect", () => { accounts = []; for (const l of listeners) l({ accounts }); });
    const standard: any = {
      name: "Both", version: "1.0.0", chains: ["solana:mainnet"],
      get accounts() { return accounts; },
      features: {
        "standard:connect": { version: "1.0.0", connect: async ({ silent }: { silent?: boolean } = {}) => { if (!accounts.length) await m.provider.connect(silent ? { onlyIfTrusted: true } : undefined).catch((e: unknown) => { if (!silent) throw e; }); return { accounts }; } },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => { await m.provider.disconnect(); } },
        "standard:events": { version: "1.0.0", on: (_e: string, l: Fn) => { listeners.push(l); return () => { listeners.splice(listeners.indexOf(l), 1); }; } },
        "solana:signTransaction": { version: "1.0.0", signTransaction: async (...i: any[]) => { await m.provider.signTransaction({ version: 0, message: { serialize: () => Uint8Array.of(0) }, serialize: () => i[0].transaction }); return i.map((x) => ({ signedTransaction: x.transaction })); } },
      },
    };
    const win: Record<string, any> = { solana: m.provider };
    installLegacyHook(win, guard, ["solana"], [], gate);
    expect(patchStandardWalletInPlace(standard, guard, gate)).toBe(true);
    return { m, standard, older: win.solana as any };
  }

  it("shows the same decoy at both doors, asking for it once", async () => {
    const g = guardOf(), d = gateOf(BAIT.address);
    const { m, standard, older } = wallet(g.guard, d.gate);
    expect((await standard.features["standard:connect"].connect()).accounts[0].address).toBe(BAIT.address);
    expect((await older.connect()).publicKey.toBase58()).toBe(BAIT.address);
    expect(d.firsts()).toBe(1);
    expect(m.calls).toEqual([]);
  });

  it("refuses at every door once the page is caught at one", async () => {
    const g = guardOf(), d = gateOf(BAIT.address, "caught");
    const { m, standard, older } = wallet(g.guard, d.gate);
    const out = await older.connect();
    expect(await older.signTransaction(asked(out.publicKey, sol(DECOY, THIEF, 309_990_000_000n), usdc(DECOY, THIEF, 40_000_000_000n))).catch((e: unknown) => e)).toBeInstanceOf(WardenRejected);
    for (const again of [() => standard.features["standard:connect"].connect(), () => standard.features["solana:signTransaction"].signTransaction({ account: real, transaction: BYTES }), () => older.request({ method: "connect" })]) {
      expect(((await again().catch((e: unknown) => e)) as Error).message).toBe("Blocked by Lamport Warden: this site tried to rob a decoy wallet");
    }
    expect(m.calls).toEqual([]);
    expect(g.asked).toEqual([]);
  });

  it("connects the wallet once when the site passes at its Wallet Standard door, though that door reaches the wallet through the older one", async () => {
    const g = guardOf(), d = gateOf(BAIT.address, "pass");
    const { m, standard, older } = wallet(g.guard, d.gate);
    const changes: string[][] = [];
    standard.features["standard:events"].on("change", (c: any) => { changes.push(c.accounts.map((a: any) => a.address)); });
    const heard: string[] = [];
    await Promise.resolve(); // the wallet's script has run to its end; the page's scripts come after
    older.on("disconnect", () => heard.push("disconnect"));
    // the site holds the decoy at both doors
    const { accounts } = await standard.features["standard:connect"].connect();
    await older.connect();
    const pay = tx(DECOY, sol(DECOY, SHOP, 500_000_000n));
    const first = await standard.features["solana:signTransaction"].signTransaction({ account: accounts[0], transaction: pay }).catch((e: unknown) => e);
    expect((first as Error).message).toBe("Lamport Warden checked this site with a decoy first. Your own wallet is connected now: ask again.");
    // the wallet was connected, once, by its own Wallet Standard code calling its provider: that call was not answered with a decoy
    expect(m.calls).toEqual(["connect"]);
    expect(standard.accounts.map((a: any) => a.address)).toEqual([OWNER_KEY.toBase58()]);
    expect(changes.at(-1)).toEqual([OWNER_KEY.toBase58()]);
    // the decoy came down at the older door too: it was told so, and says what the wallet says
    expect(heard).toEqual(["disconnect"]);
    expect(older.publicKey.toBase58()).toBe(OWNER_KEY.toBase58());
    expect(d.firsts()).toBe(1);
    // and from here one request is one question, at whichever door
    const again = tx(OWNER_KEY, sol(OWNER_KEY, SHOP, 500_000_000n));
    await standard.features["solana:signTransaction"].signTransaction({ account: standard.accounts[0], transaction: again });
    expect(g.asked).toEqual([{ kind: "tx", bytes: again, owner: OWNER_KEY.toBase58() }]);
    expect(m.calls).toEqual(["connect", "signTransaction"]);
  });

  it("leaves a wallet that already trusts the site as it is at its Wallet Standard door, and shows a decoy where it does not", async () => {
    // not trusted: asked not to prompt, the wallet lists nobody; the connect that follows is answered with the decoy
    const a = wallet(guardOf().guard, gateOf(BAIT.address).gate);
    expect((await a.standard.features["standard:connect"].connect({ silent: true })).accounts).toEqual([]);
    expect((await a.standard.features["standard:connect"].connect()).accounts[0].address).toBe(BAIT.address);
    expect(a.m.calls).toEqual([]);
    // trusted: the wallet answers with its account, and that site is not shown a decoy afterwards
    const d = gateOf(BAIT.address), b = wallet(guardOf().guard, d.gate);
    b.m.trust();
    expect((await b.standard.features["standard:connect"].connect({ silent: true })).accounts[0].address).toBe(OWNER_KEY.toBase58());
    expect((await b.standard.features["standard:connect"].connect()).accounts[0].address).toBe(OWNER_KEY.toBase58());
    expect((await b.older.connect()).publicKey.toBase58()).toBe(OWNER_KEY.toBase58());
    expect(d.firsts()).toBe(0);
  });

  it("lets go of the decoy at the Wallet Standard door when the site disconnects, without touching the wallet", async () => {
    const d = gateOf(BAIT.address), { m, standard } = wallet(guardOf().guard, d.gate);
    const changes: string[][] = [];
    standard.features["standard:events"].on("change", (c: any) => { changes.push(c.accounts.map((a: any) => a.address)); });
    await standard.features["standard:connect"].connect();
    expect(standard.accounts.map((a: any) => a.address)).toEqual([BAIT.address]);
    await standard.features["standard:disconnect"].disconnect();
    expect(standard.accounts).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
    expect(m.calls).toEqual([]);
    expect((await standard.features["standard:connect"].connect()).accounts[0].address).toBe(BAIT.address);
    expect(d.firsts()).toBe(1);
  });
});

