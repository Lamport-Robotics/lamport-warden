/**
 * What an owner is told when the profile itself changes.
 *
 * A profile belongs to whoever can sign with one of its wallets, and a stolen key is exactly what Sentinel is
 * for. So a thief who has the key can also sign in here, and the first thing worth doing with that is to
 * switch the alerts off. These sentences close that door: whatever makes a profile watch less, or tell fewer
 * places, is said to the channels it had a moment before, by the one who is about to lose them.
 *
 * Like every alert: a plain sentence, no link, nothing to sign.
 */
const short = (a: string) => `${a.slice(0, 4)}..${a.slice(-4)}`;

/** Who did it, as far as the service knows: the wallet whose signature started the session. */
const by = (wallet: string | null) => (wallet ? `, by someone signed in with ${short(wallet)}` : "");
const notYou = (wallet: string | null) => (wallet ? `If that was not you, someone else has the key to ${short(wallet)}.` : "If that was not you, someone else has the key to one of this profile's wallets.");

export const signedInNotice = (wallet: string): string =>
  `${short(wallet)} signed in to Sentinel just now. ${notYou(wallet)}`;

export const channelAddedNotice = (hint: string, wallet: string | null): string =>
  `An alert channel (${hint}) was added to this profile${by(wallet)}. Alerts go there now. ${notYou(wallet)}`;

export const channelRemovedNotice = (hint: string, wallet: string | null): string =>
  `An alert channel (${hint}) was removed from this profile${by(wallet)}. Alerts no longer go there. ${notYou(wallet)}`;

export const walletRemovedNotice = (removed: string, last: boolean, wallet: string | null): string =>
  last
    ? `Sentinel has stopped watching ${short(removed)}, and this profile is gone: its last wallet was removed${by(wallet)}. ${notYou(wallet)}`
    : `Sentinel has stopped watching ${short(removed)}: it was removed from this profile${by(wallet)}. ${notYou(wallet)}`;

export const reportLinkedNotice = (target: string, wallet: string | null): string =>
  `A browser was linked to tell Sentinel which of ${short(target)}'s transactions are its owner's${by(wallet)}. What it reports is treated as yours. ${notYou(wallet)}`;

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

export const planStartedNotice = (wallets: number, seconds: number, push = false): string =>
  `This profile's Sentinel plan has started: up to ${wallets} wallets, each read every ${seconds} seconds${push ? ", and at once when the network reports a transaction in one" : ""}.`;

export const planEndedNotice = (wallets: number, pausedNow: number): string =>
  `This profile's Sentinel plan has ended, so it is on the free plan again: ${wallets} wallets, read every minute, alerts to one ntfy channel.${pausedNow > 0 ? ` ${pausedNow} of its wallets ${pausedNow === 1 ? "is" : "are"} no longer watched.` : ""}`;

/** A day as it is written in a sentence, in UTC so that the service and the reader mean the same day. */
export const dayOf = (unix: number): string => new Date(unix * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export const planCancelledNotice = (endsAt: number): string =>
  `This profile's Sentinel plan was cancelled. It runs until ${dayOf(endsAt)} and does not renew; after that the profile is on the free plan. If that was not you, someone else has the key to one of this profile's wallets.`;

export const planResumedNotice = (): string =>
  "This profile's Sentinel plan is no longer set to end: it renews as before.";

export const paymentFailedNotice = (): string =>
  "The payment for this profile's Sentinel plan did not go through. The plan stays on while the card is tried again; if it keeps failing, the plan ends.";

export const priceChangedNotice = (to: "full" | "holder", cents: number, holderMin: number): string =>
  to === "holder"
    ? `From its next bill, this profile's Sentinel plan is ${dollars(cents)} a month: its wallets hold ${holderMin.toLocaleString("en-US")} $LAMPORT between them.`
    : `From its next bill, this profile's Sentinel plan is ${dollars(cents)} a month: its wallets no longer hold ${holderMin.toLocaleString("en-US")} $LAMPORT between them.`;
