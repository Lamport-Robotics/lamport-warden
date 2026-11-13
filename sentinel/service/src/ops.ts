/**
 * A line to whoever runs the service: that it started, that it cannot read the chain, that someone is paying
 * for a plan no profile has, that it started from a snapshot. An owner hears about their wallets; this is
 * for the things no owner can do anything about.
 *
 * It goes to one channel, set in the configuration (the same kinds an owner can use). Without one it is
 * only logged. Nothing here names a wallet in full, an owner, or a Stripe customer: an id that somebody would
 * need is in the log, where the sentence says to look.
 */
import type { ChannelKind } from "./plans.js";
import { messageFor, type Post } from "./notify.js";

export class Ops {
  constructor(
    private target: { kind: ChannelKind; url: string } | null,
    /** When each thing was last said. The store's own record, so a restart does not say it all again. */
    private said: Record<string, number>,
    private opts: { post?: Post; now?: () => number; log?: (line: string) => void; saved?: () => void; timeoutMs?: number } = {},
  ) {}

  /**
   * Says it, unless the same thing (`key`) was said within `everySeconds`. Always logged. Never throws, and
   * never holds up what called it for longer than the channel's timeout.
   */
  async say(sentence: string, key: string = sentence, everySeconds = 6 * 3600): Promise<boolean> {
    const now = this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000);
    (this.opts.log ?? console.error)(`sentinel: ${sentence}`);
    if (now - (this.said[key] ?? -Infinity) < everySeconds) return false;
    this.said[key] = now;
    for (const k of Object.keys(this.said)) if (now - this.said[k]! > 7 * 86_400) delete this.said[k];
    this.opts.saved?.();
    if (!this.target) return false;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 8000);
    try {
      const res = await (this.opts.post ?? ((u, i) => fetch(u, i)))(this.target.url, { method: "POST", ...messageFor(this.target.kind, "Warden Sentinel: operations", "alert", sentence), redirect: "error", signal: ctl.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
