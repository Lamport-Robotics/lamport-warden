/**
 * A watcher that stops quietly is the failure this service exists to prevent. When a wallet has not been
 * read for a while (the RPC is down, or refusing), its owner is told that it is not being watched, once, and
 * told again when it is. Nothing is said about a hiccup: one failed read is followed by another try.
 */
export const STOPPED_AFTER_SECONDS = 15 * 60;

export const stoppedSentence = (seconds: number): string =>
  `Sentinel has not been able to read this wallet for ${Math.round(seconds / 60)} minutes, so it is not being watched right now. The fault is at Sentinel's end, not in your wallet.`;
export const RESUMED_SENTENCE = "Sentinel is reading this wallet again. What happened while it could not is being checked now.";

export class Blindness {
  private since = new Map<string, number>();
  private told = new Set<string>();
  constructor(readonly afterSeconds = STOPPED_AFTER_SECONDS) {}

  /** After each attempt to read a wallet: whether the owner should now hear that watching stopped, or resumed. */
  note(wallet: string, read: boolean, now: number): "stopped" | "resumed" | null {
    if (read) {
      this.since.delete(wallet);
      return this.told.delete(wallet) ? "resumed" : null;
    }
    const first = this.since.get(wallet) ?? now;
    this.since.set(wallet, first);
    if (this.told.has(wallet) || now - first < this.afterSeconds) return null;
    this.told.add(wallet);
    return "stopped";
  }

  /** Drops what is kept about wallets that are no longer watched. */
  forget(keep: (wallet: string) => boolean): void {
    for (const w of this.since.keys()) if (!keep(w)) this.since.delete(w);
    for (const w of this.told) if (!keep(w)) this.told.delete(w);
  }
}
