/**
 * The watcher: for each wallet, read what happened since last time, run the rules, raise what they say.
 *
 * It polls. A subscription (a Helius websocket or webhook) is faster and is where this should go, but a poll
 * is what every RPC offers, is easy to reason about after an outage (the cursor says exactly what was not yet
 * read), and is enough to measure the rules against real wallets.
 *
 * It holds no key. When the rules say a rescue is warranted it says so in the event; acting on that is the
 * rescuer's job, in another process, with another key.
 */
import { Baseline } from "./baseline.js";
import { fromRpc, type ObservedTx } from "./observed.js";
import type { Rpc } from "./rpc.js";
import { BurstWindow, assessTokenAccount, assessTransaction, assessWalletAccount, type Assessment, type Level, type TokenAccountState, type WatchContext } from "./signals.js";
import type { Store, StoredEvent, WatchedWallet } from "./store.js";

/** How many of a wallet's token accounts are kept and compared. */
export const MAX_TOKEN_ACCOUNTS = 1000;
/** How many new transactions one pass reads. */
export const MOST_PER_PASS = 25;
/** How many accounts one call can ask about, and so how many of a wallet's token accounts a look takes in beside the wallet. */
export const ACCOUNTS_PER_CALL = 100;

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
  /** How many wallets are read at the same time (default 1). The RPC client keeps the pace; this keeps a slow answer from holding up the rest. */
  readers?: number;
  now?: () => number;
}

export class Watcher {
  private windows = new Map<string, BurstWindow>();
  /** One thing at a time per wallet: a pass reads a wallet's record, waits on the RPC, and writes it back. */
  private busy = new Map<string, Promise<unknown>>();
  /** Signatures the owner's browser reported and that are not yet in the wallet's record. */
  private reported = new Map<string, Map<string, number>>();
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
      this.store.save(wallet, record);
      return true;
    });
  }

  private now(): number { return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000); }

  /** Signatures newer than `until`, oldest first. */
  private async signaturesSince(wallet: string, until: string | null, limit: number): Promise<string[]> {
    const out: string[] = [];
    let before: string | undefined;
    for (;;) {
      // confirmed, like everything else read here: a transaction the RPC has just pushed word of is in the list, not thirteen seconds behind it
      const page: any[] = (await this.rpc.call("getSignaturesForAddress", [wallet, { limit: Math.min(1000, limit - out.length), commitment: "confirmed", ...(before ? { before } : {}), ...(until ? { until } : {}) }])) ?? [];
      for (const s of page) out.push(s.signature);
      if (page.length < 1000 || out.length >= limit) break;
      before = page[page.length - 1].signature;
    }
    return out.reverse();
  }

  /** `background`: part of a new wallet's history, which waits for anything that is about a wallet already watched. */
  private async transaction(signature: string, background = false): Promise<ObservedTx | null> {
    return fromRpc(signature, await this.rpc.call("getTransaction", [signature, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], background ? { background: true } : undefined));
  }

  private async tokenAccounts(wallet: string): Promise<Record<string, TokenAccountState>> {
    const out: Record<string, TokenAccountState> = {};
    for (const programId of TOKEN_PROGRAMS) {
      const res = await this.rpc.call("getTokenAccountsByOwner", [wallet, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]);
      for (const entry of res?.value ?? []) {
        const info = entry?.account?.data?.parsed?.info;
        if (!info || typeof entry.pubkey !== "string") continue;
        out[entry.pubkey] = { address: entry.pubkey, mint: String(info.mint), owner: String(info.owner), delegate: typeof info.delegate === "string" ? info.delegate : null, closeAuthority: typeof info.closeAuthority === "string" ? info.closeAuthority : null };
      }
    }
    // A wallet can have thousands of token accounts (an exchange's has), and every one of them would be kept
    // and written out with each save. A thousand are kept, the same thousand every time; a wallet of an
    // ordinary person has a few dozen.
    const addresses = Object.keys(out);
    if (addresses.length <= MAX_TOKEN_ACCOUNTS) return out;
    return Object.fromEntries(addresses.sort().slice(0, MAX_TOKEN_ACCOUNTS).map((a) => [a, out[a]!]));
  }

  private watching(wallet: string): boolean { return this.store.wallets().some((w) => w.address === wallet); }

  private async raise(wallet: string, a: Assessment, tx: { signature: string; slot: number; blockTime: number | null } | null): Promise<StoredEvent | null> {
    // a wallet its owner removed a moment ago gets no alert and leaves no record
    if (a.level === null || !this.watching(wallet)) return null;
    const event: StoredEvent = { wallet, signature: tx?.signature ?? "", slot: tx?.slot ?? 0, at: tx?.blockTime ?? this.now(), level: a.level, signals: a.signals.map((s) => s.kind), sentence: a.sentence, rescueWorthy: a.rescueWorthy };
    this.store.addEvent(event);
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
  pass(w: WatchedWallet, print?: string): Promise<StoredEvent[]> {
    return this.exclusive(w.address, () => this.passNow(w, print));
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
  async glance(wallets: WatchedWallet[]): Promise<{ prints: Map<string, string>; failed: Map<string, string> }> {
    const prints = new Map<string, string>(), failed = new Map<string, string>();
    // each wallet's addresses stay together in one call, so that one answer says everything about it
    const calls: { wallet: string; addresses: string[] }[][] = [[]];
    let room = ACCOUNTS_PER_CALL;
    for (const w of wallets) {
      const tokens = Object.keys(this.store.record(w.address).tokenAccounts).sort().slice(0, ACCOUNTS_PER_CALL - 1);
      const addresses = [w.address, ...tokens];
      if (addresses.length > room) { calls.push([]); room = ACCOUNTS_PER_CALL; }
      calls[calls.length - 1]!.push({ wallet: w.address, addresses });
      room -= addresses.length;
    }
    await Promise.all(calls.filter((c) => c.length > 0).map(async (group) => {
      try {
        const res = await this.rpc.call("getMultipleAccounts", [group.flatMap((g) => g.addresses), { encoding: "jsonParsed", commitment: "confirmed" }]);
        const values: unknown[] = Array.isArray(res?.value) ? res.value : [];
        let at = 0;
        for (const g of group) {
          prints.set(g.wallet, g.addresses.map((address, i) => lineOf(address, values[at + i], i === 0)).join("\n"));
          at += g.addresses.length;
        }
      } catch (e) {
        for (const g of group) failed.set(g.wallet, String((e as Error).message ?? e));
      }
    }));
    return { prints, failed };
  }

  private async passNow(w: WatchedWallet, print?: string): Promise<StoredEvent[]> {
    const wallet = w.address;
    if (!this.watching(wallet)) return [];
    const record = this.store.record(wallet);
    const baseline = Baseline.from(record.baseline);
    const raised: StoredEvent[] = [];
    const ctxBase: Omit<WatchContext, "ownerSigned"> = { wallet, baseline, sentinelDelegate: w.sentinelDelegate, drainers: this.opts.drainers ?? new Set(), reviewedPrograms: this.opts.reviewedPrograms, window: this.windows.get(wallet) ?? this.windows.set(wallet, new BurstWindow()).get(wallet)! };

    let somethingNew = false;
    if (record.cursor === null && record.baseline === null) {
      const history = await this.signaturesSince(wallet, null, this.opts.historyLimit ?? 200);
      for (const signature of history) {
        // the past of a wallet that is new here can wait its turn behind news of wallets already watched
        const tx = await this.transaction(signature, true);
        if (tx) baseline.learn(tx, wallet);
      }
      record.cursor = history.at(-1) ?? null;
      somethingNew = true;
    } else {
      const fresh = await this.signaturesSince(wallet, record.cursor, 1000);
      somethingNew = fresh.length > 0;
      // So many in one pass, oldest first, and the rest on the next: a wallet that transacts without pause
      // (a bot, an exchange) must not hold a reader, and the RPC's allowance, for as long as it likes.
      let read = 0;
      for (const signature of fresh.slice(0, this.opts.mostPerPass ?? MOST_PER_PASS)) {
        const tx = await this.transaction(signature);
        // a transaction the RPC does not have yet is read on the next pass: the cursor stays before it
        if (!tx) break;
        read += 1;
        const a = assessTransaction(tx, { ...ctxBase, ownerSigned: signature in record.ownerSignatures || !!this.reported.get(wallet)?.has(signature) });
        const event = await this.raise(wallet, a, tx);
        if (event) raised.push(event);
        // what raised an alert is not taken as normal: a thief's first transfer must not make the second one familiar
        if (a.level === null || a.level === "info") baseline.learn(tx, wallet);
        record.cursor = signature;
      }
      // what is listed and not yet read is read on this wallet's very next turn, not when its accounts next move
      record.more = read < fresh.length;
    }

    // The accounts themselves: what an instruction list can hide. What is watched here (who may spend a token
    // account, who owns it, which program owns the wallet) changes only by a transaction the wallet signs, and
    // every such transaction is in the list just read. So the accounts are read when that list had something
    // new, on the first pass, and every quarter of an hour regardless, in case that reasoning has a hole. A
    // quiet wallet then costs one call a pass instead of four, which is what lets an RPC that rations its
    // heavy calls keep up with the pace the plans promise.
    const at = this.now();
    // a record written before this was kept had its accounts read on every pass: its last pass is when
    const accountsReadAt = record.accountsReadAt ?? record.lastSeenAt ?? undefined;
    if (somethingNew || accountsReadAt === undefined || at - accountsReadAt >= (this.opts.accountsEverySeconds ?? 900)) {
      const accounts = await this.tokenAccounts(wallet);
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
    }

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
    const chosen = this.store.wallets().filter((w) => !only || only(w.address));
    const now = this.now();
    const every = typeof this.opts.fullEverySeconds === "function" ? this.opts.fullEverySeconds() : this.opts.fullEverySeconds ?? 600;
    // Why a wallet would need its transactions read, most pressing first: the RPC has just spoken of it (0);
    // a pass left some unread (1); it was never read (3); or only that it has been long enough (4). A look
    // that differs is 2, and is decided below.
    const kept = new Map<string, { print: string | undefined; known: boolean; why: number | null }>();
    for (const w of chosen) {
      const r = this.store.record(w.address);
      const known = r.lastSeenAt !== null;
      const why = opts.full?.(w.address) === true ? 0 : r.more === true ? 1 : !known ? 3 : now - (r.passedAt ?? 0) >= every ? 4 : null;
      kept.set(w.address, { print: r.glance?.print, known, why });
    }
    // a wallet never read has no token accounts on record to look at: its first pass finds them
    const { prints, failed } = await this.glance(chosen.filter((w) => kept.get(w.address)!.known));
    const wanted: { w: WatchedWallet; print: string | undefined; why: number; moved: boolean }[] = [];
    const same: string[] = [];
    for (const w of chosen) {
      const k = kept.get(w.address)!;
      const failure = failed.get(w.address);
      if (failure !== undefined) { blind.push({ wallet: w.address, why: failure }); continue; }
      const print = prints.get(w.address);
      const moved = k.known && (print === undefined || print !== k.print);
      if (k.why !== null || moved) wanted.push({ w, print, why: Math.min(k.why ?? 2, moved ? 2 : 9), moved }); else same.push(w.address);
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
        try { raised.push(...(await this.pass(next.w, next.print))); } catch (e) { blind.push({ wallet: next.w.address, why: String((e as Error).message ?? e) }); }
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
