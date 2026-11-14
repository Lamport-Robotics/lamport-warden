/**
 * What each plan gives. One place, read by the service that enforces it and by the page, the extension and
 * the store listing that describe it, so that what is sold and what is delivered cannot drift apart.
 *
 * Nothing here but data: the page and the extension bundle this file.
 */
export type Tier = "watch" | "pro";
export type ChannelKind = "ntfy" | "discord" | "slack" | "telegram";

export interface Plan {
  name: string;
  /** Wallets watched. */
  wallets: number;
  /** Alert channels in use, and which kinds. */
  channels: number;
  kinds: readonly ChannelKind[];
  /** How often each wallet is read, in seconds. */
  pollSeconds: number;
  /** Whether a wallet is also read at once when the network reports a transaction in it, ahead of its turn. */
  push: boolean;
  /** Whether the plan has rescue. It is offered only where the service is set up to do one (rescue.ts). */
  rescue: boolean;
}

export const PLANS: Record<Tier, Plan> = {
  // "telegram" is in both, and is offered only where the service has a Telegram bot to send through (telegram.ts)
  watch: { name: "Watch", wallets: 3, channels: 1, kinds: ["ntfy", "telegram"], pollSeconds: 60, push: false, rescue: false },
  pro: { name: "Pro", wallets: 10, channels: 5, kinds: ["ntfy", "discord", "slack", "telegram"], pollSeconds: 20, push: true, rescue: true },
};

/** The monthly prices, in cents, as the page shows them when the service has not said otherwise. */
export const PRICE_CENTS = 1500;
export const HOLDER_PRICE_CENTS = 1000;
export const HOLDER_MIN_LAMPORT = 250_000;

/** What Watch gives, in the words every surface uses. */
export const WATCH_FEATURES: readonly string[] = [
  `${PLANS.watch.wallets} wallets watched around the clock, each read every minute`,
  "Alerts in plain sentences, pushed to your phone through ntfy",
  "\"This was me\", so it learns who you pay",
];
/** What Pro adds today. Every line is something the service does now. */
export const PRO_FEATURES: readonly string[] = [
  "Alerts in seconds: a wallet is read as soon as the network reports a transaction in it, without waiting for its turn",
  `${PLANS.pro.wallets} wallets watched instead of ${PLANS.watch.wallets}`,
  `Each wallet read every ${PLANS.pro.pollSeconds} seconds instead of every minute`,
  `Up to ${PLANS.pro.channels} alert channels, including Discord and Slack, so a team sees an alert together`,
];
const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const tokens = (n: number) => n.toLocaleString("en-US");

/**
 * What someone is told before they pay, all of it, in the order it matters: what is charged and how often,
 * how it ends, and what can change the price. Shown beside the button that starts the plan, and written the
 * same way wherever the plan is described.
 */
export const purchaseTerms = (cents: number, centsFull: number = PRICE_CENTS, centsHolder: number = HOLDER_PRICE_CENTS, holderMin: number = HOLDER_MIN_LAMPORT): string[] => [
  `${dollars(cents)} is charged to your card today, and again every month until you cancel. Stripe takes the payment; Sentinel never sees the card.`,
  "Cancel any time from this page. The plan then runs to the end of the month you paid for, your profile goes back to Watch, and nothing is deleted.",
  `The price follows what this profile's wallets hold: ${dollars(centsHolder)} a month while they hold ${tokens(holderMin)} $LAMPORT between them, ${dollars(centsFull)} otherwise. It is checked every day, a change applies from your next bill, and your alert channels are told before that bill.`,
];

/** How many months can be paid for ahead at once, in USDC or SOL. */
export const PREPAID_MONTHS: readonly number[] = [1, 3, 12];

/** An amount in an asset's smallest units as a wallet shows it: no trailing zeros. */
export function decimal(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals), frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * What someone is told before they pay ahead in USDC or SOL: that it is once and does not renew, that the
 * payment is public, and what happens if they pay again or want it back.
 */
export const prepaidTerms = (cents: number, months: number): string[] => [
  `${dollars(cents)} pays for ${months === 1 ? "one month" : `${months} months`}, once. Nothing is charged again and nothing renews: when the time is up your profile goes back to Watch, and nothing is deleted. Your alert channels are told three days before.`,
  "It is one transfer of exactly the amount shown, to Lamport's address, from any wallet. Like every transfer on the chain it is public: anyone can see that the paying wallet paid Lamport.",
  "Paying again before the time is up adds to it. A refund is on the same terms as by card, and is sent back to the wallet that paid.",
];

/** The same, for someone who already has the plan. */
export const renewalTerms = (cents: number, centsFull: number = PRICE_CENTS, centsHolder: number = HOLDER_PRICE_CENTS, holderMin: number = HOLDER_MIN_LAMPORT): string =>
  `It renews every month at ${dollars(cents)} until you cancel, which you can do any time with the button above; it then runs to the end of the month you paid for. The price is ${dollars(centsHolder)} a month while this profile's wallets hold ${tokens(holderMin)} $LAMPORT between them and ${dollars(centsFull)} otherwise, checked every day; your alert channels are told before a bill at a different price.`;

/**
 * How a profile's wallets are being read, said to its owner in full: the pace its plan promises, whether the
 * network is also reporting transactions as they happen (`push`: the plan has it and the line is up), and,
 * when the service is behind, that it is.
 */
export function paceText(pollSeconds: number, now: { push: boolean; late: boolean } | null): string {
  const every = pollSeconds === 60 ? "every minute" : `every ${pollSeconds} seconds`;
  const base = `Each wallet is read ${every}`;
  if (!now) return `${base}.`;
  const pushed = now.push ? `${base}, and at once when the network reports a transaction in it.` : `${base}.`;
  return now.late ? `${pushed} Sentinel is behind right now: some wallets are being read later than that.` : pushed;
}

/** What Pro will add, and why it does not yet. Shown wherever Pro is described, and never as a feature. */
export const PRO_NOT_YET =
  "Rescue is not available yet. Moving your tokens into your own Lamport Vault when a wallet is compromised needs the vault and the rescue program on mainnet, and both are waiting on their audits. It joins Pro when they are, at the same price.";
