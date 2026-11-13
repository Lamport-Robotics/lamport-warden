# Sentinel service

The watcher, and the small server around it. The watcher reads what happened to each watched wallet, decides
what it means, and tells the owner. The server lets an owner sign in with a wallet, choose where alerts go,
and answer them. It holds no signing key and moves nothing. There is no rescuer yet, and it is not deployed.

| File | Job |
|---|---|
| `src/observed.ts` | A confirmed transaction as an RPC returns it: the signed message, and the balances before and after. Reads version 0 messages through the addresses the cluster says their tables resolved to. |
| `src/baseline.ts` | What is normal for one wallet, built from its public history: who it paid, which programs it used, usual amounts, usual hours. Only what the wallet itself sent builds trust. |
| `src/signals.ts` | The spec's signal table as rules: a transaction or a changed account in, signals with a level and a sentence out. |
| `src/watcher.ts` | One pass per wallet: what is new since the last pass, oldest first, through the rules; then the wallet's token accounts and the wallet account itself. Alerts go to a notifier (ntfy to start with) as a plain sentence, never with a link. |
| `src/store.ts` | What it keeps per wallet: where it has read up to, the baseline, the token accounts as last seen, the alerts raised. One JSON file for now. |
| `src/rpc.ts` | JSON-RPC over HTTP, waiting out "too many requests". |
| `src/signin.ts` | Sign In With Solana, the service's side: the text a wallet signs, the one-time number in it, and the checks that make a signature count. |
| `src/accounts.ts` | Profiles, their wallets, their alert channels, sessions, and the token an owner's browser reports with. |
| `src/notify.ts` | Sends an alert to the owner's channels. |
| `src/server.ts` | The HTTP API. |
| `src/main.ts`, `src/cli.ts` | The process: the watcher on a timer and the API beside it. |
| `src/billing.ts` | The paid plan: a monthly Stripe subscription at one of two prices, the webhook that moves a profile between tiers, and the daily look at who holds the token. |
| `src/crypto.ts` | Random tokens and their hashes, the sealed box for channel addresses, and the check of a wallet's signature. All from Node itself. |

It uses Warden's decoder, explainer and `OwnerMemory` from the `pincer1/` submodule, as the extension does.

## Levels

Info is for the Sentinel page. Alert sends a push. Urgent pushes on every channel and offers a rescue.

Signals are hard or soft. Hard: something was done to the wallet (a token account handed over, the wallet
reassigned, value sent to a known drainer or a look-alike, an unlimited approval, a nonce someone else
controls, Sentinel's permission replaced). Soft: this is unlike the wallet's past (a first large payment, a
program never used, a burst, an odd hour).

- A transaction the owner's own browser reported as theirs keeps its hard signals and loses its soft ones.
- An hour the wallet never transacts in raises everything else one level, but a level raised that way is not
  "by the table".
- `rescueWorthy` is true only for a hard signal that is Urgent by the table. It is the only thing automatic
  rescue may ever act on.

Both the instruction list and the balances are read. An approval moves nothing yet and shows only in the
instructions; a drain behind a program the decoder does not read shows only in the balances.

## Tests

`pnpm test` runs them with the extension's (`sentinel/service/test`). Each drain raises its signal at the
table's level; sixty days of a wallet's ordinary payments and swaps raise nothing; what arrives never changes
what the wallet is taken to trust. `service.test.ts` is the server: each check that keeps one owner out of
another's profile was also removed in turn, to see a test fail for it.

## How a pass goes

- The first pass builds the wallet's baseline from its history and raises nothing: what already happened is
  not news.
- After that it reads what is new, oldest first. A transaction that raised an Alert or more is not taken into
  the baseline, so a thief's first transfer does not make the second one familiar.
- It polls. A subscription is faster and is where this should go; a poll is what every RPC offers and says
  exactly what was not yet read after an outage.
- When the RPC fails the wallet is reported as not being watched, the cursor stays where it was, and the next
  pass reads on from there. A transaction the RPC lists but cannot show yet is waited for, not skipped.
- A notifier that fails does not stop the watching, and the alert is on record either way.

It has been run once against the public mainnet RPC (a first pass over a real account). The tests run it
against a simulated RPC.

## Who an owner is

An owner has no name here, no email and no password. A profile is a set of wallets, and the owner is whoever
can sign with one of them.

- Signing in is a wallet signature over a short text that names this site, the wallet, and a number the
  service issued a moment ago. The number works once, for one purpose, for five minutes. A text that names
  another site is refused (and Warden, in the browser, blocks a page that asks for one).
- A wallet is added to a profile only on that wallet's own signature, and belongs to one profile.
- Removing a wallet forgets its baseline, its token accounts and its alerts. Removing the last one removes the
  profile, its channels and its sessions.
- Watch, the free tier, watches three wallets per profile.

## What the stored file gives away

One JSON file, mode 0600. Someone who reads it learns which wallet addresses are watched and what alerts they
raised, which is what the chain already says. They do not get in:

- a session and a report token are stored as SHA-256 hashes;
- where alerts go is sealed with AES-256-GCM under `SENTINEL_DATA_KEY`, which is not in the file. The page is
  shown only the host and the last four characters of a topic.

## The API

Everything is JSON under `/v1`. The Sentinel page sends its session as a bearer header, not a cookie, so no
other site can ride on it, and only that page's origin is allowed to read answers.

| Call | Who | What |
|---|---|---|
| `GET /health` | anyone | How many wallets are watched, when the last round ended, how many could not be read. No addresses. |
| `POST /nonce` | anyone; with `{"purpose":"link"}`, a session | A one-time number for the sign-in text. |
| `POST /signin` | a wallet's signature | Signs in (a new profile for a new wallet), or adds the wallet to the profile whose number it is. |
| `GET /me`, `POST /signout` | session | The profile, its wallets and channels. |
| `DELETE /wallets/:address` | session | Stops watching and forgets. |
| `POST` or `DELETE /wallets/:address/report-token` | session | Issues (shown once), replaces or revokes the token below. |
| `POST /channels`, `DELETE /channels/:id` | session | An ntfy topic to send alerts to. |
| `GET /events`, `POST /events/:id/answer` | session | The alerts, and "this was me" or "ignore". |
| `GET /billing`, `POST /billing/checkout`, `POST /billing/portal` | session | The price this profile would pay and its plan; a Stripe Checkout page; Stripe's page for the card and for cancelling. |
| `POST /stripe/webhook` | Stripe's signature | A subscription started, changed or ended. |
| `POST /report` | a wallet's report token | The extension's "this signature was mine". |

`POST /report` is the one call that does not come from the page. The extension's background worker makes it
with a token that can do nothing else, for one wallet. A reported transaction loses its soft signals and keeps
its hard ones, so a stolen token cannot hide a handover or a look-alike. "This was me" does not take the
page's word for what a transaction did: the watcher reads it from the chain again.

Alerts go only to `https` ntfy topics on hosts the service was told about (`ntfy.sh` unless configured), and
a redirect is refused: the service posts to no address an owner can point somewhere else. On ntfy, whoever
knows a topic can read it, so the topic is the owner's secret and has to be long.

## The paid plan

One monthly subscription through Stripe: $15, or $10 for a profile whose wallets hold 250,000 $LAMPORT between
them. The wallets in a profile each proved themselves with a signature, so the holder price rests on what the
service knows, not on what a page says. Stripe holds the card and the email; the service keeps only the ids
of the customer and the subscription.

- **What moves a profile between tiers is Stripe saying so**, in a webhook checked for Stripe's signature over
  the exact body and refused when it is more than five minutes old. The owner's browser coming back from the
  checkout page proves nothing. The event is only a prompt: the subscription is read from Stripe again, so
  events that repeat or arrive out of order end in the same place.
- **The holder price is looked at again every day.** A subscription on the wrong price moves to the right one
  from its next bill, with nothing charged or refunded for days already paid. When the balance cannot be
  read, nobody is moved, and checkout refuses rather than guess a price.
- **A card that is failing is not cut off** while Stripe is still trying it. When the plan ends, the wallets
  over the free tier's three are paused, oldest kept: they stay in the profile with what was learned about
  them, and are read again when there is room.
- **The last wallet cannot be removed while the plan runs**, because that removes the profile and the
  subscription would go on charging with nobody behind it.
- **Checkout is closed unless `SENTINEL_CHECKOUT=open`.** With the Stripe settings in place and checkout
  closed, the page shows the prices and existing subscriptions are honoured, and nothing is sold.

`scripts/stripe-sentinel-setup.mjs` makes the product, the two prices, the customer portal and the webhook in
a Stripe account, and can be run again safely. `test/stripe.real.test.ts` runs the whole path against Stripe
in test mode when `SENTINEL_STRIPE_TEST_KEY` is set (it refuses a live key).

What the paid tier gives today is ten watched wallets instead of three. Rescue, the reason for the tier, is
not built into this service yet and cannot move real funds until Lamport Vault and the rescue program are
audited and on mainnet. Whatever sells this plan has to say so.

## Running it

```
pnpm build:service
SENTINEL_RPC_URL=https://… SENTINEL_DATA_KEY=$(openssl rand -base64 32) pnpm start:service
```

`src/main.ts` lists the settings. It listens on 127.0.0.1 and expects a web server in front for TLS. It
refuses to start without an RPC and a data key. Keep the data key: without it the stored channels cannot be
read and owners have to add them again.

It has been run against the public devnet RPC with a throwaway wallet: sign-in, a replayed sign-in refused, a
report, a first read of the wallet, and removal leaving nothing in the file.

## Not here yet

The Sentinel page that uses this API, the rescuer, the Pincer1 webhook, a subscription in place of the poll,
more channels than ntfy, and payment in SOL or USDC. Replaying real wallets' public history to count
false alerts needs an RPC that allows it (the public one refuses most `getTransaction` calls); a free Helius
key is enough.
