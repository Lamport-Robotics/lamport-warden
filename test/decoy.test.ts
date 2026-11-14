/**
 * Decoy first: what catches a site, and how a wallet is stood in for while the site is looking at a decoy.
 *
 * (The whole of it in a browser, against the practice page's pretend thief, is test/browser/decoy.test.ts.)
 */
import "../src/polyfill.js";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { PRACTICE_DECOY, decoyVerdict, judgeDecoy, readHoldings, type Decoy } from "../src/decoy.js";
import { WardenRejected, installStandardHook, wrapStandardWallet, type DecoyGate, type Guard, type GuardRequest } from "../src/intercept.js";
import { cleanAddress, settingsFrom } from "../src/settings.js";
import type { FetchLike } from "../src/rpc.js";

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const DECOY = new PublicKey(PRACTICE_DECOY.address), THIEF = key(9), SHOP = key(8);
const ata = (owner: PublicKey, mint = USDC) => PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN.toBytes(), mint.toBytes()], ASSOCIATED)[0];
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const tx = (payer: PublicKey, ...ix: TransactionInstruction[]) => new Uint8Array(new Transaction({ feePayer: payer, recentBlockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" }).add(...ix).serialize({ requireAllSignatures: false, verifySignatures: false }));
const sol = (from: PublicKey, to: PublicKey, lamports: bigint) => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
const usdc = (from: PublicKey, to: PublicKey, units: bigint) => new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: ata(from), isSigner: false, isWritable: true }, { pubkey: USDC, isSigner: false, isWritable: false }, { pubkey: ata(to), isSigner: false, isWritable: true }, { pubkey: from, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([12]), u64(units), Buffer.from([6])]) });
const approve = (from: PublicKey, to: PublicKey, units: bigint) => new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: ata(from), isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: false }, { pubkey: from, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([4]), u64(units)]) });
const setAuthority = (from: PublicKey, to: PublicKey) => new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: ata(from), isSigner: false, isWritable: true }, { pubkey: from, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([6, 2, 1]), to.toBuffer()]) });
/** What the practice page's pretend thief asks for (site/try/src/thief.ts): all but a little of the SOL, and all of the USDC. */
const everything = (victim: PublicKey) => tx(victim, sol(victim, THIEF, 309_990_000_000n), usdc(victim, THIEF, 40_000_000_000n));

describe("the practice decoy", () => {
  it("is an address that looks like any wallet's and that nobody has a key to", () => {
    // a hash of some words, walked forward to the nearest point on the curve: there is no key it was made from
    const bytes = Uint8Array.from(createHash("sha256").update("Lamport Warden practice decoy").digest());
    while (!PublicKey.isOnCurve(bytes)) bytes[31] = (bytes[31]! + 1) & 0xff;
    expect(new PublicKey(bytes).toBase58()).toBe(PRACTICE_DECOY.address);
    expect(PRACTICE_DECOY.tokens![0]!.account).toBe(ata(DECOY).toBase58());
    expect(cleanAddress(PRACTICE_DECOY.address)).toBe(PRACTICE_DECOY.address);
  });
});

describe("what a site asks a decoy for says what the site is", () => {
  it("catches the site that asks for everything, and says what it asked for", () => {
    const found = judgeDecoy(everything(DECOY), PRACTICE_DECOY);
    expect(found).toEqual({ caught: true, asked: ["send out 309.99 SOL, of the 310 SOL it holds and 40,000 USDC, all it holds"], to: null });
    const v = decoyVerdict(found, PRACTICE_DECOY);
    expect(v.level).toBe("block");
    expect(v.sentence).toBe("This site tried to rob a wallet that is not yours. I showed it a decoy before your own wallet, and it asked the decoy to send out 309.99 SOL, of the 310 SOL it holds and 40,000 USDC, all it holds.");
    expect(v.reasons).toEqual([
      "your wallet was never connected to this site, and the site has not seen your address.",
      "nothing was taken: nobody here holds the decoy's key, so nothing it is asked to sign can be signed.",
      "I will pass nothing from this page to your wallet. Close it.",
    ]);
  });

  it("catches nearly all of one thing, a sweep of several, and any handing over of power", () => {
    const caught = (bytes: Uint8Array, decoy: Decoy = PRACTICE_DECOY) => judgeDecoy(bytes, decoy);
    // nearly all the SOL, to one address: the amount is the balance, which no visitor chose
    expect(caught(tx(DECOY, sol(DECOY, THIEF, 300_000_000_000n)))).toEqual({ caught: true, asked: ["send out 300 SOL, of the 310 SOL it holds"], to: THIEF.toBase58() });
    // all of a token
    expect(caught(tx(DECOY, usdc(DECOY, THIEF, 40_000_000_000n)))).toMatchObject({ caught: true, asked: ["send out 40,000 USDC, all it holds"] });
    // Two different things at once and nothing else is a sweep, whatever the amounts, and whether or not
    // anything is known of what the decoy holds.
    const bare: Decoy = { address: PRACTICE_DECOY.address };
    expect(caught(tx(DECOY, sol(DECOY, THIEF, 1_000_000_000n), usdc(DECOY, THIEF, 5_000_000n)), bare)).toEqual({ caught: true, asked: ["send out 1 SOL and 5 USDC"], to: null });
    // letting somebody spend, and handing an account over: caught with nothing sent at all
    expect(caught(tx(DECOY, approve(DECOY, THIEF, 0xffff_ffff_ffff_ffffn)), bare)).toEqual({ caught: true, asked: [`let ${short(THIEF.toBase58())} spend its tokens, without limit`], to: THIEF.toBase58() });
    expect(caught(tx(DECOY, approve(DECOY, THIEF, 5n)), bare).asked).toEqual([`let ${short(THIEF.toBase58())} spend its tokens`]);
    expect(caught(tx(DECOY, setAuthority(DECOY, THIEF)), bare)).toEqual({ caught: true, asked: [`hand ${short(THIEF.toBase58())} control of one of its token accounts`], to: THIEF.toBase58() });
    const both = decoyVerdict(caught(tx(DECOY, approve(DECOY, THIEF, 0xffff_ffff_ffff_ffffn), sol(DECOY, THIEF, 309_000_000_000n))), PRACTICE_DECOY);
    expect(both.sentence).toBe(`This site tried to rob a wallet that is not yours. I showed it a decoy before your own wallet, and it asked the decoy to let ${short(THIEF.toBase58())} spend its tokens, without limit, and send out 309 SOL, of the 310 SOL it holds, to ${short(THIEF.toBase58())}.`);
  });

  it("lets an ordinary site pass: a payment somebody chose, a swap, and anything that is not a request of the decoy", () => {
    const passed = { caught: false, asked: [], to: null };
    // a shop asking for half a SOL, of 310
    expect(judgeDecoy(tx(DECOY, sol(DECOY, SHOP, 500_000_000n)), PRACTICE_DECOY)).toEqual(passed);
    // 25 USDC of 40,000
    expect(judgeDecoy(tx(DECOY, usdc(DECOY, SHOP, 25_000_000n)), PRACTICE_DECOY)).toEqual(passed);
    // With nothing known of what the decoy holds, one thing sent once catches nobody: it might be a payment.
    expect(judgeDecoy(tx(DECOY, sol(DECOY, THIEF, 300_000_000_000n)), { address: PRACTICE_DECOY.address })).toEqual(passed);
    // A program Warden does not read in the transaction: a swap looks like this, and so could a thief's own
    // program. The decoy does not settle it; the site passes, and Warden reads what it asks of the real wallet.
    const swap = new TransactionInstruction({ programId: key(77), keys: [{ pubkey: DECOY, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) });
    expect(judgeDecoy(tx(DECOY, sol(DECOY, key(78), 309_000_000_000n), swap), PRACTICE_DECOY)).toEqual(passed);
    // a transaction somebody else signs asks nothing of the decoy
    expect(judgeDecoy(everything(key(5)), PRACTICE_DECOY)).toEqual(passed);
    // and bytes that are no transaction at all
    expect(judgeDecoy(Uint8Array.from([1, 2, 3]), PRACTICE_DECOY)).toEqual(passed);
    const v = decoyVerdict(passed, PRACTICE_DECOY);
    expect(v).toEqual({ level: "explain", sentence: `I showed this site a decoy wallet (${short(PRACTICE_DECOY.address)}) before yours, and what it asked the decoy to sign is not a robbery. Continue to connect your own wallet; the site will then ask again, and I will read that request like any other.`, reasons: [] });
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
    expect(await readHoldings(PRACTICE_DECOY.address, "https://rpc.example", rpc)).toEqual({ lamports: 310_000_000_000n, tokens: [{ mint: USDC.toBase58(), account: ata(DECOY).toBase58(), amount: 40_000_000_000n, decimals: 6 }] });
    expect(asked.map((a) => [a.method, a.params[0]])).toEqual([["getBalance", PRACTICE_DECOY.address], ["getTokenAccountsByOwner", PRACTICE_DECOY.address], ["getTokenAccountsByOwner", PRACTICE_DECOY.address]]);
    // an RPC that is off, or cannot be reached, or does not answer the question: nothing is known, and nothing is made up
    expect(await readHoldings(PRACTICE_DECOY.address, "", rpc)).toBeNull();
    expect(await readHoldings(PRACTICE_DECOY.address, "https://rpc.example", async () => { throw new Error("offline"); })).toBeNull();
    expect(await readHoldings(PRACTICE_DECOY.address, "https://rpc.example", async () => ({ ok: true, json: async () => ({ result: {} }) }))).toBeNull();
  });

  it("is off until it is turned on, and has no decoy until one is named", () => {
    expect(settingsFrom({})).toMatchObject({ decoyFirst: false, decoyAddress: "" });
    expect(settingsFrom({ decoyFirst: true, decoyAddress: ` ${PRACTICE_DECOY.address} ` })).toMatchObject({ decoyFirst: true, decoyAddress: PRACTICE_DECOY.address });
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
    const wallet = make(), g = guardOf(), d = gateOf(PRACTICE_DECOY.address, "caught");
    const site = meet(wallet, g.guard, d.gate);
    const { accounts } = await site.features["standard:connect"].connect();
    // the site is handed the decoy: its address, as an account of this wallet
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ address: PRACTICE_DECOY.address, chains: ["solana:mainnet"] });
    expect(Buffer.from(accounts[0].publicKey).equals(DECOY.toBuffer())).toBe(true);
    expect(site.accounts.map((a: any) => a.address)).toEqual([PRACTICE_DECOY.address]);
    expect(wallet.calls).toEqual([]); // the wallet itself was not connected: the site has not seen its address
    // asked again, the answer is the same and the question is not put twice
    await site.features["standard:connect"].connect();
    expect(d.firsts()).toBe(1);

    // the site asks the decoy to sign everything away
    const stopped = await site.features["solana:signTransaction"].signTransaction({ account: accounts[0], chain: "solana:mainnet", transaction: BYTES }).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(WardenRejected);
    expect((stopped as Error).message).toBe("Blocked by Lamport Warden: this site tried to rob a decoy wallet");
    expect(d.asked).toEqual([{ kind: "tx", bytes: BYTES, owner: PRACTICE_DECOY.address }]);
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
    const wallet = make(), g = guardOf(), d = gateOf(PRACTICE_DECOY.address, "pass");
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
    const wallet = make(), g = guardOf(), d = gateOf(PRACTICE_DECOY.address, "declined");
    const site = meet(wallet, g.guard, d.gate);
    const { accounts } = await site.features["standard:connect"].connect();
    expect(await site.features["solana:signMessage"].signMessage({ account: accounts[0], message: Uint8Array.of(7) }).catch((e: unknown) => e)).toBeInstanceOf(WardenRejected);
    // the question was put (a message asked of the decoy), the owner said no, and the site still holds the decoy
    expect(d.asked).toEqual([{ kind: "msg", bytes: Uint8Array.of(7), owner: PRACTICE_DECOY.address }]);
    expect(wallet.calls).toEqual([]);
    expect(site.accounts.map((a: any) => a.address)).toEqual([PRACTICE_DECOY.address]);
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
    // everything locked: the accounts are a fixed value on a frozen object
    const calls: string[] = [];
    const locked: any = { name: "L", chains: ["solana:mainnet"], calls, accounts: [real] };
    locked.features = features({ calls, listeners: [], set: () => undefined });
    Object.freeze(locked);
    const g = guardOf(), d = gateOf(PRACTICE_DECOY.address);
    const site = meet(locked, g.guard, d.gate);
    expect((await site.features["standard:connect"].connect()).accounts).toEqual([real]);
    expect(calls).toEqual(["connect"]);
    expect(site.accounts).toEqual([real]);
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
    const locked: any = { name: "L", chains: ["solana:mainnet"], calls, accounts: [real] };
    locked.features = features({ calls, listeners: [], set: () => undefined });
    Object.freeze(locked);
    const g = guardOf(), d = gateOf(PRACTICE_DECOY.address, "caught");
    const site = wrapStandardWallet(locked, g.guard, d.gate);
    const { accounts } = await site.features["standard:connect"].connect();
    expect(accounts[0].address).toBe(PRACTICE_DECOY.address);
    expect(site.accounts.map((a: any) => a.address)).toEqual([PRACTICE_DECOY.address]);
    expect(locked.accounts).toEqual([real]); // the wallet's own object is as it was
    expect(calls).toEqual([]);
  });
});
