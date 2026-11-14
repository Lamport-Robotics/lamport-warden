/**
 * Rescue, as the service offers it: setting a wallet up for it, and carrying one out.
 *
 * Setting up ("arming") is the owner's doing and happens on the chain: one instruction that names the
 * owner's Lamport Vault, and for each token account an approval of the one address the rescue program can
 * sign for. The service builds those transactions; the owner's wallet signs them; nothing is armed because
 * the service says so. What is armed is read back from the chain every time.
 *
 * A rescue moves every armed token account of a wallet into that owner's vault, and nowhere else: where it
 * goes is not something the service, or its key, can choose (sentinel/program). So what whoever holds the
 * service's rescuer key can do to an owner is move their tokens to their own vault sooner than they wanted.
 *
 * Nothing here runs unless the service was given a rescuer key, and the rescue program and the vault
 * program are on the chain it reads.
 */
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { Accounts } from "./accounts.js";
import { PLANS } from "./plans.js";
import { PROGRAM, approveForRescue, closeConfig, configAddress, delegateAddress, initConfig, planRescue, rescuerSetAddress, type Holding } from "./program.js";
import { holdingsOf, readConfig, readRescuerSet, type Config, type Rescuer } from "./rescuer.js";
import type { Rpc } from "./rpc.js";
import type { MemoryStore, StoredEvent } from "./store.js";

/** The Lamport Vault program whose vaults a rescue may go to: the one the rescue program itself pins. */
export const LAMPORT_VAULT_PROGRAM = "B7dNdVV8shrKgqx7A5JvBQBp7vsTyQTLrdAdeiLKwXqH";
const VAULT_MARK = [211, 8, 232, 43, 2, 152, 117, 119], TOMBSTONE_MARK = [45, 187, 252, 155, 232, 114, 36, 22];
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** How many token accounts are set up in one go, and how many approvals ride in one transaction. */
export const MOST_ARMED_AT_ONCE = 40;
const APPROVALS_PER_TRANSACTION = 6;
/** How soon after one rescue of a wallet another may be asked for. */
export const RESCUE_AGAIN_SECONDS = 60;
/** How long what the owner asked for on the page is taken for theirs by the watcher, while the chain catches up. */
export const CHANGE_SECONDS = 30 * 60;
/** What the page is told while rescue cannot work on the chain the service reads. */
export const NOT_ON_CHAIN = "rescue is not available yet: Lamport Vault and the rescue program are not on this network.";

export type Refusal = { ok: false; status: number; why: string };
const no = (status: number, why: string): Refusal => ({ ok: false, status, why });

/**
 * Whether an account is a live Lamport Vault at its own address: the same four things the rescue program
 * checks, so that nobody is asked to sign a setup the program would refuse.
 */
export function checkVault(address: string, account: { owner: string; data: Uint8Array } | null): { ok: true } | { ok: false; why: string } {
  if (!account) return { ok: false, why: "there is no account at that address. A vault's address is shown in Lamport Vault." };
  const head = [...account.data.subarray(0, 8)];
  if (account.owner !== LAMPORT_VAULT_PROGRAM) return { ok: false, why: "that address is not a Lamport Vault." };
  if (head.join() === TOMBSTONE_MARK.join()) return { ok: false, why: "that vault was closed. A closed vault cannot be rescued into." };
  if (account.data.length < 42 || head.join() !== VAULT_MARK.join()) return { ok: false, why: "that address is not a Lamport Vault." };
  if (account.data[8] !== 2) return { ok: false, why: "that vault is of a kind this cannot rescue into yet." };
  try {
    const expected = PublicKey.createProgramAddressSync([Buffer.from("vault"), account.data.subarray(10, 42), account.data.subarray(9, 10)], new PublicKey(LAMPORT_VAULT_PROGRAM));
    if (expected.toBase58() !== address) return { ok: false, why: "that address is not a Lamport Vault." };
  } catch { return { ok: false, why: "that address is not a Lamport Vault." }; }
  return { ok: true };
}

export interface TokenView { account: string; mint: string; amount: string; decimals: number }
/** How one wallet stands, as the chain has it now. */
export interface WalletRescue {
  armed: boolean;
  vault: string | null;
  /** Who may trigger it besides the owner: Lamport's keys, or one key of the owner's own (then Sentinel can only alert). */
  rescuers: "lamport" | "own" | null;
  /** Token accounts a rescue would move now. */
  covered: TokenView[];
  /** Token accounts that hold something and would be left where they are, and why. */
  uncovered: (TokenView & { why: "not set up" | "frozen" })[];
}

const view = (h: Holding): TokenView => ({ account: h.address, mint: h.mint, amount: h.amount.toString(), decimals: h.decimals });
const revoke = (source: PublicKey, owner: PublicKey, tokenProgram: PublicKey) => new TransactionInstruction({ programId: tokenProgram, data: Buffer.from([5]), keys: [{ pubkey: source, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }] });

export const rescuedSentence = (moved: number, failed: number, vault: string): string =>
  `Sentinel moved ${moved} of this wallet's token account${moved === 1 ? "" : "s"} into your Lamport Vault (${vault.slice(0, 4)}..${vault.slice(-4)}).${failed > 0 ? ` ${failed} could not be moved and ${failed === 1 ? "is" : "are"} still in the wallet.` : ""} Only your vault's key can move what is there now. SOL is not moved by a rescue.`;

export class Rescue {
  private last = new Map<string, number>();
  private there: { ok: boolean; at: number } | null = null;
  private net: string | null = null;
  constructor(
    private rpc: Rpc, private rescuer: (Pick<Rescuer, "rescue"> & { address?: string }) | null, private accounts: Accounts, private store: MemoryStore,
    private opts: { now?: () => number; notify?: (wallet: string, sentence: string) => Promise<unknown>; notice?: (profile: string, sentence: string) => Promise<void> } = {},
  ) {}

  private now(): number { return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000); }
  /** True when the service holds a key to rescue with: without one it can show how a wallet stands and nothing more. */
  get on(): boolean { return this.rescuer !== null; }

  /**
   * Whether rescue can work on the chain this reads: the rescue program and the vault program are both
   * there. Looked up again every ten minutes while they are not, and every hour once they are.
   */
  async available(): Promise<boolean> {
    const now = this.now();
    if (this.there && now - this.there.at < (this.there.ok ? 3600 : 600)) return this.there.ok;
    try {
      const res = await this.rpc.call("getMultipleAccounts", [[PROGRAM.toBase58(), LAMPORT_VAULT_PROGRAM], { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }]);
      this.there = { ok: Array.isArray(res?.value) && res.value.length === 2 && res.value.every((a: any) => a?.executable === true), at: now };
    } catch { return this.there?.ok ?? false; }
    return this.there.ok;
  }

  /** The network this reads, as a wallet is told it when it is handed a transaction: asked of the chain once. */
  async network(): Promise<string> {
    if (this.net) return this.net;
    const genesis = String(await this.rpc.call("getGenesisHash", []).catch(() => ""));
    const known: Record<string, string> = { "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "solana:mainnet", EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "solana:devnet", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "solana:testnet" };
    if (genesis === "") return "solana:mainnet";
    return (this.net = known[genesis] ?? "solana:localnet");
  }

  /** How the key this rescues with stands: what it holds, and whether it is among Lamport's rescuers. Null without a key. */
  async keyStanding(): Promise<{ lamports: number; amongRescuers: boolean } | null> {
    const address = this.rescuer?.address;
    if (!address) return null;
    const lamports = Number((await this.rpc.call("getBalance", [address, { commitment: "confirmed" }], { background: true }))?.value ?? 0);
    const set = await this.account(rescuerSetAddress().toBase58());
    return { lamports, amongRescuers: !!set && set.owner === PROGRAM.toBase58() && (readRescuerSet(set.data) ?? []).includes(address) };
  }

  /**
   * Notes how a wallet stands: the watcher is told which address, if any, this wallet has approved for
   * rescue, so that it takes a rescue for a rescue; and the profile's channels are told when that changes,
   * because setting a wallet up, or taking the setup away, is not something that should happen unnoticed.
   */
  private note(wallet: string, config: Config | null): void {
    const delegate = config ? delegateAddress(new PublicKey(wallet), new PublicKey(config.vault)).toBase58() : null;
    if (!this.store.setDelegate(wallet, delegate)) return;
    const profile = this.accounts.profileOf(wallet);
    if (profile) void this.opts.notice?.(profile, config
      ? `The wallet ${wallet.slice(0, 4)}..${wallet.slice(-4)} is set up for rescue into the Lamport Vault ${config.vault.slice(0, 4)}..${config.vault.slice(-4)}. If that was not you, or that is not your vault, someone else has the key to that wallet.`
      : `The wallet ${wallet.slice(0, 4)}..${wallet.slice(-4)} is no longer set up for rescue. If that was not you, someone else has the key to that wallet.`).catch(() => undefined);
  }

  /**
   * Brings what is on record in step with the chain for these wallets, a hundred to a call: which of them
   * are set up for rescue, and for which vault. Run now and then for every watched wallet, so that a setup
   * made or taken away anywhere (not only on the Sentinel page) is noticed and its owner told.
   */
  async sync(wallets: string[]): Promise<void> {
    for (let i = 0; i < wallets.length; i += 100) {
      const some = wallets.slice(i, i + 100);
      const res = await this.rpc.call("getMultipleAccounts", [some.map((w) => configAddress(new PublicKey(w)).toBase58()), { encoding: "base64", commitment: "confirmed" }], { background: true });
      // an answer that is not one account for each address says nothing about any of them
      if (!Array.isArray(res?.value) || res.value.length !== some.length) continue;
      some.forEach((wallet, j) => {
        const a = res.value[j];
        const raw = a?.data?.[0];
        const config = a && typeof raw === "string" && String(a.owner) === PROGRAM.toBase58() ? readConfig(Uint8Array.from(Buffer.from(raw, "base64"))) : null;
        this.note(wallet, config && config.owner === wallet ? config : null);
      });
    }
  }

  private async account(address: string): Promise<{ owner: string; data: Uint8Array } | null> {
    const res = await this.rpc.call("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
    const raw = res?.value?.data?.[0];
    return res?.value && typeof raw === "string" ? { owner: String(res.value.owner), data: Uint8Array.from(Buffer.from(raw, "base64")) } : null;
  }

  private async config(wallet: string): Promise<Config | null> {
    const stored = await this.account(configAddress(new PublicKey(wallet)).toBase58());
    const config = stored && stored.owner === PROGRAM.toBase58() ? readConfig(stored.data) : null;
    return config && config.owner === wallet ? config : null;
  }

  /** Whether this profile's plan has rescue, and this wallet is the profile's. */
  private may(profile: string, wallet: unknown): { ok: true; wallet: string } | Refusal {
    const p = this.accounts.profile(profile);
    if (!p) return no(401, "sign in again.");
    if (typeof wallet !== "string" || !ADDRESS.test(wallet) || !this.accounts.walletsOf(profile).includes(wallet)) return no(404, "that wallet is not in this profile.");
    if (!PLANS[p.tier].rescue) return no(403, "rescue comes with Pro.");
    return { ok: true, wallet };
  }

  /** How the wallet stands on the chain, now. What it finds is noted (see `note`). */
  async status(wallet: string): Promise<WalletRescue> {
    const config = await this.config(wallet);
    const holdings = await holdingsOf(this.rpc, wallet);
    const owner = new PublicKey(wallet);
    const planned = config ? new Set(planRescue(holdings, owner, new PublicKey(config.vault)).map((h) => h.address)) : new Set<string>();
    this.note(wallet, config);
    return {
      armed: !!config, vault: config?.vault ?? null, rescuers: config ? config.rescuers.kind : null,
      covered: holdings.filter((h) => planned.has(h.address)).map(view),
      uncovered: holdings.filter((h) => h.amount > 0n && !planned.has(h.address)).map((h) => ({ ...view(h), why: h.frozen ? "frozen" as const : "not set up" as const })),
    };
  }

  private async transactions(payer: PublicKey, instructions: TransactionInstruction[], first: TransactionInstruction[] = []): Promise<string[]> {
    const blockhash = String((await this.rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]))?.value?.blockhash);
    const out: string[] = [];
    const batches: TransactionInstruction[][] = [];
    for (let i = 0; i < instructions.length; i += APPROVALS_PER_TRANSACTION) batches.push(instructions.slice(i, i + APPROVALS_PER_TRANSACTION));
    if (first.length > 0) { if (batches.length === 0) batches.push([]); batches[0] = [...first, ...batches[0]!]; }
    for (const batch of batches) out.push(Buffer.from(new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(...batch).serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64"));
    return out;
  }

  /**
   * The transactions that set a wallet up for rescue into `vault`, unsigned, for the owner's wallet to sign:
   * the config naming the vault when there is none yet, and an approval for each token account that holds
   * something and is not set up, the biggest first. Nothing in them moves anything.
   */
  async arm(profile: string, wallet: unknown, vault: unknown): Promise<{ ok: true; transactions: string[]; accounts: number; vault: string; delegate: string } | Refusal> {
    const may = this.may(profile, wallet);
    if (!may.ok) return may;
    if (typeof vault !== "string" || !ADDRESS.test(vault)) return no(400, "that is not an address.");
    if (!(await this.available())) return no(501, NOT_ON_CHAIN);
    if (vault === may.wallet) return no(400, "that is the wallet itself. A rescue goes into a Lamport Vault, which has its own address.");
    try {
      const checked = checkVault(vault, await this.account(vault));
      if (!checked.ok) return no(400, checked.why);
      const config = await this.config(may.wallet);
      if (config && config.vault !== vault) return no(409, `this wallet is already set up for another vault (${config.vault.slice(0, 4)}..${config.vault.slice(-4)}). Take that setup away first; pointing it at another vault is a separate step with a waiting time.`);
      const owner = new PublicKey(may.wallet), to = new PublicKey(vault);
      const delegate = delegateAddress(owner, to).toBase58();
      const todo = (await holdingsOf(this.rpc, may.wallet))
        .filter((h) => h.amount > 0n && !h.frozen && !(h.delegate === delegate && h.delegatedAmount > 0n))
        .sort((a, b) => Number(b.amount) / 10 ** b.decimals - Number(a.amount) / 10 ** a.decimals).slice(0, MOST_ARMED_AT_ONCE);
      const approvals = todo.map((h) => approveForRescue({ owner, source: new PublicKey(h.address), mint: new PublicKey(h.mint), decimals: h.decimals, vault: to, tokenProgram: new PublicKey(h.tokenProgram) }));
      // for the next half hour the watcher takes approvals to this address for the setup asked for here
      if (!config || approvals.length > 0) this.store.expectRescueChange(may.wallet, delegate, this.now() + CHANGE_SECONDS);
      return { ok: true, transactions: await this.transactions(owner, approvals, config ? [] : [initConfig(owner, to)]), accounts: todo.length, vault, delegate };
    } catch { return no(502, "the chain could not be read just now. Try again in a minute."); }
  }

  /**
   * The transactions that take the setup away: every approval given for rescue is revoked, and then the
   * config is closed, in a transaction of its own. (Warden reads Sentinel's requests by their exact shape and
   * passes a closing only when nothing else is beside it: src/sentinel.ts.)
   */
  async disarm(profile: string, wallet: unknown): Promise<{ ok: true; transactions: string[] } | Refusal> {
    const p = this.accounts.profile(profile);
    if (!p) return no(401, "sign in again.");
    // taking it away is not kept behind the plan: an owner can always undo what they set up
    if (typeof wallet !== "string" || !ADDRESS.test(wallet) || !this.accounts.walletsOf(profile).includes(wallet)) return no(404, "that wallet is not in this profile.");
    try {
      const config = await this.config(wallet);
      if (!config) return no(409, "this wallet is not set up for rescue.");
      const owner = new PublicKey(wallet);
      const delegate = delegateAddress(owner, new PublicKey(config.vault)).toBase58();
      const revokes = (await holdingsOf(this.rpc, wallet)).filter((h) => h.delegate === delegate).map((h) => revoke(new PublicKey(h.address), owner, new PublicKey(h.tokenProgram)));
      const txs = [...(await this.transactions(owner, revokes)), ...(await this.transactions(owner, [closeConfig(owner)]))];
      // and the permissions going, for the next half hour, for the owner's own doing
      this.store.expectRescueChange(wallet, null, this.now() + CHANGE_SECONDS);
      return { ok: true, transactions: txs };
    } catch { return no(502, "the chain could not be read just now. Try again in a minute."); }
  }

  /**
   * A rescue, now. Whoever is signed in to the profile may ask: the worst that asking can do is put the
   * owner's tokens in the owner's vault. What was moved is put on record and said on the profile's channels.
   */
  async rescue(profile: string, wallet: unknown, by: "owner" | "sentinel" = "owner"): Promise<{ ok: true; vault: string; moved: number; failed: number; signatures: string[] } | Refusal> {
    const may = this.may(profile, wallet);
    if (!may.ok) return may;
    if (!this.rescuer) return no(501, "rescue is not switched on here.");
    if (!(await this.available())) return no(501, NOT_ON_CHAIN);
    const now = this.now();
    if (now - (this.last.get(may.wallet) ?? -Infinity) < RESCUE_AGAIN_SECONDS) return no(429, "a rescue of this wallet was asked for a moment ago. Give it a minute.");
    this.last.set(may.wallet, now);
    let result: Awaited<ReturnType<Rescuer["rescue"]>>;
    try { result = await this.rescuer.rescue(may.wallet); } catch { return no(502, "the chain could not be reached, so nothing was moved. Try again."); }
    if (!result.ok) return no(409, result.why);
    const moved = result.steps.filter((s) => s.ok).reduce((n, s) => n + s.accounts.length, 0);
    const failed = result.steps.filter((s) => !s.ok).reduce((n, s) => n + s.accounts.length, 0);
    const signatures = result.steps.flatMap((s) => (s.ok && s.signature ? [s.signature] : []));
    if (moved + failed > 0) {
      const sentence = `${by === "sentinel" ? "After the alert before this one, " : ""}${rescuedSentence(moved, failed, result.vault)}`;
      const event: StoredEvent = { wallet: may.wallet, signature: signatures[0] ?? "", slot: 0, at: now, level: "urgent", signals: ["rescued"], sentence, rescueWorthy: false };
      this.store.addEvent(event);
      const sent = await this.opts.notify?.(may.wallet, sentence).catch(() => null) as { delivered?: number } | null | undefined;
      if (sent && sent.delivered === 0 && event.id) this.store.markUndelivered(event.id);
    }
    return { ok: true, vault: result.vault, moved, failed, signatures };
  }

  /**
   * After an alert that is reason enough on its own (a hard signal, Urgent by the table): rescue the wallet
   * without being asked, when its owner switched that on and the plan has it.
   */
  async after(event: StoredEvent): Promise<boolean> {
    if (!event.rescueWorthy || !this.rescuer) return false;
    const profile = this.accounts.profileOf(event.wallet);
    const p = profile ? this.accounts.profile(profile) : undefined;
    if (!profile || !p?.autoRescue || !PLANS[p.tier].rescue) return false;
    // only a wallet known to be set up: an alert about any other costs the chain nothing
    if (!this.store.wallets().find((w) => w.address === event.wallet)?.sentinelDelegate) return false;
    return (await this.rescue(profile, event.wallet, "sentinel")).ok;
  }
}
