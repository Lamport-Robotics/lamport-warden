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
controls, Sentinel's permission replaced, tokens taken in a transaction the wallet did not sign). Soft: this is unlike the wallet's past (a first large payment, a
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

## Told as it happens, looked at in turn, read through when something moved

Three things happen to a watched wallet, and they cost very different amounts.

**A look, in its turn**, at the pace its plan promises (`Watcher.glance`). One call reads a hundred accounts:
the wallet's own, and its token accounts. They are reduced to a line: the wallet's balance and owner, and for
each token account its amount, who may spend it and how much, who owns it, who may close it. Everything an
alert is about moves that line. A wallet whose line is the one kept from last time has had nothing happen to
its money or its permissions, and that look is its read. An RPC barely rations this call, which is what lets
one deployment watch hundreds of wallets every minute.

**A full pass**, which reads the wallet's list of transactions and judges each new one. It is made when the
look differs from the last one, when the wallet was never read, when the last pass left transactions unread,
when the RPC has just said the wallet was in a transaction, and every ten minutes or so regardless, for the
transaction that changes none of the things a look sees. This is the call an RPC rations. The line kept
beside a pass is the one from the look just *before* it, so whatever lands while the pass is reading moves the
next look and the wallet is read through again: nothing falls between the two.

**The RPC saying so** (`src/push.ts`), for wallets on the paid plan. The service keeps a few websockets to
the RPC and asks to be told when one of those addresses is mentioned in a transaction. When it is, that
wallet is read through next, ahead of its turn. Nothing that is pushed is believed: it is only a reason to read sooner. A wallet is read on the RPC's
word at most every quarter of its promised pace. The connections are asked twice a minute whether they are
still there and put up again when they are not; `/v1/health` says `push: on`, `down` or `off`, and whoever
runs the service is told when it has been down for a quarter of an hour. `SENTINEL_PUSH=off` turns it off.

Run for real against the public RPC, watching a public wallet that transacts about every eleven seconds: with
the push line up, each new transaction had been read 3 to 7 seconds after it happened. With it off, the look
alone noticed at the wallet's next turn, about a minute apart, and the transaction was then read.

What a look cannot see is a transaction that moves no balance and changes no permission. For a wallet on the
paid plan with the push line up it is read within seconds all the same; otherwise, at the next full pass.

The paid plan promises the push (`PLANS.pro.push`), and the free plan is read in turn only: it is what
"alerts in seconds" on the plan means. The public RPC takes about 450 such subscriptions from one address
(five connections of ninety), so that is how many paid wallets can have it there; whoever runs the service
is told when nine in ten are taken, and again if more wallets are on the plan than the line takes. It is not
counted in what a wallet costs in reads. What it does not cover is a transaction that does not name the
wallet (a delegate's taking, below), which only a look sees, at the plan's pace.

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
- A pass over a quiet wallet costs one call: the list of what is new. Its accounts (who may spend a token account,
  who owns it, which program owns the wallet) change only by a transaction the wallet signs, and every such
  transaction is in that list. So the accounts are read when the list has something new, on the first pass,
  and every quarter of an hour regardless, in case that reasoning has a hole.

It has been run once against the public mainnet RPC (a first pass over a real account). The tests run it
against a simulated RPC.

## Tokens taken through a permission

A delegate the wallet once approved can move its tokens in a transaction the wallet does not sign and that
need not name the wallet at all. That transaction is in no list of the wallet's transactions, so reading the
wallet's list, however often, never shows it. This is how an approval given to a bad site months ago turns
into a theft.

What shows it is the token account, which holds less. The record keeps what each token account held and the
slot that was read at, and a pass compares:

- It holds as much or more: nothing to do.
- It holds less, and the wallet's own transactions since then took out at least that much: nothing to do.
  The watcher remembers what each transaction it read did to each token account until that account is next
  accounted for, so this costs no extra call. It is what happens on every ordinary payment.
- It holds less than the wallet's own transactions explain: some other transaction took the rest. The token
  account's own list of transactions is read, back to the slot on record and the oldest first, and every
  transaction on it that the wallet did not sign and that took tokens raises `taken_by_permission`, Urgent
  and hard, once, with the amount, whose permission it went under (from the record, because the Token
  program forgets a delegate that has used all it was allowed), who signed, and what the wallet received in
  the same transaction if it received anything. A transaction that names the wallet without its signature
  is also in the wallet's own list and raises the same signal there; whichever place comes upon it first
  tells of it, and the other does not.

What Sentinel's own delegate moves is a rescue and is not called a taking.

A fall that cannot be explained yet (the RPC a moment behind, or more to read than one pass reads: five
account lists and ten transactions) is kept on the record as it was and looked at again on the wallet's next
turn; when more accounts hold less than one pass looks into, they take turns. After ten minutes without
finding the transaction, the owner gets `unexplained_loss`, and the new amount is taken as it is.

### Somebody trying to hide it

The code is public, and a transaction costs a thief almost nothing, so each of these was tried:

- **Dust after the taking**, to push it out of what is read. The account's list is read oldest first from the
  slot on record, and as far back as three thousand signatures, so what took the tokens is read before
  anything sent after it.
- **Filling the wallet's own list** (thirty transactions a turn that merely name it), so that "the wallet's
  own transactions are read first" never ends. A fall waits two minutes for the wallet's list and no longer;
  then the account's own list is read regardless.
- **Naming the wallet in the taking**, and burying it under a thousand more that name it, so the wallet's
  list (which takes the newest thousand) never shows it. The taking is judged where it is found, on the
  account's list, by who signed it and not by whom it names.
- **A flood before the taking**, so that reading oldest first does not reach it in ten minutes.
  `unexplained_loss` is then Urgent and says why: tokens left, the wallet did not move them, and there was
  more than could be read, which is how one is hidden. Nobody can be named, and the owner is told to revoke.
- Beside these the owner is told, at Alert, when more names the wallet than is being read: after ten minutes
  of it, or at once when there was more than the list holds and the oldest go unread (`watch_behind`, at
  most every six hours).

### A sale is a taking too

A marketplace that lists without taking the token away holds a permission, and a sale is the buyer's
transaction moving the token under it: to the chain, the same thing as a theft. It is told as a taking, at
Urgent, with what the wallet was paid in the same transaction, so that the owner recognises it. A payment
does not soften the alert: a thief can send a wallet one lamport. What does is the owner. "This was me" on
such an alert makes whoever holds that permission familiar for that wallet (`trustedTakers` on the record,
the newest twenty), and what it takes afterwards is Info: on the page, and nobody's phone rings. Because
that is less protection from then on, and anyone signed in to the profile can press it, the profile's
channels are told when it is done (`takerTrustedNotice`), with the wallet that was signed in.

### What it does not see

- A taking that is made up, between two reads, by what other people paid into the same account. The account
  did not fall, and nothing is looked for. When it is looking anyway, it reads everything that happened to
  the account since the record, so a second taking behind a payment in is found then.
- A wallet with more token accounts than a look takes in (99) has the ones most at risk looked at each turn:
  those somebody holds a permission to spend from, then those that hold something. The rest are compared
  when the wallet's accounts are next read in full, which for a quiet wallet is about every twenty minutes.
- A record from before amounts were kept has nothing to compare with until its first read after the upgrade.
- Transactions the wallet itself signs are read from its own list, twenty-five a pass, oldest first. A flood
  of transactions naming the wallet delays alerts about those (the owner is told it is behind, as above);
  what happened to its balances and permissions is still seen by the look, every turn.

`taken.test.ts` runs all of this against a chain written for it; `taken.validator.test.ts` runs the plain
case against a local validator and the Token program itself (a real approval, a real transfer by the
delegate), and is part of `pnpm test:rescue`.

## How much it can watch, and keeping the pace

A plan's pace is a promise: Watch says each wallet is read every minute, Pro every twenty seconds. Whether
that can be kept is a matter of how much the RPC will take. Measured on the public Solana RPC, from the
server, on 2026-11-13:

| Call | What the public RPC took from one address |
|---|---|
| `getMultipleAccounts`, a hundred accounts a call | four calls a second with none refused; at eight a second, refused after about forty-five |
| `getAccountInfo` | four a second without a refusal |
| `getSignaturesForAddress` (a wallet's list of transactions) | about 10 in ten seconds; at two a second, half were refused |
| `getTokenAccountsByOwner` | the same |
| `getTransaction` | the same |
| several calls in one batch request | refused every time |
| a websocket subscription to an address being mentioned | 100 on a connection (closed at the 101st), 5 connections from one address (the 6th closed as it opened), ten requests a second all taken, two hundred a second closed |

Each refusal came with "retry after 10 seconds". Each of the three rationed calls has an allowance of its
own. Reading accounts in bulk is more than four hundred times cheaper, counted in accounts, than listing
transactions: that difference is the whole design.

What the service does with it:

- **A wallet's turn is a look at its accounts**, a hundred to a call (see above). A wallet is taken for
  twelve accounts, and half of what that pace carries is promised: on the public RPC, 875 reads a minute.
  A free wallet is one, a paid one three (`SENTINEL_READS_PER_MINUTE`). That is 875 free wallets, or 29 paying
  profiles with ten wallets each, where reading the list of transactions every turn gave 43 and 1.
- **It asks at a pace the RPC takes** (`src/rpc.ts`): each rationed call on a lane of its own, everything
  else on another, each spaced evenly. A refusal is waited out for as long as the RPC says, by every call of
  that kind. Reading a new wallet's history is work that can wait: it takes the turns nobody else wants.
- **A round is short.** It looks at the sixty or so wallets furthest behind their own promise, reads through
  the few of them that need it (the RPC's word first, then an unfinished pass, then accounts that moved, then
  a wallet never read, then the now-and-then pass), and hands back the rest as still due. A wallet handed
  back is not counted as read. A paid wallet promised twenty seconds is not kept waiting behind free ones.
- **One pass reads so much and no more.** At most 25 new transactions, the rest on the next turn, and a
  thousand of a wallet's token accounts however many it has. A wallet that transacts without pause cannot
  hold a reader or the RPC's allowance. It is read behind what it does, and never skipped ahead: with more
  than a thousand unread, the oldest are lost.
- **A new wallet's first read** fetches up to two hundred transactions of its history at the rationed pace:
  about four minutes on the public RPC for a wallet with that much, during which the page says "Not read yet".
- **The push line** carries 450 wallets on the public RPC (five connections of ninety), asked for twenty at a
  time. Wallets past that are looked at in turn like the rest and are not told of at once.
- **When the promise is not kept, that is said.** `/v1/health` counts the wallets read later than twice their
  promise (`late`), and after a quarter of an hour of it whoever runs the service is told.

Run for real, from a laptop against the public RPC: **800 wallets, each read within its minute, for as long
as it ran, with nothing refused and none late**, and the push line up.

What is still small:

- **The data file.** It is one JSON file rewritten whole on every change that matters. That is comfortable for
  some hundreds of wallets, which is why `SENTINEL_MAX_WALLETS` is 500 unless set. Past that it wants a
  database.
- **Wallets that are busy all day.** Every transaction of a watched wallet costs rationed calls (the list, the
  transaction, its token accounts). The public RPC carries a few of those a second in all. People's wallets
  transact a few times a day; a thousand of them is a fraction of that. A few hundred bots would not fit.
- **The public RPC is nobody's promise.** It says of itself that it is not for production, and it can change
  what it takes on any day. The same code runs against a paid RPC by changing four settings, and there the
  look is as cheap as it is here: a paying profile's ten wallets are three or four calls a minute.

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
lost server. For that there is a copy somewhere else:

- `sentinel/backup.sh [ssh-host]` copies the data file as it is now to the machine it is run on, gzipped,
  into a folder only that user can read (`~/Library/Application Support/Lamport Sentinel/backups`), and
  removes copies older than seven days, which is what the privacy policy says backups hold. What comes back
  is kept only if it unpacks and is the service's own file.
- On a Mac it also puts into the login keychain, never into a file and never onto a command line, the two
  things a restored file is no use without: the data key (the stored alert channels are sealed with it) and
  the address of the operator's channel. Stripe's keys are not copied: they can be made again at Stripe. A
  process running as that user on that Mac can read both the copies and the key; the keychain keeps the key
  out of the folder, out of other backups of the folder, and out of anything that reads files.
- Nothing is removed when a copy fails, so a server that is gone does not take its backups with it a week
  later. Nothing is removed either when the server's file has no wallets in it and the copy before had
  several: a server that was lost and set up again looks like that, and the script and the look both say so.
- It ends with 2 when the copy was made and the key for it is not in the keychain and could not be read.
- `sentinel/watch-from-here.sh` asks the deployed service the same question as the check from GitHub, from
  that machine, and looks at the copies: it says so, as a notification there and on the operator's ntfy
  channel, when the service does not answer or is not watching, and when no copy has been made for two days.
- `sentinel/mac-agents.sh [ssh-host]` sets a Mac up to run both: a backup every day at 04:40 (or when it
  next wakes), a look every ten minutes while it is awake. Two launchd agents for the user, no root;
  `--remove` takes them out. A laptop that sleeps is not a monitor, and this does not pretend to be one: it
  is a third look, beside the watchdog on the server and GitHub's schedule.

To restore onto a new server: deploy (`sentinel/deploy.sh`), stop the service, gunzip the newest copy to
`/var/lib/private/lamport-sentinel/sentinel.json` owned by the service's user, set `SENTINEL_DATA_KEY` in
`/etc/lamport-sentinel.env` to what `security find-generic-password -s lamport-sentinel-data-key -a <host> -w`
prints, and start it. Whatever happened after the copy was made is lost: at most a day.

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
| The RPC has not been saying when transactions happen for a quarter of an hour (the push line is down) | every six hours |
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
email; it is switched back on from the Actions tab. GitHub also runs schedules late, and sometimes not at
all: in the first hours after this one was added it did not run once on its own. It is a backstop for the
day the whole server is gone, not something that will say so within minutes.

### Watched from beside it

What does act within minutes is on the server itself. `sentinel/watchdog.sh`, on a systemd timer, asks the
service's health address every five minutes the same question (the same `check-live.mjs`). When the answer is
"not watching" twice, half a minute apart, it starts the service again and tells the operator's channel, once
an hour at most. systemd already starts a service that dies; this is for one that is up and has stopped
reading. When the service answers and cannot read the chain it is left alone: that is the RPC's trouble, the
service says so itself, and starting it again would not help. Being on the same machine, it cannot say that
the machine is gone.

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
- **A real payment before it is on sale.** `SENTINEL_CHECKOUT_TESTERS` names up to twenty wallet addresses,
  separated by commas. A profile that one of them is in sees the button and can buy while checkout is closed
  to everyone else, so the whole path (the page, Stripe's checkout with a real card, the webhook, the tier,
  the portal, cancelling) can be run once for real. A wallet is in a profile only by its own signature, so
  nobody can put a tester's wallet into theirs. Take the setting out again afterwards, or leave it: it sells
  to nobody else.

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
| Read as soon as the network reports a transaction in it | no | yes |
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

- A watchdog beside it (`lamport-sentinel-watch.timer`) asks every five minutes whether it is still watching,
  and starts it again when it is not.
- The service runs under systemd as a user of its own (`DynamicUser`), able to write one folder,
  `/var/lib/lamport-sentinel`, and nothing else.
- `/etc/lamport-sentinel.env` (root only) holds its settings. The data key in it was made on the server.
  One copy of it is in the login keychain of the machine that keeps the backups (`sentinel/backup.sh`), and
  nowhere else. Lose both and the stored alert channels cannot be read.
- It reads the public mainnet RPC, at the pace that RPC was measured to take, and promises 875 reads a minute
  in all (a free wallet is one, a paid one three; see "How much it can watch"). Past that, and past 500
  wallets whatever they cost (`SENTINEL_MAX_WALLETS`), new sign-ups are told it is full. The public RPC is
  free, rationed, and nobody's promise; a paid RPC is four settings away.
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
