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

const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

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
  pass(w: WatchedWallet): Promise<StoredEvent[]> {
    return this.exclusive(w.address, () => this.passNow(w));
  }

  private async passNow(w: WatchedWallet): Promise<StoredEvent[]> {
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
      for (const signature of fresh.slice(0, this.opts.mostPerPass ?? MOST_PER_PASS)) {
        const tx = await this.transaction(signature);
        // a transaction the RPC does not have yet is read on the next pass: the cursor stays before it
        if (!tx) break;
        const a = assessTransaction(tx, { ...ctxBase, ownerSigned: signature in record.ownerSignatures || !!this.reported.get(wallet)?.has(signature) });
        const event = await this.raise(wallet, a, tx);
        if (event) raised.push(event);
        // what raised an alert is not taken as normal: a thief's first transfer must not make the second one familiar
        if (a.level === null || a.level === "info") baseline.learn(tx, wallet);
        record.cursor = signature;
      }
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
   * One pass over every wallet, or over the ones `only` picks. A wallet that could not be read is reported,
   * and the others are still read.
   */
  async passAll(only?: (address: string) => boolean): Promise<{ raised: StoredEvent[]; blind: { wallet: string; why: string }[] }> {
    const raised: StoredEvent[] = [];
    const blind: { wallet: string; why: string }[] = [];
    const queue = this.store.wallets().filter((w) => !only || only(w.address));
    const reader = async () => {
      for (let w = queue.shift(); w; w = queue.shift()) {
        try { raised.push(...(await this.pass(w))); } catch (e) { blind.push({ wallet: w.address, why: String((e as Error).message ?? e) }); }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.opts.readers ?? 1, queue.length)) }, reader));
    return { raised, blind };
  }

  /** Wallets not read successfully for `seconds`: the owner is told when watching stops. */
  stale(seconds: number): string[] {
    const now = this.now();
    return this.store.wallets().map((w) => w.address).filter((a) => { const at = this.store.record(a).lastSeenAt; return at === null || now - at > seconds; });
  }
}
