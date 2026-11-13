/**
 * Sends an alert to the channels of the wallet's owner.
 *
 * The body is the plain sentence the rules wrote. It never carries a link and never asks for a signature: a
 * message that says "your wallet is in danger, click here" is what a thief sends, so Sentinel's never look
 * like one. The title says which wallet, by its first and last four characters.
 */
import type { Accounts } from "./accounts.js";
import type { Level } from "./signals.js";
import type { Notifier } from "./watcher.js";

export type Post = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "error"; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

// plain ASCII: this goes in an HTTP header
const short = (a: string) => `${a.slice(0, 4)}..${a.slice(-4)}`;

export class ChannelNotifier implements Notifier {
  /** What could not be delivered, newest last: the service says so rather than pretending the owner was told. */
  readonly undelivered: { wallet: string; at: number; why: string }[] = [];

  constructor(private accounts: Accounts, private post: Post = (u, i) => fetch(u, i), private opts: { timeoutMs?: number; now?: () => number } = {}) {}

  async notify(wallet: string, level: Level, sentence: string): Promise<void> {
    const targets = this.accounts.targetsFor(wallet);
    const title = `${level === "urgent" ? "Warden Sentinel: urgent" : "Warden Sentinel"} (${short(wallet)})`;
    for (const url of targets) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 8000);
      try {
        // a redirect is refused: the alert goes to the address the owner gave, or nowhere
        const res = await this.post(url, { method: "POST", headers: { Title: title, Priority: level === "urgent" ? "5" : "3" }, body: sentence, redirect: "error", signal: ctl.signal });
        if (!res.ok) this.miss(wallet, `the channel answered ${res.status}`);
      } catch (e) {
        this.miss(wallet, String((e as Error).message ?? e));
      } finally {
        clearTimeout(timer);
      }
    }
    if (targets.length === 0) this.miss(wallet, "the owner has no channel");
  }

  private miss(wallet: string, why: string): void {
    this.undelivered.push({ wallet, at: this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000), why });
    if (this.undelivered.length > 200) this.undelivered.shift();
  }
}
