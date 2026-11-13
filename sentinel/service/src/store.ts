/**
 * What the watcher keeps: per wallet, where it has read up to, the wallet's baseline, its token accounts as
 * last seen, and the alerts it raised. Nothing that would turn a breach into a map of someone's life: no
 * names, no balances beyond the alert that mentions one.
 *
 * `FileStore` is one JSON file, replaced whole on every save. It is enough for a first deployment with few
 * wallets; the spec's tables (profiles, channels, rescues) come with the service around this.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BaselineState } from "./baseline.js";
import type { Level, SignalKind, TokenAccountState } from "./signals.js";

export interface WatchedWallet {
  address: string;
  /** The delegate the wallet approved for Sentinel, when it is armed. */
  sentinelDelegate?: string;
}

export interface StoredEvent {
  wallet: string;
  /** The transaction, or empty for a change seen on an account. */
  signature: string;
  slot: number;
  at: number | null;
  level: Level;
  signals: SignalKind[];
  sentence: string;
  rescueWorthy: boolean;
  /** What the owner said about it. */
  answer?: "this_was_me" | "rescue" | "ignore";
}

export interface WalletRecord {
  /** The newest signature already read; null before the first pass. */
  cursor: string | null;
  baseline: BaselineState | null;
  /** The wallet's token accounts as last seen, by address. */
  tokenAccounts: Record<string, TokenAccountState>;
  /** The program that owned the wallet account when last seen. */
  ownerProgram: string | null;
  /** When the wallet was last read successfully, unix seconds: the health check. */
  lastSeenAt: number | null;
  /** Signatures the owner's browser reported as theirs, with the time each was reported. */
  ownerSignatures: Record<string, number>;
}

export interface Store {
  wallets(): WatchedWallet[];
  record(wallet: string): WalletRecord;
  save(wallet: string, record: WalletRecord): void;
  addEvent(event: StoredEvent): void;
  events(wallet: string): StoredEvent[];
}

const fresh = (): WalletRecord => ({ cursor: null, baseline: null, tokenAccounts: {}, ownerProgram: null, lastSeenAt: null, ownerSignatures: {} });

interface Data { wallets: WatchedWallet[]; records: Record<string, WalletRecord>; events: StoredEvent[] }

export class MemoryStore implements Store {
  protected data: Data = { wallets: [], records: {}, events: [] };
  constructor(wallets: WatchedWallet[] = []) { this.data.wallets = wallets; }
  wallets(): WatchedWallet[] { return this.data.wallets; }
  record(wallet: string): WalletRecord { return structuredClone(this.data.records[wallet] ?? fresh()); }
  save(wallet: string, record: WalletRecord): void { this.data.records[wallet] = structuredClone(record); this.persist(); }
  addEvent(event: StoredEvent): void { this.data.events.push(event); if (this.data.events.length > 10_000) this.data.events.splice(0, this.data.events.length - 10_000); this.persist(); }
  events(wallet: string): StoredEvent[] { return this.data.events.filter((e) => e.wallet === wallet); }
  /** Tells the watcher that a signature was the owner's own (from the extension's opt-in). Kept 30 days. */
  reportOwnerSignature(wallet: string, signature: string, now: number): void {
    const r = this.record(wallet);
    r.ownerSignatures[signature] = now;
    for (const [sig, at] of Object.entries(r.ownerSignatures)) if (now - at > 30 * 86_400) delete r.ownerSignatures[sig];
    this.save(wallet, r);
  }
  protected persist(): void { /* memory only */ }
}

export class FileStore extends MemoryStore {
  constructor(private file: string, wallets: WatchedWallet[] = []) {
    super(wallets);
    if (existsSync(file)) {
      const stored = JSON.parse(readFileSync(file, "utf8")) as Partial<Data>;
      this.data = { wallets: wallets.length ? wallets : stored.wallets ?? [], records: stored.records ?? {}, events: stored.events ?? [] };
    }
  }
  protected override persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
