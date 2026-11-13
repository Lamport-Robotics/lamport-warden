/**
 * Sends an alert to the channels of the wallet's owner.
 *
 * The body is the plain sentence the rules wrote. It never carries a link and never asks for a signature: a
 * message that says "your wallet is in danger, click here" is what a thief sends, so Sentinel's never look
 * like one. The title says which wallet, by its first and last four characters.
 *
 * A sentence can quote text from the chain (a token's name, a memo), and whoever wrote that text would like
 * it to become a link, a mention of everyone in the channel, or bold type. So each kind of channel gets the
 * sentence in the form that service shows as plain characters.
 */
import type { Accounts } from "./accounts.js";
import type { ChannelKind } from "./plans.js";
import type { Level } from "./signals.js";
import { chatOf } from "./telegram.js";
import type { Notifier } from "./watcher.js";

export type Post = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "error"; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

// plain ASCII: this goes in an HTTP header
const short = (a: string) => `${a.slice(0, 4)}..${a.slice(-4)}`;
/** A zero-width space after "://" and "www.": the text reads the same and no chat app takes it for an address to open. */
const unlink = (s: string) => s.replace(/:\/\//g, ":\u200b//").replace(/\bwww\./gi, "www\u200b.");

/**
 * What is sent to one channel: the headers and the body. `quiet` is for something worth a line and not worth
 * a buzz (the owner signing in): ntfy and Discord deliver it without a sound; Slack has no such thing.
 */
export function messageFor(kind: Exclude<ChannelKind, "telegram">, title: string, level: Level, sentence: string, quiet = false): { headers: Record<string, string>; body: string } {
  if (kind === "ntfy") return { headers: { Title: title, Priority: level === "urgent" ? "5" : quiet ? "2" : "3" }, body: sentence };
  if (kind === "discord") {
    // every character Discord reads as formatting is escaped, nobody is mentioned, and nothing is unfurled
    const plain = unlink(sentence).replace(/[\\*_~`|>#\[\]()@:-]/g, (c) => (c === ":" ? c : `\\${c}`));
    // flags: 4 suppresses embeds, 4096 delivers without a notification
    return { headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${title}\n${plain}`.slice(0, 1900), allowed_mentions: { parse: [] }, flags: quiet ? 4 | 4096 : 4 }) };
  }
  // Slack: formatting off, the three characters it gives meaning to written as entities, nothing unfurled
  const plain = unlink(sentence).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return { headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `${title}\n${plain}`.slice(0, 3000), mrkdwn: false, unfurl_links: false, unfurl_media: false }) };
}

export const TEST_SENTENCE = "This is a test from Warden Sentinel. Alerts about your wallets arrive here, one plain sentence each, never with a link.";

/** Why a channel did not take a message, in words fit for its owner: what it answered, or that it did not. */
export const refusalOf = (status: number | null): string => (status === null ? "it could not be reached" : `it answered ${status}`);

export const failingChannelNotice = (hint: string, why: string): string =>
  `An alert could not be delivered to another of this profile's channels (${hint}): ${why}. Send it a test from the Sentinel page, or replace it.`;

export class ChannelNotifier implements Notifier {
  /** What could not be delivered, newest last: the service says so rather than pretending the owner was told. */
  readonly undelivered: { wallet: string; at: number; why: string }[] = [];
  /** When the profile's other channels were last told that one of them is failing, by that channel. */
  private toldFailing = new Map<string, number>();

  constructor(private accounts: Accounts, private post: Post = (u, i) => fetch(u, i), private opts: {
    timeoutMs?: number; now?: () => number;
    /** The bot that Telegram chats are written to. Without one, a Telegram channel takes nothing and is shown as failing. */
    telegram?: { send(chat: string, text: string, quiet?: boolean): Promise<{ ok: boolean; status: number | null }> };
  } = {}) {}

  private now(): number { return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000); }

  /**
   * One message to one channel. Whether it was taken is written down on the channel, so the owner can see on
   * the page that a channel has stopped working without waiting to miss an alert. Never throws.
   */
  private async send(channel: { id: string; kind: ChannelKind; url: string }, title: string, level: Level, sentence: string, about: string, quiet = false): Promise<boolean> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 8000);
    let status: number | null = null, ok = false, detail = "";
    try {
      if (channel.kind === "telegram") {
        // a chat is written to through the bot, which shows the sentence as plain characters (telegram.ts)
        const chat = chatOf(channel.url);
        const res = chat && this.opts.telegram ? await this.opts.telegram.send(chat, `${title}\n${sentence}`, quiet) : { ok: false, status: null };
        status = res.status; ok = res.ok;
        detail = this.opts.telegram ? (res.status === null ? "Telegram could not be reached" : `Telegram answered ${res.status}`) : "there is no Telegram bot to send through";
      } else {
        // a redirect is refused: the message goes to the address the owner gave, or nowhere
        const res = await this.post(channel.url, { method: "POST", ...messageFor(channel.kind, title, level, sentence, quiet), redirect: "error", signal: ctl.signal });
        status = res.status; ok = res.ok;
        detail = `the channel answered ${res.status}`;
      }
    } catch (e) {
      detail = String((e as Error).message ?? e); // what went wrong inside stays in the log
    } finally {
      clearTimeout(timer);
    }
    if (!ok) this.miss(about, detail);
    this.accounts.noteDelivery(channel.id, ok, refusalOf(status), this.now());
    return ok;
  }

  /** Sends an alert to the owner's channels, and says how many took it. */
  async notify(wallet: string, level: Level, sentence: string): Promise<{ delivered: number; failed: number }> {
    const channels = this.accounts.channelsFor(wallet);
    const title = `${level === "urgent" ? "Warden Sentinel: urgent" : "Warden Sentinel"} (${short(wallet)})`;
    const took: typeof channels = [], refused: typeof channels = [];
    for (const channel of channels) ((await this.send(channel, title, level, sentence, wallet)) ? took : refused).push(channel);
    if (channels.length === 0) this.miss(wallet, "the owner has no channel");
    // A channel that has stopped taking alerts is said on the ones that still do, once a day: the owner
    // should not find out by missing the one alert that only went there.
    for (const dead of refused) {
      if (took.length === 0 || this.now() - (this.toldFailing.get(dead.id) ?? -Infinity) < 86_400) continue;
      this.toldFailing.set(dead.id, this.now());
      const why = this.accounts.channelViews(this.accounts.profileOf(wallet) ?? "").find((c) => c.id === dead.id)?.failing?.why ?? "it did not take it";
      for (const alive of took) await this.send(alive, "Warden Sentinel: your profile", "alert", failingChannelNotice(dead.hint, why), wallet);
    }
    return { delivered: took.length, failed: refused.length };
  }

  /**
   * Sends one channel a test, so an owner knows an alert would reach them before they need one. Says plainly
   * whether the channel took it.
   */
  async test(profile: string, channelId: string): Promise<{ ok: true } | { ok: false; status: number; why: string }> {
    const channel = this.accounts.channelOf(profile, channelId);
    if (!channel.ok) return channel;
    if (await this.send(channel, "Warden Sentinel: test", "alert", TEST_SENTENCE, `profile ${profile.slice(0, 4)}`)) return { ok: true };
    const why = this.accounts.channelViews(profile).find((c) => c.id === channelId)?.failing?.why ?? "";
    return why.startsWith("it answered")
      ? { ok: false, status: 502, why: `the channel did not take it (${why}). Check the address, or remove it and add it again.` }
      : { ok: false, status: 502, why: "the channel could not be reached. Check the address, or try again in a minute." };
  }

  /**
   * Tells the owner about a change to the profile itself: who signed in, what was removed, what the plan now
   * is. It goes to the channels in use at the moment it is sent, so a notice about a channel being removed is
   * sent before the channel is. Resolves when every channel has answered or timed out; never throws.
   */
  async notice(profile: string, sentence: string, opts: { quiet?: boolean } = {}): Promise<void> {
    await Promise.all(this.accounts.channelsOfProfile(profile).map((channel) => this.send(channel, "Warden Sentinel: your profile", "alert", sentence, `profile ${profile.slice(0, 4)}`, opts.quiet)));
  }

  private miss(wallet: string, why: string): void {
    this.undelivered.push({ wallet, at: this.now(), why });
    if (this.undelivered.length > 200) this.undelivered.shift();
  }
}
