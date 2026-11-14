/**
 * A rescue, for real: a local validator running the compiled rescue program, a vault account as the Lamport
 * Vault program lays one out, a wallet with tokens, and the rescuer moving them. Nothing is stood in for but
 * the vault program itself, which the rescue program never calls.
 *
 * Skipped unless `solana-test-validator` is on PATH and the program is built:
 *
 *   cargo build-sbf --manifest-path sentinel/program/programs/lamport-sentinel/Cargo.toml
 *   pnpm vitest run sentinel/service/test/rescue.validator.test.ts
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
import { PROGRAM, TOKEN, approveForRescue, configAddress, createVaultTokenAccount, delegateAddress, initConfig, initRescuerSet, proposeVault, setRescuers, vaultTokenAddress } from "../src/program.js";
import { Rescuer, holdingsOf, readConfig, readRescuerSet } from "../src/rescuer.js";
import { HttpRpc } from "../src/rpc.js";

const here = dirname(fileURLToPath(import.meta.url));
const SO = join(here, "..", "..", "program", "target", "deploy", "lamport_sentinel.so");
const onPath = (() => { try { execFileSync("solana-test-validator", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

// `pnpm test:rescue` (and CI) asks for the real thing: there, a missing validator or program is a failure, not a skip
if (process.env.REQUIRE_VALIDATOR && (!onPath || !existsSync(SO))) throw new Error(`a rescue cannot be tested here: ${onPath ? `the program is not built (${SO})` : "solana-test-validator is not on PATH"}`);

const LAMPORT_VAULT = new PublicKey("B7dNdVV8shrKgqx7A5JvBQBp7vsTyQTLrdAdeiLKwXqH");
const seeded = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const authority = seeded(31), owner = seeded(32), lamportRescuer = seeded(33), ownRescuer = seeded(34), stranger = seeded(35), other = seeded(36);

/** A vault as the Lamport Vault program lays one out: its marker, version 2, its bump and id, then the rest. */
function vault(idByte: number) {
  const id = new Uint8Array(32).fill(idByte);
  const [address, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"), id], LAMPORT_VAULT);
  const data = Buffer.concat([Buffer.from([211, 8, 232, 43, 2, 152, 117, 119]), Buffer.from([2, bump]), Buffer.from(id), Buffer.alloc(80, 7)]);
  return { address, data };
}
const vaultA = vault(1), vaultB = vault(2);

describe.skipIf(!onPath || !existsSync(SO))("a rescue on a local validator, through the compiled program", () => {
  let validator: ChildProcess;
  let rpc: HttpRpc;
  let port = 0;
  const mints: PublicKey[] = [];
  const accounts: Record<string, PublicKey> = {};

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
  const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
  /** A new token with `amount` of it in a new account of `holder`. Plain Token program instructions. */
  const tokenFor = async (holder: Keypair, amount: bigint, decimals = 6): Promise<{ mint: PublicKey; account: PublicKey }> => {
    const mint = Keypair.generate(), account = Keypair.generate();
    await send([authority, mint, account],
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint.publicKey, lamports: await rent(82), space: 82, programId: TOKEN }),
      new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }], data: Buffer.concat([Buffer.from([20, decimals]), authority.publicKey.toBuffer(), Buffer.from([0])]) }), // InitializeMint2
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: account.publicKey, lamports: await rent(165), space: 165, programId: TOKEN }),
      new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: account.publicKey, isSigner: false, isWritable: true }, { pubkey: mint.publicKey, isSigner: false, isWritable: false }], data: Buffer.concat([Buffer.from([18]), holder.publicKey.toBuffer()]) }), // InitializeAccount3
      new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }, { pubkey: account.publicKey, isSigner: false, isWritable: true }, { pubkey: authority.publicKey, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([7]), u64(amount)]) }), // MintTo
    );
    mints.push(mint.publicKey);
    return { mint: mint.publicKey, account: account.publicKey };
  };
  const balance = async (account: PublicKey): Promise<bigint | null> => {
    const res = await rpc.call("getTokenAccountBalance", [account.toBase58(), { commitment: "confirmed" }]).catch(() => null);
    return res?.value ? BigInt(res.value.amount) : null;
  };
  const quick = { confirmSeconds: 30 };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-validator-"));
    const file = (name: string, v: { address: PublicKey; data: Buffer }) => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify({ pubkey: v.address.toBase58(), account: { lamports: 10_000_000, data: [v.data.toString("base64"), "base64"], owner: LAMPORT_VAULT.toBase58(), executable: false, rentEpoch: 0, space: v.data.length } }));
      return path;
    };
    // A stretch of ports nobody is using, for this validator alone: its RPC, its faucet, its gossip and the
    // range it picks the rest from. Another validator on the machine (another test, another project) takes
    // the defaults, and two that share a port either fail to start or, worse, answer for each other.
    const isFree = (p: number) => new Promise<boolean>((resolve) => { const s = createServer(); s.once("error", () => resolve(false)); s.listen(p, "127.0.0.1", () => s.close(() => resolve(true))); });
    for (let tries = 0; ; tries++) {
      const base = 20_000 + Math.floor(Math.random() * 300) * 100;
      const all = await Promise.all(Array.from({ length: 70 }, (_, i) => isFree(base + i)));
      if (all.every(Boolean)) { port = base; break; }
      if (tries > 20) throw new Error("no free stretch of ports for a validator");
    }
    let exited: number | null = null;
    validator = spawn("solana-test-validator", [
      "--reset", "--quiet", "--ledger", join(dir, "ledger"), "--bind-address", "127.0.0.1", "--rpc-port", String(port), "--faucet-port", String(port + 3),
      "--gossip-port", String(port + 5), "--dynamic-port-range", `${port + 10}-${port + 69}`,
      "--upgradeable-program", PROGRAM.toBase58(), SO, authority.publicKey.toBase58(),
      "--account", vaultA.address.toBase58(), file("vault-a.json", vaultA), "--account", vaultB.address.toBase58(), file("vault-b.json", vaultB),
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
    // and it is this validator that answers: the one with the rescue program in it
    const program = await rpc.call("getAccountInfo", [PROGRAM.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
    if (!program?.value?.executable) throw new Error("whatever answers on that port is not the validator this test started");
    for (const k of [authority, owner, lamportRescuer, ownRescuer, stranger, other]) await rpc.call("requestAirdrop", [k.publicKey.toBase58(), 5_000_000_000]);
    for (let i = 0; i < 100 && ((await rpc.call("getBalance", [other.publicKey.toBase58(), { commitment: "confirmed" }]))?.value ?? 0) === 0; i++) await new Promise((r) => setTimeout(r, 200));
    // Lamport's rescuer set, made once by the program's upgrade authority
    await send([authority], initRescuerSet(authority.publicKey, authority.publicKey, [lamportRescuer.publicKey]));
  }, 120_000);
  afterAll(() => { validator?.kill("SIGKILL"); });

  it("reads back what the program stored: the rescuer set, and a wallet's configuration", async () => {
    const set = await rpc.call("getAccountInfo", [PublicKey.findProgramAddressSync([new TextEncoder().encode("rescuers")], PROGRAM)[0].toBase58(), { encoding: "base64", commitment: "confirmed" }]);
    expect(readRescuerSet(Buffer.from(set.value.data[0], "base64"))).toEqual([lamportRescuer.publicKey.toBase58()]);

    // arming: the owner names the vault, makes the vault's own token account for each token (a rescue goes only
    // into ones that exist, so that the key that rescues never pays for one), and lets Sentinel's delegate for
    // that vault move each token account
    const usdc = await tokenFor(owner, 250_000_000n), bonk = await tokenFor(owner, 9_000_000_000n, 5), dust = await tokenFor(owner, 1n);
    const unarmed = await tokenFor(owner, 77_000_000n);
    Object.assign(accounts, { usdc: usdc.account, bonk: bonk.account, dust: dust.account, unarmed: unarmed.account, usdcMint: usdc.mint, bonkMint: bonk.mint, dustMint: dust.mint, unarmedMint: unarmed.mint });
    await send([owner], initConfig(owner.publicKey, vaultA.address),
      createVaultTokenAccount(owner.publicKey, vaultA.address, usdc.mint), approveForRescue({ owner: owner.publicKey, source: usdc.account, mint: usdc.mint, decimals: 6, vault: vaultA.address }),
      createVaultTokenAccount(owner.publicKey, vaultA.address, bonk.mint), approveForRescue({ owner: owner.publicKey, source: bonk.account, mint: bonk.mint, decimals: 5, vault: vaultA.address }),
      createVaultTokenAccount(owner.publicKey, vaultA.address, dust.mint), approveForRescue({ owner: owner.publicKey, source: dust.account, mint: dust.mint, decimals: 6, vault: vaultA.address }));
    const stored = await rpc.call("getAccountInfo", [configAddress(owner.publicKey).toBase58(), { encoding: "base64", commitment: "confirmed" }]);
    expect(readConfig(Buffer.from(stored.value.data[0], "base64"))).toEqual({ owner: owner.publicKey.toBase58(), vault: vaultA.address.toBase58(), pendingVault: null, rescuers: { kind: "lamport" } });
    const holdings = await holdingsOf(rpc, owner.publicKey.toBase58());
    expect(holdings.filter((h) => h.delegate === delegateAddress(owner.publicKey, vaultA.address).toBase58()).map((h) => h.address).sort()).toEqual([usdc.account, bonk.account, dust.account].map((a) => a.toBase58()).sort());
  }, 120_000);

  it("a key that is not a rescuer is told so before it sends anything, and an unarmed wallet has nothing to rescue", async () => {
    expect(await new Rescuer(rpc, stranger, quick).rescue(owner.publicKey.toBase58())).toEqual({ ok: false, why: "this key is not one of the rescuer set." });
    expect(await new Rescuer(rpc, lamportRescuer, quick).rescue(other.publicKey.toBase58())).toEqual({ ok: false, why: "this wallet is not armed." });
    expect(await balance(accounts.usdc!)).toBe(250_000_000n);
  }, 60_000);

  it("one of Lamport's keys moves every armed account into the owner's vault, and nothing else", async () => {
    const result = await new Rescuer(rpc, lamportRescuer, quick).rescue(owner.publicKey.toBase58());
    expect(result).toMatchObject({ ok: true, vault: vaultA.address.toBase58() });
    if (!result.ok) return;
    expect(result.steps.map((s) => [s.ok, s.why])).toEqual([[true, undefined]]);
    expect(result.steps[0]!.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    expect(result.steps[0]!.accounts.sort()).toEqual([accounts.usdc!, accounts.bonk!, accounts.dust!].map((a) => a.toBase58()).sort());
    // everything that was armed is in the vault's own token accounts, which did not exist before
    expect(await balance(accounts.usdc!)).toBe(0n);
    expect(await balance(accounts.bonk!)).toBe(0n);
    expect(await balance(accounts.dust!)).toBe(0n);
    expect(await balance(vaultTokenAddress(vaultA.address, accounts.usdcMint!))).toBe(250_000_000n);
    expect(await balance(vaultTokenAddress(vaultA.address, accounts.bonkMint!))).toBe(9_000_000_000n);
    expect(await balance(vaultTokenAddress(vaultA.address, accounts.dustMint!))).toBe(1n);
    // the account the owner did not arm is where it was
    expect(await balance(accounts.unarmed!)).toBe(77_000_000n);
    expect(await balance(vaultTokenAddress(vaultA.address, accounts.unarmedMint!))).toBeNull();
    // and the rescuer holds none of it: the vault's token accounts belong to the vault
    const landed = await rpc.call("getAccountInfo", [vaultTokenAddress(vaultA.address, accounts.usdcMint!).toBase58(), { encoding: "jsonParsed", commitment: "confirmed" }]);
    expect(landed.value.data.parsed.info.owner).toBe(vaultA.address.toBase58());
    // a second rescue finds nothing left to move
    expect(await new Rescuer(rpc, lamportRescuer, quick).rescue(owner.publicKey.toBase58())).toEqual({ ok: true, vault: vaultA.address.toBase58(), steps: [] });
  }, 120_000);

  it("an owner who chose a key of their own is rescued by that key, and no longer by Lamport's", async () => {
    const more = await tokenFor(owner, 5_000_000n);
    await send([owner], setRescuers(owner.publicKey, { kind: "own", key: ownRescuer.publicKey }), createVaultTokenAccount(owner.publicKey, vaultA.address, more.mint), approveForRescue({ owner: owner.publicKey, source: more.account, mint: more.mint, decimals: 6, vault: vaultA.address }));
    expect(await new Rescuer(rpc, lamportRescuer, quick).rescue(owner.publicKey.toBase58())).toEqual({ ok: false, why: "this wallet chose a rescuer key of its own, and this is not it." });
    expect(await balance(more.account)).toBe(5_000_000n);
    const result = await new Rescuer(rpc, ownRescuer, quick).rescue(owner.publicKey.toBase58());
    expect(result).toMatchObject({ ok: true, steps: [{ ok: true, accounts: [more.account.toBase58()] }] });
    expect(await balance(vaultTokenAddress(vaultA.address, more.mint))).toBe(5_000_000n);
    // the owner can always rescue themselves
    const again = await tokenFor(owner, 3n);
    await send([owner], createVaultTokenAccount(owner.publicKey, vaultA.address, again.mint), approveForRescue({ owner: owner.publicKey, source: again.account, mint: again.mint, decimals: 6, vault: vaultA.address }));
    expect(await new Rescuer(rpc, owner, quick).rescue(owner.publicKey.toBase58())).toMatchObject({ ok: true, steps: [{ ok: true }] });
    expect(await balance(vaultTokenAddress(vaultA.address, again.mint))).toBe(3n);
  }, 120_000);

  it("a proposed change of vault changes nothing yet: a rescue still goes to the vault that is configured", async () => {
    const t = await tokenFor(owner, 42n);
    await send([owner], proposeVault(owner.publicKey, vaultB.address), createVaultTokenAccount(owner.publicKey, vaultA.address, t.mint), approveForRescue({ owner: owner.publicKey, source: t.account, mint: t.mint, decimals: 6, vault: vaultA.address }));
    const stored = await rpc.call("getAccountInfo", [configAddress(owner.publicKey).toBase58(), { encoding: "base64", commitment: "confirmed" }]);
    expect(readConfig(Buffer.from(stored.value.data[0], "base64"))).toMatchObject({ vault: vaultA.address.toBase58(), pendingVault: vaultB.address.toBase58(), rescuers: { kind: "own", key: ownRescuer.publicKey.toBase58() } });
    expect(await new Rescuer(rpc, ownRescuer, quick).rescue(owner.publicKey.toBase58())).toMatchObject({ ok: true, vault: vaultA.address.toBase58(), steps: [{ ok: true }] });
    expect(await balance(vaultTokenAddress(vaultA.address, t.mint))).toBe(42n);
    expect(await balance(vaultTokenAddress(vaultB.address, t.mint))).toBeNull();
  }, 120_000);
});
