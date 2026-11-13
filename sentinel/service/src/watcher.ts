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

const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

/** Sends an alert to the owner. The text is a plain sentence: it never carries a link, and never asks for a signature. */
export interface Notifier {
  notify(wallet: string, level: Level, sentence: string): Promise<void>;
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
  now?: () => number;
}

export class Watcher {
  private windows = new Map<string, BurstWindow>();
  constructor(private rpc: Rpc, private store: Store, private notifier: Notifier, private opts: WatcherOptions = {}) {}

  private now(): number { return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000); }

  /** Signatures newer than `until`, oldest first. */
  private async signaturesSince(wallet: string, until: string | null, limit: number): Promise<string[]> {
    const out: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page: any[] = (await this.rpc.call("getSignaturesForAddress", [wallet, { limit: Math.min(1000, limit - out.length), ...(before ? { before } : {}), ...(until ? { until } : {}) }])) ?? [];
      for (const s of page) out.push(s.signature);
      if (page.length < 1000 || out.length >= limit) break;
      before = page[page.length - 1].signature;
    }
    return out.reverse();
  }

  private async transaction(signature: string): Promise<ObservedTx | null> {
    return fromRpc(signature, await this.rpc.call("getTransaction", [signature, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]));
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
    return out;
  }

  private async raise(wallet: string, a: Assessment, tx: { signature: string; slot: number; blockTime: number | null } | null): Promise<StoredEvent | null> {
    if (a.level === null) return null;
    const event: StoredEvent = { wallet, signature: tx?.signature ?? "", slot: tx?.slot ?? 0, at: tx?.blockTime ?? this.now(), level: a.level, signals: a.signals.map((s) => s.kind), sentence: a.sentence, rescueWorthy: a.rescueWorthy };
    this.store.addEvent(event);
    // Info is for the Sentinel page; the others go to the owner. A notifier that fails must not stop the watching.
    if (a.level !== "info") await this.notifier.notify(wallet, a.level, a.sentence).catch(() => undefined);
    return event;
  }

  /**
   * One pass over one wallet. The first pass builds the baseline from the wallet's history and raises nothing
   * for it: what already happened is not news. Later passes read what is new, oldest first.
   */
  async pass(w: WatchedWallet): Promise<StoredEvent[]> {
    const wallet = w.address;
    const record = this.store.record(wallet);
    const baseline = Baseline.from(record.baseline);
    const raised: StoredEvent[] = [];
    const ctxBase: Omit<WatchContext, "ownerSigned"> = { wallet, baseline, sentinelDelegate: w.sentinelDelegate, drainers: this.opts.drainers ?? new Set(), reviewedPrograms: this.opts.reviewedPrograms, window: this.windows.get(wallet) ?? this.windows.set(wallet, new BurstWindow()).get(wallet)! };

    if (record.cursor === null && record.baseline === null) {
      const history = await this.signaturesSince(wallet, null, this.opts.historyLimit ?? 200);
      for (const signature of history) {
        const tx = await this.transaction(signature);
        if (tx) baseline.learn(tx, wallet);
      }
      record.cursor = history.at(-1) ?? null;
    } else {
      for (const signature of await this.signaturesSince(wallet, record.cursor, 1000)) {
        const tx = await this.transaction(signature);
        // a transaction the RPC does not have yet is read on the next pass: the cursor stays before it
        if (!tx) break;
        const a = assessTransaction(tx, { ...ctxBase, ownerSigned: signature in record.ownerSignatures });
        const event = await this.raise(wallet, a, tx);
        if (event) raised.push(event);
        // what raised an alert is not taken as normal: a thief's first transfer must not make the second one familiar
        if (a.level === null || a.level === "info") baseline.learn(tx, wallet);
        record.cursor = signature;
      }
    }

    // the accounts themselves: what an instruction list can hide
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

    record.baseline = baseline.toJSON();
    record.lastSeenAt = this.now();
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

  /** One pass over every wallet. A wallet that could not be read is reported, and the others are still read. */
  async passAll(): Promise<{ raised: StoredEvent[]; blind: { wallet: string; why: string }[] }> {
    const raised: StoredEvent[] = [];
    const blind: { wallet: string; why: string }[] = [];
    for (const w of this.store.wallets()) {
      try { raised.push(...(await this.pass(w))); } catch (e) { blind.push({ wallet: w.address, why: String((e as Error).message ?? e) }); }
    }
    return { raised, blind };
  }

  /** Wallets not read successfully for `seconds`: the owner is told when watching stops. */
  stale(seconds: number): string[] {
    const now = this.now();
    return this.store.wallets().map((w) => w.address).filter((a) => { const at = this.store.record(a).lastSeenAt; return at === null || now - at > seconds; });
  }
}
