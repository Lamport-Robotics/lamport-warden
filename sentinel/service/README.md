# Sentinel service

The watcher's rules, so far. No server, no network and no keys yet: this folder holds the part that decides
what a confirmed transaction means for a wallet, which is the part that has to be right before anything is
built around it.

| File | Job |
|---|---|
| `src/observed.ts` | A confirmed transaction as an RPC returns it: the signed message, and the balances before and after. Reads version 0 messages through the addresses the cluster says their tables resolved to. |
| `src/baseline.ts` | What is normal for one wallet, built from its public history: who it paid, which programs it used, usual amounts, usual hours. Only what the wallet itself sent builds trust. |
| `src/signals.ts` | The spec's signal table as rules: a transaction or a changed account in, signals with a level and a sentence out. |

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

## Not here yet

Subscribing to a chain, storing anything, sending alerts, the rescuer, sign-in, the Pincer1 webhook. Replaying
real wallets' public history to count false alerts needs an RPC that allows it (the public one refuses most
`getTransaction` calls); a free Helius key is enough.
