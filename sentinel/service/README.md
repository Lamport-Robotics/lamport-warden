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
| `src/program.ts` | The rescue program's instructions, for arming (the owner signs) and for a rescue, and the plan of a rescue: which accounts, in what order, in how many transactions. |
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
- A quiet wallet costs one call a pass: the list of what is new. Its accounts (who may spend a token account,
  who owns it, which program owns the wallet) change only by a transaction the wallet signs, and every such
  transaction is in that list. So the accounts are read when the list has something new, on the first pass,
  and every quarter of an hour regardless, in case that reasoning has a hole.

It has been run once against the public mainnet RPC (a first pass over a real account). The tests run it
against a simulated RPC.

## How much it can watch, and keeping the pace

A plan's pace is a promise: Watch says each wallet is read every minute, Pro every twenty seconds. Whether
that can be kept is a matter of how much the RPC will take, and the public Solana RPC takes little. Measured
from the server on 2026-11-13:

| Call | What the public RPC took |
|---|---|
| `getSignaturesForAddress` (what is new for a wallet) | about 10 in ten seconds; at two a second, half were refused |
| `getTokenAccountsByOwner` | the same |
| `getAccountInfo` | four a second without a refusal |
| several calls in one batch request | refused every time |

Each refusal came with "retry after 10 seconds", and the signature list took over a second to answer. Read
the old way (four calls a wallet, one wallet after another) that is about thirty wallets a minute, not the
hundred the first deployment allowed itself.

What the service does about it:

- **It asks at a pace the RPC takes** (`src/rpc.ts`): the two rationed calls on one lane, everything else on
  another, each spaced evenly. A refusal is waited out for as long as the RPC says, by every call of that
  kind. The public RPC's measured pace is the default when that is the RPC; a paid RPC is told its own
  (`SENTINEL_RPC_HEAVY_PER_10S`, `SENTINEL_RPC_LIGHT_PER_10S`).
- **A quiet wallet costs one call**, as above, so the rationed lane is spent on reads and not on asking again
  for accounts that cannot have changed.
- **The wallet furthest behind its own promise is read first**, in short rounds one after another, a few
  wallets at a time (`SENTINEL_READERS`). A paid wallet promised twenty seconds is then not kept waiting
  behind sixty free ones: with twenty paid wallets among eighty free ones on an RPC that takes three reads
  a second, each kind is read within a fifth of its promise (the test runs exactly that).
- **A wallet is taken only when its reads fit** (`SENTINEL_READS_PER_MINUTE`). A free wallet is one read a
  minute, a paid one three. Unless set, four fifths of the rationed pace is promised and the rest is kept
  for what a read leads to: a new transaction to fetch, a first look at a new wallet's history. On the public
  RPC that is 43 reads a minute: forty-three free wallets, or fourteen paid ones, or a mix.
- **A new wallet takes its turn.** Its first read costs three of the rationed calls and up to two hundred
  light ones for its history. It is due at once and is behind by how long it has waited, so many arriving
  together are read among the wallets already here and do not push them all back.
- **Run for real**, from a laptop against the public RPC, with new empty wallets all added in the same
  second: with 24, every wallet was read within its minute from the start and nothing was refused. With 60,
  which is more than the 43 it would promise, nothing was refused either; the first look at all of them took
  about five minutes, during which up to 27 were counted late, and after that none was: each was read every
  70 to 90 seconds.
- **When the promise is not kept, that is said.** `/v1/health` counts the wallets read later than twice their
  promise (`late`), and after a quarter of an hour of it whoever runs the service is told, with the worst
  case in seconds.

The honest size of this deployment on the free public RPC is therefore a few dozen wallets, and one or two
paying profiles with ten wallets each would take all of it. Selling the paid plan needs an RPC that takes
more: with one that takes a hundred signature lists in ten seconds, the same code promises 480 reads a
minute. Notifications pushed by the RPC instead of polling would take far less again, and are where this
should go.

## Who an owner is

An owner has no name here, no email and no password. A profile is a set of wallets, and the owner is whoever
can sign with one of them.

- Signing in is a wallet signature over a short text that names this site, the wallet, and a number the
  service issued a moment ago. The number works once, for one purpose, for five minutes. A text that names
  another site is refused (and Warden, in the browser, blocks a page that asks for one).
- A wallet is added to a profile only on that wallet's own signature, and belongs to one profile.
- Removing a wallet forgets its baseline, its token accounts and its alerts. Removing the last one removes the
  profile, its channels and its sessions. The daily snapshots (below) still hold them for up to seven days,
  and then they are gone from those too.
- Watch, the free tier, watches three wallets per profile.

## What an owner is told about the profile itself

A stolen key is what Sentinel is for, and whoever has one can sign in here with it. The first thing worth
doing with that is switching the alerts off. So whatever makes a profile watch less, or tell fewer places, is
said to the channels it had a moment before (`src/notices.ts`):

- a sign-in to a profile that already exists, quietly (a line in the channel, no sound), a few times an hour
  at most;
- an alert channel removed, said on that channel before it goes, and a channel added;
- a wallet removed, and the profile's end when it was the last one;
- a browser linked to report a wallet's signatures as its owner's;
- the paid plan starting, a payment failing, the plan being cancelled (with its last day) or set to renew
  again, the plan ending (said before its extra channels and wallets go), and the price changing for the
  next bill.

Each names the wallet whose signature started the session: "by someone signed in with AbCd..WxYz. If that was
not you, someone else has the key to AbCd..WxYz." Like every alert, a notice is one plain sentence with no
link in it. The addresses are taken at the moment a notice is called for and it is sent without waiting, so a
removal is announced even on a slow channel, and a channel that is down does not stop its owner removing it.

What a notice does not stop: someone with the key can still read the profile (its other wallets' addresses,
its alerts) and can answer an alert with "this was me". The owner has heard of the sign-in by then.

## Limits

In memory, per process: a restart forgives everyone.

| What | How many |
|---|---|
| Sign-in numbers | 30 a minute per network |
| Sign-in attempts | 10 a minute per network |
| New profiles | 5 a day per network (`newProfilesPerDay`) |
| Wallets added to a profile | 10 a day |
| Changes that send a notice (a channel added or removed, a wallet removed, a browser linked) | 20 an hour per profile; the next is refused, not done silently |
| Test alerts | 5 in ten minutes per profile |
| Reports from the extension | 240 an hour per wallet |
| Checkout and portal pages | 10 in ten minutes per profile |
| Everything else with a session | 300 a minute per profile |

A network is an IPv4 address or an IPv6 /64: one subscriber is handed a whole /64, so counting its addresses
one by one would count nothing. Behind a proxy (`SENTINEL_TRUST_PROXY=1`), the caller is the last address in
`X-Forwarded-For`, the one the proxy wrote; anything before it is whatever the caller sent. The limits on new
profiles and added wallets are there because the service has room for only so many wallets and a wallet's
first read costs a few hundred RPC calls: without them one visitor could take every place, or have the RPC
spent on wallets made up for the purpose.

Ids that arrive from outside (a path, a webhook's profile) are looked up as own entries only: `__proto__`,
`constructor` and the like are not profiles, wallets or records.

## What the stored file gives away

One JSON file, mode 0600. Someone who reads it learns which wallet addresses are watched and what alerts they
raised, which is what the chain already says. They do not get in:

- a session and a report token are stored as SHA-256 hashes; beside a session, which of the profile's wallets
  signed it in (so that a change made in it can be reported as made with that wallet);
- where alerts go is sealed with AES-256-GCM under `SENTINEL_DATA_KEY`, which is not in the file. The page is
  shown only the host and the last four characters of a topic.

## Keeping the data

The data file is one file on one disk, and with a paid plan it is also the only record of which profile a
subscription belongs to. So:

- every write goes to a new file, onto the disk (`fsync`), then into place: a crash leaves the old file or
  the new one, never half of one;
- once a day a copy is set aside in `snapshots/` beside it, mode 0600, and the last seven are kept;
- a data file that cannot be read at start (cut short, not JSON, not this shape) is set aside as
  `sentinel.json.unreadable-<time>`, never overwritten, and the newest snapshot that can be read is used
  instead. The same when the file is gone and snapshots are there. Whoever runs the service is told;
- with a file that cannot be read and no snapshot, the service does not start. An empty service would have
  forgotten every owner, and that is not a decision for a program.

The snapshots are on the same disk. They are for a bad write, a bad deploy or a slip of the hand, not for a
lost server: a copy somewhere else is still to be set up.

## A line to whoever runs it

`SENTINEL_OPS_CHANNEL` is one channel (an ntfy topic, or a Discord or Slack webhook) for what no owner can
act on (`src/ops.ts`). Without it the same lines are only in the log.

| Said | How often at most |
|---|---|
| The service started, with how many wallets and the state of the paid plan | every ten minutes, so a service that keeps falling over does not fill the channel |
| Wallets have gone unread for fifteen minutes (how many, and what the RPC answered), and when all are read again | hourly |
| It started from a snapshot, because the data file was missing or unreadable | every time |
| Today's snapshot could not be written | every six hours |
| It is watching nine tenths of the wallets it has room for, or has promised nine tenths of the reads it gives | daily |
| Wallets have been read later than their plan promises for a quarter of an hour (how many, and the worst case) | hourly |
| A webhook Stripe signed could not be applied | hourly |
| A subscription is being paid and belongs to no profile here | daily, per subscription |
| Stripe could not be read for the daily check | daily |

No line names a wallet in full, an owner or a Stripe customer. When each was last said is kept in the data
file, so a restart does not say it all again.

### Watched from outside

All of the above is the service speaking for itself, and the one thing it cannot say is that it has stopped.
So it is also asked from somewhere else. `.github/workflows/sentinel-watch.yml` runs
`scripts/check-live.mjs` four times an hour on GitHub's machines: it reads the public `/v1/health` and fails
when the service does not answer in three tries, when it has not finished a round of reading wallets in ten
minutes (the API is up and the watcher is not), or when none of the watched wallets can be read. It prints
how many are read later than promised, and does not fail on that: lateness is the operator's line above. A failed run
is the notice: GitHub tells whoever watches the repository's workflows. It holds no secret and reads nothing
that names a wallet or an owner. `node scripts/check-live.mjs` does the same from a terminal.

GitHub switches a scheduled workflow off after sixty days without a commit to the repository, and says so by
email; it is switched back on from the Actions tab.

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

**An alert that reaches nobody is said, not hidden.** Each channel keeps when it last took a message, and,
while it is refusing them, since when and what it answered ("it answered 404", "it could not be reached";
never the error from inside). The Sentinel page shows that on the channel. When a profile has another channel
that still works, that one is told, once a day, that the other is failing, by its hint and never its address.
An alert that no channel took (or that had no channel to go to) is marked, and the page says so on the alert.
A test that works clears the mark.

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
- **Room is kept for those who pay.** The service holds only so many wallets. When the paid plan is set up, a
  fifth of the places (`SENTINEL_RESERVED_FOR_PRO`) are not given to free sign-ups, so that someone paying
  for ten wallets can add them whoever signed up free in the meantime. Full is still full: nobody is put out
  to make room.
- **Only a subscription to this plan counts.** The Stripe account can sell other things; a subscription whose
  one item is not one of the plan's two prices changes nothing here, whatever profile it names.
- **One checkout page at a time, good for half an hour.** Opening another closes the one before at Stripe, so
  a page left open in another tab cannot be paid as well and start a second subscription. If the earlier page
  was just paid and Stripe's word has not arrived, no new page is opened. Someone who had the plan before
  comes back as the same Stripe customer.
- **Once a day every profile is made to match Stripe**, in case a webhook was missed: the active
  subscriptions to the plan's two prices are listed, a profile that paid and was never lifted is lifted, and
  one whose plan ended without a word arriving is put back. A subscription that is being paid and belongs to
  no profile here is reported to whoever runs the service, and nothing is done to it: cancelling and
  refunding is a person's decision. A list that could not be read to its end concludes nothing.
- **The owner hears what the plan does** through the profile's channels: that it started, that a payment
  failed, that it was cancelled and when it ends (someone with a key could do that from the page), that it
  ended (and how many wallets are no longer watched), and, before the bill that carries it, that the price
  changes because the wallets now hold, or no longer hold, enough $LAMPORT.
- **Everything that bears on the money is said before the button is pressed**, in one place
  (`purchaseTerms` in `src/plans.ts`): what is charged today and every month until cancelled, how cancelling
  works, and what moves the price. Someone who has the plan sees when the next bill is due. A plan that was
  cancelled is shown as ending on its last day, never as renewing. Cancelling in Stripe's portal ends the
  plan at the end of the paid month (`at_period_end`), which is what the page says.
- **Checkout is closed unless `SENTINEL_CHECKOUT=open`.** With the Stripe settings in place and checkout
  closed, the page shows the prices and existing subscriptions are honoured, and nothing is sold.

`scripts/stripe-sentinel-setup.mjs` makes the product, the two prices, the customer portal and the webhook in
a Stripe account, and can be run again safely. `test/stripe.real.test.ts` runs the whole path against Stripe
in test mode when `SENTINEL_STRIPE_TEST_KEY` is set (it refuses a live key).

`sentinel/billing-setup.sh [ssh-host]` does the whole setup for the deployed service in the live Stripe
account: it runs that script on the server with the key the server already holds, writes the Stripe settings
into the service's root-only env file, restarts it, and checks that the service accepts a webhook signed with
the new secret and refuses one signed with another. It leaves checkout closed. It makes things in a real
Stripe account, so it is run by a person.

### What each plan gives

`src/plans.ts` is the one definition. The service enforces it, the Sentinel page and the extension's settings
page print it, and `test/plans.test.ts` fails if the Warden site or the store listing says anything else.

| | Watch (free) | Pro ($15 a month, $10 for holders) |
|---|---|---|
| Wallets watched | 3 | 10 |
| Each wallet read | every minute | every 20 seconds |
| Alert channels | 1, ntfy | up to 5: ntfy, Discord, Slack |
| Rescue into the owner's Lamport Vault | no | not yet |

Every Pro line above is something the service does today. Rescue is the reason the tier exists and is not
one of them: it cannot move real funds until Lamport Vault and the rescue program are audited and on
mainnet. Every place that describes Pro says so in the same sentence (`PRO_NOT_YET`), and never lists rescue
as a feature.

When a plan ends, what it added is kept and stops being used: wallets over three are paused, and channels
past the first ntfy one stay listed and silent. Nothing is deleted, so a plan that comes back loses nothing.

Discord and Slack alerts go only to the exact webhook shapes those services hand out, on their own hosts. A
sentence can quote text from the chain (a token's name, a memo), so for those two it is sent with every
formatting character escaped, mentions switched off, links unfurled never, and addresses broken with an
invisible character so that nothing in an alert can be clicked.

## Running it

```
pnpm build:service
SENTINEL_RPC_URL=https://… SENTINEL_DATA_KEY=$(openssl rand -base64 32) pnpm start:service
```

`src/main.ts` lists the settings. It listens on 127.0.0.1 and expects a web server in front for TLS. It
refuses to start without an RPC and a data key. Keep the data key: without it the stored channels cannot be
read and owners have to add them again. To start over from nothing, remove the `snapshots` folder as well as
the data file, or it starts from the newest snapshot.

`pnpm test:service` builds it and starts the built file once, with a probe beside it: sign-in, a first read,
an RPC failure reported as blind, removal. It is there because the first deployment crashed within seconds of
its first request. A bundled dependency written for CommonJS read `__filename`, which an ES module does not
have, and left Node's error handling broken; on the server's Node the next error anywhere ended the process.
The build now defines the name, and the probe fails on any Node if it comes back. CI runs it.

## Deployed

`sentinel/deploy.sh [ssh-host]` puts the service and the page on the server behind
`warden.lamportrobotics.com`: the page at `/sentinel/`, the API at `/sentinel/api/`. It runs the smoke test
first, and each step is safe to repeat.

- The service runs under systemd as a user of its own (`DynamicUser`), able to write one folder,
  `/var/lib/lamport-sentinel`, and nothing else.
- `/etc/lamport-sentinel.env` (root only) holds its settings. The data key in it was made on the server and
  has never left it. Lose it and the stored alert channels cannot be read.
- It reads the public mainnet RPC, at the pace that RPC was measured to take, and promises 43 reads a minute
  in all (a free wallet is one, a paid one three; see "How much it can watch"). Past that, and past 100
  wallets whatever they cost (`SENTINEL_MAX_WALLETS`), new sign-ups are told it is full. The public RPC is
  free and rationed. More wallets, or a paid plan sold to more than a couple of people, need an RPC key of
  its own.
- The paid plan is not configured there: `/v1/billing` answers `{"enabled": false}`.

After deploying it was checked from outside with a throwaway wallet: sign-in, a first read of the wallet from
mainnet, removal, and an empty data file afterwards.

## Rescue, so far

`src/program.ts` builds every instruction of the rescue program and is checked byte for byte, and account
for account, against `sentinel/vectors/instructions.json`, which the program's own test suite writes after
running each instruction through the compiled program. It also plans a rescue: only accounts that still name
Sentinel's delegate for the owner's vault, hold something and are not frozen, biggest first, a few to a
transaction with a priority fee.

`src/rescuer.ts` is the rescuer. Before it sends anything it reads the chain: is the wallet armed, for which
vault, and is its key one that may act for this wallet (the owner, the owner's own rescuer key, or one of
Lamport's set). A key that may not is told so there, instead of paying fees to be refused by the program.
Then it sends every planned transaction at once, each simulated first, and answers with one step per
transaction and its signature.

`pnpm test:rescue` runs it for real: a local validator running the compiled program, a vault account laid
out as the Lamport Vault program lays one out, a wallet with tokens, and the rescuer moving them. It checks
that everything armed lands in the vault's own token accounts and nothing else moves; that a stranger's key
and a wallet that is not armed are refused before anything is sent; that an owner who chose a key of their
own is rescued by it and no longer by Lamport's; and that a proposed change of vault redirects nothing. Only
the vault program is stood in for, and the rescue program never calls it. CI runs it in the job that builds
the program.

What rescue still lacks: a process and a key (nothing runs the rescuer yet), a way to arm a wallet on the
page, SOL (the rescue program moves tokens only), and a chain to run on. The program is not on devnet: the
devnet faucet no longer answers the command line, so the deploy key
(`BgWwL1UVqA8NNMwB68G8t7BuG9a7yR9WApfZrCgy3wBT`) needs about 4 test SOL from https://faucet.solana.com.

## Not here yet

A process that runs the rescuer, arming on the page, the Pincer1 webhook, a subscription in place of the poll,
more channels than ntfy, and payment in SOL or USDC. Replaying real wallets' public history to count
false alerts needs an RPC that allows it (the public one refuses most `getTransaction` calls); a free Helius
key is enough.
