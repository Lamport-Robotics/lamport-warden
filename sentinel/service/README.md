# Sentinel service

The watcher: it reads what happened to each watched wallet, decides what it means, and tells the owner. It
holds no key and moves nothing. There is no server around it yet (no sign-in, no rescuer, no deployment).

| File | Job |
|---|---|
| `src/observed.ts` | A confirmed transaction as an RPC returns it: the signed message, and the balances before and after. Reads version 0 messages through the addresses the cluster says their tables resolved to. |
| `src/baseline.ts` | What is normal for one wallet, built from its public history: who it paid, which programs it used, usual amounts, usual hours. Only what the wallet itself sent builds trust. |
| `src/signals.ts` | The spec's signal table as rules: a transaction or a changed account in, signals with a level and a sentence out. |
| `src/watcher.ts` | One pass per wallet: what is new since the last pass, oldest first, through the rules; then the wallet's token accounts and the wallet account itself. Alerts go to a notifier (ntfy to start with) as a plain sentence, never with a link. |
| `src/store.ts` | What it keeps per wallet: where it has read up to, the baseline, the token accounts as last seen, the alerts raised. One JSON file for now. |
| `src/rpc.ts` | JSON-RPC over HTTP, waiting out "too many requests". |

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
what the wallet is taken to trust.

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

## Not here yet

A process that runs it on a schedule, profiles and sign-in, more alert channels, the rescuer, the Pincer1
webhook. Replaying real wallets' public history to count false alerts needs an RPC that allows it (the public
one refuses most `getTransaction` calls); a free Helius key is enough.
