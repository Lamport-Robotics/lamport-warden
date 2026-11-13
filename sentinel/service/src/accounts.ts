/**
 * Who owns which watched wallet, how to reach them, and who is signed in.
 *
 * An owner has no name here and no password. A profile is a set of wallets, and the owner is whoever can sign
 * with one of them. So:
 *   - a wallet is added only on its own signature, and belongs to one profile;
 *   - a session, and the token an owner's browser reports with, are kept as hashes;
 *   - where alerts go is sealed with a key that is not in the stored file;
 *   - taking the last wallet out of a profile removes the profile and everything kept for it.
 */
import { randomBytes } from "node:crypto";
import { hashToken, randomToken, sameHash, seal, unseal } from "./crypto.js";
import type { Channel, MemoryStore, Profile, StoredEvent } from "./store.js";

export const SESSION_SECONDS = 7 * 86_400;
/** How many wallets a profile may have watched, by tier. */
export const WALLET_LIMIT: Record<Profile["tier"], number> = { watch: 3, rescue: 10 };
export const CHANNEL_LIMIT = 3;

export type Refusal = { ok: false; status: number; why: string };
const refuse = (status: number, why: string): Refusal => ({ ok: false, status, why });

/** Where an alert may be sent. Only a topic on a host the service was told about: it posts to no other address. */
export function cleanNtfyTarget(input: unknown, hosts: ReadonlySet<string>): string | null {
  if (typeof input !== "string" || input.length > 200) return null;
  let u: URL;
  try { u = new URL(input.trim()); } catch { return null; }
  if (u.protocol !== "https:" || !hosts.has(u.host.toLowerCase()) || u.username || u.password || u.search || u.hash) return null;
  // one path part, long enough that it is not guessed: on ntfy, whoever knows the topic can read it
  if (!/^\/[A-Za-z0-9_-]{8,64}$/.test(u.pathname)) return null;
  return `https://${u.host.toLowerCase()}${u.pathname}`;
}

export class Accounts {
  constructor(private store: MemoryStore, private dataKey: Buffer, private opts: { ntfyHosts?: ReadonlySet<string>; maxWallets?: number } = {}) {}

  /** No room for another wallet across the whole service: what it can read is finite, and a full house is said, not hidden. */
  private full(): boolean { return this.opts.maxWallets !== undefined && Object.keys(this.data.owners).length >= this.opts.maxWallets; }

  private get data() { return this.store.accounts; }
  private get ntfyHosts(): ReadonlySet<string> { return this.opts.ntfyHosts ?? new Set(["ntfy.sh"]); }

  profile(id: string): Profile | undefined { return this.data.profiles[id]; }
  profileOf(wallet: string): string | undefined { return this.data.owners[wallet]?.profile; }
  walletsOf(profile: string): string[] { return Object.entries(this.data.owners).filter(([, o]) => o.profile === profile).map(([address]) => address); }
  channelsOf(profile: string): Channel[] { return this.data.channels.filter((c) => c.profile === profile); }
  reporting(wallet: string): boolean { return !!this.data.owners[wallet]?.reportTokenHash; }
  paused(wallet: string): boolean { return this.data.owners[wallet]?.paused === true; }
  profiles(): Profile[] { return Object.values(this.data.profiles); }

  /**
   * Watches as many of the profile's wallets as its tier allows, oldest first, and pauses the rest. A paused
   * wallet stays in the profile with what was learned about it, and is read again when there is room.
   */
  enforce(profile: string): void {
    const p = this.data.profiles[profile];
    if (!p) return;
    const mine = Object.entries(this.data.owners).filter(([, o]) => o.profile === profile).sort((a, b) => a[1].addedAt - b[1].addedAt);
    mine.forEach(([address, owner], i) => {
      if (i < WALLET_LIMIT[p.tier]) { delete owner.paused; this.store.watch({ address }); }
      else { owner.paused = true; this.store.unwatch(address); }
    });
    this.store.flush();
  }

  /** Changes what the profile pays for. Moving down pauses the wallets over the limit; moving up reads them again. */
  setTier(profile: string, tier: Profile["tier"]): void {
    const p = this.data.profiles[profile];
    if (!p || p.tier === tier) return;
    p.tier = tier;
    this.enforce(profile);
  }

  setBilling(profile: string, billing: Profile["billing"] | null): void {
    const p = this.data.profiles[profile];
    if (!p) return;
    if (billing === null) delete p.billing; else p.billing = billing;
    this.store.flush();
  }

  profileBySubscription(subscription: string): Profile | undefined {
    return Object.values(this.data.profiles).find((p) => p.billing?.subscription === subscription);
  }

  /**
   * A wallet has just proved itself with a signature. Signing in: its profile, or a new one with this wallet
   * in it. Linking: it joins the profile that asked, unless it is already someone else's.
   */
  admit(wallet: string, into: string | null, now: number): { ok: true; profile: string; created: boolean } | Refusal {
    const owner = this.data.owners[wallet];
    if (into === null) {
      if (owner) return { ok: true, profile: owner.profile, created: false };
      if (this.full()) return refuse(503, "Sentinel is watching as many wallets as it can for now. Try again later.");
      const id = randomBytes(12).toString("base64url");
      this.data.profiles[id] = { id, tier: "watch", createdAt: now, autoRescue: false };
      this.data.owners[wallet] = { profile: id, addedAt: now };
      this.store.watch({ address: wallet });
      this.store.flush();
      return { ok: true, profile: id, created: true };
    }
    const profile = this.data.profiles[into];
    if (!profile) return refuse(401, "sign in again.");
    if (owner) return owner.profile === into ? { ok: true, profile: into, created: false } : refuse(409, "that wallet is already watched under another profile.");
    if (this.full()) return refuse(503, "Sentinel is watching as many wallets as it can for now. Try again later.");
    if (this.walletsOf(into).length >= WALLET_LIMIT[profile.tier]) return refuse(403, `this profile watches ${WALLET_LIMIT[profile.tier]} wallets, which is its limit.`);
    this.data.owners[wallet] = { profile: into, addedAt: now };
    this.store.watch({ address: wallet });
    this.store.flush();
    return { ok: true, profile: into, created: false };
  }

  /** Stops watching a wallet and forgets it. The last one takes the profile with it. */
  removeWallet(profile: string, wallet: string): { ok: true; profileRemoved: boolean } | Refusal {
    if (this.data.owners[wallet]?.profile !== profile) return refuse(404, "that wallet is not in this profile.");
    // the last wallet takes the profile with it, and a subscription with nobody behind it would go on charging
    const billing = this.data.profiles[profile]?.billing;
    if (this.walletsOf(profile).length === 1 && billing && ["active", "trialing", "past_due"].includes(billing.status)) return refuse(409, "this is the profile's last wallet and the paid plan is still running. Cancel the plan first, then remove it.");
    delete this.data.owners[wallet];
    this.store.forget(wallet);
    const profileRemoved = this.walletsOf(profile).length === 0;
    if (!profileRemoved) this.enforce(profile); // a paused wallet takes the place that came free
    if (profileRemoved) {
      delete this.data.profiles[profile];
      this.data.channels = this.data.channels.filter((c) => c.profile !== profile);
      this.data.sessions = this.data.sessions.filter((s) => s.profile !== profile);
    }
    this.store.flush();
    return { ok: true, profileRemoved };
  }

  // ---- sessions

  startSession(profile: string, now: number): string {
    const token = randomToken();
    this.data.sessions = this.data.sessions.filter((s) => s.expiresAt > now);
    // a handful per profile: the oldest gives way
    const mine = this.data.sessions.filter((s) => s.profile === profile);
    if (mine.length >= 5) this.data.sessions.splice(this.data.sessions.indexOf(mine[0]!), 1);
    this.data.sessions.push({ tokenHash: hashToken(token), profile, expiresAt: now + SESSION_SECONDS });
    this.store.flush();
    return token;
  }

  /** The profile a session token stands for, or null. */
  session(token: string | null, now: number): string | null {
    if (!token) return null;
    const hash = hashToken(token);
    const s = this.data.sessions.find((x) => sameHash(x.tokenHash, hash));
    return s && s.expiresAt > now && this.data.profiles[s.profile] ? s.profile : null;
  }

  endSession(token: string): void {
    const hash = hashToken(token);
    this.data.sessions = this.data.sessions.filter((x) => !sameHash(x.tokenHash, hash));
    this.store.flush();
  }

  // ---- "this signature was mine"

  /** A new token for the owner's browser to report with. Shown once; the old one stops working. */
  newReportToken(profile: string, wallet: string): { ok: true; token: string } | Refusal {
    const owner = this.data.owners[wallet];
    if (owner?.profile !== profile) return refuse(404, "that wallet is not in this profile.");
    const token = randomToken();
    owner.reportTokenHash = hashToken(token);
    this.store.flush();
    return { ok: true, token };
  }

  dropReportToken(profile: string, wallet: string): boolean {
    const owner = this.data.owners[wallet];
    if (owner?.profile !== profile) return false;
    delete owner.reportTokenHash;
    this.store.flush();
    return true;
  }

  /** True when this token is the one issued for this wallet. */
  mayReport(wallet: string, token: string | null): boolean {
    const stored = this.data.owners[wallet]?.reportTokenHash;
    return !!token && !!stored && sameHash(stored, hashToken(token));
  }

  // ---- channels

  addNtfy(profile: string, target: unknown, now: number): { ok: true; channel: { id: string; kind: "ntfy"; hint: string } } | Refusal {
    if (!this.data.profiles[profile]) return refuse(401, "sign in again.");
    const clean = cleanNtfyTarget(target, this.ntfyHosts);
    if (!clean) return refuse(400, `that is not a topic address I can send to. It looks like https://${[...this.ntfyHosts][0] ?? "ntfy.sh"}/a-long-topic-name`);
    if (this.channelsOf(profile).length >= CHANNEL_LIMIT) return refuse(403, `a profile has ${CHANNEL_LIMIT} channels at most.`);
    if (this.targetsOf(profile).includes(clean)) return refuse(409, "that channel is already added.");
    const u = new URL(clean);
    const channel: Channel = { id: randomBytes(6).toString("base64url"), profile, kind: "ntfy", target: seal(this.dataKey, clean), hint: `${u.host}/…${u.pathname.slice(-4)}`, addedAt: now };
    this.data.channels.push(channel);
    this.store.flush();
    return { ok: true, channel: { id: channel.id, kind: "ntfy", hint: channel.hint } };
  }

  removeChannel(profile: string, id: string): boolean {
    const before = this.data.channels.length;
    this.data.channels = this.data.channels.filter((c) => !(c.profile === profile && c.id === id));
    if (this.data.channels.length === before) return false;
    this.store.flush();
    return true;
  }

  private targetsOf(profile: string): string[] {
    return this.channelsOf(profile).map((c) => unseal(this.dataKey, c.target)).filter((t): t is string => t !== null);
  }

  /** Where alerts about this wallet go, checked again as they are used: a stored target is not trusted more than a typed one. */
  targetsFor(wallet: string): string[] {
    const profile = this.profileOf(wallet);
    if (!profile) return [];
    return this.targetsOf(profile).filter((t) => cleanNtfyTarget(t, this.ntfyHosts) === t);
  }

  // ---- alerts

  /** The profile's alerts, newest first. */
  eventsOf(profile: string, limit = 100): StoredEvent[] {
    return this.walletsOf(profile).flatMap((w) => this.store.events(w)).sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || b.slot - a.slot).slice(0, limit);
  }

  /** The alert with this id, when it is about one of the profile's wallets. */
  eventOf(profile: string, id: string): StoredEvent | undefined {
    const e = this.store.event(id);
    return e && this.profileOf(e.wallet) === profile ? e : undefined;
  }
}
