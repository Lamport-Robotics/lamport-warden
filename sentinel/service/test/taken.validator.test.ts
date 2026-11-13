/**
 * Tokens taken through an old permission, for real: a local validator, the Token program itself, a wallet
 * that approves a delegate, and the delegate taking. Nothing is stood in for: the watcher reads the
 * validator through the same RPC client the service uses.
 *
 * It is here because the other tests (taken.test.ts) run against a chain written for them, which reports a
 * delegate's transfer the way its author believes Solana does. This one asks Solana.
 *
 * Skipped unless `solana-test-validator` is on PATH:
 *
 *   pnpm vitest run sentinel/service/test/taken.validator.test.ts
 */
import "../../../src/polyfill.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { HttpRpc } from "../src/rpc.js";
import { MemoryStore, type StoredEvent } from "../src/store.js";
import { Watcher } from "../src/watcher.js";

const onPath = (() => { try { execFileSync("solana-test-validator", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
if (process.env.REQUIRE_VALIDATOR && !onPath) throw new Error("a taking cannot be tested here: solana-test-validator is not on PATH");

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const seeded = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const authority = seeded(41), owner = seeded(42), thief = seeded(43), friend = seeded(44);
const W = owner.publicKey.toBase58();
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

describe.skipIf(!onPath)("a delegate taking tokens on a local validator", () => {
  let validator: ChildProcess;
  let rpc: HttpRpc;
  let mint: PublicKey;
  const accounts: Record<"mine" | "theirs" | "friends", PublicKey> = {} as never;
  let store: MemoryStore, watcher: Watcher;
  const told: string[] = [];

  const send = async (signers: Keypair[], ...ixs: TransactionInstruction[]): Promise<string> => {
    const { value } = await rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const tx = new Transaction({ feePayer: signers[0]!.publicKey, recentBlockhash: value.blockhash }).add(...ixs);
    tx.sign(...signers);
    const sig: string = await rpc.call("sendTransaction", [tx.serialize().toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]);
    for (let i = 0; i < 100; i++) {
      const s = (await rpc.call("getSignatureStatuses", [[sig]]))?.value?.[0];
      if (s?.err) throw new Error(`refused: ${JSON.stringify(s.err)}`);
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return sig;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("not confirmed");
  };
  const rent = (space: number): Promise<number> => rpc.call("getMinimumBalanceForRentExemption", [space]);
  const tokenAccount = async (holder: PublicKey): Promise<PublicKey> => {
    const account = Keypair.generate();
    await send([authority, account],
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: account.publicKey, lamports: await rent(165), space: 165, programId: TOKEN }),
      new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: account.publicKey, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }], data: Buffer.concat([Buffer.from([18]), holder.toBuffer()]) })); // InitializeAccount3
    return account.publicKey;
  };
  /** Transfer: `signer` moves `amount` from one token account to another, as its owner or as its delegate. */
  const transfer = (signer: Keypair, from: PublicKey, to: PublicKey, amount: bigint) =>
    send([signer], new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: from, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: signer.publicKey, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([3]), u64(amount)]) }));
  /** The wallet's turns until something is raised, or a few have passed: a validator can take a moment to show a transaction it has confirmed. */
  const turns = async (most = 15): Promise<StoredEvent[]> => {
    for (let i = 0; i < most; i++) {
      const { raised, blind } = await watcher.passAll();
      expect(blind).toEqual([]);
      if (raised.length > 0) return raised;
      await new Promise((r) => setTimeout(r, 400));
    }
    return [];
  };
  const onChain = async (account: PublicKey) => (await rpc.call("getAccountInfo", [account.toBase58(), { encoding: "jsonParsed", commitment: "confirmed" }]))?.value?.data?.parsed?.info;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-taken-validator-"));
    const isFree = (p: number) => new Promise<boolean>((resolve) => { const s = createServer(); s.once("error", () => resolve(false)); s.listen(p, "127.0.0.1", () => s.close(() => resolve(true))); });
    let port = 0;
    for (let tries = 0; ; tries++) {
      const base = 20_000 + Math.floor(Math.random() * 300) * 100;
      if ((await Promise.all(Array.from({ length: 70 }, (_, i) => isFree(base + i)))).every(Boolean)) { port = base; break; }
      if (tries > 20) throw new Error("no free stretch of ports for a validator");
    }
    let exited: number | null = null;
    validator = spawn("solana-test-validator", ["--reset", "--quiet", "--ledger", join(dir, "ledger"), "--bind-address", "127.0.0.1", "--rpc-port", String(port), "--faucet-port", String(port + 3), "--gossip-port", String(port + 5), "--dynamic-port-range", `${port + 10}-${port + 69}`], { stdio: "ignore" });
    validator.once("exit", (code) => { exited = code ?? -1; });
    const why = () => { try { return readFileSync(join(dir, "ledger", "validator.log"), "utf8").split("\n").filter((l) => /panicked|Address already in use|ERROR/.test(l)).slice(-3).join(" | ").slice(0, 400); } catch { return "no log"; } };
    rpc = new HttpRpc(`http://127.0.0.1:${port}`, undefined, { timeoutMs: 5000, retries: 0 });
    for (let i = 0; ; i++) {
      if (exited !== null) throw new Error(`the validator stopped while starting (${exited}): ${why()}`);
      try { if ((await rpc.call("getHealth", [])) === "ok") break; } catch { /* still starting */ }
      if (i > 150) throw new Error(`the validator did not start: ${why()}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    for (const k of [authority, owner, thief, friend]) await rpc.call("requestAirdrop", [k.publicKey.toBase58(), 5_000_000_000]);
    for (let i = 0; i < 100 && ((await rpc.call("getBalance", [friend.publicKey.toBase58(), { commitment: "confirmed" }]))?.value ?? 0) === 0; i++) await new Promise((r) => setTimeout(r, 200));

    // a token with six decimals, a hundred of it in the owner's account, and empty accounts for the other two
    const m = Keypair.generate();
    mint = m.publicKey;
    await send([authority, m],
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint, lamports: await rent(82), space: 82, programId: TOKEN }),
      new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: mint, isSigner: false, isWritable: true }], data: Buffer.concat([Buffer.from([20, 6]), authority.publicKey.toBuffer(), Buffer.from([0])]) })); // InitializeMint2
    accounts.mine = await tokenAccount(owner.publicKey);
    accounts.theirs = await tokenAccount(thief.publicKey);
    accounts.friends = await tokenAccount(friend.publicKey);
    await send([authority], new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: mint, isSigner: false, isWritable: true }, { pubkey: accounts.mine, isSigner: false, isWritable: true }, { pubkey: authority.publicKey, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([7]), u64(100_000_000n)]) })); // MintTo
    // the approval: the owner signs it, some day, for sixty
    await send([owner], new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: accounts.mine, isSigner: false, isWritable: true }, { pubkey: thief.publicKey, isSigner: false, isWritable: false }, { pubkey: owner.publicKey, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([4]), u64(60_000_000n)]) })); // Approve

    store = new MemoryStore([{ address: W }]);
    watcher = new Watcher(rpc, store, { notify: async (_w, _level, sentence) => { told.push(sentence); } });
    // the wallet is taken on after the approval: its history is its baseline, and the permission is on record
    await watcher.passAll(); await watcher.passAll();
  }, 120_000);

  afterAll(() => { validator?.kill("SIGKILL"); });

  it("has the permission and the amount on record before anything is taken", () => {
    expect(store.record(W).tokenAccounts[accounts.mine.toBase58()]).toMatchObject({ owner: W, delegate: thief.publicKey.toBase58(), amount: "100000000", decimals: 6 });
    expect(store.record(W).tokenAccounts[accounts.mine.toBase58()]!.slot).toBeGreaterThan(0);
    expect(store.events(W)).toEqual([]);
  });

  it("tells the owner when the delegate takes some, in a transaction that does not name the wallet", async () => {
    const signature = await transfer(thief, accounts.mine, accounts.theirs, 25_000_000n);
    // the wallet's own list of transactions does not have it: this is what made it invisible
    const own: { signature: string }[] = await rpc.call("getSignaturesForAddress", [W, { limit: 20, commitment: "confirmed" }]);
    expect(own.map((s) => s.signature)).not.toContain(signature);
    const raised = await turns();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ wallet: W, signature, level: "urgent", signals: ["taken_by_permission"], rescueWorthy: true });
    expect(raised[0]!.sentence).toBe(`25 token ${short(mint.toBase58())} left your wallet in a transaction your wallet did not sign. ${short(thief.publicKey.toBase58())} did it, using a permission to spend that your wallet gave it at some earlier time. Whatever that permission still covers can go the same way until your wallet revokes it.`);
    expect(told).toEqual([raised[0]!.sentence]);
    expect(store.record(W).tokenAccounts[accounts.mine.toBase58()]!.amount).toBe("75000000");
    expect(await turns(3)).toEqual([]); // said once
  }, 60_000);

  it("tells again when it takes the rest of what the permission covered, and the chain has by then forgotten the delegate", async () => {
    const signature = await transfer(thief, accounts.mine, accounts.theirs, 35_000_000n);
    // the Token program clears a delegate that has used all it was allowed: the account no longer says who it was
    expect((await onChain(accounts.mine)).delegate).toBeUndefined();
    const raised = await turns();
    expect(raised.map((e) => [e.signature, e.signals])).toEqual([[signature, ["taken_by_permission"]]]);
    // the record, from before the taking, still does
    expect(raised[0]!.sentence).toContain(`35 token ${short(mint.toBase58())} left your wallet`);
    expect(raised[0]!.sentence).toContain(`${short(thief.publicKey.toBase58())} did it, using a permission to spend`);
    expect(store.record(W).tokenAccounts[accounts.mine.toBase58()]!.amount).toBe("40000000");
    expect(await turns(3)).toEqual([]);
  }, 60_000);

  it("says nothing of that kind about the owner's own payment", async () => {
    await transfer(owner, accounts.mine, accounts.friends, 10_000_000n);
    const raised = await turns(6);
    expect(raised.flatMap((e) => e.signals).filter((k) => k === "taken_by_permission" || k === "unexplained_loss")).toEqual([]);
    expect(store.record(W).tokenAccounts[accounts.mine.toBase58()]!.amount).toBe("30000000");
    expect(store.record(W).unsettled).toBeUndefined();
    expect(store.events(W).map((e) => e.signals.join("+")).filter((k) => k.includes("taken"))).toEqual(["taken_by_permission", "taken_by_permission"]);
  }, 60_000);
});
