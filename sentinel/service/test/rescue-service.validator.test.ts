/**
 * Rescue as the service offers it, for real: a local validator running the compiled rescue program, a vault
 * account laid out as the vault program lays one out, and the service's own code showing how a wallet
 * stands, building the setup for the owner to sign, and carrying a rescue out.
 *
 * (That a vault made by the real vault program is accepted, and that what is rescued can be taken out of it
 * again, is rescue.realvault.test.ts, which needs the vault's repository.)
 *
 * Skipped unless `solana-test-validator` is on PATH and the program is built.
 */
import "../../../src/polyfill.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Accounts } from "../src/accounts.js";
import { PROGRAM, TOKEN, TOKEN_2022, delegateAddress, initRescuerSet, vaultTokenAddress } from "../src/program.js";
import { LAMPORT_VAULT_PROGRAM, RESCUE_AGAIN_SECONDS, Rescue, checkVault, rescuedSentence } from "../src/rescue.js";
import { Rescuer } from "../src/rescuer.js";
import { HttpRpc } from "../src/rpc.js";
import { MemoryStore } from "../src/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const SO = join(here, "..", "..", "program", "target", "deploy", "lamport_sentinel.so");
const onPath = (() => { try { execFileSync("solana-test-validator", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
if (process.env.REQUIRE_VALIDATOR && (!onPath || !existsSync(SO))) throw new Error(`rescue cannot be tested here: ${onPath ? `the program is not built (${SO})` : "solana-test-validator is not on PATH"}`);

const VAULT_PROGRAM = new PublicKey(LAMPORT_VAULT_PROGRAM);
const seeded = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const authority = seeded(81), owner = seeded(82), lamportRescuer = seeded(83), stranger = seeded(84);
const W = owner.publicKey.toBase58();
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
/** A vault as the Lamport Vault program lays one out; `closed` is what a closed one leaves at its address. */
function vault(idByte: number, closed = false) {
  const id = new Uint8Array(32).fill(idByte);
  const [address, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"), id], VAULT_PROGRAM);
  const data = Buffer.concat([Buffer.from(closed ? [45, 187, 252, 155, 232, 114, 36, 22] : [211, 8, 232, 43, 2, 152, 117, 119]), Buffer.from([2, bump]), Buffer.from(id), Buffer.alloc(80, 7)]);
  return { address, data };
}
const vaultA = vault(1), vaultB = vault(2), closedVault = vault(3, true);

describe("what counts as a vault", () => {
  it("is the four things the rescue program checks, said in words an owner can act on", () => {
    const a = { owner: LAMPORT_VAULT_PROGRAM, data: Uint8Array.from(vaultA.data) };
    expect(checkVault(vaultA.address.toBase58(), a)).toEqual({ ok: true });
    expect(checkVault(vaultA.address.toBase58(), null)).toMatchObject({ ok: false, why: expect.stringContaining("there is no account at that address") });
    expect(checkVault(vaultA.address.toBase58(), { ...a, owner: TOKEN.toBase58() })).toEqual({ ok: false, why: "that address is not a Lamport Vault." });
    expect(checkVault(closedVault.address.toBase58(), { owner: LAMPORT_VAULT_PROGRAM, data: Uint8Array.from(closedVault.data) })).toEqual({ ok: false, why: "that vault was closed. A closed vault cannot be rescued into." });
    // the right shape at the wrong address: another account of the vault program's cannot stand in for one
    expect(checkVault(vaultB.address.toBase58(), a)).toEqual({ ok: false, why: "that address is not a Lamport Vault." });
    const wrongVersion = Uint8Array.from(vaultA.data); wrongVersion[8] = 3;
    expect(checkVault(vaultA.address.toBase58(), { owner: LAMPORT_VAULT_PROGRAM, data: wrongVersion })).toMatchObject({ ok: false, why: expect.stringContaining("of a kind this cannot rescue into yet") });
    expect(checkVault(vaultA.address.toBase58(), { owner: LAMPORT_VAULT_PROGRAM, data: new Uint8Array(10) })).toMatchObject({ ok: false });
  });
});

describe.skipIf(!onPath || !existsSync(SO))("rescue through the service, on a local validator", () => {
  let validator: ChildProcess;
  let rpc: HttpRpc;
  let store: MemoryStore, accounts: Accounts, rescue: Rescue, profile = "";
  let now = Math.floor(Date.now() / 1000);
  const told: string[] = [], noticed: string[] = [];
  const held: Record<string, { mint: PublicKey; account: PublicKey; program: PublicKey }> = {};

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
  const send = async (signers: Keypair[], ...ixs: TransactionInstruction[]): Promise<string> => {
    const { value } = await rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const tx = new Transaction({ feePayer: signers[0]!.publicKey, recentBlockhash: value.blockhash }).add(...ixs);
    tx.sign(...signers);
    return sendRaw(tx.serialize());
  };
  /** What the owner's wallet does with the transactions the service built: signs each, and sends it. */
  const signAll = async (transactions: string[]) => { for (const t of transactions) { const tx = Transaction.from(Buffer.from(t, "base64")); tx.sign(owner); await sendRaw(tx.serialize()); } };
  const rent = (space: number): Promise<number> => rpc.call("getMinimumBalanceForRentExemption", [space]);
  const tokenFor = async (name: string, amount: bigint, program = TOKEN) => {
    const mint = Keypair.generate(), account = Keypair.generate();
    await send([authority, mint, account],
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint.publicKey, lamports: await rent(82), space: 82, programId: program }),
      new TransactionInstruction({ programId: program, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }], data: Buffer.concat([Buffer.from([20, 6]), authority.publicKey.toBuffer(), Buffer.from([0])]) }),
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: account.publicKey, lamports: await rent(165), space: 165, programId: program }),
      new TransactionInstruction({ programId: program, keys: [{ pubkey: account.publicKey, isSigner: false, isWritable: true }, { pubkey: mint.publicKey, isSigner: false, isWritable: false }], data: Buffer.concat([Buffer.from([18]), owner.publicKey.toBuffer()]) }),
      ...(amount > 0n ? [new TransactionInstruction({ programId: program, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }, { pubkey: account.publicKey, isSigner: false, isWritable: true }, { pubkey: authority.publicKey, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([7]), u64(amount)]) })] : []),
    );
    held[name] = { mint: mint.publicKey, account: account.publicKey, program };
  };
  const balance = async (account: PublicKey): Promise<bigint | null> => {
    const res = await rpc.call("getTokenAccountBalance", [account.toBase58(), { commitment: "confirmed" }]).catch(() => null);
    return res?.value ? BigInt(res.value.amount) : null;
  };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-rescue-service-"));
    const file = (name: string, v: { address: PublicKey; data: Buffer }) => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify({ pubkey: v.address.toBase58(), account: { lamports: 10_000_000, data: [v.data.toString("base64"), "base64"], owner: LAMPORT_VAULT_PROGRAM, executable: false, rentEpoch: 0, space: v.data.length } }));
      return path;
    };
    const isFree = (p: number) => new Promise<boolean>((resolve) => { const s = createServer(); s.once("error", () => resolve(false)); s.listen(p, "127.0.0.1", () => s.close(() => resolve(true))); });
    let port = 0;
    for (let tries = 0; ; tries++) {
      const base = 20_000 + Math.floor(Math.random() * 300) * 100;
      if ((await Promise.all(Array.from({ length: 70 }, (_, i) => isFree(base + i)))).every(Boolean)) { port = base; break; }
      if (tries > 20) throw new Error("no free stretch of ports for a validator");
    }
    let exited: number | null = null;
    validator = spawn("solana-test-validator", [
      "--reset", "--quiet", "--ledger", join(dir, "ledger"), "--bind-address", "127.0.0.1", "--rpc-port", String(port), "--faucet-port", String(port + 3),
      "--gossip-port", String(port + 5), "--dynamic-port-range", `${port + 10}-${port + 69}`, "--mint", authority.publicKey.toBase58(),
      "--upgradeable-program", PROGRAM.toBase58(), SO, authority.publicKey.toBase58(),
      "--account", vaultA.address.toBase58(), file("vault-a.json", vaultA), "--account", vaultB.address.toBase58(), file("vault-b.json", vaultB), "--account", closedVault.address.toBase58(), file("vault-closed.json", closedVault),
    ], { stdio: "ignore" });
    validator.once("exit", (code) => { exited = code ?? -1; });
    const why = () => { try { return readFileSync(join(dir, "ledger", "validator.log"), "utf8").split("\n").filter((l) => /panicked|Address already in use|ERROR/.test(l)).slice(-3).join(" | ").slice(0, 400); } catch { return "no log"; } };
    rpc = new HttpRpc(`http://127.0.0.1:${port}`, undefined, { timeoutMs: 5000, retries: 0 });
    for (let i = 0; ; i++) {
      if (exited !== null) throw new Error(`the validator stopped while starting (${exited}): ${why()}`);
      try { if ((await rpc.call("getHealth", [])) === "ok") break; } catch { /* still starting */ }
      if (i > 150) throw new Error(`the validator did not start: ${why()}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    await send([authority], ...[owner, lamportRescuer, stranger].map((k) => SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: k.publicKey, lamports: 5_000_000_000 })));
    await send([authority], initRescuerSet(authority.publicKey, authority.publicKey, [lamportRescuer.publicKey]));
    await tokenFor("usdc", 250_000_000n);
    await tokenFor("t22", 7_000_000n, TOKEN_2022);
    await tokenFor("empty", 0n);

    store = new MemoryStore();
    accounts = new Accounts(store, Buffer.alloc(32, 9));
    const admitted = accounts.admit(W, null, now);
    if (!admitted.ok) throw new Error("setup");
    profile = admitted.profile;
    rescue = new Rescue(rpc, new Rescuer(rpc, lamportRescuer, { confirmSeconds: 30 }), accounts, store, { now: () => now, notify: async (_w, sentence) => { told.push(sentence); return { delivered: 1, failed: 0 }; }, notice: async (_p, sentence) => { noticed.push(sentence); } });
  }, 120_000);
  afterAll(() => { validator?.kill("SIGKILL"); });

  it("comes with Pro, and only for a wallet of the profile's own", async () => {
    expect(await rescue.arm(profile, W, vaultA.address.toBase58())).toEqual({ ok: false, status: 403, why: "rescue comes with Pro." });
    expect(await rescue.rescue(profile, W)).toEqual({ ok: false, status: 403, why: "rescue comes with Pro." });
    accounts.setTier(profile, "pro");
    expect(await rescue.arm(profile, stranger.publicKey.toBase58(), vaultA.address.toBase58())).toMatchObject({ ok: false, status: 404 });
    expect(await rescue.arm("nobody", W, vaultA.address.toBase58())).toMatchObject({ ok: false, status: 401 });
  }, 60_000);

  it("shows a wallet that is not set up as it is: nothing covered, and what would be left where it is", async () => {
    const s = await rescue.status(W);
    expect(s).toMatchObject({ armed: false, vault: null, rescuers: null, covered: [] });
    expect(s.uncovered.map((u) => [u.account, u.amount, u.why]).sort()).toEqual([[held.usdc!.account.toBase58(), "250000000", "not set up"], [held.t22!.account.toBase58(), "7000000", "not set up"]].sort());
    expect(store.wallets()[0]!.sentinelDelegate).toBeUndefined();
    expect(noticed).toEqual([]);
  }, 60_000);

  it("refuses to set a wallet up for anything that is not a live vault, before anybody signs", async () => {
    expect(await rescue.arm(profile, W, stranger.publicKey.toBase58())).toMatchObject({ ok: false, status: 400, why: "that address is not a Lamport Vault." });
    expect(await rescue.arm(profile, W, closedVault.address.toBase58())).toMatchObject({ ok: false, status: 400, why: "that vault was closed. A closed vault cannot be rescued into." });
    expect(await rescue.arm(profile, W, Keypair.generate().publicKey.toBase58())).toMatchObject({ ok: false, status: 400, why: expect.stringContaining("there is no account at that address") });
    expect(await rescue.arm(profile, W, W)).toMatchObject({ ok: false, status: 400 });
    expect(await rescue.arm(profile, W, "not an address")).toMatchObject({ ok: false, status: 400 });
  }, 60_000);

  it("builds the setup, the owner's wallet signs it, and the chain then says the wallet is armed", async () => {
    const built = await rescue.arm(profile, W, vaultA.address.toBase58());
    if (!built.ok) throw new Error(built.why);
    expect(built).toMatchObject({ accounts: 2, vault: vaultA.address.toBase58() });
    expect(built.transactions).toHaveLength(1);
    // one instruction names the vault; the others are approvals; nothing in it moves anything
    const tx = Transaction.from(Buffer.from(built.transactions[0]!, "base64"));
    expect(tx.instructions.map((ix) => ix.programId.toBase58()).sort()).toEqual([PROGRAM.toBase58(), TOKEN.toBase58(), TOKEN_2022.toBase58()].sort());
    await signAll(built.transactions);
    expect(await balance(held.usdc!.account)).toBe(250_000_000n);

    const s = await rescue.status(W);
    expect(s).toMatchObject({ armed: true, vault: vaultA.address.toBase58(), rescuers: "lamport", uncovered: [] });
    expect(s.covered.map((c) => c.account).sort()).toEqual([held.usdc!.account.toBase58(), held.t22!.account.toBase58()].sort());
    // the watcher now knows which address a rescue of this wallet is signed by, and the owner's channels heard of the setup
    expect(store.wallets()[0]!.sentinelDelegate).toBe(delegateAddress(owner.publicKey, vaultA.address).toBase58());
    expect(noticed).toHaveLength(1);
    expect(noticed[0]).toContain(`is set up for rescue into the Lamport Vault ${vaultA.address.toBase58().slice(0, 4)}..`);
    // asked again there is nothing left to sign, and another vault is refused while this setup stands
    expect(await rescue.arm(profile, W, vaultA.address.toBase58())).toMatchObject({ ok: true, transactions: [], accounts: 0 });
    expect(await rescue.arm(profile, W, vaultB.address.toBase58())).toMatchObject({ ok: false, status: 409 });
  }, 120_000);

  it("a rescue moves what is armed into the vault, puts it on record, and tells the owner", async () => {
    const r = await rescue.rescue(profile, W);
    if (!r.ok) throw new Error(r.why);
    expect(r).toMatchObject({ vault: vaultA.address.toBase58(), moved: 2, failed: 0 });
    expect(await balance(held.usdc!.account)).toBe(0n);
    expect(await balance(vaultTokenAddress(vaultA.address, held.usdc!.mint))).toBe(250_000_000n);
    expect(await balance(vaultTokenAddress(vaultA.address, held.t22!.mint, TOKEN_2022))).toBe(7_000_000n);
    const said = rescuedSentence(2, 0, vaultA.address.toBase58());
    expect(told).toEqual([said]);
    expect(said).toBe(`Sentinel moved 2 of this wallet's token accounts into your Lamport Vault (${vaultA.address.toBase58().slice(0, 4)}..${vaultA.address.toBase58().slice(-4)}). Only your vault's key can move what is there now. SOL is not moved by a rescue.`);
    expect(store.events(W).map((e) => [e.signals, e.level, e.signature === r.signatures[0]])).toEqual([[["rescued"], "urgent", true]]);
    // asked again at once: not twice in a minute; a minute on: nothing is left to move, and nothing is said
    expect(await rescue.rescue(profile, W)).toMatchObject({ ok: false, status: 429 });
    now += RESCUE_AGAIN_SECONDS;
    expect(await rescue.rescue(profile, W)).toMatchObject({ ok: true, moved: 0, failed: 0 });
    expect(told).toHaveLength(1);
  }, 180_000);

  it("a token that arrives later is not covered until the owner sets it up, and then it is", async () => {
    await tokenFor("late", 42n);
    expect((await rescue.status(W)).uncovered.map((u) => u.account)).toEqual([held.late!.account.toBase58()]);
    const built = await rescue.arm(profile, W, vaultA.address.toBase58());
    if (!built.ok) throw new Error(built.why);
    expect(built.accounts).toBe(1);
    await signAll(built.transactions);
    expect((await rescue.status(W)).covered.map((c) => c.account)).toEqual([held.late!.account.toBase58()]);
  }, 120_000);

  it("after an alert that is reason enough, rescues unasked only when the owner switched that on", async () => {
    const alert = { wallet: W, signature: "s", slot: 1, at: now, level: "urgent" as const, signals: ["taken_by_permission" as const], sentence: "x", rescueWorthy: true };
    now += RESCUE_AGAIN_SECONDS;
    expect(await rescue.after(alert)).toBe(false);
    expect(await balance(held.late!.account)).toBe(42n);
    expect(await rescue.after({ ...alert, rescueWorthy: false })).toBe(false);
    accounts.profile(profile)!.autoRescue = true;
    expect(await rescue.after({ ...alert, rescueWorthy: false })).toBe(false); // an alert that is not reason enough moves nothing
    expect(await rescue.after(alert)).toBe(true);
    expect(await balance(held.late!.account)).toBe(0n);
    expect(await balance(vaultTokenAddress(vaultA.address, held.late!.mint))).toBe(42n);
    expect(told.at(-1)).toBe(`After the alert before this one, ${rescuedSentence(1, 0, vaultA.address.toBase58())}`);
  }, 180_000);

  it("the setup is taken away by the owner signing it away: approvals revoked, the config closed, and the channels told", async () => {
    await tokenFor("kept", 5n);
    await signAll(((await rescue.arm(profile, W, vaultA.address.toBase58())) as { transactions: string[] }).transactions);
    const built = await rescue.disarm(profile, W);
    if (!built.ok) throw new Error(built.why);
    await signAll(built.transactions);
    const s = await rescue.status(W);
    expect(s).toMatchObject({ armed: false, covered: [] });
    expect((await rpc.call("getAccountInfo", [held.kept!.account.toBase58(), { encoding: "jsonParsed", commitment: "confirmed" }])).value.data.parsed.info.delegate).toBeUndefined();
    expect(store.wallets()[0]!.sentinelDelegate).toBeUndefined();
    expect(noticed.at(-1)).toContain("is no longer set up for rescue");
    now += RESCUE_AGAIN_SECONDS;
    expect(await rescue.rescue(profile, W)).toEqual({ ok: false, status: 409, why: "this wallet is not armed." });
    expect(await rescue.disarm(profile, W)).toMatchObject({ ok: false, status: 409 });
    // without a rescuer key the service still shows how a wallet stands, and says it cannot rescue
    const keyless = new Rescue(rpc, null, accounts, store);
    expect(keyless.on).toBe(false);
    expect(await keyless.rescue(profile, W)).toEqual({ ok: false, status: 501, why: "rescue is not switched on here." });
    expect((await keyless.status(W)).armed).toBe(false);
  }, 180_000);
});
