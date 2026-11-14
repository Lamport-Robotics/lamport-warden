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
import { PROGRAM, approveForRescue, closeConfig, configAddress, createVaultTokenAccount, delegateAddress, initConfig, planRescue, rescuerSetAddress, type Holding } from "./program.js";
import { MOST_RESCUED_AT_ONCE, holdingsOf, readConfig, readRescuerSet, vaultAccountsThere, type Config, type Rescuer } from "./rescuer.js";
import type { Rpc } from "./rpc.js";
import type { SignalKind } from "./signals.js";
import { disarmingNow, type MemoryStore, type StoredEvent } from "./store.js";

/** The Lamport Vault program whose vaults a rescue may go to: the one the rescue program itself pins. */
export const LAMPORT_VAULT_PROGRAM = "B7dNdVV8shrKgqx7A5JvBQBp7vsTyQTLrdAdeiLKwXqH";
const VAULT_MARK = [211, 8, 232, 43, 2, 152, 117, 119], TOMBSTONE_MARK = [45, 187, 252, 155, 232, 114, 36, 22];
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** How many token accounts are set up in one go, and how many approvals ride in one transaction. */
export const MOST_ARMED_AT_ONCE = 40;
const APPROVALS_PER_TRANSACTION = 6;
/** How many of the vault's token accounts are made in one transaction. */
const CREATES_PER_TRANSACTION = 8;
/** How soon after one rescue of a wallet another may be asked for. */
export const RESCUE_AGAIN_SECONDS = 60;
/** How many times a rescue is sent in all: once, and once more, one account to a transaction, for whatever the first left behind. */
export const RESCUE_TRIES = 2;
/** How long what the owner asked for on the page is taken for theirs by the watcher, while the chain catches up. */
export const CHANGE_SECONDS = 30 * 60;
/**
 * How many token accounts Sentinel moves for one profile in a day, at its own cost: three full rescues. A
 * rescue costs the key that sends it a fee for each transaction, and whoever is signed in can ask for one,
 * so there is an end to what a profile can make that key spend.
 */
export const MOST_RESCUED_A_DAY = 3 * MOST_RESCUED_AT_ONCE;
export const SPENT_TODAY = "Sentinel has sent as many rescues for this profile today as it pays for. The wallet's own key can still rescue it.";
/** What the key that rescues has to hold, in lamports, to be counted on: the fees of a few full rescues. */
export const RESCUER_NEEDS_LAMPORTS = 5_000_000;
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
  /** There is a setup on the chain. */
  armed: boolean;
  /**
   * That setup names the vault this profile asked for on the Sentinel page. Only then does Sentinel act on
   * it: a setup made anywhere else is shown, can be taken away, and is not rescued into.
   */
  ours: boolean;
  vault: string | null;
  /** Who may trigger it besides the owner: Lamport's keys, or one key of the owner's own (then Sentinel can only alert). */
  rescuers: "lamport" | "own" | null;
  /** Token accounts a rescue would move now. */
  covered: TokenView[];
  /**
   * Token accounts that hold something and would be left where they are, and why. `other`: somebody else
   * holds a permission to spend from it now (a marketplace it is listed on, say), which a setup would replace.
   */
  uncovered: (TokenView & { why: "not set up" | "frozen" | "cannot be moved"; other?: string })[];
}

const view = (h: Holding): TokenView => ({ account: h.address, mint: h.mint, amount: h.amount.toString(), decimals: h.decimals });
const revoke = (source: PublicKey, owner: PublicKey, tokenProgram: PublicKey) => new TransactionInstruction({ programId: tokenProgram, data: Buffer.from([5]), keys: [{ pubkey: source, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }] });

/**
 * What a rescue did, in a sentence. `moved`: token accounts whose transaction is on the chain. `failed`: ones
 * that could not be moved and still hold their tokens. `gone`: ones that were empty by the time the rescue
 * reached them, which nothing of Sentinel's emptied: in a theft, those are what the thief got to first.
 */
export const rescuedSentence = (moved: number, failed: number, vault: string, gone = 0): string =>
  (moved > 0
    ? `Sentinel moved ${moved} of this wallet's token account${moved === 1 ? "" : "s"} into your Lamport Vault (${vault.slice(0, 4)}..${vault.slice(-4)}).`
    : "Sentinel tried to rescue this wallet and moved nothing.")
  + (failed > 0 ? ` ${failed} could not be moved and ${failed === 1 ? "is" : "are"} still in the wallet.` : "")
  + (gone > 0 ? ` ${gone} ${gone === 1 ? "was" : "were"} emptied by something else before the rescue reached ${gone === 1 ? "it" : "them"}: Sentinel did not move what was in ${gone === 1 ? "it" : "them"}.` : "")
  + (moved > 0 ? " Only your vault's key can move what is there now." : "")
  + " SOL is not moved by a rescue.";

const short = (a: string) => `${a.slice(0, 4)}..${a.slice(-4)}`;

export class Rescue {
  private last = new Map<string, number>();
  private busy = new Set<string>();
  private there: { ok: boolean; at: number } | null = null;
  private net: string | null = null;
  /** What the last look at the key that rescues found: false when it cannot be counted on. Null until it was looked at. */
  private keyOk: boolean | null = null;
  /** How many accounts were sent for each profile, and on which day. */
  private spent = new Map<string, { day: number; accounts: number }>();
  constructor(
    private rpc: Rpc, private rescuer: (Pick<Rescuer, "rescue"> & { address?: string; landed?: Rescuer["landed"] }) | null, private accounts: Accounts, private store: MemoryStore,
    private opts: { now?: () => number; notify?: (wallet: string, sentence: string) => Promise<unknown>; notice?: (profile: string, sentence: string) => Promise<void>; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  private now(): number { return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000); }
  /**
   * True when the service can carry a rescue out: it holds a key, and the last look at that key found it
   * among Lamport's rescuers with something to pay with. Without that it can show how a wallet stands and
   * build a setup, and nothing more.
   */
  get on(): boolean { return this.rescuer !== null && this.keyOk !== false; }

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
    const amongRescuers = !!set && set.owner === PROGRAM.toBase58() && (readRescuerSet(set.data) ?? []).includes(address);
    this.keyOk = amongRescuers && lamports >= RESCUER_NEEDS_LAMPORTS;
    return { lamports, amongRescuers };
  }

  /** Puts an Urgent alert about a wallet's rescue on record, and tells its owner. */
  private alert(wallet: string, kind: SignalKind, sentence: string): void {
    const event: StoredEvent = { wallet, signature: "", slot: 0, at: this.now(), level: "urgent", signals: [kind], sentence, rescueWorthy: false };
    this.store.addEvent(event);
    void Promise.resolve(this.opts.notify?.(wallet, sentence)).then((sent) => { if ((sent as { delivered?: number } | undefined)?.delivered === 0 && event.id) this.store.markUndelivered(event.id); }).catch(() => undefined);
  }

  /**
   * Notes how a wallet stands on the chain, and tells its owner when that changed: a setup made or taken away
   * is not something that should happen unnoticed.
   *
   * A setup is Sentinel's to use only when it names the vault that was asked for on the Sentinel page. The
   * watcher is then told which address the wallet approved for rescue, and which vault a rescue goes to. A
   * setup that names any other vault was made somewhere else, by whoever had the wallet sign it: it is said,
   * loudly, and nothing is excused or moved on its account.
   */
  private note(wallet: string, config: Config | null): void {
    const w = this.store.wallets().find((x) => x.address === wallet);
    if (!w) return;
    const profile = this.accounts.profileOf(wallet);
    if (config && w.rescueWanted === config.vault) {
      this.store.setForeign(wallet, null);
      const delegate = delegateAddress(new PublicKey(wallet), new PublicKey(config.vault)).toBase58();
      if (this.store.setDelegate(wallet, delegate, config.vault) && profile) void this.opts.notice?.(profile, `The wallet ${short(wallet)} is set up for rescue into the Lamport Vault ${short(config.vault)}. If that was not you, or that is not your vault, someone else has the key to that wallet.`).catch(() => undefined);
      return;
    }
    const asked = disarmingNow(w, this.now());
    if (config) {
      // what was Sentinel's is not any more, and the new setup is nobody's that asked here
      this.store.setDelegate(wallet, null);
      if (this.store.setForeign(wallet, config.vault)) this.alert(wallet, "rescue_foreign", `This wallet has been set up for rescue into the Lamport Vault ${short(config.vault)}, and not from the Sentinel page. Whoever had it sign that can have its tokens moved into that vault. If the vault is not yours, treat this wallet's key as stolen and move what is left to a new wallet. If it is yours, set the wallet up for it on the Sentinel page, and Sentinel will use it.`);
      return;
    }
    this.store.setForeign(wallet, null);
    const was = this.store.setDelegate(wallet, null);
    if (asked) this.store.wantRescue(wallet, null);
    if (!was || !profile) return;
    if (asked) { void this.opts.notice?.(profile, `The wallet ${short(wallet)} is no longer set up for rescue. If that was not you, someone else has the key to that wallet.`).catch(() => undefined); return; }
    // Closed, and not from the Sentinel page: only the wallet's own key can do that, and nothing can rescue the
    // wallet from here on. For a thief it is the move that comes before the rest. An alert, not a notice.
    this.alert(wallet, "rescue_closed", "This wallet's rescue setup was closed, and not from the Sentinel page. Nothing can rescue it now. If that was not you, someone else has this wallet's key: move what is left to a new wallet.");
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
      for (const [j, wallet] of some.entries()) {
        const a = res.value[j];
        const raw = a?.data?.[0];
        const read = a && typeof raw === "string" && String(a.owner) === PROGRAM.toBase58() ? readConfig(Uint8Array.from(Buffer.from(raw, "base64"))) : null;
        let config = read && read.owner === wallet ? read : null;
        // A setup that was there and is not in this answer: asked once more, of that wallet alone, before anyone
        // is told that it is gone. One wrong answer from an RPC must not send an owner an Urgent alert.
        if (!config && this.store.wallets().find((w) => w.address === wallet)?.sentinelDelegate) {
          try { config = await this.config(wallet); } catch { continue; }
        }
        this.note(wallet, config);
      }
    }
  }

  private async account(address: string): Promise<{ owner: string; data: Uint8Array } | null> {
    const res = await this.rpc.call("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
    // an answer without a value field is no answer: only a null there says the account is not on the chain
    if (!res || !("value" in res)) throw new Error("the account could not be read");
    const raw = res.value?.data?.[0];
    return res.value && typeof raw === "string" ? { owner: String(res.value.owner), data: Uint8Array.from(Buffer.from(raw, "base64")) } : null;
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
    // what a rescue would move: approved for this vault, movable, and with a token account waiting for it in the vault
    const approved = config ? planRescue(holdings, owner, new PublicKey(config.vault)) : [];
    const there = config && approved.length ? await vaultAccountsThere(this.rpc, new PublicKey(config.vault), approved) : new Set<string>();
    const planned = new Set(approved.filter((h) => there.has(h.address)).map((h) => h.address));
    const delegate = config ? delegateAddress(owner, new PublicKey(config.vault)).toBase58() : null;
    this.note(wallet, config);
    return {
      armed: !!config, ours: !!config && this.store.wallets().find((w) => w.address === wallet)?.rescueWanted === config.vault,
      vault: config?.vault ?? null, rescuers: config ? config.rescuers.kind : null,
      covered: holdings.filter((h) => planned.has(h.address)).map(view),
      uncovered: holdings.filter((h) => h.amount > 0n && !planned.has(h.address)).map((h) => ({
        ...view(h), why: h.frozen ? "frozen" as const : h.unmovable ? "cannot be moved" as const : "not set up" as const,
        ...(h.delegate && h.delegate !== delegate && h.delegatedAmount > 0n ? { other: h.delegate } : {}),
      })),
    };
  }

  private async transactions(payer: PublicKey, instructions: TransactionInstruction[], first: TransactionInstruction[] = [], per = APPROVALS_PER_TRANSACTION): Promise<string[]> {
    if (instructions.length === 0 && first.length === 0) return [];
    const blockhash = String((await this.rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]))?.value?.blockhash);
    const out: string[] = [];
    const batches: TransactionInstruction[][] = [];
    for (let i = 0; i < instructions.length; i += per) batches.push(instructions.slice(i, i + per));
    if (first.length > 0) { if (batches.length === 0) batches.push([]); batches[0] = [...first, ...batches[0]!]; }
    for (const batch of batches) out.push(Buffer.from(new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(...batch).serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64"));
    return out;
  }

  /**
   * The transactions that set a wallet up for rescue into `vault`, unsigned, for the owner's wallet to sign.
   * First the vault's own token account for each token, where the vault has none (the owner pays for those,
   * so that the key that rescues never does); then the config naming the vault when there is none yet, and
   * an approval for each token account that holds something and is not set up, the biggest first. Nothing in
   * them moves a token.
   *
   * `only`: the token accounts to set up, when the owner chose them. A wallet collects tokens nobody asked
   * for, and each one set up costs a deposit and is one more thing a rescue has to carry: the page has the
   * owner pick. Without it, every account that can be moved is set up.
   *
   * Asking is also how a profile says which vault it wants: from here on a setup naming this vault is
   * Sentinel's to use (see `note`). `asked`: true when this asking is news, for whoever tells the owner.
   */
  async arm(profile: string, wallet: unknown, vault: unknown, only?: unknown): Promise<{ ok: true; transactions: string[]; accounts: number; /** How many token accounts it makes in the vault. */ makes: number; vault: string; delegate: string; asked: boolean } | Refusal> {
    const may = this.may(profile, wallet);
    if (!may.ok) return may;
    if (typeof vault !== "string" || !ADDRESS.test(vault)) return no(400, "that is not an address.");
    if (only !== undefined && (!Array.isArray(only) || only.length > MOST_ARMED_AT_ONCE || only.some((a) => typeof a !== "string" || !ADDRESS.test(a)))) return no(400, "name the token accounts to set up, forty at most.");
    const chosen = only === undefined ? null : new Set(only as string[]);
    if (!(await this.available())) return no(501, NOT_ON_CHAIN);
    if (vault === may.wallet) return no(400, "that is the wallet itself. A rescue goes into a Lamport Vault, which has its own address.");
    try {
      const checked = checkVault(vault, await this.account(vault));
      if (!checked.ok) return no(400, checked.why);
      const config = await this.config(may.wallet);
      if (config && config.vault !== vault) return no(409, `this wallet is already set up for another vault (${short(config.vault)}). Take that setup away first, then set it up for the other.`);
      const owner = new PublicKey(may.wallet), to = new PublicKey(vault);
      const delegate = delegateAddress(owner, to).toBase58();
      // what could be rescued at all: it holds something, is not frozen, and is of a token a plain transfer moves
      const movable = (await holdingsOf(this.rpc, may.wallet)).filter((h) => h.amount > 0n && !h.frozen && !h.unmovable && (!chosen || chosen.has(h.address)));
      const there = movable.length ? await vaultAccountsThere(this.rpc, to, movable) : new Set<string>();
      const isApproved = (h: Holding) => h.delegate === delegate && h.delegatedAmount > 0n;
      const todo = movable.filter((h) => !isApproved(h) || !there.has(h.address))
        .sort((a, b) => Number(b.amount) / 10 ** b.decimals - Number(a.amount) / 10 ** a.decimals).slice(0, MOST_ARMED_AT_ONCE);
      // two token accounts of one mint share the vault's one account for it
      const mints = new Map(todo.filter((h) => !there.has(h.address)).map((h) => [`${h.tokenProgram}:${h.mint}`, h]));
      const creates = [...mints.values()].map((h) => createVaultTokenAccount(owner, to, new PublicKey(h.mint), new PublicKey(h.tokenProgram)));
      const approvals = todo.filter((h) => !isApproved(h)).map((h) => approveForRescue({ owner, source: new PublicKey(h.address), mint: new PublicKey(h.mint), decimals: h.decimals, vault: to, tokenProgram: new PublicKey(h.tokenProgram) }));
      // Each kind in transactions of its own. Warden reads a setup by its exact shape (src/sentinel.ts): the
      // config with approvals and nothing else beside it, and approvals alone.
      const transactions = [...(await this.transactions(owner, creates, [], CREATES_PER_TRANSACTION)), ...(await this.transactions(owner, approvals, config ? [] : [initConfig(owner, to)]))];
      const news = this.store.wallets().find((w) => w.address === may.wallet)?.rescueWanted !== vault;
      this.store.wantRescue(may.wallet, vault);
      // for the next half hour the watcher takes approvals to this address for the setup asked for here
      const expected = !config || approvals.length > 0 ? this.store.expectRescueChange(may.wallet, delegate, this.now() + CHANGE_SECONDS, vault, this.now()) : false;
      // a setup that names this vault and was nobody's until now is this profile's from here on
      if (config) this.note(may.wallet, config);
      return { ok: true, transactions, accounts: todo.length, makes: creates.length, vault, delegate, asked: news || expected };
    } catch { return no(502, "the chain could not be read just now. Try again in a minute."); }
  }

  /**
   * The transactions that take the setup away: every approval given for rescue is revoked, and then the
   * config is closed, in a transaction of its own. (Warden reads Sentinel's requests by their exact shape and
   * passes a closing only when nothing else is beside it: src/sentinel.ts.) A frozen account's permission
   * cannot be revoked by anyone, and is left: once the setup is closed nothing can use it. `frozen` says how many.
   */
  async disarm(profile: string, wallet: unknown): Promise<{ ok: true; transactions: string[]; frozen: number; asked: boolean } | Refusal> {
    const p = this.accounts.profile(profile);
    if (!p) return no(401, "sign in again.");
    // taking it away is not kept behind the plan: an owner can always undo what they set up
    if (typeof wallet !== "string" || !ADDRESS.test(wallet) || !this.accounts.walletsOf(profile).includes(wallet)) return no(404, "that wallet is not in this profile.");
    try {
      const config = await this.config(wallet);
      if (!config) return no(409, "this wallet is not set up for rescue.");
      const owner = new PublicKey(wallet);
      const delegate = delegateAddress(owner, new PublicKey(config.vault)).toBase58();
      const given = (await holdingsOf(this.rpc, wallet)).filter((h) => h.delegate === delegate);
      const revokes = given.filter((h) => !h.frozen).map((h) => revoke(new PublicKey(h.address), owner, new PublicKey(h.tokenProgram)));
      const txs = [...(await this.transactions(owner, revokes)), ...(await this.transactions(owner, [closeConfig(owner)]))];
      // and the permissions going, for the next half hour, for the owner's own doing
      const asked = this.store.expectRescueChange(wallet, null, this.now() + CHANGE_SECONDS, undefined, this.now());
      return { ok: true, transactions: txs, frozen: given.length - revokes.length, asked };
    } catch { return no(502, "the chain could not be read just now. Try again in a minute."); }
  }

  /** How many accounts Sentinel will still send for this profile today. */
  private left(profile: string): number {
    const spent = this.spent.get(profile);
    return MOST_RESCUED_A_DAY - (spent && spent.day === Math.floor(this.now() / 86_400) ? spent.accounts : 0);
  }

  /**
   * A rescue, now. Whoever is signed in to the profile may ask: the worst that asking can do is put the
   * owner's tokens in the owner's vault. Only into the vault that was asked for on the Sentinel page: a setup
   * on the chain that names another is not acted on. What was moved is put on record and said on the
   * profile's channels.
   */
  async rescue(profile: string, wallet: unknown, by: "owner" | "sentinel" = "owner"): Promise<{ ok: true; vault: string; moved: number; failed: number; gone: number; signatures: string[] } | Refusal> {
    const may = this.may(profile, wallet);
    if (!may.ok) return may;
    if (!this.rescuer) return no(501, "rescue is not switched on here.");
    if (!(await this.available())) return no(501, NOT_ON_CHAIN);
    const wanted = this.store.wallets().find((w) => w.address === may.wallet)?.rescueWanted;
    if (!wanted) return no(409, "this wallet was not set up for rescue on the Sentinel page. Set it up here first: Sentinel rescues only into a vault that was named here.");
    const now = this.now();
    // One at a time for a wallet, and not again within a minute of one that went through. One that did not go
    // through (the chain could not be reached, the program refused) can be asked for again at once: the minute
    // is there to stop the same rescue being sent twice, not to make an owner wait in an emergency.
    if (this.busy.has(may.wallet)) return no(429, "a rescue of this wallet is under way.");
    if (now - (this.last.get(may.wallet) ?? -Infinity) < RESCUE_AGAIN_SECONDS) return no(429, "a rescue of this wallet was asked for a moment ago. Give it a minute.");
    if (this.left(profile) <= 0) return no(429, SPENT_TODAY);
    this.busy.add(may.wallet);
    try {
      const tried = new Set<string>(), moved = new Set<string>(), signatures: string[] = [];
      const unsure: { signature: string; accounts: string[] }[] = [];
      let vault = "", sent = 0;
      // Sent, and whatever that leaves behind is sent once more, one account to a transaction: a token that
      // refuses to move fails every account riding beside it, and must not be able to hold the others back.
      // Each try plans from the chain as it then is.
      for (let attempt = 0; attempt < RESCUE_TRIES; attempt++) {
        const most = Math.min(MOST_RESCUED_AT_ONCE, this.left(profile) - sent);
        if (most <= 0) break;
        let result: Awaited<ReturnType<Rescuer["rescue"]>>;
        try { result = await this.rescuer.rescue(may.wallet, { vault: wanted, most, ...(attempt === 0 ? {} : { perTransaction: 1 }) }); } catch { if (attempt === 0) return no(502, "the chain could not be reached, so nothing was moved. Try again."); break; }
        if (!result.ok) { if (attempt === 0) return no(409, result.why); break; }
        vault = result.vault;
        let failed = 0;
        for (const s of result.steps) {
          sent += s.accounts.length;
          for (const a of s.accounts) tried.add(a);
          if (s.ok) { for (const a of s.accounts) moved.add(a); if (s.signature && !signatures.includes(s.signature)) signatures.push(s.signature); }
          else { failed += s.accounts.length; if (s.signature) unsure.push({ signature: s.signature, accounts: s.accounts }); }
        }
        if (failed === 0) break;
      }
      const day = Math.floor(now / 86_400), before = this.spent.get(profile);
      this.spent.set(profile, { day, accounts: (before && before.day === day ? before.accounts : 0) + sent });
      // A transaction that was given up on can have landed all the same: the chain is asked, and only its
      // word makes an account one that was moved.
      for (const u of unsure) {
        if (u.accounts.every((a) => moved.has(a))) continue;
        const landed = await Promise.resolve(this.rescuer.landed?.(u.signature)).catch(() => false);
        if (landed) { for (const a of u.accounts) moved.add(a); if (!signatures.includes(u.signature)) signatures.push(u.signature); }
      }
      // Of the rest, what still holds its tokens could not be moved. What is empty was emptied by something
      // else first, and is said as that: in a theft, an empty account is not a rescued one.
      const rest = [...tried].filter((a) => !moved.has(a));
      let holding = new Set(rest);
      if (rest.length > 0) {
        try { holding = new Set((await holdingsOf(this.rpc, may.wallet)).filter((h) => h.amount > 0n).map((h) => h.address)); } catch { /* then all of the rest is said to be still there, which is the careful reading */ }
      }
      const failed = rest.filter((a) => holding.has(a)).length, gone = rest.length - failed;
      // the minute before another runs from a rescue that did what it could; one that left something behind can be asked for again at once
      if (moved.size > 0 && failed === 0) this.last.set(may.wallet, now);
      if (tried.size > 0) {
        const sentence = `${by === "sentinel" ? "An alert about this wallet set off a rescue. " : ""}${rescuedSentence(moved.size, failed, vault, gone)}`;
        const event: StoredEvent = { wallet: may.wallet, signature: signatures[0] ?? "", slot: 0, at: now, level: "urgent", signals: ["rescued"], sentence, rescueWorthy: false, ...(signatures.length > 1 ? { also: signatures.slice(1) } : {}) };
        this.store.addEvent(event);
        const told = await this.opts.notify?.(may.wallet, sentence).catch(() => null) as { delivered?: number } | null | undefined;
        if (told && told.delivered === 0 && event.id) this.store.markUndelivered(event.id);
      }
      return { ok: true, vault, moved: moved.size, failed, gone, signatures };
    } finally { this.busy.delete(may.wallet); }
  }

  /**
   * After an alert that is reason enough on its own (a hard signal, Urgent by the table): rescue the wallet
   * without being asked, when its owner switched that on and the plan has it. A chain that cannot be reached
   * is tried twice more, a few seconds apart. A rescue that then still cannot be carried out is said, at
   * once: an owner who switched this on is counting on it, and must not find out later that nothing happened.
   */
  async after(event: StoredEvent): Promise<boolean> {
    if (!event.rescueWorthy || !this.rescuer) return false;
    const profile = this.accounts.profileOf(event.wallet);
    const p = profile ? this.accounts.profile(profile) : undefined;
    if (!profile || !p?.autoRescue || !PLANS[p.tier].rescue) return false;
    // only a wallet known to be set up, for the vault asked for here: an alert about any other costs the chain nothing
    const w = this.store.wallets().find((x) => x.address === event.wallet);
    if (!w?.sentinelDelegate || !w.rescueWanted) return false;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let why = "";
    for (const wait of [0, 2000, 5000]) {
      if (wait) await sleep(wait);
      const r = await this.rescue(profile, event.wallet, "sentinel");
      if (r.ok) return true;
      // one is under way, or has just been: this alert needs no rescue of its own
      if (r.status === 429 && r.why !== SPENT_TODAY) return false;
      why = r.status === 502 ? "the chain could not be reached." : r.why;
      if (r.status !== 502) break;
    }
    this.alert(event.wallet, "rescue_failed", `An alert about this wallet set off a rescue, and it could not be carried out: ${why} Press Rescue now on the Sentinel page, or move what is left yourself.`);
    return false;
  }

  /**
   * After a restart: an alert of the last ten minutes that was reason for a rescue, with no rescue (and no
   * word of a failed one) on record after it, is acted on now. A service that went down between raising an
   * alert and rescuing would otherwise have told the owner and done nothing.
   */
  async resume(within = 600): Promise<number> {
    const now = this.now();
    let n = 0;
    for (const w of this.store.wallets()) {
      const events = this.store.events(w.address);
      const latest = events.filter((e) => e.rescueWorthy && (e.at ?? 0) >= now - within).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
      if (!latest) continue;
      if (events.some((e) => (e.signals.includes("rescued") || e.signals.includes("rescue_failed")) && (e.at ?? 0) >= (latest.at ?? 0))) continue;
      if (await this.after(latest).catch(() => false)) n += 1;
    }
    return n;
  }
}
