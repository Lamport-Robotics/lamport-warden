/**
 * Simulation: what a transaction would do, read from the accounts before and after a simulated run. It adds to
 * what the decoder says and can only make a verdict stricter.
 */
import "../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { judge, type Store } from "../src/judge.js";
import { Simulator, readChanges, wordsFor, writableAccounts, type Reading, type RpcAccount, type Simulated } from "../src/simulate.js";
import type { FetchLike } from "../src/rpc.js";
import { splitTransaction } from "../pincer1/daemon/src/tx/parse.js";
import type { MemoryState } from "../pincer1/daemon/src/warden/index.js";

const owner = Keypair.fromSeed(new Uint8Array(32).fill(7));
const OWNER = owner.publicKey.toBase58();
const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const BLOCKHASH = "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = key(90).toBase58(); // a mint nobody has a name for
const DEX = key(80);             // a program the decoder does not read

const wallet = (lamports: number, program = SYSTEM): RpcAccount => ({ lamports, owner: program, data: ["", "base64"] });
const tokens = (mint: string, holder: string, amount: bigint, decimals: number, extra: Record<string, unknown> = {}): RpcAccount => ({
  lamports: 2_039_280, owner: TOKEN,
  data: { program: "spl-token", space: 165, parsed: { type: "account", info: { isNative: false, mint, owner: holder, state: "initialized", tokenAmount: { amount: amount.toString(), decimals }, ...extra } } },
});
const swapTx = () => new Transaction({ feePayer: owner.publicKey, recentBlockhash: BLOCKHASH })
  .add(new TransactionInstruction({ programId: DEX, keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }, { pubkey: key(81), isSigner: false, isWritable: true }, { pubkey: key(82), isSigner: false, isWritable: true }], data: Buffer.from([9, 9, 9]) }))
  .serialize({ requireAllSignatures: false, verifySignatures: false });
const store = (): Store => { const saved = new Map<string, MemoryState>(); return { load: async (o) => saved.get(o), save: async (o, s) => { saved.set(o, s); }, ringSites: async () => [] }; };
const reading = (r: Partial<Reading>): Simulated => ({ ok: true, reading: { lamports: -5000n, tokens: [], handedOver: [], delegated: [], reassignedTo: null, ...r } });

describe("reading the accounts before and after", () => {
  const usdcAcct = key(81).toBase58(), bonkAcct = key(82).toBase58(), someoneElses = key(83).toBase58();
  const addresses = [OWNER, usdcAcct, bonkAcct, someoneElses];

  it("finds what left and what arrived: a swap that opens a new token account", () => {
    const r = readChanges(OWNER, addresses,
      [wallet(3_000_000_000), tokens(USDC, OWNER, 80_000_000n, 6), null, tokens(USDC, "pool", 5_000_000_000n, 6)],
      [wallet(2_997_955_720), tokens(USDC, OWNER, 30_000_000n, 6), tokens(BONK, OWNER, 3_400_000_000n, 5), tokens(USDC, "pool", 5_050_000_000n, 6)]);
    expect(r.lamports).toBe(-2_044_280n); // the fee and the rent of the new account
    expect(r.tokens).toEqual([{ mint: USDC, decimals: 6, delta: -50_000_000n }, { mint: BONK, decimals: 5, delta: 3_400_000_000n }]);
    expect(r.handedOver).toEqual([]);
    expect(r.delegated).toEqual([]);
    expect(r.reassignedTo).toBeNull();
  });

  it("sees a token account handed to someone else: the tokens are gone though no transfer moved them", () => {
    const r = readChanges(OWNER, addresses, [wallet(1e9), tokens(USDC, OWNER, 80_000_000n, 6), null, null], [wallet(1e9 - 5000), tokens(USDC, "thief", 80_000_000n, 6), null, null]);
    expect(r.handedOver).toEqual([{ account: usdcAcct, to: "thief", mint: USDC }]);
    expect(r.tokens).toEqual([{ mint: USDC, decimals: 6, delta: -80_000_000n }]);
  });

  it("sees a delegate given the right to spend, and tells a new one from one that was already there", () => {
    const given = readChanges(OWNER, addresses, [wallet(1e9), tokens(USDC, OWNER, 80_000_000n, 6), null, null], [wallet(1e9 - 5000), tokens(USDC, OWNER, 80_000_000n, 6, { delegate: "spender", delegatedAmount: { amount: "18446744073709551615", decimals: 6 } }), null, null]);
    expect(given.delegated).toEqual([{ account: usdcAcct, to: "spender", mint: USDC, amount: 18446744073709551615n, decimals: 6, all: true }]);
    expect(given.tokens).toEqual([]); // nothing moved yet: that is the trap
    const old = { delegate: "spender", delegatedAmount: { amount: "1000000", decimals: 6 } };
    const before = readChanges(OWNER, addresses, [wallet(1e9), tokens(USDC, OWNER, 80_000_000n, 6, old), null, null], [wallet(1e9 - 5000), tokens(USDC, OWNER, 80_000_000n, 6, old), null, null]);
    expect(before.delegated).toEqual([]);
  });

  it("sees the wallet's own account reassigned to a program", () => {
    const r = readChanges(OWNER, addresses, [wallet(1e9), null, null, null], [wallet(1e9 - 5000, DEX.toBase58()), null, null, null]);
    expect(r.reassignedTo).toBe(DEX.toBase58());
  });

  it("ignores accounts that are not the wallet's, and data it cannot read", () => {
    const junk: RpcAccount = { lamports: 1, owner: TOKEN, data: ["AAAA", "base64"] };
    const r = readChanges(OWNER, addresses, [wallet(1e9), junk, null, tokens(USDC, "pool", 1n, 6)], [wallet(1e9), junk, null, tokens(USDC, "pool", 999n, 6)]);
    expect(r).toEqual({ lamports: 0n, tokens: [], handedOver: [], delegated: [], reassignedTo: null });
  });

  it("reads what the public Solana RPC really returns (captured from mainnet, a 0.001 SOL transfer)", () => {
    const payer = "payer", to = "to";
    const pre = [{ data: ["", "base64"], executable: false, lamports: 1083599358, owner: SYSTEM, rentEpoch: 18446744073709552000, space: 0 }, null];
    const post = [{ data: ["", "base64"], executable: false, lamports: 1082594358, owner: SYSTEM, rentEpoch: 18446744073709552000, space: 0 }, { data: ["", "base64"], executable: false, lamports: 1000000, owner: SYSTEM, rentEpoch: 18446744073709552000, space: 0 }];
    expect(readChanges(payer, [payer, to], pre, post).lamports).toBe(-1_005_000n);
    const parsedToken = { lamports: 2039280, data: { program: "spl-token", parsed: { info: { isNative: false, mint: USDC, owner: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", state: "initialized", tokenAmount: { amount: "6131218", decimals: 6, uiAmount: 6.131218, uiAmountString: "6.131218" } }, type: "account" }, space: 165 }, owner: TOKEN, executable: false, rentEpoch: 18446744073709552000, space: 165 };
    expect(readChanges("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", ["acct"], [null], [parsedToken]).tokens).toEqual([{ mint: USDC, decimals: 6, delta: 6131218n }]);
  });
});

describe("which accounts a message may write", () => {
  it("legacy: by the header", () => {
    const m = splitTransaction(swapTx()).messageBytes;
    expect(writableAccounts(m, {})[0]).toBe(OWNER); // the fee payer leads
    expect(writableAccounts(m, {}).sort()).toEqual([OWNER, key(81).toBase58(), key(82).toBase58()].sort()); // the program itself is read-only
  });
  it("version 0: with the writable entries of its tables", () => {
    const TABLE = key(60), a = key(61), b = key(62);
    const table = new AddressLookupTableAccount({ key: TABLE, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [a, b] } });
    const ix = new TransactionInstruction({ programId: DEX, keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }, { pubkey: a, isSigner: false, isWritable: true }, { pubkey: b, isSigner: false, isWritable: false }], data: Buffer.from([1]) });
    const m = new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: BLOCKHASH, instructions: [ix] }).compileToV0Message([table]).serialize();
    expect(writableAccounts(m, { [TABLE.toBase58()]: [a.toBase58(), b.toBase58()] })).toEqual([OWNER, a.toBase58()]);
    expect(writableAccounts(m, {})).toEqual([OWNER]); // an unread table adds nothing, and the verdict says it is unread
  });
});

describe("what the owner is told", () => {
  const known = { feeLamports: 5000n, decodedLamportsOut: 0n };
  it("says what left and what arrived, in the wallet's own terms", () => {
    const w = wordsFor(reading({ lamports: -1_204_000_000n, tokens: [{ mint: USDC, decimals: 6, delta: 250_000_000n }] }), known);
    expect(w.sentence).toBe("In a simulation just now, your wallet lost 1.204 SOL (fee included) and gained 250 USDC.");
    expect(w.atLeast).toBe("allow");
    expect(wordsFor(reading({}), known).sentence).toBe("In a simulation just now, nothing left your wallet but the fee.");
    expect(wordsFor(reading({ lamports: 499_995_000n }), known).sentence).toBe("In a simulation just now, your wallet gained 0.5 SOL and lost only the fee.");
  });
  it("asks for attention when tokens leave and nothing comes back", () => {
    const w = wordsFor(reading({ tokens: [{ mint: USDC, decimals: 6, delta: -80_000_000n }] }), known);
    expect(w.sentence).toBe("In a simulation just now, your wallet lost 80 USDC and gained nothing.");
    expect(w.atLeast).toBe("explain");
  });
  it("names the traps no instruction list shows", () => {
    const handed = wordsFor(reading({ handedOver: [{ account: "a", to: key(5).toBase58(), mint: USDC }] }), known);
    expect(handed.atLeast).toBe("confirm");
    expect(handed.reasons[0]).toMatch(/your account for USDC ended up belonging to .*, not to you\.$/);
    const delegated = wordsFor(reading({ delegated: [{ account: "a", to: key(5).toBase58(), mint: BONK, amount: 1n, decimals: 5, all: true }] }), known);
    expect(delegated.atLeast).toBe("confirm");
    expect(delegated.reasons[0]).toMatch(/was given the right to spend all of your token .{4}….{4}, now or later\.$/);
    const taken = wordsFor(reading({ reassignedTo: DEX.toBase58() }), known);
    expect(taken.atLeast).toBe("block");
    expect(taken.reasons[0]).toMatch(/your wallet's own account ended up owned by the program/);
  });
  it("points at SOL that leaves without an instruction it can read", () => {
    const w = wordsFor(reading({ lamports: -2_000_005_000n }), { feeLamports: 5000n, decodedLamportsOut: 500_000_000n });
    expect(w.reasons[0]).toBe("the simulation shows 1.5 SOL leaving your wallet that no instruction I can read accounts for.");
    expect(w.atLeast).toBe("explain");
    // the rent of a new token account is not a drain
    expect(wordsFor(reading({ lamports: -2_044_280n }), known).reasons).toEqual([]);
  });
  it("says so when it failed, and when it could not be run", () => {
    expect(wordsFor({ ok: false, why: "failed" }, known)).toMatchObject({ sentence: expect.stringMatching(/it failed, so as it stands it would do nothing but cost the fee/), atLeast: "allow" });
    expect(wordsFor({ ok: false, why: "unavailable" }, known)).toMatchObject({ sentence: expect.stringMatching(/^I could not simulate it/), atLeast: "explain" });
  });
});

describe("simulation in the verdict", () => {
  const pay = (to: PublicKey, sol: number) => new Transaction({ feePayer: owner.publicKey, recentBlockhash: BLOCKHASH }).add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: to, lamports: Math.round(sol * 1e9) })).serialize({ requireAllSignatures: false, verifySignatures: false });

  it("adds what the simulation showed to a transaction that calls a program the decoder does not read", async () => {
    let asked = 0;
    const v = await judge({ kind: "tx", bytes: swapTx(), owner: OWNER }, "https://dex.example", store(), { simulate: async () => { asked++; return reading({ lamports: -1_000_005_000n, tokens: [{ mint: USDC, decimals: 6, delta: 150_000_000n }] }); } });
    expect(asked).toBe(1);
    expect(v.verdict.sentence).toMatch(/In a simulation just now, your wallet lost 1 SOL \(fee included\) and gained 150 USDC\.$/);
    expect(v.verdict.level).not.toBe("allow");
  });

  it("raises the verdict for a handover seen only in the simulation, and asks for an acknowledgement", async () => {
    const v = await judge({ kind: "tx", bytes: swapTx(), owner: OWNER }, "https://dex.example", store(), { simulate: async () => reading({ handedOver: [{ account: "a", to: key(5).toBase58(), mint: USDC }] }) });
    expect(v.verdict.level).toBe("confirm");
    expect(v.verdict.confirm).toBeDefined();
    expect(v.verdict.reasons[0]).toMatch(/ended up belonging to/);
  });

  it("blocks when the simulation shows the wallet's account reassigned", async () => {
    const v = await judge({ kind: "tx", bytes: swapTx(), owner: OWNER }, "https://dex.example", store(), { simulate: async () => reading({ reassignedTo: DEX.toBase58() }) });
    expect(v.verdict.level).toBe("block");
  });

  it("does not simulate what the decoder reads in full, nor what is already blocked", async () => {
    let asked = 0;
    const simulate = async () => { asked++; return reading({}); };
    const v = await judge({ kind: "tx", bytes: pay(key(30), 0.5), owner: OWNER }, "https://shop.example", store(), { simulate });
    expect(v.verdict.sentence).not.toMatch(/simulation/);
    await judge({ kind: "tx", bytes: Uint8Array.of(1, 2, 3), owner: OWNER }, "https://shop.example", store(), { simulate });
    expect(asked).toBe(0);
  });

  it("says nothing about simulation when the owner has it off, and says so when it could not be run", async () => {
    const absent = await judge({ kind: "tx", bytes: swapTx(), owner: OWNER }, "https://dex.example", store(), {});
    expect(absent.verdict.sentence).not.toMatch(/simulat/);
    const off = await judge({ kind: "tx", bytes: swapTx(), owner: OWNER }, "https://dex.example", store(), { simulate: async () => null });
    expect(off.verdict).toEqual(absent.verdict); // turned off is the same as not there
    const down = await judge({ kind: "tx", bytes: swapTx(), owner: OWNER }, "https://dex.example", store(), { simulate: async () => { throw new Error("offline"); } });
    expect(down.verdict.sentence).toMatch(/I could not simulate it/);
  });
});

describe("asking the RPC", () => {
  const RPC = "https://rpc.example";
  function rpc(answer: (method: string, params: any[]) => unknown) {
    const calls: { method: string; params: any[] }[] = [];
    const fetchImpl: FetchLike = async (_url, init) => { const b = JSON.parse(init.body); calls.push({ method: b.method, params: b.params }); return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: answer(b.method, b.params) }) }; };
    return { fetchImpl, calls };
  }
  const tx = swapTx(), message = splitTransaction(tx).messageBytes;

  it("asks for the accounts before and after in one go, with nothing signed and the blockhash replaced", async () => {
    const { fetchImpl, calls } = rpc((method, params) => {
      const addresses: string[] = method === "getMultipleAccounts" ? params[0] : params[1].accounts.addresses;
      const before = addresses.map((a) => (a === OWNER ? wallet(2e9) : null));
      return method === "getMultipleAccounts" ? { value: before } : { value: { err: null, accounts: addresses.map((a) => (a === OWNER ? wallet(1.5e9) : null)) } };
    });
    const out = await new Simulator(fetchImpl).run(tx, message, OWNER, {}, RPC);
    expect(out).toEqual({ ok: true, reading: { lamports: -500_000_000n, tokens: [], handedOver: [], delegated: [], reassignedTo: null } });
    expect(calls.map((c) => c.method).sort()).toEqual(["getMultipleAccounts", "simulateTransaction"]);
    const sim = calls.find((c) => c.method === "simulateTransaction")!;
    expect(Buffer.from(sim.params[0], "base64")).toEqual(Buffer.from(tx));
    expect(sim.params[1]).toMatchObject({ encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "jsonParsed" } });
    expect(sim.params[1].accounts.addresses[0]).toBe(OWNER);
    expect(sim.params[1].accounts.addresses).toEqual(calls.find((c) => c.method === "getMultipleAccounts")!.params[0]);
  });

  it("reports a transaction that fails, and an RPC that gives no usable answer", async () => {
    const failing = rpc((method) => (method === "getMultipleAccounts" ? { value: [null, null, null] } : { value: { err: { InstructionError: [0, "Custom"] }, accounts: null } }));
    expect(await new Simulator(failing.fetchImpl).run(tx, message, OWNER, {}, RPC)).toEqual({ ok: false, why: "failed" });
    const short = rpc((method) => (method === "getMultipleAccounts" ? { value: [null, null, null] } : { value: { err: null, accounts: [null] } }));
    expect(await new Simulator(short.fetchImpl).run(tx, message, OWNER, {}, RPC)).toEqual({ ok: false, why: "unavailable" });
    const broken: FetchLike = async () => { throw new Error("offline"); };
    expect(await new Simulator(broken).run(tx, message, OWNER, {}, RPC)).toEqual({ ok: false, why: "unavailable" });
  });

  it("makes no call without an RPC", async () => {
    const { fetchImpl, calls } = rpc(() => null);
    expect(await new Simulator(fetchImpl).run(tx, message, OWNER, {}, "")).toEqual({ ok: false, why: "unavailable" });
    expect(calls).toEqual([]);
  });
});
