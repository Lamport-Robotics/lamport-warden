/**
 * Rescue as the service offers it, for real: a local validator running the compiled rescue program, a vault
 * account laid out as the vault program lays one out, and the service's own code showing how a wallet
 * stands, building the setup for the owner to sign, and carrying a rescue out. The real watcher reads the
 * same wallet all the while, so that what it says of each step is tested too: nothing of the owner's own
 * setup, nothing of a rescue this service sent, and a rescue of its own accord when a thief takes something.
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
import { LAMPORT_VAULT_PROGRAM, NOT_ON_CHAIN, RESCUE_AGAIN_SECONDS, Rescue, checkVault, rescuedSentence } from "../src/rescue.js";
import { Rescuer } from "../src/rescuer.js";
import { HttpRpc } from "../src/rpc.js";
import { MemoryStore, type StoredEvent } from "../src/store.js";
import { Watcher } from "../src/watcher.js";

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
  let store: MemoryStore, accounts: Accounts, rescue: Rescue, rescuer: Rescuer, watcher: Watcher, profile = "";
  let now = Math.floor(Date.now() / 1000);
  const told: string[] = [], noticed: string[] = [], heard: string[] = [];
  /** Rescues the watcher's alerts set off, to be waited for. */
  const unasked: Promise<boolean>[] = [];
  let lastUnasked: boolean[] = [];
  /** The wallet's turns with the watcher: all that it raised in them, stopping early once `enough` says so. */
  const watch = async (enough: (all: StoredEvent[]) => boolean = () => false, most = 6): Promise<StoredEvent[]> => {
    const all: StoredEvent[] = [];
    lastUnasked = [];
    for (let i = 0; i < most; i++) {
      const { raised, blind } = await watcher.passAll();
      expect(blind).toEqual([]);
      all.push(...raised);
      lastUnasked.push(...(await Promise.all(unasked.splice(0))));
      if (enough(all)) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    return all;
  };
  const kinds = (events: StoredEvent[]) => events.flatMap((e) => e.signals);
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
      // Something that runs has to be at the vault program's address for rescue to count as there at all. Nothing
      // in a rescue calls it (the rescue program reads a vault's account, it does not ask the vault program), so
      // the same file serves; rescue.realvault.test.ts is where the vault program itself is run.
      "--bpf-program", LAMPORT_VAULT_PROGRAM, SO,
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
    rescuer = new Rescuer(rpc, lamportRescuer, { confirmSeconds: 30 });
    rescue = new Rescue(rpc, rescuer, accounts, store, { now: () => now, notify: async (_w, sentence) => { told.push(sentence); return { delivered: 1, failed: 0 }; }, notice: async (_p, sentence) => { noticed.push(sentence); } });
    // the watcher as the service runs it: told which rescues are the service's own, and handing each alert to rescue
    watcher = new Watcher(rpc, store, { notify: async (_w, _level, sentence) => { heard.push(sentence); } }, { ownRescues: rescuer.sent, onRaised: (event) => { unasked.push(rescue.after(event)); } });
    await watcher.passAll(); await watcher.passAll();
  }, 120_000);
  afterAll(() => { validator?.kill("SIGKILL"); });

  it("knows where it is: the programs are on this chain, which is no public network, and its key is one of Lamport's rescuers with something to pay with", async () => {
    expect(await rescue.available()).toBe(true);
    expect(await rescue.network()).toBe("solana:localnet");
    expect(await rescue.keyStanding()).toMatchObject({ amongRescuers: true, lamports: 5_000_000_000 });
    expect(await new Rescue(rpc, new Rescuer(rpc, stranger), accounts, store).keyStanding()).toMatchObject({ amongRescuers: false });
    expect(await new Rescue(rpc, null, accounts, store).keyStanding()).toBeNull();
  }, 60_000);

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

    // The watcher reads the setup before the service has looked at the chain again. It is the owner's own, asked
    // for on the page a moment ago: an unlimited permission given to anyone else is an alert, and this is not one.
    expect(store.wallets()[0]!.sentinelDelegate).toBeUndefined();
    const seen = await watch();
    expect(kinds(seen)).not.toContain("unlimited_approval");
    expect(seen.filter((e) => e.level !== "info")).toEqual([]);
    expect(store.record(W).tokenAccounts[held.usdc!.account.toBase58()]).toMatchObject({ delegate: built.delegate });

    // the round that keeps the record in step with the chain finds the setup, and the owner's channels hear of it once
    await rescue.sync([W]);
    expect(store.wallets()[0]!.sentinelDelegate).toBe(built.delegate);
    expect(noticed).toHaveLength(1);

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
    // The watcher sees the tokens gone, in transactions the wallet did not sign, and reads them. They are the
    // service's own rescue, which the owner was told of when it was sent: it is not called a taking, and not said twice.
    expect(await watch()).toEqual([]);
    expect(heard).toEqual([]);
    expect(store.record(W).tokenAccounts[held.usdc!.account.toBase58()]).toMatchObject({ amount: "0" });
    expect(store.record(W).unsettled).toBeUndefined();
  }, 180_000);

  it("a token that arrives later is not covered until the owner sets it up, and then it is", async () => {
    await tokenFor("late", 42n);
    expect((await rescue.status(W)).uncovered.map((u) => u.account)).toEqual([held.late!.account.toBase58()]);
    const built = await rescue.arm(profile, W, vaultA.address.toBase58());
    if (!built.ok) throw new Error(built.why);
    expect(built.accounts).toBe(1);
    await signAll(built.transactions);
    expect((await rescue.status(W)).covered.map((c) => c.account)).toEqual([held.late!.account.toBase58()]);
    expect((await watch()).filter((e) => e.level !== "info")).toEqual([]);
  }, 120_000);

  it("a thief takes tokens under a permission: the watcher says so, and Sentinel rescues what is set up without being asked, once the owner has switched that on", async () => {
    // A token the wallet did not set up, and a permission on it that the owner was talked into giving a stranger.
    await tokenFor("prey", 1_000_000_000n);
    const theirs = Keypair.generate();
    await send([authority, theirs],
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: theirs.publicKey, lamports: await rent(165), space: 165, programId: TOKEN }),
      new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: theirs.publicKey, isSigner: false, isWritable: true }, { pubkey: held.prey!.mint, isSigner: false, isWritable: false }], data: Buffer.concat([Buffer.from([18]), stranger.publicKey.toBuffer()]) }));
    await send([owner], new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: held.prey!.account, isSigner: false, isWritable: true }, { pubkey: stranger.publicKey, isSigner: false, isWritable: false }, { pubkey: owner.publicKey, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([4]), u64(0xffff_ffff_ffff_ffffn)]) }));
    // that one the watcher does speak of: only the rescue program's own address is excused
    const approved = await watch((all) => kinds(all).includes("unlimited_approval"));
    expect(kinds(approved)).toContain("unlimited_approval");
    expect(lastUnasked.every((r) => r === false)).toBe(true); // an alert, and not reason enough for a rescue
    const take = (amount: bigint) => send([stranger], new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: held.prey!.account, isSigner: false, isWritable: true }, { pubkey: theirs.publicKey, isSigner: false, isWritable: true }, { pubkey: stranger.publicKey, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([3]), u64(amount)]) }));

    // Rescue without asking is off: the taking is told, it is reason enough, and nothing is moved.
    now += RESCUE_AGAIN_SECONDS;
    const first = await take(400_000_000n);
    const alarm = await watch((all) => kinds(all).includes("taken_by_permission"));
    expect(alarm.map((e) => [e.signature, e.signals, e.level, e.rescueWorthy])).toEqual([[first, ["taken_by_permission"], "urgent", true]]);
    expect(lastUnasked).toEqual([false]);
    expect(await balance(held.late!.account)).toBe(42n);

    // The owner switches it on. The thief comes back for more: what is set up is in the vault before they can turn to it.
    expect(accounts.setAutoRescue(profile, true)).toBe(true);
    const second = await take(100_000_000n);
    const again = await watch((all) => kinds(all).includes("taken_by_permission"));
    expect(again.map((e) => [e.signature, e.signals])).toEqual([[second, ["taken_by_permission"]]]);
    expect(lastUnasked).toEqual([true]);
    expect(await balance(held.late!.account)).toBe(0n);
    expect(await balance(vaultTokenAddress(vaultA.address, held.late!.mint))).toBe(42n);
    expect(told.at(-1)).toBe(`After the alert before this one, ${rescuedSentence(1, 0, vaultA.address.toBase58())}`);
    // and the watcher, reading that rescue in its turn, adds nothing to it
    expect(await watch()).toEqual([]);
    // an alert that is not reason enough moves nothing, switched on or not
    now += RESCUE_AGAIN_SECONDS;
    expect(await rescue.after({ ...alarm[0]!, rescueWorthy: false })).toBe(false);
    // what was not set up is where the thief left it, and the page says so
    expect((await rescue.status(W)).uncovered.map((u) => [u.account, u.amount, u.why])).toEqual([[held.prey!.account.toBase58(), "500000000", "not set up"]]);
  }, 240_000);

  it("the setup is taken away by the owner signing it away: approvals revoked, the config closed, and the channels told", async () => {
    await tokenFor("kept", 5n);
    await signAll(((await rescue.arm(profile, W, vaultA.address.toBase58())) as { transactions: string[] }).transactions);
    await watch();
    const before = store.events(W).length;
    const built = await rescue.disarm(profile, W);
    if (!built.ok) throw new Error(built.why);
    await signAll(built.transactions);
    // The watcher sees Sentinel's permission gone from each account. From a thief that is the first move, and
    // Urgent; asked for on the page a moment ago it is the owner's doing, noted and no alarm.
    const gone = await watch((all) => kinds(all).includes("delegate_replaced"));
    expect(kinds(gone)).toContain("delegate_replaced");
    expect(gone.filter((e) => e.level !== "info")).toEqual([]);
    expect(gone.find((e) => e.signals.includes("delegate_replaced"))!.sentence).toMatch(/^Sentinel's permission on your .* account was removed, as asked for on the Sentinel page\.$/);
    expect(lastUnasked.every((r) => r === false)).toBe(true);
    expect(store.events(W).length).toBeGreaterThan(before);
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
    expect(NOT_ON_CHAIN).toContain("not available yet");
  }, 180_000);
});
