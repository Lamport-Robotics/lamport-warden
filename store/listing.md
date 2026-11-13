# Chrome Web Store listing

What to paste into the developer dashboard. Keep this file in step with what is submitted.

## Store listing tab

**Name** (from the manifest): Lamport Warden

**Summary** (from the manifest, 132 characters at most):
Reads each Solana signing request before your wallet does, says what it will do, and stops it when that is not what you meant.

**Category:** Privacy & Security

**Language:** English

**Description:**

Warden sits in front of the Solana wallet you already use. Before a signing request reaches the wallet,
Warden reads it, says in one sentence what it will do to your money, and decides how much friction it
deserves.

Most of the time you see nothing: a payment to an address you have paid before, of a size you have sent
before, goes straight through. A first payment to a new address gets one sentence and two buttons. And some
requests are blocked, with the reason, before your wallet is ever asked:

• A look-alike of an address you have paid: the same first and last four characters, a different address.
• A hidden instruction that hands your account, or a token account, to someone else.
• An unlimited approval for someone to spend a token.
• A transaction or a raw hash dressed up as a message to sign.
• A sign-in request that would sign you in to a different site than the one asking.
• A site asking for the signature that unlocks your Privacy Rings keys.

Warden keeps its own record of who you have paid, on your machine only. It learns an address only when a
request you let through comes back signed, so dust sent to you by a look-alike teaches it nothing.

Works with Phantom, Backpack and Solflare through Wallet Standard, which is what most dapps use, and with
the older page objects of Phantom and Backpack. Solflare's older page object cannot be guarded; the settings
page tells you when Warden meets it.

No account, no Lamport server, no model. By default the only network request is to read on-chain lookup
tables from a Solana RPC you can change or turn off. You can turn on simulation, which sends a swap,
unsigned, to your RPC to find out what it would do; it is off until you choose it.

Warden is advice in front of your wallet, not a lock on it. A page can still reach a wallet in ways an
extension never sees. It is open source: https://github.com/Lamport-Robotics/lamport-warden

**Screenshots** (1280 x 800): `store/screenshots/`, made by `pnpm shots`.

**Small promo tile** (440 x 280): not made yet.

**Website:** https://warden.lamportrobotics.com

**Support:** support@lamportrobotics.com

## Privacy practices tab

**Single purpose:**
Warden shows what a Solana signing request will do before it reaches the user's wallet, and stops requests
that match known theft patterns.

**Permission justification, storage:**
Keeps, on the user's device, the addresses each of their wallets has paid (to recognise familiar payments
and look-alike addresses) and the user's settings.

**Host permission justification** (content scripts on https://*/*):
Any web page can ask a Solana wallet to sign, and a page built to steal is not on any list. Warden's scripts
run on every https page to do two things: put Warden in front of the wallet's signing calls, and draw its
prompt. They do not read the page's content.

**Remote code:** No. Everything the extension runs is in the package.

**Data usage.** Tick "Financial and payment information": Warden handles transactions and wallet addresses.
It keeps payment history on the device, and when the user has turned simulation on, sends the unsigned
transaction to the Solana RPC the user chose. Tick nothing else. Then certify all three statements: the data
is not sold, not used for purposes unrelated to the single purpose, and not used for creditworthiness or
lending.

**Privacy policy URL:** https://warden.lamportrobotics.com/privacy

## Distribution tab

Free. All regions. Public, or Unlisted for a first round with testers: unlisted is reviewed the same way and
anyone with the link can install it.
