/**
 * What the watcher keeps: per wallet, where it has read up to, the wallet's baseline, its token accounts as
 * last seen, and the alerts it raised. Nothing that would turn a breach into a map of someone's life: no
 * names, no balances beyond the alert that mentions one.
 *
 * `FileStore` is one JSON file, replaced whole on every save, with a copy set aside each day. It is enough
 * for a first deployment with few wallets; the spec's tables (profiles, channels, rescues) come with the
 * service around this.
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BaselineState } from "./baseline.js";
import type { ChannelKind, Tier } from "./plans.js";
import type { Level, SignalKind, TokenAccountState } from "./signals.js";

export interface WatchedWallet {
  address: string;
  /** The delegate the wallet approved for Sentinel, when it is armed. */
  sentinelDelegate?: string;
  /** The vault that setup names: where a rescue of this wallet goes, and how one is told from a taking. */
  sentinelVault?: string;
  /**
   * What the owner asked for on the Sentinel page a moment ago, until the chain shows it: a setup for rescue
   * (approvals to `delegate` are then that setup, not a stranger's), or taking the setup away (`delegate`
   * null: the permissions going is then the owner's doing).
   */
  rescueChange?: { delegate: string | null; vault?: string; until: number };
}

/** The address whose approvals and movements are rescue's, for this wallet, now. */
export const rescueDelegateOf = (w: WatchedWallet, now: number): string | undefined =>
  w.sentinelDelegate ?? (w.rescueChange && w.rescueChange.until > now && w.rescueChange.delegate ? w.rescueChange.delegate : undefined);
/** The vault a rescue of this wallet goes to, as far as is known now. */
export const rescueVaultOf = (w: WatchedWallet, now: number): string | undefined =>
  w.sentinelDelegate ? w.sentinelVault : w.rescueChange && w.rescueChange.until > now && w.rescueChange.delegate ? w.rescueChange.vault : undefined;
/** True while the owner is taking the rescue setup away through the page. */
export const disarmingNow = (w: WatchedWallet, now: number): boolean => !!w.rescueChange && w.rescueChange.until > now && w.rescueChange.delegate === null;

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
  /** For a taking: whose permissions it went under. */
  takers?: string[];
  /** What the owner said about it. */
  answer?: "this_was_me" | "rescue" | "ignore";
  /** True when it was pushed and no channel took it (or there was none): the owner has only the page for it. */
  undelivered?: boolean;
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
  /** When its accounts (not just its list of transactions) were last read. Absent before the first time. */
  accountsReadAt?: number;
  /** When its list of transactions was last read through: a full pass, as against a look at its accounts. */
  passedAt?: number;
  /** True when the last pass left transactions unread (too many for one pass, or one the RPC could not show yet): the next turn is a pass, whatever a look says. */
  more?: boolean;
  /** True while one of its token accounts holds less than the transactions found so far account for: the next turn is a pass, which looks again. */
  unsettled?: boolean;
  /** Since when its list of transactions has had more in it than a pass reads, and when its owner was last told so. */
  moreSince?: number;
  behindToldAt?: number;
  /** Holders of a permission whose takings the owner called their own doing ("this was me"): the newest twenty. */
  trustedTakers?: string[];
  /**
   * What its accounts looked like at the last look (watcher.ts, `glance`): the wallet's balance and owner, and
   * each token account's amount and who may spend or close it, as one line of text. A look that finds the
   * same line found nothing new.
   */
  glance?: { print: string; at: number };
  /** Signatures the owner's browser reported as theirs, with the time each was reported. */
  ownerSignatures: Record<string, number>;
}

export interface Store {
  wallets(): WatchedWallet[];
  record(wallet: string): WalletRecord;
  save(wallet: string, record: WalletRecord): void;
  addEvent(event: StoredEvent): void;
  events(wallet: string): StoredEvent[];
  /** Notes that an alert reached no channel. */
  markUndelivered?(id: string): void;
  /** Notes that these wallets were looked at and nothing had changed. Many at once, and written out lazily. */
  seen?(addresses: string[], at: number): void;
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
  billing?: {
    customer: string; subscription: string; price: "full" | "holder"; status: string;
    /** When the month that is paid for ends: the next bill, or the plan's last day. Unix seconds. */
    periodEnd?: number;
    /** Set when the owner cancelled: the plan runs until then and does not renew. */
    endsAt?: number;
  };
  /**
   * Months of the paid tier paid for ahead, in USDC or SOL (prepaid.ts). The plan runs until `until` and does
   * not renew by itself. `payments`: what was paid, the newest twelve. `remindedFor`: the `until` its owner
   * was last told is coming.
   */
  prepaid?: { until: number; remindedFor?: number; payments: Payment[] };
}
export type PayAsset = "USDC" | "SOL";
/** One payment that was credited: the transaction, what it paid in its asset's smallest units, and for how many months. */
export interface Payment { signature: string; asset: PayAsset; units: string; months: number; cents: number; at: number }
/**
 * An amount a profile was quoted, and the address that marks the payment as this one (a "reference": an
 * address nobody holds, named in the paying transaction and in no other).
 */
export interface PayIntent { reference: string; profile: string; asset: PayAsset; units: string; months: number; cents: number; createdAt: number; expiresAt: number; paidBy?: string }
/** Which profile a watched wallet belongs to, and the hash of the token its owner's browser reports with. */
export interface WalletOwner {
  profile: string; addedAt: number; reportTokenHash?: string;
  /** Kept in the profile but not read: the profile has more wallets than its tier watches. */
  paused?: boolean;
}
/** A way to reach an owner. The target is sealed (crypto.ts): the stored file alone does not say where alerts go. */
export interface Channel {
  id: string; profile: string; kind: ChannelKind; target: string; hint: string; addedAt: number;
  /** When it last took a message, unix seconds. */
  delivered?: number;
  /** Set while it is refusing them: since when, and what it answered, in words fit for its owner. */
  failed?: { at: number; why: string };
}
/** `wallet`: the one whose signature started the session. */
export interface Session { tokenHash: string; profile: string; expiresAt: number; wallet?: string }

/** The service's own tables (accounts.ts reads and writes them). */
export interface AccountsData {
  profiles: Record<string, Profile>;
  /** By wallet address. */
  owners: Record<string, WalletOwner>;
  channels: Channel[];
  sessions: Session[];
  /** Amounts quoted for payment in USDC or SOL and not yet a week old. */
  intents?: PayIntent[];
  /** Transactions already credited, and to which profile: a payment pays for one thing, once. */
  credited?: Record<string, { profile: string; at: number }>;
}
const noAccounts = (): AccountsData => ({ profiles: {}, owners: {}, channels: [], sessions: [] });

interface Data { wallets: WatchedWallet[]; records: Record<string, WalletRecord>; events: StoredEvent[]; accounts: AccountsData; said?: Record<string, number> }

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
  markUndelivered(id: string): void {
    const e = this.data.events.find((x) => x.id === id);
    if (!e || e.undelivered) return;
    e.undelivered = true;
    this.persist();
  }
  /**
   * These wallets were looked at just now and nothing had changed. Only the time is kept, for every one of
   * them at once, and it is written out soon rather than now: a thousand wallets looked at every minute must
   * not mean a thousand writes of the whole file.
   */
  seen(addresses: string[], at: number): void {
    let any = false;
    for (const a of addresses) {
      const r = Object.hasOwn(this.data.records, a) ? this.data.records[a] : undefined;
      if (r && this.watched(a)) { r.lastSeenAt = at; any = true; }
    }
    if (any) this.persistSoon();
  }
  /** Starts watching a wallet. A wallet already watched is left as it is. */
  watch(wallet: WatchedWallet): void {
    if (this.data.wallets.some((w) => w.address === wallet.address)) return;
    this.data.wallets.push(wallet);
    this.persist();
  }
  /**
   * Notes which address, if any, the wallet has approved for Sentinel's rescue (rescue.ts reads it from the
   * chain). The watcher takes what that address moves for a rescue and not for a theft. True when it changed.
   */
  setDelegate(address: string, delegate: string | null, vault?: string): boolean {
    const w = this.data.wallets.find((x) => x.address === address);
    if (!w || ((w.sentinelDelegate ?? null) === delegate && (!delegate || w.sentinelVault === vault))) return false;
    const changed = (w.sentinelDelegate ?? null) !== delegate;
    if (delegate) { w.sentinelDelegate = delegate; if (vault) w.sentinelVault = vault; else delete w.sentinelVault; } else { delete w.sentinelDelegate; delete w.sentinelVault; }
    this.persist();
    return changed;
  }
  /** Notes what the owner asked for on the page (see `rescueChange`), good until `until`. */
  expectRescueChange(address: string, delegate: string | null, until: number, vault?: string): void {
    const w = this.data.wallets.find((x) => x.address === address);
    if (!w) return;
    w.rescueChange = { delegate, ...(delegate && vault ? { vault } : {}), until };
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
  /** When each thing was last said to whoever runs the service (ops.ts), so that a restart does not say it all again. */
  get said(): Record<string, number> { return (this.data.said ??= {}); }
  flush(): void { this.persist(); }
  /** Tells the watcher that a signature was the owner's own (from the extension's opt-in). Kept 30 days. */
  reportOwnerSignature(wallet: string, signature: string, now: number): void {
    const r = this.record(wallet);
    r.ownerSignatures[signature] = now;
    for (const [sig, at] of Object.entries(r.ownerSignatures)) if (now - at > 30 * 86_400) delete r.ownerSignatures[sig];
    this.save(wallet, r);
  }
  protected persist(): void { /* memory only */ }
  protected persistSoon(): void { /* memory only */ }
}

/** How long a time-of-last-look may wait to be written out. Nothing but the page's "read a moment ago" depends on it. */
export const LAZY_WRITE_SECONDS = 30;

/** How many daily copies are kept. What an owner had the service forget is gone from the last of them after this many days. */
export const SNAPSHOT_DAYS = 7;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads a data file, or throws when it is not one: cut short, not JSON, or not this shape. */
function readData(path: string): Partial<Data> {
  const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(stored)) throw new Error("not a data file");
  const { wallets, records, events, accounts } = stored;
  if ((wallets !== undefined && !Array.isArray(wallets)) || (records !== undefined && !isRecord(records)) || (events !== undefined && !Array.isArray(events)) || (accounts !== undefined && !isRecord(accounts))) throw new Error("not a data file");
  return stored as Partial<Data>;
}

/** Writes a file whole: to a new file, onto the disk, then into place. A crash leaves the old one or the new one, never half. */
function writeWhole(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

export class FileStore extends MemoryStore {
  /** The snapshot the service started from, when its data file was missing or could not be read. */
  readonly restoredFrom: string | null = null;
  /** Where a data file that could not be read was put. */
  readonly setAside: string | null = null;

  /**
   * Opens the data file. A file that cannot be read is set aside, never overwritten, and the newest daily
   * snapshot that can be read is used instead; the same when the file is gone and snapshots are there. With
   * neither, it starts empty. With a file that cannot be read and no snapshot, it does not start: an empty
   * service would have forgotten every owner, and whoever runs it has to decide.
   */
  constructor(private file: string, wallets: WatchedWallet[] = []) {
    super(wallets);
    let stored: Partial<Data> | null = null;
    if (existsSync(file)) {
      try { stored = readData(file); } catch {
        this.setAside = `${file}.unreadable-${Date.now()}`;
        renameSync(file, this.setAside);
      }
    }
    if (!stored) {
      for (const snapshot of this.snapshots().reverse()) {
        try { stored = readData(snapshot); this.restoredFrom = snapshot; break; } catch { /* the one before it */ }
      }
      if (!stored && this.setAside) throw new Error(`the data file could not be read and no snapshot can stand in for it. It was set aside as ${this.setAside}; nothing was overwritten.`);
    }
    if (stored) this.data = { wallets: wallets.length ? wallets : stored.wallets ?? [], records: stored.records ?? {}, events: stored.events ?? [], accounts: { ...noAccounts(), ...(stored.accounts ?? {}) }, ...(isRecord(stored.said) ? { said: stored.said as Record<string, number> } : {}) };
    if (this.restoredFrom) this.persist();
  }

  private get snapshotDir(): string { return join(dirname(this.file), "snapshots"); }

  /** The daily snapshots there are, oldest first. */
  snapshots(): string[] {
    if (!existsSync(this.snapshotDir)) return [];
    return readdirSync(this.snapshotDir).filter((n) => /^sentinel-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().map((n) => join(this.snapshotDir, n));
  }

  /**
   * Sets a copy of everything aside, once a day, and keeps the last few. The data file is one file on one
   * disk; a snapshot is what a bad write, a bad deploy or a slip of the hand is recovered from. Returns the
   * snapshot it wrote, or null when today's is already there.
   */
  snapshot(now: number): string | null {
    const path = join(this.snapshotDir, `sentinel-${new Date(now * 1000).toISOString().slice(0, 10)}.json`);
    if (existsSync(path)) return null;
    mkdirSync(this.snapshotDir, { recursive: true, mode: 0o700 });
    writeWhole(path, JSON.stringify(this.data));
    for (const old of this.snapshots().slice(0, -SNAPSHOT_DAYS)) unlinkSync(old);
    return path;
  }

  private soon: ReturnType<typeof setTimeout> | null = null;

  protected override persist(): void {
    if (this.soon) { clearTimeout(this.soon); this.soon = null; }
    mkdirSync(dirname(this.file), { recursive: true });
    writeWhole(this.file, JSON.stringify(this.data));
  }

  /** Within half a minute, unless something that matters is written first (which writes this too). */
  protected override persistSoon(): void {
    if (this.soon) return;
    this.soon = setTimeout(() => { this.soon = null; this.persist(); }, LAZY_WRITE_SECONDS * 1000);
    (this.soon as { unref?: () => void }).unref?.();
  }
}
