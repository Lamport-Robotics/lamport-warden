/**
 * Paying for the plan in a token and in SOL, for real: a local validator, the Token program itself, and the
 * service's own code making the quote, building the payment for the wallet to sign, and finding it on the
 * chain afterwards. Nothing is stood in for but the token's name: the "USDC" here is a token made for the
 * test, with USDC's six decimals.
 *
 * It is here because prepaid.test.ts runs against a list of transactions written for it, with balances as
 * its author believes the chain reports them. This asks the chain: is a transaction found by an address it
 * merely names, once it is final, and does it say what arrived where.
 *
 * Skipped unless `solana-test-validator` is on PATH:
 *
 *   pnpm vitest run sentinel/service/test/prepaid.validator.test.ts
 */
import "../../../src/polyfill.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Accounts } from "../src/accounts.js";
import { Prepaid, addMonths, paymentInstruction, tokenAccountOf, type CheckView } from "../src/prepaid.js";
import { HttpRpc } from "../src/rpc.js";
import { MemoryStore } from "../src/store.js";

const onPath = (() => { try { execFileSync("solana-test-validator", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
if (process.env.REQUIRE_VALIDATOR && !onPath) throw new Error("a payment cannot be tested here: solana-test-validator is not on PATH");

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const seeded = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const authority = seeded(71), lamport = seeded(72), customer = seeded(73), watched = seeded(74);
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

describe.skipIf(!onPath)("a payment for the plan on a local validator", () => {
  let validator: ChildProcess;
  let rpc: HttpRpc;
  let mint: PublicKey;
  let accounts: Accounts, prepaid: Prepaid, profile = "";
  const said: string[] = [];

  const send = async (signers: Keypair[], ...ixs: TransactionInstruction[]): Promise<string> => {
    const { value } = await rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const tx = new Transaction({ feePayer: signers[0]!.publicKey, recentBlockhash: value.blockhash }).add(...ixs);
    tx.sign(...signers);
    return sendRaw(tx.serialize());
  };
  const sendRaw = async (raw: Buffer | Uint8Array): Promise<string> => {
    const sig: string = await rpc.call("sendTransaction", [Buffer.from(raw).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]);
    for (let i = 0; i < 100; i++) {
      const s = (await rpc.call("getSignatureStatuses", [[sig]]))?.value?.[0];
      if (s?.err) throw new Error(`refused: ${JSON.stringify(s.err)}`);
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return sig;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("not confirmed");
  };
  const rent = (space: number): Promise<number> => rpc.call("getMinimumBalanceForRentExemption", [space]);
  /** The token account a wallet keeps this token in, made if it is not there. */
  const tokenAccount = async (owner: PublicKey): Promise<PublicKey> => {
    const address = tokenAccountOf(owner, mint);
    await send([authority], new TransactionInstruction({ programId: ASSOCIATED, data: Buffer.from([1]), keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true }, { pubkey: address, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN, isSigner: false, isWritable: false },
    ] }));
    return address;
  };
  const balance = async (account: PublicKey): Promise<bigint> => BigInt((await rpc.call("getTokenAccountBalance", [account.toBase58(), { commitment: "confirmed" }])).value.amount);
  /** Asks the service whether a quote was paid, until it says something other than "waiting" or a minute has gone: a payment counts when it is final. */
  const settled = async (reference: string): Promise<CheckView> => {
    for (let i = 0; i < 80; i++) {
      const r = await prepaid.check(profile, reference);
      if (!r.ok) throw new Error(r.why);
      if (r.result.status !== "waiting") return r.result;
      await new Promise((res) => setTimeout(res, 750));
    }
    return { status: "waiting" };
  };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-prepaid-validator-"));
    const isFree = (p: number) => new Promise<boolean>((resolve) => { const s = createServer(); s.once("error", () => resolve(false)); s.listen(p, "127.0.0.1", () => s.close(() => resolve(true))); });
    let port = 0;
    for (let tries = 0; ; tries++) {
      const base = 20_000 + Math.floor(Math.random() * 300) * 100;
      if ((await Promise.all(Array.from({ length: 70 }, (_, i) => isFree(base + i)))).every(Boolean)) { port = base; break; }
      if (tries > 20) throw new Error("no free stretch of ports for a validator");
    }
    let exited: number | null = null;
    validator = spawn("solana-test-validator", ["--reset", "--quiet", "--ledger", join(dir, "ledger"), "--bind-address", "127.0.0.1", "--rpc-port", String(port), "--faucet-port", String(port + 3), "--gossip-port", String(port + 5), "--dynamic-port-range", `${port + 10}-${port + 69}`, "--mint", authority.publicKey.toBase58()], { stdio: "ignore" });
    validator.once("exit", (code) => { exited = code ?? -1; });
    const why = () => { try { return readFileSync(join(dir, "ledger", "validator.log"), "utf8").split("\n").filter((l) => /panicked|Address already in use|ERROR/.test(l)).slice(-3).join(" | ").slice(0, 400); } catch { return "no log"; } };
    rpc = new HttpRpc(`http://127.0.0.1:${port}`, undefined, { timeoutMs: 5000, retries: 0 });
    for (let i = 0; ; i++) {
      if (exited !== null) throw new Error(`the validator stopped while starting (${exited}): ${why()}`);
      try { if ((await rpc.call("getHealth", [])) === "ok") break; } catch { /* still starting */ }
      if (i > 150) throw new Error(`the validator did not start: ${why()}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    await send([authority], ...[lamport, customer].map((k) => SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: k.publicKey, lamports: 5_000_000_000 })));
    // a token with six decimals, as USDC has; 100 of it with the customer; and Lamport's own account for it
    const m = Keypair.generate();
    mint = m.publicKey;
    await send([authority, m],
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint, lamports: await rent(82), space: 82, programId: TOKEN }),
      new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: mint, isSigner: false, isWritable: true }], data: Buffer.concat([Buffer.from([20, 6]), authority.publicKey.toBuffer(), Buffer.from([0])]) }));
    const customers = await tokenAccount(customer.publicKey);
    await tokenAccount(lamport.publicKey);
    await send([authority], new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: mint, isSigner: false, isWritable: true }, { pubkey: customers, isSigner: false, isWritable: true }, { pubkey: authority.publicKey, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([7]), u64(100_000_000n)]) }));

    accounts = new Accounts(new MemoryStore(), Buffer.alloc(32, 9));
    const admitted = accounts.admit(watched.publicKey.toBase58(), null, Math.floor(Date.now() / 1000));
    if (!admitted.ok) throw new Error("setup");
    profile = admitted.profile;
    prepaid = new Prepaid({ payTo: lamport.publicKey.toBase58(), usdcMint: mint.toBase58() }, accounts, rpc,
      { sells: () => true, holder: async () => false, byCard: () => false, centsFull: 1500, centsHolder: 1000 },
      { price: async () => 75, notice: async (_p, sentence) => { said.push(sentence); } });
  }, 120_000);

  afterAll(() => { validator?.kill("SIGKILL"); });

  it("in the token: the service builds the payment, the customer's wallet signs it, and it is found and counted once it is final", async () => {
    const quoted = await prepaid.quote(profile, "USDC", 1);
    if (!quoted.ok) throw new Error(quoted.why);
    const q = quoted.quote;
    expect(q.units).toBe("15000000");
    expect((await prepaid.check(profile, q.reference))).toEqual({ ok: true, result: { status: "waiting" } });

    // what the page would hand the wallet: paid from a wallet that is not one the profile watches
    const built = await prepaid.transaction(profile, q.reference, customer.publicKey.toBase58());
    if (!built.ok) throw new Error(built.why);
    const tx = Transaction.from(Buffer.from(built.transaction, "base64"));
    expect(tx.instructions).toHaveLength(1); // one transfer, and nothing else to sign
    tx.sign(customer);
    const signature = await sendRaw(tx.serialize());

    const result = await settled(q.reference);
    expect(result.status).toBe("paid");
    expect(await balance(tokenAccountOf(lamport.publicKey, mint))).toBe(15_000_000n);
    expect(await balance(tokenAccountOf(customer.publicKey, mint))).toBe(85_000_000n);
    const p = accounts.profile(profile)!;
    expect(p.tier).toBe("pro");
    expect(p.prepaid!.payments).toMatchObject([{ signature, asset: "USDC", units: "15000000", months: 1 }]);
    expect(Math.abs(p.prepaid!.until - addMonths(Math.floor(Date.now() / 1000), 1))).toBeLessThan(120);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("does not renew by itself");
    // asked again it is paid, and it is not paid twice
    expect(await settled(q.reference)).toEqual({ status: "paid", until: p.prepaid!.until });
    expect(accounts.profile(profile)!.prepaid!.payments).toHaveLength(1);
  }, 180_000);

  it("in SOL: the same, added to the time already paid for", async () => {
    const before = accounts.profile(profile)!.prepaid!.until;
    const lamportsBefore = (await rpc.call("getBalance", [lamport.publicKey.toBase58(), { commitment: "confirmed" }])).value as number;
    const quoted = await prepaid.quote(profile, "SOL", 3);
    if (!quoted.ok) throw new Error(quoted.why);
    expect(quoted.quote.units).toBe("600000000"); // 45 dollars at 75 a SOL
    const built = await prepaid.transaction(profile, quoted.quote.reference, customer.publicKey.toBase58());
    if (!built.ok) throw new Error(built.why);
    const tx = Transaction.from(Buffer.from(built.transaction, "base64"));
    tx.sign(customer);
    await sendRaw(tx.serialize());
    const result = await settled(quoted.quote.reference);
    expect(result).toEqual({ status: "paid", until: addMonths(before, 3) });
    expect(((await rpc.call("getBalance", [lamport.publicKey.toBase58(), { commitment: "confirmed" }])).value as number) - lamportsBefore).toBe(600_000_000);
    expect(said.at(-1)).toContain("A payment for this profile's Sentinel plan arrived.");
  }, 180_000);

  it("a payment that is short is said to be short, and a wallet that does not hold the amount is not asked to sign", async () => {
    const quoted = await prepaid.quote(profile, "USDC", 12);
    if (!quoted.ok) throw new Error(quoted.why);
    const q = quoted.quote;
    // 180 is asked and the wallet holds 85: refused before anything is built
    expect(await prepaid.transaction(profile, q.reference, customer.publicKey.toBase58())).toEqual({ ok: false, status: 409, why: "that wallet holds 85 USDC, and this needs 180." });
    // someone pays 1 of the 180 by hand, naming the quote
    await send([customer], paymentInstruction({ payer: customer.publicKey, payTo: lamport.publicKey, asset: "USDC", units: 1_000_000n, mint, reference: new PublicKey(q.reference) }));
    expect(await settled(q.reference)).toEqual({ status: "short", arrived: "1000000", wanted: "180000000" });
    expect(accounts.profile(profile)!.prepaid!.payments).toHaveLength(2);
  }, 180_000);
});
