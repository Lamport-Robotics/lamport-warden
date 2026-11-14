/**
 * The watcher: for each wallet, read what happened since last time, run the rules, raise what they say.
 *
 * It polls. A subscription (a Helius websocket or webhook) is faster and is where this should go, but a poll
 * is what every RPC offers, is easy to reason about after an outage (the cursor says exactly what was not yet
 * read), and is enough to measure the rules against real wallets.
 *
 * It holds no key. When the rules say a rescue is warranted it says so in the event and hands the event on
 * (`onRaised`); acting on it is rescue's job (rescue.ts), with the rescuer's key.
 */
import { Baseline } from "./baseline.js";
import { fromRpc, signersOf, tokenDeltasOf, type ObservedTx } from "./observed.js";
import type { Rpc } from "./rpc.js";
import { BurstWindow, assessBehind, assessTaken, assessTokenAccount, assessTransaction, assessUnexplainedLoss, assessWalletAccount, without, type Assessment, type Level, type TokenAccountState, type WatchContext } from "./signals.js";
import { disarmingNow, rescueDelegateOf, rescueVaultOf, type Store, type StoredEvent, type WalletRecord, type WatchedWallet } from "./store.js";

/** How many of a wallet's token accounts are kept and compared. */
export const MAX_TOKEN_ACCOUNTS = 1000;
/** How many new transactions one pass reads. */
export const MOST_PER_PASS = 25;
/** How many accounts one call can ask about, and so how many of a wallet's token accounts a look takes in beside the wallet. */
export const ACCOUNTS_PER_CALL = 100;

/** How long the watcher looks for the transaction behind a fall in a token account's holding before it says it could not find one. */
export const EXPLAIN_FOR_SECONDS = 600;
/** How long a wallet may have gone unread before what its token accounts held then is no longer something to explain: it is taken as it is found. */
export const STALE_AFTER_SECONDS = 6 * 3600;
/** How many times one pass asks for a token account's own list of transactions (a page each), and how many transactions from them it reads. The rest wait for the wallet's next turn. */
export const MOST_ACCOUNT_LISTS = 5;
export const MOST_EXTRA_READS = 10;
/** How long a fall waits for the wallet's own list to be read through before the account's own list is read regardless. */
export const WAIT_FOR_OWN_SECONDS = 120;
/** How many pages, of a thousand signatures, of a token account's own list are asked for to get back to the amount on record. */
const ACCOUNT_LIST_PAGES = 3;
/** How many pages, of a thousand signatures, of a wallet's own list one pass asks for when it is far behind. The rest on its next turns. */
const OWN_LIST_PAGES = 3;
/** How far back a wallet's own list is followed at most, in pages: a cursor the RPC no longer knows must not mean reading its whole history. */
const OWN_LIST_PAGES_IN_ALL = 200;
/** How long a wallet's list may have more in it than is read before its owner is told, and how often they are told. */
export const BEHIND_AFTER_SECONDS = 600;
export const BEHIND_EVERY_SECONDS = 6 * 3600;
/** How many of one token account's transactions are remembered until its holding is next accounted for. */
const MOST_MOVES = 500;

const DIGITS = /^\d+$/;
const slotOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);

/** What a look saw a wallet's token accounts holding, and the slot it saw them at. */
export interface Held { slot: number; amounts: Record<string, { amount: string; decimals?: number }> }

const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

/**
 * One account as a line of text, for comparing one look with the next. The wallet itself: its balance and the
 * program that owns it. A token account: its amount, who may spend it and how much, who owns it, who may
 * close it, and whether it is frozen. An account that is not there says so.
 */
function lineOf(address: string, value: unknown, isWallet: boolean): string {
  const v = value as { lamports?: unknown; owner?: unknown; data?: { parsed?: { info?: Record<string, any> } } } | null | undefined;
  if (!v) return `${address}:none`;
  const info = v.data?.parsed?.info;
  if (isWallet || !info) return `${address}:${String(v.lamports)}:${String(v.owner)}`;
  return [address, String(info.tokenAmount?.amount ?? ""), String(info.delegate ?? ""), String(info.delegatedAmount?.amount ?? ""), String(info.owner ?? ""), String(info.closeAuthority ?? ""), String(info.state ?? "")].join(":");
}

/** Sends an alert to the owner. The text is a plain sentence: it never carries a link, and never asks for a signature. */
export interface Notifier {
  /** May say how many channels took it; one that says nothing is taken at its word. */
  notify(wallet: string, level: Level, sentence: string): Promise<void | { delivered: number; failed: number }>;
}

/** ntfy: a POST of the sentence to a topic URL the owner chose. No account, no link in the body. */
export class NtfyNotifier implements Notifier {
  constructor(private topicUrl: string, private fetchImpl: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown> = (u, i) => fetch(u, i)) {}
  async notify(_wallet: string, level: Level, sentence: string): Promise<void> {
    await this.fetchImpl(this.topicUrl, { method: "POST", headers: { Title: level === "urgent" ? "Warden Sentinel: urgent" : "Warden Sentinel", Priority: level === "urgent" ? "5" : "3" }, body: sentence });
  }
}

export interface WatcherOptions {
  /** Addresses known to drain wallets. */
  drainers?: ReadonlySet<string>;
  reviewedPrograms?: ReadonlySet<string>;
  /** How much history a wallet's baseline is built from on its first pass. */
  historyLimit?: number;
  /** How often a quiet wallet's accounts are read anyway (default 900 seconds). */
  accountsEverySeconds?: number;
  /** How many new transactions one pass reads at most (default 25); the rest wait for the next pass. */
  mostPerPass?: number;
  /**
   * How long a wallet may go without its list of transactions being read through, when every look at its
   * accounts finds them unchanged (default 600 seconds). A number, or a way to work one out as the service grows.
   */
  fullEverySeconds?: number | (() => number);
  /** How many pages of a wallet's own list are followed back at most before giving up on reaching where reading stopped (default 200). */
  ownListPagesInAll?: number;
  /** How many wallets are read at the same time (default 1). The RPC client keeps the pace; this keeps a slow answer from holding up the rest. */
  readers?: number;
  /** The rescues this service sent itself (rescue.ts), which it tells the owner of when it sends them. */
  ownRescues?: { has(signature: string): boolean };
  /** Called with each alert as it is raised, after the owner was told: what acts on one (a rescue, unasked) hangs here. */
  onRaised?: (event: StoredEvent) => void;
  now?: () => number;
}

export class Watcher {
  private windows = new Map<string, BurstWindow>();
  /** One thing at a time per wallet: a pass reads a wallet's record, waits on the RPC, and writes it back. */
  private busy = new Map<string, Promise<unknown>>();
  /** Signatures the owner's browser reported and that are not yet in the wallet's record. */
  private reported = new Map<string, Map<string, number>>();
  /**
   * What each transaction read did to each of a wallet's token accounts, kept until that account's holding is
   * next accounted for: wallet, then account, then signature. It is how a fall is told from the wallet's own
   * spending without reading anything twice. Lost when the service starts again, and then read again.
   */
  private moves = new Map<string, Map<string, Map<string, { slot: number; delta: bigint }>>>();
  /**
   * A wallet's transactions that are listed and not yet read, the oldest first (`queue`), and, while its list
   * is still being followed back to where reading stopped, how far that has got (`scan`). Nothing is ever
   * skipped: a wallet sent a flood of transactions is read late, in order, and never past one.
   */
  private waiting = new Map<string, { queue: string[]; scan: { before: string; tail: string[]; pages: number } | null }>();
  constructor(private rpc: Rpc, private store: Store, private notifier: Notifier, private opts: WatcherOptions = {}) {}

  private exclusive<T>(wallet: string, work: () => Promise<T>): Promise<T> {
    const run = (this.busy.get(wallet) ?? Promise.resolve()).then(work, work);
    const settled = run.catch(() => undefined);
    this.busy.set(wallet, settled);
    void settled.then(() => { if (this.busy.get(wallet) === settled) this.busy.delete(wallet); });
    return run;
  }

  /** Moves what was reported into the record. Kept 30 days, and no more than a few thousand. */
  private takeReported(wallet: string, record: { ownerSignatures: Record<string, number> }): void {
    const now = this.now();
    for (const [signature, at] of this.reported.get(wallet) ?? []) record.ownerSignatures[signature] = at;
    this.reported.delete(wallet);
    const kept = Object.entries(record.ownerSignatures).filter(([, at]) => now - at <= 30 * 86_400).sort((a, b) => b[1] - a[1]).slice(0, 5000);
    record.ownerSignatures = Object.fromEntries(kept);
  }

  /**
   * The owner's own browser says it signed this. Known at once, so a pass already under way sees it, and
   * written to the record when the wallet is next free.
   */
  ownerSigned(wallet: string, signature: string): Promise<void> {
    const pending = this.reported.get(wallet) ?? this.reported.set(wallet, new Map()).get(wallet)!;
    pending.set(signature, this.now());
    return this.exclusive(wallet, async () => {
      if (!this.reported.has(wallet)) return;
      const record = this.store.record(wallet);
      this.takeReported(wallet, record);
      this.store.save(wallet, record);
    });
  }

  /**
   * "This was me": the owner says a transaction an alert was about was theirs. Who it paid becomes someone
   * this wallet pays, the same way a confirmed send does in the browser. False when the RPC cannot show it.
   */
  confirmOwn(wallet: string, signature: string): Promise<boolean> {
    return this.exclusive(wallet, async () => {
      const tx = await this.transaction(signature);
      if (!tx) return false;
      const record = this.store.record(wallet);
      const baseline = Baseline.from(record.baseline);
      baseline.confirm(tx, wallet);
      record.baseline = baseline.toJSON();
      // If it was a taking under a permission (a marketplace selling what the owner listed), whoever holds
      // that permission is from now on someone whose takings are the owner's doing: the newest twenty.
      // One holder, never several: a transaction that took under two permissions (a sale, and a thief's old
      // approval riding in it) is not a reason to make both familiar.
      const takers = [...new Set(this.store.events(wallet).filter((e) => e.signature === signature).flatMap((e) => e.takers ?? []))];
      if (takers.length === 1) record.trustedTakers = [...new Set([...(record.trustedTakers ?? []), ...takers])].slice(-20);
      this.store.save(wallet, record);
      return true;
    });
  }

  private now(): number { return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000); }

  /** A wallet's newest signatures, oldest first: what a baseline is built from the first time it is read. */
  private async newest(wallet: string, limit: number): Promise<string[]> {
    const page: any[] = (await this.rpc.call("getSignaturesForAddress", [wallet, { limit: Math.min(1000, limit), commitment: "confirmed" }])) ?? [];
    return page.map((s) => s.signature).reverse();
  }

  /**
   * The wallet's next transactions after `cursor`, in the order they happened, `most` of them at most.
   *
   * The RPC lists newest first, a thousand at a time, so the next ones are at the far end. When there are
   * more than a thousand, the list is followed back, a few pages a pass, until it reaches the cursor; the
   * oldest thousand are then kept and read through, twenty-five a pass, before it is asked for again.
   * `far` says that is going on: the wallet is more than a thousand behind. Nothing is passed over, so a
   * transaction cannot be hidden by sending a thousand after it: it is read before any of them.
   */
  private async nextOwn(wallet: string, cursor: string, most: number): Promise<{ next: string[]; more: boolean; far: boolean; lost: boolean }> {
    const state = this.waiting.get(wallet) ?? { queue: [], scan: null };
    let far = state.scan !== null, lost = false;
    // What is waiting from an earlier pass was listed then: once it is read, the list has to be asked for
    // again before the wallet can be called caught up.
    const listedNow = state.queue.length === 0;
    if (listedNow) {
      let before = state.scan?.before, tail = state.scan?.tail ?? [], pages = state.scan?.pages ?? 0, reached = false;
      for (let i = 0; i < OWN_LIST_PAGES && !reached; i++) {
        // confirmed, like everything else read here: a transaction the RPC has just pushed word of is in the list, not thirteen seconds behind it
        const page: any[] = (await this.rpc.call("getSignaturesForAddress", [wallet, { limit: 1000, commitment: "confirmed", until: cursor, ...(before ? { before } : {}) }])) ?? [];
        pages += 1;
        // the oldest thousand of everything seen so far, newest first
        tail = [...tail, ...page.map((s) => s.signature)].slice(-1000);
        if (page.length < 1000) reached = true;
        else { before = page[page.length - 1].signature; far = true; }
        // a cursor the RPC no longer knows would have this follow the wallet's whole past: it stops, and says so
        if (!reached && pages >= (this.opts.ownListPagesInAll ?? OWN_LIST_PAGES_IN_ALL)) { reached = true; lost = true; }
      }
      if (reached) { state.queue = tail.reverse(); state.scan = null; } else state.scan = { before: before!, tail, pages };
    }
    if (state.queue.length > 0 || state.scan) this.waiting.set(wallet, state); else this.waiting.delete(wallet);
    return { next: state.queue.slice(0, most), more: state.queue.length > most || state.scan !== null || !listedNow, far, lost };
  }

  /** So many of the wallet's waiting transactions have been read. */
  private readOwn(wallet: string, count: number): void {
    const state = this.waiting.get(wallet);
    if (!state) return;
    state.queue.splice(0, count);
    if (state.queue.length === 0 && !state.scan) this.waiting.delete(wallet);
  }

  /**
   * A token account's own transactions since a slot, the oldest first, and whether that reaches all the way
   * back to it. Failed ones are left out: they moved nothing.
   */
  private async accountList(account: string, after: number, pages: number, background: boolean): Promise<{ list: { signature: string; slot: number }[]; whole: boolean; asked: number }> {
    const out: { signature: string; slot: number }[] = [];
    let before: string | undefined, whole = false, asked = 0;
    pages: for (let page = 0; page < Math.min(pages, ACCOUNT_LIST_PAGES); page++) {
      asked += 1;
      const answer: any[] = (await this.rpc.call("getSignaturesForAddress", [account, { limit: 1000, commitment: "confirmed", ...(before ? { before } : {}) }], background ? { background: true } : undefined)) ?? [];
      for (const s of answer) {
        if (typeof s?.signature !== "string") continue;
        if (!(Number(s.slot) > after)) { whole = true; break pages; }
        if (!s.err) out.push({ signature: s.signature, slot: Number(s.slot) });
      }
      if (answer.length < 1000) { whole = true; break; }
      before = answer[answer.length - 1].signature;
    }
    // the RPC answers newest first
    return { list: out.reverse(), whole, asked };
  }

  /** Whether the owner was already told of a taking in this transaction. It can be come upon twice: in the wallet's list and in a token account's. */
  /**
   * The rescues that are this service's own, for a wallet: the ones it has just sent, and the ones on record
   * (a rescue's other transactions are kept with its alert, so that a restart does not make strangers of them).
   */
  private ownRescues(wallet: string): { has(signature: string): boolean } {
    return { has: (signature) => this.opts.ownRescues?.has(signature) === true || this.store.events(wallet).some((e) => e.signals.includes("rescued") && (e.signature === signature || e.also?.includes(signature) === true)) };
  }

  private told(wallet: string, signature: string, kind: "taken_by_permission" | "rescued" | null = null): boolean {
    return this.store.events(wallet).some((e) => e.signature === signature && (kind ? e.signals.includes(kind) : e.signals.includes("taken_by_permission") || e.signals.includes("rescued")));
  }

  /** `background`: part of a new wallet's history, which waits for anything that is about a wallet already watched. */
  private async transaction(signature: string, background = false): Promise<ObservedTx | null> {
    return fromRpc(signature, await this.rpc.call("getTransaction", [signature, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], background ? { background: true } : undefined));
  }

  private async tokenAccounts(wallet: string, known: Record<string, unknown> = {}): Promise<Record<string, TokenAccountState>> {
    const out: Record<string, TokenAccountState> = {};
    for (const programId of TOKEN_PROGRAMS) {
      const res = await this.rpc.call("getTokenAccountsByOwner", [wallet, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]);
      const slot = slotOf(res?.context?.slot);
      for (const entry of res?.value ?? []) {
        const info = entry?.account?.data?.parsed?.info;
        if (!info || typeof entry.pubkey !== "string") continue;
        const amount = info.tokenAmount?.amount, decimals = info.tokenAmount?.decimals;
        out[entry.pubkey] = {
          address: entry.pubkey, mint: String(info.mint), owner: String(info.owner), delegate: typeof info.delegate === "string" ? info.delegate : null, closeAuthority: typeof info.closeAuthority === "string" ? info.closeAuthority : null,
          ...(typeof amount === "string" && DIGITS.test(amount) ? { amount } : {}), ...(typeof decimals === "number" ? { decimals } : {}), ...(slot !== undefined ? { slot } : {}),
        };
      }
    }
    // A wallet can have thousands of token accounts (an exchange's has), and every one of them would be kept
    // and written out with each save. A thousand are kept, the same thousand every time; a wallet of an
    // ordinary person has a few dozen.
    //
    // Which thousand matters: anyone can open token accounts in a wallet's name, for a little rent, and
    // must not be able to push the ones worth watching off the record by opening a thousand. So first the
    // ones somebody holds a permission to spend from, then the ones already on record, then the ones that
    // hold something, and only then the rest; by address within each.
    const addresses = Object.keys(out);
    if (addresses.length <= MAX_TOKEN_ACCOUNTS) return out;
    const rank = (a: string) => (out[a]!.delegate ? 0 : Object.hasOwn(known, a) ? 1 : out[a]!.amount !== undefined && out[a]!.amount !== "0" ? 2 : 3);
    return Object.fromEntries(addresses.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1)).slice(0, MAX_TOKEN_ACCOUNTS).map((a) => [a, out[a]!]));
  }

  private watching(wallet: string): boolean { return this.store.wallets().some((w) => w.address === wallet); }

  private async raise(wallet: string, a: Assessment, tx: { signature: string; slot: number; blockTime: number | null } | null): Promise<StoredEvent | null> {
    // a wallet its owner removed a moment ago gets no alert and leaves no record
    if (a.level === null || !this.watching(wallet)) return null;
    const takers = [...new Set(a.signals.flatMap((s) => s.takers ?? []))];
    const event: StoredEvent = { wallet, signature: tx?.signature ?? "", slot: tx?.slot ?? 0, at: tx?.blockTime ?? this.now(), level: a.level, signals: a.signals.map((s) => s.kind), sentence: a.sentence, rescueWorthy: a.rescueWorthy, ...(takers.length > 0 ? { takers } : {}) };
    this.store.addEvent(event);
    // Handed on at once, before the owner is told: telling can take seconds a channel, and what acts on an
    // alert (a rescue) is in a race. Whatever hangs here must not stop the watching.
    try { this.opts.onRaised?.(event); } catch { /* its own affair */ }
    // Info is for the Sentinel page; the others go to the owner. A notifier that fails must not stop the watching.
    if (a.level !== "info") {
      const sent = await this.notifier.notify(wallet, a.level, a.sentence).catch(() => ({ delivered: 0, failed: 1 }));
      // nobody was told: the alert says so on the page, which is now the only place it is
      if (sent && sent.delivered === 0 && event.id) this.store.markUndelivered?.(event.id);
    }
    return event;
  }

  /**
   * One pass over one wallet. The first pass builds the baseline from the wallet's history and raises nothing
   * for it: what already happened is not news. Later passes read what is new, oldest first.
   */
  pass(w: WatchedWallet, print?: string, held?: Held): Promise<StoredEvent[]> {
    return this.exclusive(w.address, () => this.passNow(w, print, held));
  }

  /** Remembers what a transaction did to each of these token accounts of the wallet's. */
  private note(wallet: string, tx: ObservedTx, accounts: Record<string, unknown>, also?: string): void {
    const deltas = tx.failed ? new Map<string, bigint>() : tokenDeltasOf(tx);
    // `also`: an account whose list this transaction was found on is noted even when it did nothing to it, so that it is not read again
    if (also !== undefined && !deltas.has(also)) deltas.set(also, 0n);
    for (const [account, delta] of deltas) {
      if (account !== also && !Object.hasOwn(accounts, account)) continue;
      const ofWallet = this.moves.get(wallet) ?? this.moves.set(wallet, new Map()).get(wallet)!;
      const ofAccount = ofWallet.get(account) ?? ofWallet.set(account, new Map()).get(account)!;
      ofAccount.set(tx.signature, { slot: tx.slot, delta });
      if (ofAccount.size > MOST_MOVES) ofAccount.delete(ofAccount.keys().next().value!);
    }
  }

  /** What the transactions read took from, or added to, a token account after one slot and up to another. */
  private moved(wallet: string, account: string, after: number, upTo: number): bigint {
    let sum = 0n;
    for (const m of this.moves.get(wallet)?.get(account)?.values() ?? []) if (m.slot > after && m.slot <= upTo) sum += m.delta;
    return sum;
  }

  /** The account's holding is accounted for up to this slot: what was remembered up to it is no longer needed. */
  private accounted(wallet: string, account: string, upTo: number): void {
    const ofWallet = this.moves.get(wallet);
    const ofAccount = ofWallet?.get(account);
    if (!ofWallet || !ofAccount) return;
    for (const [signature, m] of ofAccount) if (m.slot <= upTo) ofAccount.delete(signature);
    if (ofAccount.size === 0) ofWallet.delete(account);
    if (ofWallet.size === 0) this.moves.delete(wallet);
  }

  /**
   * Tokens that left without the wallet signing.
   *
   * Someone the wallet once gave a permission to spend (a delegate) can move its tokens in a transaction that
   * does not name the wallet at all, so the wallet's own list of transactions never shows it. What shows it
   * is the token account: it holds less. For each of the wallet's token accounts this compares what it holds
   * now with what it held when last accounted for, and takes off what the wallet's own transactions since
   * then did to it. If it still holds less than that explains, some other transaction took the rest: the
   * account's own list of transactions is read to find it, and the owner is told who signed it.
   *
   * What it cannot see: a taking that is made up, between two reads, by what other people paid into the same
   * account. The holding did not fall, and nothing is looked for.
   */
  private async settle(w: WatchedWallet, record: WalletRecord, before: Record<string, TokenAccountState>, accountsRead: boolean, held: Held | undefined, listUnread: boolean, trusted: ReadonlySet<string>): Promise<StoredEvent[]> {
    const wallet = w.address;
    const raised: StoredEvent[] = [];
    let lists = 0, reads = 0, pending = false;
    // In the order they were last looked into, the longest ago first: when more accounts hold less than one
    // pass looks into, each gets its turn.
    const order = Object.entries(record.tokenAccounts).sort(([a], [b]) => (before[a]?.lookedAt ?? 0) - (before[b]?.lookedAt ?? 0));
    for (const [address, entry] of order) {
      const was = before[address];
      // what it holds now: as just read with the wallet's other accounts, or as the look before this pass saw it
      const seen = accountsRead ? entry : held?.amounts[address] ? { ...held.amounts[address]!, slot: held.slot } : undefined;
      if (!seen || seen.amount === undefined || seen.slot === undefined || !DIGITS.test(seen.amount)) continue;
      const now = { amount: seen.amount, slot: seen.slot, decimals: seen.decimals };
      const adopt = () => {
        entry.amount = now.amount; entry.slot = now.slot;
        if (now.decimals !== undefined) entry.decimals = now.decimals;
        delete entry.fellAt; delete entry.lookedAt; delete entry.others;
        this.accounted(wallet, address, now.slot);
      };
      if (!was || was.amount === undefined || was.slot === undefined || !DIGITS.test(was.amount) || was.owner !== wallet) { adopt(); continue; }
      const keep = (fellAt: number | undefined, lookedAt: number | undefined = was.lookedAt) => {
        entry.amount = was.amount!; entry.slot = was.slot!;
        if (fellAt !== undefined) entry.fellAt = fellAt; else delete entry.fellAt;
        if (lookedAt !== undefined) entry.lookedAt = lookedAt; else delete entry.lookedAt;
        if (was.others) entry.others = true; else delete entry.others;
      };
      // an answer from a node that is behind the one that answered last says nothing new
      if (now.slot <= was.slot) { keep(was.fellAt); if (was.fellAt !== undefined) pending = true; continue; }
      const diff = BigInt(now.amount) - BigInt(was.amount);
      const explained = () => this.moved(wallet, address, was.slot!, now.slot) <= diff;
      // it holds as much or more; or the transactions already read took out at least what is missing
      if (diff >= 0n || explained()) { adopt(); continue; }
      const fellAt = was.fellAt ?? this.now();
      // The wallet's own transactions are read first, with its own list: while some of that is unread, this
      // waits for them. Not for long: anyone can fill a wallet's list, and a taking is not to hide behind it.
      if (listUnread && this.now() - fellAt < WAIT_FOR_OWN_SECONDS) { keep(fellAt); pending = true; continue; }
      // more such accounts than one pass looks into: this one waits its turn, and is not given up on meanwhile
      if (lists >= MOST_ACCOUNT_LISTS) { keep(fellAt); pending = true; continue; }
      // The first look into a fall is news and is read like news. Looking again at one that is still not
      // accounted for gives way to everything else the RPC is asked: a wallet cannot hold the RPC's
      // allowance by keeping a fall unexplained.
      const again = was.fellAt !== undefined;
      const { list, whole, asked } = await this.accountList(address, was.slot, MOST_ACCOUNT_LISTS - lists, again);
      lists += asked;
      let others = was.others === true;
      // Everything since the amount on record, the oldest first: what took the tokens is then read before
      // whatever was sent after it to bury it. And all of it, not only until what is missing is found:
      // another taking can be behind a payment in, and one that landed after the look is told of now.
      let unread = 0;
      for (const s of list) {
        if (this.moves.get(wallet)?.get(address)?.has(s.signature)) continue;
        if (reads >= MOST_EXTRA_READS) { unread += 1; continue; }
        reads += 1;
        const tx = await this.transaction(s.signature, again);
        if (!tx) { unread += 1; continue; }
        this.note(wallet, tx, before, address);
        // somebody else's transaction touched the account: what is not accounted for is not all the wallet's own doing
        if (!tx.failed && !signersOf(tx).includes(wallet)) others = true;
        if (this.told(wallet, tx.signature)) continue;
        // whoever it names: one the wallet signed is the wallet's own, and the rule says nothing of it
        const event = await this.raise(wallet, assessTaken(tx, { wallet, sentinelDelegate: rescueDelegateOf(w, this.now()), rescueVault: rescueVaultOf(w, this.now()), tokenAccounts: before, trustedTakers: trusted, ownRescues: this.ownRescues(wallet) }), tx);
        if (event) raised.push(event);
      }
      if (explained()) { adopt(); continue; }
      // Not all of it is accounted for: the RPC may be a moment behind, or there was more to read than one
      // pass reads. It is looked for again on the wallet's next turn, and for ten minutes.
      if (this.now() - fellAt < EXPLAIN_FOR_SECONDS) { keep(fellAt, this.now()); if (others) entry.others = true; pending = true; continue; }
      // Ten minutes on, and there is still more than could be read, on the wallet or on the account.
      const unreadLeft = listUnread || unread > 0 || !whole;
      // If all that was read on the account was the wallet's own doing, so is the backlog: a wallet that
      // transacts faster than it can be read, or one come back to after a long while. Its owner is told it
      // is behind (above), and is not told of a theft.
      if (unreadLeft && !others) { adopt(); continue; }
      // If somebody else's transactions are among them, that is how a taking is hidden, and it is said as one.
      const event = await this.raise(wallet, assessUnexplainedLoss(was, this.moved(wallet, address, was.slot, now.slot) - diff, unreadLeft), null);
      if (event) raised.push(event);
      adopt();
    }
    if (pending) record.unsettled = true; else delete record.unsettled;
    // an account that is no longer the wallet's has nothing left to account for
    const ofWallet = this.moves.get(wallet);
    if (ofWallet) { for (const account of ofWallet.keys()) if (!Object.hasOwn(record.tokenAccounts, account)) ofWallet.delete(account); if (ofWallet.size === 0) this.moves.delete(wallet); }
    return raised;
  }

  /**
   * A look at many wallets' accounts at once: a hundred accounts to a call, on the part of the RPC that is
   * barely rationed. For each wallet it reads the wallet's own account and its token accounts, and reduces
   * them to one line: balance and owner, and for each token account its amount, who may spend it and how
   * much, who owns it, who may close it. Everything an alert is about moves that line. A wallet whose line is
   * the one kept from last time has had nothing happen to its money or its permissions, and its list of
   * transactions need not be asked for, which is the call an RPC rations.
   *
   * What a look cannot see is a transaction that changes none of those. That is what the push line and the
   * full pass every so often are for.
   */
  async glance(wallets: WatchedWallet[]): Promise<{ prints: Map<string, string>; failed: Map<string, string>; held: Map<string, Held> }> {
    const prints = new Map<string, string>(), failed = new Map<string, string>(), held = new Map<string, Held>();
    // each wallet's addresses stay together in one call, so that one answer says everything about it
    const calls: { wallet: string; addresses: string[] }[][] = [[]];
    let room = ACCOUNTS_PER_CALL;
    for (const w of wallets) {
      // A wallet with more token accounts than fit has the ones most at risk looked at: first those somebody
      // holds a permission to spend from, then those that hold something. The rest are read with the
      // wallet's accounts, about every quarter of an hour.
      const onRecord = this.store.record(w.address).tokenAccounts;
      const rank = (a: string) => (onRecord[a]!.delegate ? 0 : onRecord[a]!.amount === "0" ? 2 : 1);
      const tokens = Object.keys(onRecord).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1)).slice(0, ACCOUNTS_PER_CALL - 1).sort();
      const addresses = [w.address, ...tokens];
      if (addresses.length > room) { calls.push([]); room = ACCOUNTS_PER_CALL; }
      calls[calls.length - 1]!.push({ wallet: w.address, addresses });
      room -= addresses.length;
    }
    await Promise.all(calls.filter((c) => c.length > 0).map(async (group) => {
      try {
        const res = await this.rpc.call("getMultipleAccounts", [group.flatMap((g) => g.addresses), { encoding: "jsonParsed", commitment: "confirmed" }]);
        const values: unknown[] = Array.isArray(res?.value) ? res.value : [];
        const slot = slotOf(res?.context?.slot);
        let at = 0;
        for (const g of group) {
          prints.set(g.wallet, g.addresses.map((address, i) => lineOf(address, values[at + i], i === 0)).join("\n"));
          if (slot !== undefined) {
            const amounts: Held["amounts"] = {};
            g.addresses.forEach((address, i) => {
              const of = i === 0 ? undefined : (values[at + i] as any)?.data?.parsed?.info?.tokenAmount;
              if (typeof of?.amount === "string") amounts[address] = { amount: of.amount, ...(typeof of.decimals === "number" ? { decimals: of.decimals } : {}) };
            });
            held.set(g.wallet, { slot, amounts });
          }
          at += g.addresses.length;
        }
      } catch (e) {
        for (const g of group) failed.set(g.wallet, String((e as Error).message ?? e));
      }
    }));
    return { prints, failed, held };
  }

  private async passNow(w: WatchedWallet, print?: string, held?: Held): Promise<StoredEvent[]> {
    const wallet = w.address;
    if (!this.watching(wallet)) { this.moves.delete(wallet); this.waiting.delete(wallet); return []; }
    const record = this.store.record(wallet);
    /** Its token accounts as they were on record when this pass began. */
    const before = record.tokenAccounts;
    // A wallet that has not been read for hours (its plan lapsed and came back, the service was away) has
    // weeks of its own doing between what its accounts held then and now. That is not explained one
    // transaction at a time: what they hold now is taken as it is found, as on a first read.
    if (record.lastSeenAt !== null && this.now() - record.lastSeenAt > STALE_AFTER_SECONDS) {
      for (const t of Object.values(before)) { delete t.amount; delete t.slot; delete t.fellAt; delete t.lookedAt; delete t.others; }
      this.moves.delete(wallet);
    }
    const baseline = Baseline.from(record.baseline);
    const raised: StoredEvent[] = [];
    const ctxBase: Omit<WatchContext, "ownerSigned"> = { wallet, baseline, sentinelDelegate: rescueDelegateOf(w, this.now()), rescueVault: rescueVaultOf(w, this.now()), disarming: disarmingNow(w, this.now()), ownRescues: this.ownRescues(wallet), drainers: this.opts.drainers ?? new Set(), reviewedPrograms: this.opts.reviewedPrograms, window: this.windows.get(wallet) ?? this.windows.set(wallet, new BurstWindow()).get(wallet)!, tokenAccounts: before, trustedTakers: new Set(record.trustedTakers ?? []) };

    let somethingNew = false, listUnread = false, accountsRead = false;
    if (record.cursor === null && record.baseline === null) {
      const history = await this.newest(wallet, this.opts.historyLimit ?? 200);
      for (const signature of history) {
        // the past of a wallet that is new here can wait its turn behind news of wallets already watched
        const tx = await this.transaction(signature, true);
        if (tx) baseline.learn(tx, wallet);
      }
      record.cursor = history.at(-1) ?? null;
      somethingNew = true;
    } else {
      // So many in one pass, oldest first, and the rest on the next: a wallet that transacts without pause
      // (a bot, an exchange) must not hold a reader, and the RPC's allowance, for as long as it likes.
      const { next: fresh, more, far, lost } = await this.nextOwn(wallet, record.cursor!, this.opts.mostPerPass ?? MOST_PER_PASS);
      somethingNew = fresh.length > 0;
      let read = 0;
      for (const signature of fresh) {
        const tx = await this.transaction(signature);
        // a transaction the RPC does not have yet is read on the next pass: the cursor stays before it
        if (!tx) break;
        read += 1;
        this.note(wallet, tx, before);
        let a = assessTransaction(tx, { ...ctxBase, ownerSigned: signature in record.ownerSignatures || !!this.reported.get(wallet)?.has(signature) });
        // a taking that was come upon first in the token account's own list has been told of
        if (a.signals.some((s) => s.kind === "taken_by_permission") && this.told(wallet, signature, "taken_by_permission")) a = without(a, "taken_by_permission");
        if (a.signals.some((s) => s.kind === "rescued") && this.told(wallet, signature, "rescued")) a = without(a, "rescued");
        const event = await this.raise(wallet, a, tx);
        if (event) raised.push(event);
        // what raised an alert is not taken as normal: a thief's first transfer must not make the second one familiar
        if (a.level === null || a.level === "info") baseline.learn(tx, wallet);
        record.cursor = signature;
      }
      this.readOwn(wallet, read);
      // what is listed and not yet read is read on this wallet's next turns, not when its accounts next move
      listUnread = read < fresh.length || more;
      record.more = listUnread;
      // More names the wallet than is being read. Its owner hears of it when that has gone on for ten
      // minutes, or at once when it is more than a thousand behind: a wallet can be sent a flood of cheap
      // transactions to delay the reading of one, and being behind is then itself the news.
      const t = this.now();
      if (!listUnread) delete record.moreSince; else record.moreSince ??= t;
      if (listUnread && (far || lost || t - record.moreSince! >= BEHIND_AFTER_SECONDS) && t - (record.behindToldAt ?? -Infinity) >= BEHIND_EVERY_SECONDS) {
        record.behindToldAt = t;
        const event = await this.raise(wallet, assessBehind((this.waiting.get(wallet)?.queue.length ?? 0), far, lost), null);
        if (event) raised.push(event);
      }
    }

    // The accounts themselves: what an instruction list can hide. What is watched here (who may spend a token
    // account, who owns it, which program owns the wallet) changes only by a transaction the wallet signs, and
    // every such transaction is in the list just read. So the accounts are read when that list had something
    // new, on the first pass, and every quarter of an hour regardless, in case that reasoning has a hole. A
    // quiet wallet then costs one call a pass instead of four, which is what lets an RPC that rations its
    // heavy calls keep up with the pace the plans promise. (What a token account holds is another matter: a
    // delegate moves that without the wallet signing. `settle`, below, is for that.)
    const at = this.now();
    // a record written before this was kept had its accounts read on every pass: its last pass is when
    const accountsReadAt = record.accountsReadAt ?? record.lastSeenAt ?? undefined;
    if (somethingNew || accountsReadAt === undefined || at - accountsReadAt >= (this.opts.accountsEverySeconds ?? 900)) {
      const accounts = await this.tokenAccounts(wallet, before);
      if (record.lastSeenAt !== null) {
        for (const [address, before] of Object.entries(record.tokenAccounts)) {
          const after = accounts[address] ?? (await this.accountElsewhere(address));
          const event = await this.raise(wallet, assessTokenAccount(before, after, ctxBase), null);
          if (event) raised.push(event);
        }
      }
      record.tokenAccounts = accounts;
      const info = await this.rpc.call("getAccountInfo", [wallet, { encoding: "base64", commitment: "confirmed" }]);
      const ownerProgram: string | null = info?.value?.owner ?? null;
      if (record.ownerProgram && ownerProgram) {
        const event = await this.raise(wallet, assessWalletAccount(record.ownerProgram, ownerProgram), null);
        if (event) raised.push(event);
      }
      record.ownerProgram = ownerProgram ?? record.ownerProgram;
      record.accountsReadAt = at;
      accountsRead = true;
    }

    // what each token account holds, against what the transactions read account for
    raised.push(...(await this.settle(w, record, before, accountsRead, held, listUnread, ctxBase.trustedTakers ?? new Set())));

    record.baseline = baseline.toJSON();
    record.lastSeenAt = this.now();
    record.passedAt = record.lastSeenAt;
    // The line its accounts made just before this pass began. Anything that happened after that look moves
    // the next one, and the wallet is read through again: nothing falls between a look and a pass.
    if (print !== undefined) record.glance = { print, at: record.lastSeenAt };
    this.takeReported(wallet, record);
    this.store.save(wallet, record);
    return raised;
  }

  /** A token account that is no longer among the wallet's: read it directly, to see whose it is now. */
  private async accountElsewhere(address: string): Promise<TokenAccountState | null> {
    const res = await this.rpc.call("getAccountInfo", [address, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const info = res?.value?.data?.parsed?.info;
    if (!info) return null;
    return { address, mint: String(info.mint), owner: String(info.owner), delegate: typeof info.delegate === "string" ? info.delegate : null, closeAuthority: typeof info.closeAuthority === "string" ? info.closeAuthority : null };
  }

  /**
   * One round over every wallet, or over the ones `only` picks. First a look at all their accounts together.
   * Then a full pass, which reads the list of transactions, for each wallet that needs one: its accounts are
   * not as they were, it was never read, it has gone long enough without one, or `full` says so (the RPC has
   * just said it was in a transaction). The rest were looked at and found unchanged, and that is their read.
   * A wallet that could not be read is reported, and the others are still read.
   */
  async passAll(only?: (address: string) => boolean, opts: { full?: (address: string) => boolean; mostPasses?: number } = {}): Promise<{ raised: StoredEvent[]; blind: { wallet: string; why: string }[]; deferred: string[] }> {
    const raised: StoredEvent[] = [];
    const blind: { wallet: string; why: string }[] = [];
    const all = this.store.wallets();
    const chosen = all.filter((w) => !only || only(w.address));
    // a wallet no longer watched has nothing remembered about it
    if (this.moves.size > 0 || this.waiting.size > 0) {
      const watched = new Set(all.map((w) => w.address));
      for (const kept of [this.moves, this.waiting]) for (const wallet of kept.keys()) if (!watched.has(wallet)) kept.delete(wallet);
    }
    const now = this.now();
    const every = typeof this.opts.fullEverySeconds === "function" ? this.opts.fullEverySeconds() : this.opts.fullEverySeconds ?? 600;
    // Why a wallet would need its transactions read, most pressing first: the RPC has just spoken of it (0);
    // a look that differs (1, decided below); it was never read (2); a pass left some unread, or left a
    // token account's holding unaccounted for (3); or only that it has been long enough (4). News goes
    // before catching up: a wallet that is kept behind, by its owner or by anyone, waits for the others.
    const kept = new Map<string, { print: string | undefined; known: boolean; why: number | null }>();
    for (const w of chosen) {
      const r = this.store.record(w.address);
      const known = r.lastSeenAt !== null;
      const why = opts.full?.(w.address) === true ? 0 : !known ? 2 : r.more === true || r.unsettled === true ? 3 : now - (r.passedAt ?? 0) >= every ? 4 : null;
      kept.set(w.address, { print: r.glance?.print, known, why });
    }
    // a wallet never read has no token accounts on record to look at: its first pass finds them
    const { prints, failed, held } = await this.glance(chosen.filter((w) => kept.get(w.address)!.known));
    const wanted: { w: WatchedWallet; print: string | undefined; held: Held | undefined; why: number; moved: boolean }[] = [];
    const same: string[] = [];
    for (const w of chosen) {
      const k = kept.get(w.address)!;
      const failure = failed.get(w.address);
      if (failure !== undefined) { blind.push({ wallet: w.address, why: failure }); continue; }
      const print = prints.get(w.address);
      const moved = k.known && (print === undefined || print !== k.print);
      if (k.why !== null || moved) wanted.push({ w, print, held: held.get(w.address), why: Math.min(k.why ?? 1, moved ? 1 : 9), moved }); else same.push(w.address);
    }
    // A round is kept short: it reads through so many wallets and no more, the most pressing first. One that
    // is only due for its now-and-then pass, with its accounts as they were, has been read by the look and
    // waits for a quieter round. Any other has not been read yet, and is handed back to be taken first next time.
    wanted.sort((a, b) => a.why - b.why);
    const queue = wanted.slice(0, opts.mostPasses ?? Infinity);
    const deferred: string[] = [];
    for (const left of wanted.slice(queue.length)) { if (left.why === 4 && !left.moved) same.push(left.w.address); else deferred.push(left.w.address); }
    if (same.length > 0) this.store.seen?.(same, now);
    const reader = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try { raised.push(...(await this.pass(next.w, next.print, next.held))); } catch (e) { blind.push({ wallet: next.w.address, why: String((e as Error).message ?? e) }); }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.opts.readers ?? 1, queue.length)) }, reader));
    return { raised, blind, deferred };
  }

  /** Wallets not read successfully for `seconds`: the owner is told when watching stops. */
  stale(seconds: number): string[] {
    const now = this.now();
    return this.store.wallets().map((w) => w.address).filter((a) => { const at = this.store.record(a).lastSeenAt; return at === null || now - at > seconds; });
  }
}
