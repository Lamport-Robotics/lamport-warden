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
import type { Notifier } from "./watcher.js";

export type Post = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "error"; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

// plain ASCII: this goes in an HTTP header
const short = (a: string) => `${a.slice(0, 4)}..${a.slice(-4)}`;
/** A zero-width space after "://" and "www.": the text reads the same and no chat app takes it for an address to open. */
const unlink = (s: string) => s.replace(/:\/\//g, ":\u200b//").replace(/\bwww\./gi, "www\u200b.");

/** What is sent to one channel: the headers and the body. */
export function messageFor(kind: ChannelKind, title: string, level: Level, sentence: string): { headers: Record<string, string>; body: string } {
  if (kind === "ntfy") return { headers: { Title: title, Priority: level === "urgent" ? "5" : "3" }, body: sentence };
  if (kind === "discord") {
    // every character Discord reads as formatting is escaped, nobody is mentioned, and nothing is unfurled
    const plain = unlink(sentence).replace(/[\\*_~`|>#\[\]()@:-]/g, (c) => (c === ":" ? c : `\\${c}`));
    return { headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${title}\n${plain}`.slice(0, 1900), allowed_mentions: { parse: [] }, flags: 4 }) };
  }
  // Slack: formatting off, the three characters it gives meaning to written as entities, nothing unfurled
  const plain = unlink(sentence).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return { headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `${title}\n${plain}`.slice(0, 3000), mrkdwn: false, unfurl_links: false, unfurl_media: false }) };
}

export const TEST_SENTENCE = "This is a test from Warden Sentinel. Alerts about your wallets arrive here, one plain sentence each, never with a link.";

export class ChannelNotifier implements Notifier {
  /** What could not be delivered, newest last: the service says so rather than pretending the owner was told. */
  readonly undelivered: { wallet: string; at: number; why: string }[] = [];

  constructor(private accounts: Accounts, private post: Post = (u, i) => fetch(u, i), private opts: { timeoutMs?: number; now?: () => number } = {}) {}

  async notify(wallet: string, level: Level, sentence: string): Promise<void> {
    const channels = this.accounts.channelsFor(wallet);
    const title = `${level === "urgent" ? "Warden Sentinel: urgent" : "Warden Sentinel"} (${short(wallet)})`;
    for (const { kind, url } of channels) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 8000);
      try {
        // a redirect is refused: the alert goes to the address the owner gave, or nowhere
        const res = await this.post(url, { method: "POST", ...messageFor(kind, title, level, sentence), redirect: "error", signal: ctl.signal });
        if (!res.ok) this.miss(wallet, `the channel answered ${res.status}`);
      } catch (e) {
        this.miss(wallet, String((e as Error).message ?? e));
      } finally {
        clearTimeout(timer);
      }
    }
    if (channels.length === 0) this.miss(wallet, "the owner has no channel");
  }

  /**
   * Sends one channel a test, so an owner knows an alert would reach them before they need one. Says plainly
   * whether the channel took it.
   */
  async test(profile: string, channelId: string): Promise<{ ok: true } | { ok: false; status: number; why: string }> {
    const channel = this.accounts.channelOf(profile, channelId);
    if (!channel.ok) return channel;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 8000);
    try {
      const res = await this.post(channel.url, { method: "POST", ...messageFor(channel.kind, "Warden Sentinel: test", "alert", TEST_SENTENCE), redirect: "error", signal: ctl.signal });
      return res.ok ? { ok: true } : { ok: false, status: 502, why: `the channel did not take it (it answered ${res.status}). Check the address, or remove it and add it again.` };
    } catch {
      return { ok: false, status: 502, why: "the channel could not be reached. Check the address, or try again in a minute." };
    } finally {
      clearTimeout(timer);
    }
  }

  private miss(wallet: string, why: string): void {
    this.undelivered.push({ wallet, at: this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000), why });
    if (this.undelivered.length > 200) this.undelivered.shift();
  }
}
