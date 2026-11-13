/**
 * The instruction builders against the program's own vectors: sentinel/vectors/instructions.json is written
 * by the program's test suite after it runs each instruction through the compiled program. If a builder here
 * differs by a byte or an account flag, the program would read something else, or refuse.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { configAddress as wardenConfig, delegateAddress as wardenDelegate } from "../../../src/sentinel.js";
import { ASSOCIATED_TOKEN, PROGRAM, TOKEN, TOKEN_2022, acceptVault, approveForRescue, cancelProposal, closeConfig, configAddress, delegateAddress, initConfig, planRescue, proposeVault, rescueInstructions, rescueToken, rescuerSetAddress, setRescuers, vaultTokenAddress, type Holding } from "../src/program.js";

const v = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vectors", "instructions.json"), "utf8"));
const pk = (s: string) => new PublicKey(s);
const owner = pk(v.owner), vault = pk(v.vault), vault2 = pk(v.vault2), mint = pk(v.mint), source = pk(v.source);
const shape = (ix: TransactionInstruction) => ({ programId: ix.programId.toBase58(), data: Buffer.from(ix.data).toString("hex"), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })) });

describe("the rescue program's instructions", () => {
  it("derives the same addresses as the program, and as Warden does when it recognises them", () => {
    expect(configAddress(owner).toBase58()).toBe(v.config);
    expect(delegateAddress(owner, vault).toBase58()).toBe(v.delegate);
    expect(delegateAddress(owner, vault2).toBase58()).toBe(v.delegate2);
    expect(wardenConfig(v.owner)).toBe(v.config);
    expect(wardenDelegate(v.owner, v.vault)).toBe(v.delegate);
    expect(PROGRAM.toBase58()).toBe(v.program);
    // the vault's token account is the standard associated one, which is what the program computes
    expect(vaultTokenAddress(vault, mint).toBase58()).toBe(v.instructions.rescue_token_by_owner.accounts[7].pubkey);
    expect(vaultTokenAddress(vault, mint, TOKEN_2022).toBase58()).not.toBe(vaultTokenAddress(vault, mint).toBase58());
  });

  it.each([
    ["init_config", () => initConfig(owner, vault)],
    ["init_config_with_delay_24h", () => initConfig(owner, vault, 86_400)],
    ["approve_checked", () => approveForRescue({ owner, source, mint, decimals: 6, vault })],
    ["propose_vault", () => proposeVault(owner, vault2)],
    ["accept_vault", () => acceptVault(owner, vault2)],
    ["cancel_proposal", () => cancelProposal(owner)],
    ["set_rescuers_lamport_set", () => setRescuers(owner, { kind: "lamport" })],
    ["set_rescuers_own", () => setRescuers(owner, { kind: "own", key: pk(v.ownRescuer) })],
    ["close_config", () => closeConfig(owner)],
    ["rescue_token_by_owner", () => rescueToken({ rescuer: owner, owner, vault, mint, source, viaSet: false })],
  ] as const)("%s is built exactly as the program was given it", (name, build) => {
    expect(shape(build())).toEqual(v.instructions[name]);
  });

  it("a rescue by one of Lamport's keys shows the set where the owner's shows none, and changes nothing else", () => {
    const rescuer = pk(v.ownRescuer);
    const mine = shape(rescueToken({ rescuer: owner, owner, vault, mint, source, viaSet: false }));
    const theirs = shape(rescueToken({ rescuer, owner, vault, mint, source, viaSet: true }));
    expect(theirs.accounts[0]).toEqual({ pubkey: rescuer.toBase58(), isSigner: true, isWritable: true });
    expect(theirs.accounts[3]!.pubkey).toBe(rescuerSetAddress().toBase58());
    expect(mine.accounts[3]!.pubkey).toBe(PROGRAM.toBase58());
    expect(theirs.accounts.filter((_, i) => i !== 0 && i !== 3)).toEqual(mine.accounts.filter((_, i) => i !== 0 && i !== 3));
    expect(theirs.data).toBe(mine.data);
    // no account in a rescue is a destination anyone chose: the signer, the config and delegate, the vault and its own token account
    expect(theirs.accounts[7]!.pubkey).toBe(vaultTokenAddress(vault, mint).toBase58());
    expect(theirs.accounts.map((a) => a.pubkey)).toContain(ASSOCIATED_TOKEN.toBase58());
  });
});

describe("planning a rescue", () => {
  const delegate = delegateAddress(owner, vault).toBase58();
  const acct = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
  const h = (n: number, o: Partial<Holding> = {}): Holding => ({ address: acct(n), mint: acct(100 + n), tokenProgram: TOKEN.toBase58(), amount: 1_000_000n, decimals: 6, delegate, delegatedAmount: 0xffff_ffff_ffff_ffffn, frozen: false, ...o });

  it("takes only what the program would move, biggest first", () => {
    const holdings = [
      h(1, { amount: 5_000_000n }),
      h(2, { amount: 900_000_000n }),
      h(3, { delegate: acct(77) }),           // a dapp replaced Sentinel's permission
      h(4, { delegate: null }),               // never armed
      h(5, { amount: 0n }),                   // nothing to move
      h(6, { frozen: true }),                 // the program cannot move a frozen account
      h(7, { delegatedAmount: 0n }),          // permission used up or revoked
      h(8, { delegate: delegateAddress(owner, vault2).toBase58() }), // armed for another vault
      h(9, { amount: 20_000_000n }),
    ];
    expect(planRescue(holdings, owner, vault).map((x) => x.address)).toEqual([acct(2), acct(9), acct(1)]);
    // with prices, the most valuable first, whatever the count
    expect(planRescue(holdings, owner, vault, (x) => (x.address === acct(1) ? 1e9 : 1)).map((x) => x.address)[0]).toBe(acct(1));
    expect(planRescue([], owner, vault)).toEqual([]);
  });

  it("splits a rescue into small transactions, each with a priority fee, each instruction naming this owner's vault", () => {
    const plan = planRescue([1, 2, 3, 4, 5, 6, 7].map((n) => h(n, { amount: BigInt(n) * 1_000_000n })), owner, vault);
    const rescuer = pk(v.ownRescuer);
    const txs = rescueInstructions(plan, { rescuer, owner, vault, viaSet: true });
    expect(txs.map((t) => t.length)).toEqual([5, 5, 3]); // two budget instructions, then up to three rescues
    for (const tx of txs) {
      expect(tx.slice(0, 2).map((ix) => ix.programId.toBase58())).toEqual(["ComputeBudget111111111111111111111111111111", "ComputeBudget111111111111111111111111111111"]);
      for (const ix of tx.slice(2)) {
        expect(ix.programId.equals(PROGRAM)).toBe(true);
        expect(ix.keys[4]!.pubkey.equals(vault)).toBe(true);
        expect(ix.keys[7]!.pubkey.equals(vaultTokenAddress(vault, ix.keys[5]!.pubkey))).toBe(true);
      }
    }
    // every planned account is in exactly one instruction, in the plan's order
    expect(txs.flatMap((t) => t.slice(2).map((ix) => ix.keys[6]!.pubkey.toBase58()))).toEqual(plan.map((x) => x.address));
    expect(rescueInstructions([], { rescuer, owner, vault, viaSet: true })).toEqual([]);
    expect(rescueInstructions(plan, { rescuer, owner, vault, viaSet: true, perTransaction: 99 })[0]).toHaveLength(7); // never more than five to a transaction
  });
});
