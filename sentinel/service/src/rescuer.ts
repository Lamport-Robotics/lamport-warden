/**
 * The rescuer: moves what an owner armed into that owner's own vault. It holds the one key this service
 * has, and that key can do one thing: ask the rescue program to move an armed token account's balance to
 * the vault the owner configured. The program computes the destination; nothing here chooses it. (Today it
 * runs inside the service's own process, with the key in the service's settings and an RPC client of its
 * own, so that a rescue never waits behind the watcher's reading. A process of its own is the next step.)
 *
 * Before sending anything it reads the chain: is the wallet armed, for which vault, and is this key one
 * that may act for it. A key that may not is told so here, instead of paying fees to be refused there.
 */
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { PROGRAM, TOKEN, TOKEN_2022, configAddress, planRescue, rescueInstructions, rescuerSetAddress, vaultTokenAddress, type Holding } from "./program.js";
import type { Rpc } from "./rpc.js";

export interface Config { owner: string; vault: string; pendingVault: string | null; rescuers: { kind: "lamport" } | { kind: "own"; key: string } }

const key = (d: Uint8Array, at: number) => new PublicKey(d.subarray(at, at + 32)).toBase58();

/** An owner's Sentinel configuration, from its account's bytes. Null for anything that is not one. */
export function readConfig(data: Uint8Array): Config | null {
  // 8 discriminator, version, bump, owner, vault, pending vault (a flag, then a key when set), two times, rescuers
  if (data.length < 8 + 2 + 64 + 1 + 16 + 1) return null;
  const pendingAt = 74, hasPending = data[pendingAt] === 1;
  if (data[pendingAt]! > 1) return null;
  const rescuersAt = pendingAt + 1 + (hasPending ? 32 : 0) + 16;
  const tag = data[rescuersAt];
  if (tag === 1 && data.length < rescuersAt + 33) return null;
  if (tag !== 0 && tag !== 1) return null;
  return { owner: key(data, 10), vault: key(data, 42), pendingVault: hasPending ? key(data, pendingAt + 1) : null, rescuers: tag === 0 ? { kind: "lamport" } : { kind: "own", key: key(data, rescuersAt + 1) } };
}

/** The keys of the shared rescuer set, from its account's bytes. */
export function readRescuerSet(data: Uint8Array): string[] | null {
  // 8 discriminator, version, bump, admin, then how many keys and the keys
  if (data.length < 8 + 2 + 32 + 4) return null;
  const n = new DataView(data.buffer, data.byteOffset + 42, 4).getUint32(0, true);
  if (n > 4 || data.length < 46 + 32 * n) return null;
  return Array.from({ length: n }, (_, i) => key(data, 46 + 32 * i));
}

/** Every token account of a wallet, under both token programs, as the chain shows them now. */
export async function holdingsOf(rpc: Rpc, owner: string): Promise<Holding[]> {
  const out: Holding[] = [];
  for (const program of [TOKEN, TOKEN_2022]) {
    const res = await rpc.call("getTokenAccountsByOwner", [owner, { programId: program.toBase58() }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    for (const entry of res?.value ?? []) {
      const info = entry?.account?.data?.parsed?.info;
      if (!info || typeof entry.pubkey !== "string" || typeof info.mint !== "string") continue;
      const amount = BigInt(info.tokenAmount?.amount ?? "0");
      // what the token program says of the account itself: a token that is not transferable, or that calls its issuer's program on a transfer
      const marks: string[] = Array.isArray(info.extensions) ? info.extensions.map((e: any) => String(e?.extension ?? "")) : [];
      out.push({
        address: entry.pubkey, mint: info.mint, tokenProgram: program.toBase58(), amount, decimals: Number(info.tokenAmount?.decimals ?? 0),
        delegate: typeof info.delegate === "string" ? info.delegate : null, delegatedAmount: BigInt(info.delegatedAmount?.amount ?? "0"), frozen: info.state === "frozen",
        ...(marks.includes("nonTransferableAccount") || marks.includes("transferHookAccount") ? { unmovable: true } : {}),
      });
    }
  }
  return out;
}

/**
 * Which of these holdings the vault already has a token account for: the only ones a rescue is sent for.
 * The rescue program would make a missing one and have the rescuer pay for it; a vault's owner can close the
 * vault and take that payment, so a rescuer that paid could be emptied by anyone who armed many small accounts.
 * The owner makes them at setup instead (program.ts, `createVaultTokenAccount`).
 */
export async function vaultAccountsThere(rpc: Rpc, vault: PublicKey, holdings: Holding[]): Promise<Set<string>> {
  const there = new Set<string>();
  for (let i = 0; i < holdings.length; i += 100) {
    const some = holdings.slice(i, i + 100);
    const res = await rpc.call("getMultipleAccounts", [some.map((h) => vaultTokenAddress(vault, new PublicKey(h.mint), new PublicKey(h.tokenProgram)).toBase58()), { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }]);
    if (!Array.isArray(res?.value) || res.value.length !== some.length) throw new Error("the vault's token accounts could not be read");
    some.forEach((h, j) => { if (res.value[j] && String(res.value[j].owner) === h.tokenProgram) there.add(h.address); });
  }
  return there;
}

export interface RescueStep { accounts: string[]; signature: string | null; ok: boolean; why?: string }
export type RescueResult = { ok: true; vault: string; steps: RescueStep[] } | { ok: false; why: string };

const bytesOf = (value: any): Uint8Array | null => (Array.isArray(value?.data) && typeof value.data[0] === "string" ? Uint8Array.from(Buffer.from(value.data[0], "base64")) : null);

export class Rescuer {
  /**
   * The signature of every rescue this key sent, known from the moment it is sent: the watcher reads a
   * rescue within seconds, and has to know it for the service's own before the service has finished waiting
   * for it to confirm.
   */
  readonly sent = new Set<string>();
  /** The address of the key this rescues with: what pays for a rescue, and what has to be among the rescuers. */
  get address(): string { return this.signer.publicKey.toBase58(); }
  constructor(private rpc: Rpc, private signer: Keypair, private opts: { microLamportsPerUnit?: number; confirmSeconds?: number; sleep?: (ms: number) => Promise<void> } = {}) {}

  private async account(address: PublicKey): Promise<{ owner: string; data: Uint8Array } | null> {
    const res = await this.rpc.call("getAccountInfo", [address.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
    const data = bytesOf(res?.value);
    return res?.value && data ? { owner: String(res.value.owner), data } : null;
  }

  /**
   * Whether this key may rescue this wallet, and to which vault. Read from the chain every time: an owner can
   * change their rescuers or their vault whenever they like.
   */
  async standing(owner: string): Promise<{ ok: true; config: Config; viaSet: boolean } | { ok: false; why: string }> {
    const ownerKey = new PublicKey(owner);
    const stored = await this.account(configAddress(ownerKey));
    const config = stored && stored.owner === PROGRAM.toBase58() ? readConfig(stored.data) : null;
    if (!config || config.owner !== owner) return { ok: false, why: "this wallet is not armed." };
    const me = this.signer.publicKey.toBase58();
    if (me === owner) return { ok: true, config, viaSet: false };
    if (config.rescuers.kind === "own") return config.rescuers.key === me ? { ok: true, config, viaSet: false } : { ok: false, why: "this wallet chose a rescuer key of its own, and this is not it." };
    const set = await this.account(rescuerSetAddress());
    const keys = set && set.owner === PROGRAM.toBase58() ? readRescuerSet(set.data) : null;
    return keys?.includes(me) ? { ok: true, config, viaSet: true } : { ok: false, why: "this key is not one of the rescuer set." };
  }

  private async send(instructions: TransactionInstruction[], blockhash: string): Promise<string> {
    const tx = new Transaction({ feePayer: this.signer.publicKey, recentBlockhash: blockhash }).add(...instructions);
    tx.sign(this.signer);
    // simulated first: one the program would refuse costs nothing and says why
    return this.rpc.call("sendTransaction", [tx.serialize().toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]);
  }

  private async confirmed(signature: string): Promise<{ ok: boolean; why?: string }> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const until = Date.now() + (this.opts.confirmSeconds ?? 45) * 1000;
    for (;;) {
      const res = await this.rpc.call("getSignatureStatuses", [[signature]]);
      const status = res?.value?.[0];
      if (status?.err) return { ok: false, why: `the chain refused it: ${JSON.stringify(status.err).slice(0, 120)}` };
      if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return { ok: true };
      if (Date.now() > until) return { ok: false, why: "it was sent and not seen to land in time." };
      await sleep(400);
    }
  }

  /** Whether a transaction this key sent is on the chain and did what it was sent to do. False when it failed, or cannot be found. */
  async landed(signature: string): Promise<boolean> {
    const status = (await this.rpc.call("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]))?.value?.[0];
    return !!status && !status.err && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized");
  }

  /**
   * Moves every armed token account of this wallet into its vault. Each transaction is its own step in the
   * answer, with its signature, so that the owner can be shown exactly what was moved and what was not.
   * `perTransaction`: how many accounts ride in one transaction (three unless said). One that the token
   * refuses fails every account beside it, so whatever a first try leaves behind is sent again one by one.
   */
  async rescue(owner: string, opts: { perTransaction?: number } = {}): Promise<RescueResult> {
    const standing = await this.standing(owner);
    if (!standing.ok) return standing;
    const ownerKey = new PublicKey(owner), vault = new PublicKey(standing.config.vault);
    const armed = planRescue(await holdingsOf(this.rpc, owner), ownerKey, vault);
    // only into token accounts the vault already has: this key pays for a transaction, never for an account
    const there = armed.length ? await vaultAccountsThere(this.rpc, vault, armed) : new Set<string>();
    const plan = armed.filter((h) => there.has(h.address));
    if (plan.length === 0) return { ok: true, vault: standing.config.vault, steps: [] };
    const blockhash: string = (await this.rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]))?.value?.blockhash;
    const batches = rescueInstructions(plan, { rescuer: this.signer.publicKey, owner: ownerKey, vault, viaSet: standing.viaSet, microLamportsPerUnit: this.opts.microLamportsPerUnit, ...(opts.perTransaction ? { perTransaction: opts.perTransaction } : {}) });
    // all of them at once: a rescue is a race, and each transaction stands on its own
    const steps = await Promise.all(batches.map(async (instructions): Promise<RescueStep> => {
      const accounts = instructions.slice(2).map((ix) => ix.keys[6]!.pubkey.toBase58());
      try {
        const signature = await this.send(instructions, blockhash);
        if (this.sent.size >= 2000) this.sent.clear();
        this.sent.add(signature);
        return { accounts, signature, ...(await this.confirmed(signature)) };
      } catch (e) {
        return { accounts, signature: null, ok: false, why: String((e as Error).message ?? e).slice(0, 200) };
      }
    }));
    return { ok: true, vault: standing.config.vault, steps };
  }
}
