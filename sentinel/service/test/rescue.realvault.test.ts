/**
 * A rescue into a real Lamport Vault, and out of it again.
 *
 * `rescue.validator.test.ts` stands in for the vault with an account written by hand in the vault's layout,
 * because the rescue program never calls the vault program. That leaves two things it cannot show: that a
 * vault made by the vault program itself is one the rescue program accepts, and that what a rescue puts in
 * the vault's token account can be taken out again by the vault's owner. A rescue nobody can undo would be
 * a loss with extra steps.
 *
 * Here a local validator runs both compiled programs. The vault is created with the vault's own SDK and
 * its hash-based key; a wallet is armed and rescued by the service's rescuer; and the vault's owner then
 * signs the tokens out of the vault to a new wallet.
 *
 * It needs the Lamport Vault repository beside this one (or `LAMPORT_VAULT_REPO`), with its SDK installed,
 * and it is run only when asked for, by saying which vault program to use: `LAMPORT_VAULT_FROM=devnet` for
 * the one that is deployed on devnet, fetched as the validator starts; `LAMPORT_VAULT_FROM=local` for the one
 * built in that repository (`target/deploy/lamport_vault.so`, or `LAMPORT_VAULT_SO`). What happens to be
 * built there may be another variant of the program, under another address, so it is not used unasked.
 *
 *   LAMPORT_VAULT_FROM=devnet pnpm vitest run sentinel/service/test/rescue.realvault.test.ts
 *   LAMPORT_VAULT_FROM=local pnpm vitest run sentinel/service/test/rescue.realvault.test.ts
 */
import "../../../src/polyfill.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN, PROGRAM, TOKEN, TOKEN_2022, approveForRescue, configAddress, createVaultTokenAccount, delegateAddress, initConfig, initRescuerSet, vaultTokenAddress } from "../src/program.js";
import { Rescuer, readConfig } from "../src/rescuer.js";
import { HttpRpc } from "../src/rpc.js";

const here = dirname(fileURLToPath(import.meta.url));
const SO = join(here, "..", "..", "program", "target", "deploy", "lamport_sentinel.so");
const VAULT_REPO = process.env.LAMPORT_VAULT_REPO ?? join(here, "..", "..", "..", "..", "lamport-vault");
const VAULT_SDK = join(VAULT_REPO, "sdk", "packages", "vault", "src", "index.ts");
const LMS_SDK = join(VAULT_REPO, "sdk", "packages", "lms", "src", "index.ts");
const FROM_DEVNET = process.env.LAMPORT_VAULT_FROM === "devnet";
const VAULT_SO = process.env.LAMPORT_VAULT_SO ?? join(VAULT_REPO, "target", "deploy", "lamport_vault.so");
const LAMPORT_VAULT = new PublicKey("B7dNdVV8shrKgqx7A5JvBQBp7vsTyQTLrdAdeiLKwXqH");
const onPath = (() => { try { execFileSync("solana-test-validator", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const ready = onPath && existsSync(SO) && existsSync(VAULT_SDK) && existsSync(LMS_SDK) && existsSync(join(VAULT_REPO, "sdk", "node_modules")) && (FROM_DEVNET || (process.env.LAMPORT_VAULT_FROM === "local" && existsSync(VAULT_SO)));

const seeded = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const authority = seeded(51), owner = seeded(52), lamportRescuer = seeded(53), vaultPayer = seeded(54), safe = seeded(55);
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

describe.skipIf(!ready)(`a rescue into a real Lamport Vault (${FROM_DEVNET ? "the vault program that is on devnet" : "the vault program built beside this repository"}), and out again`, () => {
  let validator: ChildProcess;
  let rpc: HttpRpc, connection: Connection;
  // the vault's own SDK, loaded from its repository: nothing of it is copied here
  let vaultSdk: any, lms: any;
  let signer: any, vault: PublicKey;

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
  /** A new token with `amount` of it in a new account of `holder`, under either token program. */
  const tokenFor = async (holder: PublicKey, amount: bigint, program = TOKEN): Promise<{ mint: PublicKey; account: PublicKey }> => {
    const mint = Keypair.generate(), account = Keypair.generate();
    await send([authority, mint, account],
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint.publicKey, lamports: await rent(82), space: 82, programId: program }),
      new TransactionInstruction({ programId: program, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }], data: Buffer.concat([Buffer.from([20, 6]), authority.publicKey.toBuffer(), Buffer.from([0])]) }), // InitializeMint2
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: account.publicKey, lamports: await rent(165), space: 165, programId: program }),
      new TransactionInstruction({ programId: program, keys: [{ pubkey: account.publicKey, isSigner: false, isWritable: true }, { pubkey: mint.publicKey, isSigner: false, isWritable: false }], data: Buffer.concat([Buffer.from([18]), holder.toBuffer()]) }), // InitializeAccount3
      new TransactionInstruction({ programId: program, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }, { pubkey: account.publicKey, isSigner: false, isWritable: true }, { pubkey: authority.publicKey, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([7]), u64(amount)]) }), // MintTo
    );
    return { mint: mint.publicKey, account: account.publicKey };
  };
  /** An empty token account for `holder`, to receive what comes out of the vault. */
  const emptyAccount = async (holder: PublicKey, mint: PublicKey, program = TOKEN): Promise<PublicKey> => {
    const account = Keypair.generate();
    await send([authority, account],
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: account.publicKey, lamports: await rent(165), space: 165, programId: program }),
      new TransactionInstruction({ programId: program, keys: [{ pubkey: account.publicKey, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }], data: Buffer.concat([Buffer.from([18]), holder.toBuffer()]) }));
    return account.publicKey;
  };
  const balance = async (account: PublicKey): Promise<bigint | null> => {
    const res = await rpc.call("getTokenAccountBalance", [account.toBase58(), { commitment: "confirmed" }]).catch(() => null);
    return res?.value ? BigInt(res.value.amount) : null;
  };
  const quick = { confirmSeconds: 30 };

  beforeAll(async () => {
    vaultSdk = await import(/* @vite-ignore */ VAULT_SDK);
    lms = await import(/* @vite-ignore */ LMS_SDK);
    const dir = mkdtempSync(join(tmpdir(), "sentinel-realvault-"));
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
      "--gossip-port", String(port + 5), "--dynamic-port-range", `${port + 10}-${port + 69}`,
      // the SOL made at the start belongs to one key here, which hands the others theirs: no faucet to wait for
      "--mint", authority.publicKey.toBase58(),
      "--upgradeable-program", PROGRAM.toBase58(), SO, authority.publicKey.toBase58(),
      // the vault program: the one that is on devnet, byte for byte, or the one built from the vault's repository
      ...(FROM_DEVNET ? ["--url", "https://api.devnet.solana.com", "--clone-upgradeable-program", LAMPORT_VAULT.toBase58()] : ["--upgradeable-program", LAMPORT_VAULT.toBase58(), VAULT_SO, authority.publicKey.toBase58()]),
    ], { stdio: "ignore" });
    validator.once("exit", (code) => { exited = code ?? -1; });
    const why = () => { try { return readFileSync(join(dir, "ledger", "validator.log"), "utf8").split("\n").filter((l) => /panicked|Address already in use|ERROR/.test(l)).slice(-3).join(" | ").slice(0, 400); } catch { return "no log"; } };
    rpc = new HttpRpc(`http://127.0.0.1:${port}`, undefined, { timeoutMs: 5000, retries: 0 });
    connection = new Connection(`http://127.0.0.1:${port}`, "confirmed");
    for (let i = 0; ; i++) {
      if (exited !== null) throw new Error(`the validator stopped while starting (${exited}): ${why()}`);
      try { if ((await rpc.call("getHealth", [])) === "ok") break; } catch { /* still starting */ }
      if (i > 300) throw new Error(`the validator did not start: ${why()}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    for (const id of [PROGRAM, LAMPORT_VAULT]) {
      const program = await rpc.call("getAccountInfo", [id.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
      if (!program?.value?.executable) throw new Error(`${id.toBase58()} is not a program on the validator this test started`);
    }
    await send([authority], ...[owner, lamportRescuer, vaultPayer, safe].map((k) => SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: k.publicKey, lamports: 5_000_000_000 })));
    await send([authority], initRescuerSet(authority.publicKey, authority.publicKey, [lamportRescuer.publicKey]));
  }, 240_000);
  afterAll(() => { validator?.kill("SIGKILL"); });

  it("the rescue program takes a vault that the vault program made for one", async () => {
    // a real vault: a hash-based key (the smallest tree, 32 signatures), and the vault's own create instruction
    const key = lms.LmsPrivateKey.generate(lms.randomKeyMaterial(lms.LMS_SHA256_M32_H5));
    signer = new vaultSdk.VaultSigner({ rpc: connection, key, payer: vaultPayer, journal: "ephemeral" });
    const made = await signer.createVault({ commitment: "confirmed" }).catch(async (e: any) => { throw new Error(`the vault program refused to make a vault: ${String(e?.message ?? e).slice(0, 200)} | ${JSON.stringify(e?.transactionLogs ?? e?.logs ?? (await e?.getLogs?.(connection).catch(() => null)) ?? null).slice(0, 1500)}`); });
    vault = new PublicKey(made.vault.toBase58());
    const onChain = await rpc.call("getAccountInfo", [vault.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
    expect(onChain.value.owner).toBe(LAMPORT_VAULT.toBase58());
    // init_config checks the account's owner, its marker, its version and that it sits at its own address:
    // every one of those is read from what the vault program wrote, not from what a test wrote for it
    await send([owner], initConfig(owner.publicKey, vault));
    const stored = await rpc.call("getAccountInfo", [configAddress(owner.publicKey).toBase58(), { encoding: "base64", commitment: "confirmed" }]);
    expect(readConfig(Buffer.from(stored.value.data[0], "base64"))).toMatchObject({ owner: owner.publicKey.toBase58(), vault: vault.toBase58(), rescuers: { kind: "lamport" } });
  }, 120_000);

  it("what is rescued lands in the vault, and the vault's owner signs it out again to a wallet of their choosing", async () => {
    const usdc = await tokenFor(owner.publicKey, 250_000_000n);
    await send([owner], createVaultTokenAccount(owner.publicKey, vault, usdc.mint), approveForRescue({ owner: owner.publicKey, source: usdc.account, mint: usdc.mint, decimals: 6, vault }));
    const result = await new Rescuer(rpc, lamportRescuer, quick).rescue(owner.publicKey.toBase58());
    expect(result).toMatchObject({ ok: true, vault: vault.toBase58(), steps: [{ ok: true }] });
    const inVault = vaultTokenAddress(vault, usdc.mint);
    expect(await balance(usdc.account)).toBe(0n);
    expect(await balance(inVault)).toBe(250_000_000n);

    // Out again. The old wallet's key is taken to be lost: the tokens go to a new wallet, on the vault key's signature alone.
    const landing = await emptyAccount(safe.publicKey, usdc.mint);
    const out = await signer.execute({ kind: "TransferToken", mint: usdc.mint, to: landing, amount: 250_000_000n }, { commitment: "confirmed" });
    expect(out.signatures.length).toBeGreaterThan(0);
    expect(await balance(inVault)).toBe(0n);
    expect(await balance(landing)).toBe(250_000_000n);
  }, 180_000);

  it("the same for a Token-2022 token: in by a rescue, out by the vault's signature", async () => {
    const t22 = await tokenFor(owner.publicKey, 7_000_000n, TOKEN_2022);
    await send([owner], createVaultTokenAccount(owner.publicKey, vault, t22.mint, TOKEN_2022), approveForRescue({ owner: owner.publicKey, source: t22.account, mint: t22.mint, decimals: 6, vault, tokenProgram: TOKEN_2022 }));
    const result = await new Rescuer(rpc, lamportRescuer, quick).rescue(owner.publicKey.toBase58());
    expect(result).toMatchObject({ ok: true, steps: [{ ok: true }] });
    const inVault = vaultTokenAddress(vault, t22.mint, TOKEN_2022);
    expect(await balance(inVault)).toBe(7_000_000n);
    const landing = await emptyAccount(safe.publicKey, t22.mint, TOKEN_2022);
    // The vault has to be able to spend a Token-2022 account it owns, or a rescue of such a token is a one-way
    // door. (The vault's signer is told which token program once, when it is made; the same signer is used
    // here, so that it keeps its record of the signatures it has already spent.)
    signer.opts.tokenProgram = made(TOKEN_2022);
    try { await signer.execute({ kind: "TransferTokenFrom", from: inVault, mint: t22.mint, to: landing, amount: 7_000_000n }, { commitment: "confirmed" }); } finally { delete signer.opts.tokenProgram; }
    expect(await balance(landing)).toBe(7_000_000n);
    expect(await balance(inVault)).toBe(0n);
  }, 180_000);

  it("a vault whose key was changed is the same vault: a rescue still lands there, and the new key signs it out", async () => {
    const next = lms.LmsPrivateKey.generate(lms.randomKeyMaterial(lms.LMS_SHA256_M32_H5));
    await signer.execute({ kind: "Rotate", newLmsPubkey: next.publicKey }, { commitment: "confirmed", allowForeignKey: true });
    const t = await tokenFor(owner.publicKey, 42n);
    await send([owner], createVaultTokenAccount(owner.publicKey, vault, t.mint), approveForRescue({ owner: owner.publicKey, source: t.account, mint: t.mint, decimals: 6, vault }));
    expect(await new Rescuer(rpc, lamportRescuer, quick).rescue(owner.publicKey.toBase58())).toMatchObject({ ok: true, vault: vault.toBase58(), steps: [{ ok: true }] });
    expect(await balance(vaultTokenAddress(vault, t.mint))).toBe(42n);
    signer = new vaultSdk.VaultSigner({ rpc: connection, key: next, payer: vaultPayer, vault: made(vault), journal: "ephemeral" });
    const landing = await emptyAccount(safe.publicKey, t.mint);
    await signer.execute({ kind: "TransferToken", mint: t.mint, to: landing, amount: 42n }, { commitment: "confirmed" });
    expect(await balance(landing)).toBe(42n);
  }, 240_000);

  it("a vault that was closed is sent nothing: the rescue is refused and the tokens stay where they were", async () => {
    const t = await tokenFor(owner.publicKey, 9n);
    await send([owner], createVaultTokenAccount(owner.publicKey, vault, t.mint), approveForRescue({ owner: owner.publicKey, source: t.account, mint: t.mint, decimals: 6, vault }));
    expect((await rpc.call("getAccountInfo", [t.account.toBase58(), { encoding: "jsonParsed", commitment: "confirmed" }])).value.data.parsed.info.delegate).toBe(delegateAddress(owner.publicKey, vault).toBase58());
    await signer.execute({ kind: "Close", to: safe.publicKey }, { commitment: "confirmed" });
    const result = await new Rescuer(rpc, lamportRescuer, quick).rescue(owner.publicKey.toBase58());
    // either told before anything is sent, or refused by the program: never moved
    if (result.ok) expect(result.steps.every((s) => !s.ok)).toBe(true);
    expect(await balance(t.account)).toBe(9n);
    // the token account the owner made for it at setup is there, and nothing was put in it
    expect(await balance(vaultTokenAddress(vault, t.mint))).toBe(0n);
    expect(ASSOCIATED_TOKEN.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  }, 180_000);

  /** The vault's address as the vault SDK's own PublicKey: the two repositories may not share one copy of the class. */
  function made(address: PublicKey): any { return new (signer.vault.constructor as typeof PublicKey)(address.toBase58()); }
});
