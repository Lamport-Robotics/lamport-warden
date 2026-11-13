# Chrome Web Store listing

What to paste into the developer dashboard. Keep this file in step with what is submitted.

Item ID: `dmlhclkglnpkdhidfjfgjfdjnblnalea`, created on 2026-11-13 from `lamport-warden-0.5.0.zip`. It is a
**draft** and is not submitted. It was submitted once that day and the review was cancelled, to wait for the
version that has Sentinel built in. That was 0.6.0; the current one is 0.6.1, which adds a welcome on first
install and a link to the practice page.

To submit 0.6.1:

1. Package tab: upload `lamport-warden-0.6.1.zip` (`pnpm package`).
2. Store listing tab: paste the description below again (it now mentions Sentinel and the practice page)
   and replace the screenshots with the four in `store/screenshots/` (retaken from 0.6.1).
3. Privacy tab: paste the storage justification and the data-usage note below again.
4. Distribution tab: Payments. The extension itself sells nothing; it links to the Sentinel page, where the
   paid plan is sold once checkout is open. Choose "Contains in-app purchases" if checkout is open when you
   submit, "Free of charge" if it is not.
5. Test instructions tab: paste the text below (update the version in step 1 if it changed).
6. Submit. Google flags the host permission for an in-depth review, so expect longer than a few days.

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

You can watch it work before you trust it with anything: warden.lamportrobotics.com/try has a practice wallet
that holds nothing and eight requests to try on it.

No account, no model, and by default nothing goes to Lamport. The only network request is to read on-chain
lookup tables from a Solana RPC you can change or turn off. You can turn on simulation, which sends a swap,
unsigned, to your RPC to find out what it would do; it is off until you choose it.

Sentinel is Warden's optional watching service: it watches the wallets you give it after you sign and tells
you in one sentence when something looks wrong. If you use it, you can let Warden tell Sentinel which
signatures were yours, so it does not alert you about your own payments. That is off until you turn it on,
and it sends only the wallet's address and the transaction's signature.

Warden is free and stays free. Sentinel has two plans.

Watch is free:
• 3 wallets watched around the clock, each read every minute
• Alerts in plain sentences, pushed to your phone through ntfy
• "This was me", so it learns who you pay

Pro is $15 a month, or $10 while a wallet in your Sentinel profile holds 250,000 $LAMPORT. It adds:
• Alerts in seconds: a wallet is read as soon as the network reports a transaction in it, without waiting for its turn
• 10 wallets watched instead of 3
• Each wallet read every 20 seconds instead of every minute
• Up to 5 alert channels, including Discord and Slack, so a team sees an alert together

Rescue is not available yet. Moving your tokens into your own Lamport Vault when a wallet is compromised needs the vault and the rescue program on mainnet, and both are waiting on their audits. It joins Pro when they are, at the same price.

A plan is started and cancelled on the Sentinel page (warden.lamportrobotics.com/sentinel), which says
whether Pro is on sale. It is paid by card through Stripe; nothing is bought inside the extension.

Warden is advice in front of your wallet, not a lock on it. A page can still reach a wallet in ways an
extension never sees. It is open source: https://github.com/Lamport-Robotics/lamport-warden

**Screenshots** (1280 x 800): `store/screenshots/`, made by `pnpm shots`. Four: a look-alike address blocked,
a swap with what a simulation showed, the settings page, and the practice page with a request stopped. The
fourth is taken from the practice page as it is deployed, so `pnpm shots` needs the network for it.

**Small promo tile** (440 x 280): not made yet.

**Store icon** (128 x 128): `public/icons/icon128.png`.

**Homepage URL:** https://warden.lamportrobotics.com

**Support URL:** https://github.com/Lamport-Robotics/lamport-warden/issues (the field takes a link, not an
address). By email: support@lamportrobotics.com

## Privacy practices tab

**Single purpose:**
Warden shows what a Solana signing request will do before it reaches the user's wallet, and stops requests
that match known theft patterns.

**Permission justification, storage:**
Keeps, on the user's device, the addresses each of their wallets has paid (to recognise familiar payments
and look-alike addresses), the user's settings, and, for a wallet the user linked to Sentinel, the token it
reports with.

**Host permission justification** (content scripts on https://*/*):
Any web page can ask a Solana wallet to sign, and a page built to steal is not on any list. Warden's scripts
run on every https page to do two things: put Warden in front of the wallet's signing calls, and draw its
prompt. They do not read the page's content.

**Remote code:** No. Everything the extension runs is in the package.

**Data usage.** Tick "Financial and payment information": Warden handles transactions and wallet addresses.
It keeps payment history on the device; when the user has turned simulation on, sends the unsigned
transaction to the Solana RPC the user chose; and when the user has turned Sentinel reporting on, sends a
linked wallet's address and a transaction's signature to Lamport's Sentinel service. Tick nothing else. Then certify all three statements: the data
is not sold, not used for purposes unrelated to the single purpose, and not used for creditworthiness or
lending.

**Privacy policy URL:** https://warden.lamportrobotics.com/privacy

## Test instructions tab

Paste this. A reviewer needs no account, no wallet and no crypto to see everything the extension does.

```
No login is needed. No wallet or cryptocurrency is needed.

1. Install the extension. It opens its own settings page with a short welcome. Press
   "See it work with a practice wallet" there, or open https://warden.lamportrobotics.com/try/
   The page makes a practice wallet that holds nothing. Nothing on it is sent to any blockchain.
   Near the top it says "Warden 0.6.1 is in this browser and is standing in front of the practice wallet."
2. Press "Try it" beside "Pay someone for the first time".
   The extension shows its prompt: one sentence saying what the request does, with Cancel and
   "Continue to wallet". Press "Continue to wallet".
3. Press "Try it" beside "Pay the same address again".
   Nothing is shown: a payment to an address already paid goes straight through. This is the normal case.
4. Press "Try it" beside each of "Pay an address that only looks like it", "Let a stranger spend your USDC",
   "Hand your USDC account to someone else", "Sign in to a site you are not on" and "A payment dressed up as
   a message". Each time the prompt says "Blocked" with the reason, and its only button is Close.
   The page then says "Stopped. The practice wallet was never asked."
5. Open the extension's options page (right-click the icon, Options). It lists the practice wallet and what
   was remembered about it, and can forget it. This is all the data the extension keeps, and it stays in
   the browser.

The extension works the same in front of Phantom, Solflare and Backpack. The practice page exists so that
this can be seen without installing one of them.

Sentinel, which the options page links to, is an optional web service on our own site. Signing in to it
needs a Solana wallet extension (a signature only: no funds, no payment). It is not needed to test the
extension, and nothing is sold inside the extension.
```

The practice page is `site/try/`. `test/browser/try-page.test.ts` walks these same steps in Chromium with the
built extension, so the instructions cannot drift from what the extension does.

## Distribution tab

Free. All regions. Public, or Unlisted for a first round with testers: unlisted is reviewed the same way and
anyone with the link can install it. The draft is set to Unlisted and "Free of charge"; switching either is a
change on this tab that has to be submitted.

"Free of charge" means the package has nothing in it to buy. Google's developer agreement does not let a
publisher later charge for what users first got free (section 3.3), and lets an extension be the way in to a
paid service (section 4.4.3). So the pre-sign check stays free for good, and Sentinel is sold as a service
beside it. Google does not process the payment.
