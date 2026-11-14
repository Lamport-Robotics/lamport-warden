# Lamport Warden: privacy

Warden has no account and no analytics. Lamport Robotics receives nothing from it unless you turn on one
setting, "Tell Sentinel which signatures were mine", which is off until you do and is described below.
Sentinel, the watching service you can sign in to, is separate from the extension and has its own section
further down.

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

## Sentinel, the service

Sentinel is separate from the extension. It is a service on Lamport's server that you sign in to at
`warden.lamportrobotics.com/sentinel/` with a wallet signature, and you use it only if you choose to. It has
no name, email address or password for you: you are whoever can sign with one of your wallets.

What it keeps, on that server:

- The wallet addresses you add, and which of them belong together in your profile.
- For each wallet, what is normal for it, worked out from its public history on the chain: the addresses it
  has paid, the programs it has used, how much it usually sends, the hours it transacts in, and its token
  accounts as last seen.
- The alerts it raised about a wallet, and what you answered to each.
- If you turned on "Tell Sentinel which signatures were mine": the signatures your browser reported, for 30
  days.
- Where your alerts go: the address of each channel you gave (an ntfy topic, a Discord or Slack webhook, or
  the number of a Telegram chat you connected),
  encrypted under a key that is not in that file, and when it last took a message or since when it has
  refused them.
- Your sign-ins: each session as a hash, for seven days, with which of your wallets signed it in; and, for a
  wallet you linked to the extension, the hash of the token it reports with.
- Your plan. If you pay by card: Stripe's ids for the customer and the subscription, the price, its status
  and its dates. Not your card, your name or your email address: those are with Stripe and never reach
  Sentinel. If you pay ahead in USDC or SOL: the amounts you were shown in the last week, and for each
  payment the transaction, what it paid, for how many months, and when.

It does not keep your IP address. The address a request comes from is held in memory for up to a day, to
limit abuse, and is not written down; the web server in front of Sentinel keeps no access log. The Sentinel
page sets no cookie and has no analytics: your session is kept in the browser tab and ends with it.

Who else receives something:

- The Solana RPC at `api.mainnet-beta.solana.com` is asked, by Lamport's server, about the addresses you
  added. It sees the server, not you.
- The channel you chose (ntfy.sh, Telegram, Discord or Slack) receives each alert: one sentence about what happened,
  which can name the addresses involved, and the first and last four characters of your wallet's address.
  The same channel is told when someone signs in to your profile or changes it, and what your plan does. On
  ntfy, anyone who knows a topic's name can read what is sent to it.
- Telegram, if you connect a chat. Telegram learns that your account spoke to Sentinel's bot, and sends the
  bot your Telegram name with the message. Sentinel keeps the chat's number, encrypted like any channel's
  address, and nothing else about the account.
- Everyone, if you pay in USDC or SOL. A transfer on the chain is public: anyone can see that the wallet
  you paid from paid Lamport's address, how much and when. It can be paid from a wallet that is not one you
  have Sentinel watch.
- Stripe, if you pay by card. It takes the payment under its own privacy policy. Sentinel gives Stripe a random id
  that stands for your profile, and learns from Stripe whether the plan is paid.

Removing a wallet on the Sentinel page deletes what is kept about it. Removing the last one deletes the
profile, its channels and its sessions. Sentinel's daily backups hold them for up to seven days more, and
then they are gone from those too. The backups are copies of the same file: one set on the server, and one
on a second computer that Lamport keeps, in case the server is lost. If the server is lost or cannot be
reached, the copies on the second computer are kept until it is back. Stripe keeps its own record of
payments.

The practice page at `/try/` sends nothing anywhere. With Warden installed, Warden remembers the practice
wallet's payments as it would any wallet's, in your browser; the settings page can forget them.

## Changes and contact

Changes to this policy are made in this file, in the open:
https://github.com/Lamport-Robotics/lamport-warden/blob/main/PRIVACY.md

Questions: support@lamportrobotics.com
