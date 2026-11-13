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
import { PLANS, type ChannelKind, type Tier } from "./plans.js";
import type { Channel, MemoryStore, Profile, StoredEvent, WalletOwner } from "./store.js";

export const SESSION_SECONDS = 7 * 86_400;

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

// A Discord or Slack webhook: the exact shape each service hands out, on its own host, and nothing looser.
// These two hosts are fixed here, not configured: an alert is never posted to an address of someone's choosing.
const DISCORD = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,100}$/;
const SLACK = /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{4,20}\/B[A-Z0-9]{4,20}\/[A-Za-z0-9]{10,60}$/;

/** Reads an address as one of the kinds of channel, or as none. */
export function cleanTarget(input: unknown, ntfyHosts: ReadonlySet<string>): { kind: ChannelKind; url: string } | null {
  if (typeof input !== "string" || input.length > 300) return null;
  const s = input.trim();
  if (DISCORD.test(s)) return { kind: "discord", url: s.replace("discordapp.com", "discord.com") };
  if (SLACK.test(s)) return { kind: "slack", url: s };
  const ntfy = cleanNtfyTarget(s, ntfyHosts);
  return ntfy ? { kind: "ntfy", url: ntfy } : null;
}

const hintOf = (kind: ChannelKind, url: string): string => (kind === "ntfy" ? `${new URL(url).host}/…${url.slice(-4)}` : `${kind === "discord" ? "Discord" : "Slack"} webhook …${url.slice(-4)}`);

export class Accounts {
  constructor(private store: MemoryStore, private dataKey: Buffer, private opts: { ntfyHosts?: ReadonlySet<string>; maxWallets?: number; reservedForPro?: number } = {}) {}

  /**
   * No room for another wallet: what the service can read is finite, and a full house is said, not hidden.
   * The last places are kept for profiles on the paid plan. Someone who pays for ten wallets has to be able
   * to add them, whoever signed up free in the meantime.
   */
  private full(tier: Tier): boolean {
    if (this.opts.maxWallets === undefined) return false;
    const room = tier === "pro" ? this.opts.maxWallets : this.opts.maxWallets - (this.opts.reservedForPro ?? 0);
    return Object.keys(this.data.owners).length >= room;
  }

  /** How many wallets are in the service, and how many it takes: from anyone, and in all. */
  places(): { taken: number; open: number | null; inAll: number | null } {
    const max = this.opts.maxWallets;
    return { taken: Object.keys(this.data.owners).length, open: max === undefined ? null : max - (this.opts.reservedForPro ?? 0), inAll: max ?? null };
  }

  private get data() { return this.store.accounts; }
  private get ntfyHosts(): ReadonlySet<string> { return this.opts.ntfyHosts ?? new Set(["ntfy.sh"]); }
  // Ids arrive from outside (a path, a webhook). Only a profile or wallet that was put here is found: a name
  // every object answers to, like "constructor", is not one.
  private owner(wallet: string): WalletOwner | undefined { return Object.hasOwn(this.data.owners, wallet) ? this.data.owners[wallet] : undefined; }

  profile(id: string): Profile | undefined { return Object.hasOwn(this.data.profiles, id) ? this.data.profiles[id] : undefined; }
  profileOf(wallet: string): string | undefined { return this.owner(wallet)?.profile; }
  walletsOf(profile: string): string[] { return Object.entries(this.data.owners).filter(([, o]) => o.profile === profile).map(([address]) => address); }
  channelsOf(profile: string): Channel[] { return this.data.channels.filter((c) => c.profile === profile); }
  reporting(wallet: string): boolean { return !!this.owner(wallet)?.reportTokenHash; }
  paused(wallet: string): boolean { return this.owner(wallet)?.paused === true; }
  profiles(): Profile[] { return Object.values(this.data.profiles); }

  /**
   * Watches as many of the profile's wallets as its tier allows, oldest first, and pauses the rest. A paused
   * wallet stays in the profile with what was learned about it, and is read again when there is room.
   */
  enforce(profile: string): void {
    const p = this.profile(profile);
    if (!p) return;
    const mine = Object.entries(this.data.owners).filter(([, o]) => o.profile === profile).sort((a, b) => a[1].addedAt - b[1].addedAt);
    mine.forEach(([address, owner], i) => {
      if (i < PLANS[p.tier].wallets) { delete owner.paused; this.store.watch({ address }); }
      else { owner.paused = true; this.store.unwatch(address); }
    });
    this.store.flush();
  }

  /** Changes what the profile pays for. Moving down pauses the wallets over the limit; moving up reads them again. */
  setTier(profile: string, tier: Profile["tier"]): void {
    const p = this.profile(profile);
    if (!p || p.tier === tier) return;
    p.tier = tier;
    this.enforce(profile);
  }

  setBilling(profile: string, billing: Profile["billing"] | null): void {
    const p = this.profile(profile);
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
    const owner = this.owner(wallet);
    if (into === null) {
      if (owner) return { ok: true, profile: owner.profile, created: false };
      if (this.full("watch")) return refuse(503, "Sentinel is watching as many wallets as it can for now. Try again later.");
      const id = randomBytes(12).toString("base64url");
      this.data.profiles[id] = { id, tier: "watch", createdAt: now, autoRescue: false };
      this.data.owners[wallet] = { profile: id, addedAt: now };
      this.store.watch({ address: wallet });
      this.store.flush();
      return { ok: true, profile: id, created: true };
    }
    const profile = this.profile(into);
    if (!profile) return refuse(401, "sign in again.");
    if (owner) return owner.profile === into ? { ok: true, profile: into, created: false } : refuse(409, "that wallet is already watched under another profile.");
    if (this.full(profile.tier)) return refuse(503, "Sentinel is watching as many wallets as it can for now. Try again later.");
    if (this.walletsOf(into).length >= PLANS[profile.tier].wallets) return refuse(403, `this profile watches ${PLANS[profile.tier].wallets} wallets, which is its plan's limit.`);
    this.data.owners[wallet] = { profile: into, addedAt: now };
    this.store.watch({ address: wallet });
    this.store.flush();
    return { ok: true, profile: into, created: false };
  }

  /** Whether a wallet could be removed now, and whether it is the profile's last: asked before anyone is told it was. */
  mayRemoveWallet(profile: string, wallet: string): { ok: true; last: boolean } | Refusal {
    if (this.owner(wallet)?.profile !== profile) return refuse(404, "that wallet is not in this profile.");
    const last = this.walletsOf(profile).length === 1;
    // the last wallet takes the profile with it, and a subscription with nobody behind it would go on charging
    const billing = this.profile(profile)?.billing;
    if (last && billing && ["active", "trialing", "past_due"].includes(billing.status)) return refuse(409, "this is the profile's last wallet and the paid plan is still running. Cancel the plan first, then remove it.");
    return { ok: true, last };
  }

  /** Stops watching a wallet and forgets it. The last one takes the profile with it. */
  removeWallet(profile: string, wallet: string): { ok: true; profileRemoved: boolean } | Refusal {
    const may = this.mayRemoveWallet(profile, wallet);
    if (!may.ok) return may;
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

  /** `wallet` is the one whose signature started it: a change made in this session is reported as made with that wallet. */
  startSession(profile: string, now: number, wallet?: string): string {
    const token = randomToken();
    this.data.sessions = this.data.sessions.filter((s) => s.expiresAt > now);
    // a handful per profile: the oldest gives way
    const mine = this.data.sessions.filter((s) => s.profile === profile);
    if (mine.length >= 5) this.data.sessions.splice(this.data.sessions.indexOf(mine[0]!), 1);
    this.data.sessions.push({ tokenHash: hashToken(token), profile, expiresAt: now + SESSION_SECONDS, ...(wallet ? { wallet } : {}) });
    this.store.flush();
    return token;
  }

  /** The profile a session token stands for, or null. */
  session(token: string | null, now: number): string | null { return this.sessionOf(token, now)?.profile ?? null; }

  /** The same, with the wallet that signed in, when it is still one of the profile's. */
  sessionOf(token: string | null, now: number): { profile: string; wallet: string | null } | null {
    if (!token) return null;
    const hash = hashToken(token);
    const s = this.data.sessions.find((x) => sameHash(x.tokenHash, hash));
    if (!s || s.expiresAt <= now || !this.profile(s.profile)) return null;
    return { profile: s.profile, wallet: s.wallet && this.profileOf(s.wallet) === s.profile ? s.wallet : null };
  }

  endSession(token: string): void {
    const hash = hashToken(token);
    this.data.sessions = this.data.sessions.filter((x) => !sameHash(x.tokenHash, hash));
    this.store.flush();
  }

  // ---- "this signature was mine"

  /** A new token for the owner's browser to report with. Shown once; the old one stops working. */
  newReportToken(profile: string, wallet: string): { ok: true; token: string } | Refusal {
    const owner = this.owner(wallet);
    if (owner?.profile !== profile) return refuse(404, "that wallet is not in this profile.");
    const token = randomToken();
    owner.reportTokenHash = hashToken(token);
    this.store.flush();
    return { ok: true, token };
  }

  dropReportToken(profile: string, wallet: string): boolean {
    const owner = this.owner(wallet);
    if (owner?.profile !== profile) return false;
    delete owner.reportTokenHash;
    this.store.flush();
    return true;
  }

  /** True when this token is the one issued for this wallet. */
  mayReport(wallet: string, token: string | null): boolean {
    const stored = this.owner(wallet)?.reportTokenHash;
    return !!token && !!stored && sameHash(stored, hashToken(token));
  }

  // ---- channels

  /**
   * The channels this profile's plan uses: the kinds it includes, oldest first, up to its number. A channel
   * past that stays stored and unused, so that a plan that lapses and comes back loses nothing.
   */
  private active(profile: string): Channel[] {
    const p = this.profile(profile);
    if (!p) return [];
    const plan = PLANS[p.tier];
    return this.channelsOf(profile).filter((c) => plan.kinds.includes(c.kind)).sort((a, b) => a.addedAt - b.addedAt).slice(0, plan.channels);
  }

  /** One of the profile's channels, with its address, if alerts go there now. For sending it a test. */
  channelOf(profile: string, id: string): { ok: true; id: string; kind: ChannelKind; url: string } | Refusal {
    const c = this.channelsOf(profile).find((x) => x.id === id);
    if (!c) return refuse(404, "there is no such channel.");
    if (!this.active(profile).some((x) => x.id === id)) return refuse(409, "that channel is not in use on this plan, so nothing is sent to it.");
    const url = unseal(this.dataKey, c.target);
    const clean = url === null ? null : cleanTarget(url, this.ntfyHosts);
    return clean && clean.kind === c.kind && clean.url === url ? { ok: true, id: c.id, kind: clean.kind, url: clean.url } : refuse(409, "that channel's address can no longer be read. Remove it and add it again.");
  }

  /** The profile's channels as the page shows them: what kind, a hint of the address, and whether alerts go there now. */
  channelViews(profile: string): { id: string; kind: ChannelKind; hint: string; active: boolean; lastDeliveredAt: number | null; failing: { since: number; why: string } | null }[] {
    const active = new Set(this.active(profile).map((c) => c.id));
    return this.channelsOf(profile).map((c) => ({ id: c.id, kind: c.kind, hint: c.hint, active: active.has(c.id), lastDeliveredAt: c.delivered ?? null, failing: c.failed ? { since: c.failed.at, why: c.failed.why } : null }));
  }

  /**
   * What became of a message sent to a channel. A channel that took it is no longer failing; one that did not
   * is failing since the first time it did not, and its owner is shown why on the page.
   */
  noteDelivery(id: string, ok: boolean, why: string, now: number): void {
    const c = this.data.channels.find((x) => x.id === id);
    if (!c) return; // removed while the message was on its way
    if (ok) { c.delivered = now; delete c.failed; } else c.failed = { at: c.failed?.at ?? now, why };
    this.store.flush();
  }

  addChannel(profile: string, target: unknown, now: number): { ok: true; channel: { id: string; kind: ChannelKind; hint: string } } | Refusal {
    const p = this.profile(profile);
    if (!p) return refuse(401, "sign in again.");
    const plan = PLANS[p.tier];
    const clean = cleanTarget(target, this.ntfyHosts);
    if (!clean) return refuse(400, `that is not an address I can send alerts to. An ntfy topic looks like https://${[...this.ntfyHosts][0] ?? "ntfy.sh"}/a-long-topic-name; a Discord or Slack webhook is the address that service gave you.`);
    if (!plan.kinds.includes(clean.kind)) return refuse(403, "Discord and Slack channels come with Pro. On Watch, alerts go to ntfy.");
    if (this.channelsOf(profile).length >= plan.channels) return refuse(403, plan.channels === 1 ? "this plan has one alert channel. Remove it to use another, or move to Pro for five." : `this plan has ${plan.channels} alert channels at most.`);
    if (this.channelsOf(profile).some((c) => unseal(this.dataKey, c.target) === clean.url)) return refuse(409, "that channel is already added.");
    const channel: Channel = { id: randomBytes(6).toString("base64url"), profile, kind: clean.kind, target: seal(this.dataKey, clean.url), hint: hintOf(clean.kind, clean.url), addedAt: now };
    this.data.channels.push(channel);
    this.store.flush();
    return { ok: true, channel: { id: channel.id, kind: channel.kind, hint: channel.hint } };
  }

  removeChannel(profile: string, id: string): boolean {
    const before = this.data.channels.length;
    this.data.channels = this.data.channels.filter((c) => !(c.profile === profile && c.id === id));
    if (this.data.channels.length === before) return false;
    this.store.flush();
    return true;
  }

  /**
   * Where alerts about this wallet go, checked again as they are used: a stored address is not trusted more
   * than a typed one, and one that no longer reads as its kind is not used.
   */
  channelsFor(wallet: string): { id: string; kind: ChannelKind; url: string; hint: string }[] {
    const profile = this.profileOf(wallet);
    return profile ? this.channelsOfProfile(profile) : [];
  }
  /** Where a notice about the profile itself goes: the channels its alerts go to now. */
  channelsOfProfile(profile: string): { id: string; kind: ChannelKind; url: string; hint: string }[] {
    return this.active(profile).flatMap((c) => {
      const url = unseal(this.dataKey, c.target);
      const clean = url === null ? null : cleanTarget(url, this.ntfyHosts);
      return clean && clean.kind === c.kind && clean.url === url ? [{ id: c.id, ...clean, hint: c.hint }] : [];
    });
  }
  /** How one of the profile's channels is shown, and whether alerts go to it now. Null when it has no such channel. */
  channelView(profile: string, id: string): { kind: ChannelKind; hint: string; active: boolean } | null {
    const v = this.channelViews(profile).find((c) => c.id === id);
    return v ? { kind: v.kind, hint: v.hint, active: v.active } : null;
  }
  targetsFor(wallet: string): string[] { return this.channelsFor(wallet).map((c) => c.url); }

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
