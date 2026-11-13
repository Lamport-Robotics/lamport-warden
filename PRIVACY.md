# Lamport Warden: privacy

Warden has no account and no analytics. Lamport Robotics receives nothing from it unless you turn on one
setting, "Tell Sentinel which signatures were mine", which is off until you do and is described below.

## What it keeps, and where

In the browser's extension storage on your machine, and nowhere else:

- For each wallet address you sign with: the addresses that wallet has paid, how many times, the amounts in
  SOL, and when. Warden uses this to tell a familiar payment from a new one and to spot look-alike addresses.
  It records a payment only when a request you let through comes back signed.
- Your settings: the RPC address, whether simulation is on, the sites you allowed to ask for Privacy
  Rings keys, and whether Sentinel reporting is on.
- If you use Sentinel: for each wallet, the vault you chose for rescues, as this browser saw you set it up;
  and for each wallet you linked on the Sentinel page, the token that wallet reports with.
- The names of wallet objects it could not guard, with the day each was last seen.

The settings page shows all of it and can forget a wallet's history. Removing the extension removes it all.

Warden does not keep the sites you visit or the requests it read.

## What leaves your browser

Two kinds of request go to the Solana RPC chosen on the settings page. By default that is the public RPC at
`api.mainnet-beta.solana.com`; it can be your own, or turned off. A third goes to Lamport, and only if you
turn it on.

1. **Reading lookup tables.** When a transaction names its accounts through a table stored on chain, Warden
   asks the RPC for that table. The RPC receives the table's address and, like any server, your IP address.
   It does not receive your wallet address, the transaction or the site.
2. **Simulation, only if you turn it on.** For a transaction that calls a program Warden cannot read, Warden
   sends the unsigned transaction and the list of accounts it writes to the RPC, which runs it and answers
   with the result. The transaction names your wallet. This is off until you turn it on.

3. **Telling Sentinel a signature was yours, only if you turn it on.** Sentinel is Lamport's watching
   service. It sees only the chain, so it cannot tell a payment you made from one a thief made with your key.
   With "Tell Sentinel which signatures were mine" on, when a wallet you linked on the Sentinel page signs a
   transaction you let through, Warden sends the Sentinel service at `warden.lamportrobotics.com` that
   wallet's address and the transaction's signature. Both are public on the chain once the transaction lands.
   It does not send the site, the transaction or your history. It sends only what it can check: the
   signature has to be your own key's, over the exact transaction Warden showed you. Sentinel keeps a
   reported signature for 30 days. Unlinking a wallet, or turning the setting off, stops it.

Requests are sent without cookies and without a referrer. Nothing is sent to anyone else, nothing is sold, and
nothing is used for advertising or to decide creditworthiness or lending.

## What it can see on a page

Warden runs on every https page because any page can ask a wallet to sign. There it does two things: it puts
itself in front of the wallet's signing calls, and it draws its prompt. It does not read the page's content,
your passwords or your keys. It never has your private keys: those stay in your wallet.

## Changes and contact

Changes to this policy are made in this file, in the open:
https://github.com/Lamport-Robotics/lamport-warden/blob/main/PRIVACY.md

Questions: support@lamportrobotics.com
