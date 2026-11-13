/**
 * What the watcher keeps: per wallet, where it has read up to, the wallet's baseline, its token accounts as
 * last seen, and the alerts it raised. Nothing that would turn a breach into a map of someone's life: no
 * names, no balances beyond the alert that mentions one.
 *
 * `FileStore` is one JSON file, replaced whole on every save. It is enough for a first deployment with few
 * wallets; the spec's tables (profiles, channels, rescues) come with the service around this.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BaselineState } from "./baseline.js";
import type { ChannelKind, Tier } from "./plans.js";
import type { Level, SignalKind, TokenAccountState } from "./signals.js";

export interface WatchedWallet {
  address: string;
  /** The delegate the wallet approved for Sentinel, when it is armed. */
  sentinelDelegate?: string;
}

export interface StoredEvent {
  /** Given by the store when the event is added. */
  id?: string;
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

/** One owner. No name and no email: an owner is whoever can sign with one of the profile's wallets. */
export interface Profile {
  id: string;
  /** Watch is free. Pro is paid (plans.ts says what each gives). */
  tier: Tier;
  createdAt: number;
  autoRescue: boolean;
  /** The subscription behind the paid tier, when there is one. Stripe holds the card and the email; this holds only its ids. */
  billing?: { customer: string; subscription: string; price: "full" | "holder"; status: string };
}
/** Which profile a watched wallet belongs to, and the hash of the token its owner's browser reports with. */
export interface WalletOwner {
  profile: string; addedAt: number; reportTokenHash?: string;
  /** Kept in the profile but not read: the profile has more wallets than its tier watches. */
  paused?: boolean;
}
/** A way to reach an owner. The target is sealed (crypto.ts): the stored file alone does not say where alerts go. */
export interface Channel { id: string; profile: string; kind: ChannelKind; target: string; hint: string; addedAt: number }
/** `wallet`: the one whose signature started the session. */
export interface Session { tokenHash: string; profile: string; expiresAt: number; wallet?: string }

/** The service's own tables (accounts.ts reads and writes them). */
export interface AccountsData {
  profiles: Record<string, Profile>;
  /** By wallet address. */
  owners: Record<string, WalletOwner>;
  channels: Channel[];
  sessions: Session[];
}
const noAccounts = (): AccountsData => ({ profiles: {}, owners: {}, channels: [], sessions: [] });

interface Data { wallets: WatchedWallet[]; records: Record<string, WalletRecord>; events: StoredEvent[]; accounts: AccountsData }

export class MemoryStore implements Store {
  protected data: Data = { wallets: [], records: {}, events: [], accounts: noAccounts() };
  constructor(wallets: WatchedWallet[] = []) { this.data.wallets = wallets; }
  wallets(): WatchedWallet[] { return this.data.wallets; }
  record(wallet: string): WalletRecord { return structuredClone(Object.hasOwn(this.data.records, wallet) ? this.data.records[wallet]! : fresh()); }
  private watched(wallet: string): boolean { return this.data.wallets.some((w) => w.address === wallet); }
  // A wallet can be removed while it is being read. What that read then writes is dropped: forgotten stays forgotten.
  save(wallet: string, record: WalletRecord): void { if (!this.watched(wallet)) return; this.data.records[wallet] = structuredClone(record); this.persist(); }
  addEvent(event: StoredEvent): void { event.id ??= randomBytes(9).toString("base64url"); if (!this.watched(event.wallet)) return; this.data.events.push(event); if (this.data.events.length > 10_000) this.data.events.splice(0, this.data.events.length - 10_000); this.persist(); }
  events(wallet: string): StoredEvent[] { return this.data.events.filter((e) => e.wallet === wallet); }
  event(id: string): StoredEvent | undefined { const e = this.data.events.find((x) => x.id === id); return e ? { ...e } : undefined; }
  /** Records what the owner said about an alert. False when there is no such alert. */
  answer(id: string, answer: NonNullable<StoredEvent["answer"]>): boolean {
    const e = this.data.events.find((x) => x.id === id);
    if (!e) return false;
    e.answer = answer;
    this.persist();
    return true;
  }
  /** Starts watching a wallet. A wallet already watched is left as it is. */
  watch(wallet: WatchedWallet): void {
    if (this.data.wallets.some((w) => w.address === wallet.address)) return;
    this.data.wallets.push(wallet);
    this.persist();
  }
  /** Stops reading a wallet without forgetting it: its record and alerts stay for when it is watched again. */
  unwatch(address: string): void {
    if (!this.data.wallets.some((w) => w.address === address)) return;
    this.data.wallets = this.data.wallets.filter((w) => w.address !== address);
    this.persist();
  }
  /** Stops watching a wallet and forgets what was kept about it: its baseline, its token accounts, its alerts. */
  forget(address: string): void {
    this.data.wallets = this.data.wallets.filter((w) => w.address !== address);
    delete this.data.records[address];
    this.data.events = this.data.events.filter((e) => e.wallet !== address);
    this.persist();
  }
  /** The service's tables, to read and change in place; `flush` writes them. */
  get accounts(): AccountsData { return this.data.accounts; }
  flush(): void { this.persist(); }
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
      this.data = { wallets: wallets.length ? wallets : stored.wallets ?? [], records: stored.records ?? {}, events: stored.events ?? [], accounts: { ...noAccounts(), ...(stored.accounts ?? {}) } };
    }
  }
  protected override persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
